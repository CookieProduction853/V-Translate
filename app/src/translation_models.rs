//! User-supplied GGUF files live only in models/translation. Their local
//! fingerprints are copy/change detection, never publisher authentication.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_DIRECTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STRING_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct LocalModel {
    pub id: String,
    pub filename: String,
    pub name: String,
    pub size_bytes: u64,
    pub architecture: Option<String>,
    pub has_chat_template: bool,
}

#[derive(Debug, Serialize)]
pub struct ModelCatalog {
    pub models: Vec<LocalModel>,
    pub warnings: Vec<String>,
}

pub fn validate_filename(filename: &str) -> Result<()> {
    let stem = filename.split('.').next().unwrap_or_default();
    let reserved = matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    anyhow::ensure!(
        !filename.is_empty()
            && filename.len() <= 240
            && !filename.starts_with('.')
            && !filename.ends_with([' ', '.'])
            && !filename
                .chars()
                .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
            && !reserved
            && filename.to_ascii_lowercase().ends_with(".gguf"),
        "自訂翻譯模型必須是 models/translation 內的單一 .gguf 檔名"
    );
    Ok(())
}

fn ordinary(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

/// Creates only the fixed folder and refuses links/junctions in its path.
pub fn model_directory(root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(root).context("本機資料目錄不存在")?;
    anyhow::ensure!(
        ordinary(&metadata) && metadata.is_dir(),
        "本機資料目錄不能是連結或重新解析點"
    );
    let root = root.canonicalize().context("本機資料目錄不存在")?;
    let mut directory = root.clone();
    for component in ["models", "translation"] {
        directory.push(component);
        match std::fs::symlink_metadata(&directory) {
            Ok(metadata) => anyhow::ensure!(
                ordinary(&metadata) && metadata.is_dir(),
                "自訂模型資料夾不能是連結或重新解析點"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&directory)?;
                let metadata = std::fs::symlink_metadata(&directory)?;
                anyhow::ensure!(
                    ordinary(&metadata) && metadata.is_dir(),
                    "自訂模型資料夾無效"
                );
            }
            Err(error) => return Err(error.into()),
        }
        let canonical = directory.canonicalize()?;
        anyhow::ensure!(
            canonical.parent() == directory.parent(),
            "自訂模型資料夾路徑無效"
        );
    }
    Ok(directory)
}

fn selected_path(root: &Path, filename: &str) -> Result<PathBuf> {
    validate_filename(filename)?;
    let directory = model_directory(root)?;
    let path = directory.join(filename);
    let metadata = std::fs::symlink_metadata(&path)
        .with_context(|| format!("找不到自訂翻譯模型 {filename}，請放入模型資料夾後重新掃描"))?;
    anyhow::ensure!(
        ordinary(&metadata) && metadata.is_file(),
        "自訂模型必須是一般檔案，不能是連結或重新解析點"
    );
    let canonical = path.canonicalize()?;
    anyhow::ensure!(
        canonical.parent() == Some(directory.as_path()),
        "自訂模型不能位於模型資料夾之外"
    );
    Ok(canonical)
}

pub fn validate_selection(root: &Path, filename: &str) -> Result<LocalModel> {
    let path = selected_path(root, filename)?;
    inspect(&path, filename)
}

pub fn scan(root: &Path) -> Result<ModelCatalog> {
    let directory = model_directory(root)?;
    let mut catalog = ModelCatalog {
        models: Vec::new(),
        warnings: Vec::new(),
    };
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let Some(filename) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !filename.to_ascii_lowercase().ends_with(".gguf") {
            continue;
        }
        match validate_selection(root, &filename) {
            Ok(model) => catalog.models.push(model),
            Err(error) => catalog.warnings.push(format!("{filename}: {error:#}")),
        }
    }
    catalog.models.sort_by(|a, b| a.filename.cmp(&b.filename));
    catalog.warnings.sort();
    Ok(catalog)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Fingerprint {
    size_bytes: u64,
    modified_secs: u64,
    modified_nanos: u32,
    #[serde(default)]
    unix_identity: Option<(u64, u64, i64, i64)>,
}
impl Fingerprint {
    fn read(path: &Path) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(
            ordinary(&metadata) && metadata.is_file(),
            "自訂模型檔案已變更為連結或非一般檔案"
        );
        let modified = metadata.modified()?.duration_since(UNIX_EPOCH)?;
        #[cfg(unix)]
        let unix_identity = {
            use std::os::unix::fs::MetadataExt;
            Some((
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ))
        };
        #[cfg(not(unix))]
        let unix_identity = None;
        Ok(Self {
            size_bytes: metadata.len(),
            modified_secs: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
            unix_identity,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalPin {
    version: u32,
    filename: String,
    sha256: String,
    fingerprint: Fingerprint,
}

#[derive(Debug, Clone)]
pub struct PreparedModel {
    root: PathBuf,
    filename: String,
    pub path: PathBuf,
    fingerprint: Fingerprint,
}
impl PreparedModel {
    /// Cheap checks on each use; the multi-GB checksum is calculated on Prepare.
    pub fn revalidate(&self) -> Result<()> {
        let path = selected_path(&self.root, &self.filename)?;
        anyhow::ensure!(
            path == self.path && Fingerprint::read(&path)? == self.fingerprint,
            "自訂翻譯模型已變更，請等待檔案複製完成後重新準備引擎"
        );
        Ok(())
    }
}

fn pin_path(path: &Path, filename: &str) -> PathBuf {
    path.with_file_name(format!(".{filename}.livesub.json"))
}

/// An explicit Prepare accepts the current local file and records its checksum.
/// This does not claim that a user-supplied model has an official publisher hash.
pub fn prepare(root: &Path, filename: &str) -> Result<PreparedModel> {
    let path = selected_path(root, filename)?;
    let before = Fingerprint::read(&path)?;
    inspect(&path, filename)?;
    let mut file = File::open(&path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    anyhow::ensure!(
        Fingerprint::read(&path)? == before,
        "自訂模型仍在複製或已被修改，請完成複製後重新準備"
    );
    let pin = LocalPin {
        version: 1,
        filename: filename.into(),
        sha256: format!("{:x}", hasher.finalize()),
        fingerprint: before.clone(),
    };
    let mut output = tempfile::NamedTempFile::new_in(path.parent().context("自訂模型路徑無效")?)?;
    output.write_all(&serde_json::to_vec(&pin)?)?;
    output.as_file().sync_all()?;
    output
        .persist(pin_path(&path, filename))
        .context("無法保存自訂模型本機校驗紀錄")?;
    let model = PreparedModel {
        root: root.to_owned(),
        filename: filename.into(),
        path,
        fingerprint: before,
    };
    model.revalidate()?;
    Ok(model)
}

/// Recover only a file explicitly prepared previously, using its saved snapshot.
pub fn prepared(root: &Path, filename: &str) -> Result<PreparedModel> {
    let path = selected_path(root, filename)?;
    let pin_path = pin_path(&path, filename);
    let metadata =
        std::fs::symlink_metadata(&pin_path).context("自訂模型尚未準備，請先準備引擎")?;
    anyhow::ensure!(
        ordinary(&metadata) && metadata.is_file() && metadata.len() < 16_384,
        "自訂模型校驗紀錄無效，請重新準備引擎"
    );
    let pin: LocalPin = serde_json::from_reader(File::open(pin_path)?)?;
    anyhow::ensure!(
        pin.version == 1
            && pin.filename == filename
            && pin.sha256.len() == 64
            && pin.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
        "自訂模型校驗紀錄無效，請重新準備引擎"
    );
    let model = PreparedModel {
        root: root.to_owned(),
        filename: filename.into(),
        path,
        fingerprint: pin.fingerprint,
    };
    model.revalidate()?;
    inspect(&model.path, filename)?;
    Ok(model)
}

struct GgufReader {
    file: File,
    length: u64,
    position: u64,
}
impl GgufReader {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.bound(N as u64)?;
        let mut bytes = [0; N];
        self.file
            .read_exact(&mut bytes)
            .context("GGUF 標頭或模型目錄不完整")?;
        Ok(bytes)
    }
    fn bound(&mut self, count: u64) -> Result<()> {
        self.position = self.position.checked_add(count).context("GGUF 長度溢出")?;
        anyhow::ensure!(
            self.position <= self.length && self.position <= MAX_DIRECTORY_BYTES,
            "GGUF 模型目錄不完整或超過 64 MiB 限制"
        );
        Ok(())
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }
    fn skip(&mut self, count: u64) -> Result<()> {
        self.bound(count)?;
        self.file.seek(SeekFrom::Start(self.position))?;
        Ok(())
    }
    fn string(&mut self, capture: bool) -> Result<Option<String>> {
        let length = self.u64()?;
        anyhow::ensure!(length <= MAX_STRING_BYTES, "GGUF 字串超過讀取限制");
        if !capture {
            self.skip(length)?;
            return Ok(None);
        }
        anyhow::ensure!(length <= 4096, "GGUF 名稱或中繼資料過長");
        self.bound(length)?;
        let mut bytes = vec![0; length as usize];
        self.file.read_exact(&mut bytes)?;
        Ok(Some(
            String::from_utf8(bytes).context("GGUF 中繼資料不是 UTF-8")?,
        ))
    }
    fn value(&mut self, kind: u32) -> Result<()> {
        match kind {
            0 | 1 | 7 => self.skip(1),
            2 | 3 => self.skip(2),
            4..=6 => self.skip(4),
            8 => {
                self.string(false)?;
                Ok(())
            }
            9 => {
                let element = self.u32()?;
                let count = self.u64()?;
                anyhow::ensure!(
                    count <= MAX_DIRECTORY_BYTES && element != 9,
                    "GGUF 陣列格式無效或過大"
                );
                let width = match element {
                    0 | 1 | 7 => 1,
                    2 | 3 => 2,
                    4..=6 => 4,
                    10..=12 => 8,
                    8 => 0,
                    _ => bail!("GGUF 中繼資料類型無效"),
                };
                if width == 0 {
                    for _ in 0..count {
                        self.string(false)?;
                    }
                    Ok(())
                } else {
                    self.skip(count.checked_mul(width).context("GGUF 陣列長度溢出")?)
                }
            }
            10..=12 => self.skip(8),
            _ => bail!("GGUF 中繼資料類型無效"),
        }
    }
}

fn tensor_bytes(kind: u32, elements: u64) -> Result<u64> {
    // Known ggml storage types permit a useful truncation check. A future type
    // is left for the pinned llama runtime to diagnose, without pretending support.
    let (block, bytes) = match kind {
        0 => (1, 4),
        1 | 25 | 30 => (1, 2),
        2 | 20 => (32, 18),
        3 => (32, 20),
        6 => (32, 22),
        7 => (32, 24),
        8 => (32, 34),
        9 => (32, 36),
        10 => (256, 84),
        11 | 21 => (256, 110),
        12 => (256, 144),
        13 => (256, 176),
        14 => (256, 210),
        15 => (256, 292),
        16 => (256, 66),
        17 => (256, 74),
        18 => (256, 98),
        19 => (256, 50),
        22 => (256, 82),
        23 => (256, 136),
        24 => (1, 1),
        26 => (1, 4),
        27 | 28 => (1, 8),
        29 => (256, 56),
        _ => return Ok(1),
    };
    anyhow::ensure!(
        elements.is_multiple_of(block),
        "GGUF 張量大小不符合量化區塊"
    );
    (elements / block)
        .checked_mul(bytes)
        .context("GGUF 張量大小溢出")
}

fn inspect(path: &Path, filename: &str) -> Result<LocalModel> {
    let before = Fingerprint::read(path)?;
    anyhow::ensure!(before.size_bytes > 24, "GGUF 檔案太小或尚未複製完成");
    let mut reader = GgufReader {
        file: File::open(path)?,
        length: before.size_bytes,
        position: 0,
    };
    anyhow::ensure!(
        &reader.bytes::<4>()? == b"GGUF",
        "不是 GGUF 模型（不接受訓練權重或其他格式）"
    );
    let version = reader.u32()?;
    anyhow::ensure!(
        matches!(version, 2 | 3),
        "不支援 GGUF 版本 {version}，需要第 2 或第 3 版"
    );
    let tensors = reader.u64()?;
    let metadata = reader.u64()?;
    anyhow::ensure!(
        tensors > 0 && tensors <= 1_000_000 && metadata <= 1_000_000,
        "GGUF 張量或中繼資料數量無效"
    );
    let mut name = filename[..filename.len() - 5].to_owned();
    let mut architecture = None;
    let mut has_chat_template = false;
    let mut alignment = 32u64;
    for _ in 0..metadata {
        let key = reader.string(true)?.unwrap();
        let kind = reader.u32()?;
        match (key.as_str(), kind) {
            ("general.name" | "general.architecture", 8) => {
                let value = reader.string(true)?.unwrap();
                anyhow::ensure!(
                    !value.chars().any(char::is_control),
                    "GGUF 名稱含有控制字元"
                );
                if key == "general.name" && !value.trim().is_empty() {
                    name = value;
                } else if key == "general.architecture" {
                    architecture = Some(value);
                }
            }
            ("general.alignment", 4) => {
                alignment = u64::from(reader.u32()?);
            }
            ("split.count", 2) => anyhow::ensure!(
                u16::from_le_bytes(reader.bytes()?) <= 1,
                "自訂翻譯模型需要單一 GGUF 檔案，尚不支援分割模型"
            ),
            ("split.count", 4) => anyhow::ensure!(
                reader.u32()? <= 1,
                "自訂翻譯模型需要單一 GGUF 檔案，尚不支援分割模型"
            ),
            ("tokenizer.chat_template", 8) => {
                has_chat_template = true;
                reader.string(false)?;
            }
            _ => reader.value(kind)?,
        }
    }
    anyhow::ensure!(
        alignment.is_power_of_two() && alignment <= 4096,
        "GGUF 資料對齊無效"
    );
    let mut payload_end = 0u64;
    for _ in 0..tensors {
        reader.string(false)?;
        let dimensions = reader.u32()?;
        anyhow::ensure!((1..=4).contains(&dimensions), "GGUF 張量維度無效");
        let mut elements = 1u64;
        for _ in 0..dimensions {
            let dimension = reader.u64()?;
            anyhow::ensure!(dimension > 0, "GGUF 張量維度不能為零");
            elements = elements
                .checked_mul(dimension)
                .context("GGUF 張量維度溢出")?;
        }
        let kind = reader.u32()?;
        let offset = reader.u64()?;
        anyhow::ensure!(offset.is_multiple_of(alignment), "GGUF 張量位移未對齊");
        payload_end = payload_end.max(
            offset
                .checked_add(tensor_bytes(kind, elements)?)
                .context("GGUF 張量位移溢出")?,
        );
    }
    let data_start = reader
        .position
        .checked_add(alignment - 1)
        .context("GGUF 位移溢出")?
        / alignment
        * alignment;
    let required = data_start
        .checked_add(payload_end)
        .context("GGUF 檔案大小溢出")?;
    anyhow::ensure!(
        required <= before.size_bytes,
        "GGUF 張量資料不完整，請等待模型複製完成"
    );
    anyhow::ensure!(
        Fingerprint::read(path)? == before,
        "GGUF 檔案仍在複製或已被修改"
    );
    Ok(LocalModel {
        id: filename.into(),
        filename: filename.into(),
        name,
        size_bytes: before.size_bytes,
        architecture,
        has_chat_template,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gguf(metadata: &[(&str, &str)]) -> Vec<u8> {
        fn string(bytes: &mut Vec<u8>, value: &str) {
            bytes.extend_from_slice(&(value.len() as u64).to_le_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        let mut bytes = b"GGUF".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&1u64.to_le_bytes());
        bytes.extend_from_slice(&(metadata.len() as u64).to_le_bytes());
        for (key, value) in metadata {
            string(&mut bytes, key);
            bytes.extend_from_slice(&8u32.to_le_bytes());
            string(&mut bytes, value);
        }
        string(&mut bytes, "weight");
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&1u64.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.resize(bytes.len().div_ceil(32) * 32, 0);
        bytes.extend_from_slice(&0f32.to_le_bytes());
        bytes
    }

    fn write_model(root: &Path, filename: &str, contents: &[u8]) -> PathBuf {
        let path = model_directory(root).unwrap().join(filename);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn filenames_are_single_portable_gguf_basenames() {
        for unsafe_name in [
            "",
            ".gguf",
            ".hidden.gguf",
            "../outside.gguf",
            "sub/model.gguf",
            "sub\\model.gguf",
            "C:\\model.gguf",
            "model.gguf:stream",
            "model\n.gguf",
            "model.gguf ",
            "model.gguf.",
            "model?.gguf",
            "model*.gguf",
            "model\".gguf",
            "CON.gguf",
            "nul.GGUF",
            "COM1.model.gguf",
            "Lpt9.gguf",
            "model.safetensors",
        ] {
            assert!(validate_filename(unsafe_name).is_err(), "{unsafe_name:?}");
        }
        assert!(validate_filename(&format!("{}.gguf", "a".repeat(240))).is_err());
        for name in ["my-model.Q4_K_M.gguf", "Model.GGUF", "自訂翻譯模型.gguf"] {
            validate_filename(name).unwrap();
        }
    }

    #[test]
    fn scan_lists_direct_models_with_metadata_and_ignores_unrelated_files() {
        let dir = tempfile::tempdir().unwrap();
        let folder = model_directory(dir.path()).unwrap();
        let contents = gguf(&[
            ("general.name", "Local translator"),
            ("general.architecture", "future_architecture"),
            ("tokenizer.chat_template", "{{ messages }}"),
        ]);
        write_model(dir.path(), "z-model.gguf", &contents);
        write_model(dir.path(), "a-model.GGUF", &gguf(&[]));
        std::fs::write(folder.join("copy.gguf.part"), b"in progress").unwrap();
        std::fs::write(folder.join("training.safetensors"), b"not GGUF").unwrap();
        std::fs::create_dir(folder.join("nested")).unwrap();
        std::fs::write(folder.join("nested/hidden.gguf"), gguf(&[])).unwrap();
        let catalog = scan(dir.path()).unwrap();
        assert!(catalog.warnings.is_empty());
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[0].filename, "a-model.GGUF");
        let model = &catalog.models[1];
        assert_eq!(model.id, "z-model.gguf");
        assert_eq!(model.filename, "z-model.gguf");
        assert_eq!(model.name, "Local translator");
        assert_eq!(model.size_bytes, contents.len() as u64);
        assert_eq!(model.architecture.as_deref(), Some("future_architecture"));
        assert!(model.has_chat_template);
        let selected = validate_selection(dir.path(), "a-model.GGUF").unwrap();
        assert!(!selected.has_chat_template);
        assert_eq!(selected.size_bytes, 68);
    }

    #[test]
    fn rejects_bad_headers_counts_and_incomplete_tensor_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let valid = gguf(&[]);
        let mut bad_magic = valid.clone();
        bad_magic[..4].copy_from_slice(b"GGML");
        let mut bad_version = valid.clone();
        bad_version[4..8].copy_from_slice(&99u32.to_le_bytes());
        let mut no_tensors = valid.clone();
        no_tensors[8..16].copy_from_slice(&0u64.to_le_bytes());
        let mut huge_tensors = valid.clone();
        huge_tensors[8..16].copy_from_slice(&u64::MAX.to_le_bytes());
        let mut huge_metadata = valid.clone();
        huge_metadata[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        let mut zero_dimension = valid.clone();
        zero_dimension[42..50].copy_from_slice(&0u64.to_le_bytes());
        for (index, contents) in [
            Vec::new(),
            valid[..24].to_vec(),
            bad_magic,
            bad_version,
            no_tensors,
            huge_tensors,
            huge_metadata,
            zero_dimension,
            valid[..40].to_vec(),
            valid[..67].to_vec(),
        ]
        .into_iter()
        .enumerate()
        {
            let filename = format!("invalid-{index}.gguf");
            write_model(dir.path(), &filename, &contents);
            assert!(
                validate_selection(dir.path(), &filename).is_err(),
                "{filename}"
            );
            assert!(prepare(dir.path(), &filename).is_err(), "{filename}");
        }
        let catalog = scan(dir.path()).unwrap();
        assert!(catalog.models.is_empty());
        assert_eq!(catalog.warnings.len(), 10);
        let mut version_two = valid;
        version_two[4..8].copy_from_slice(&2u32.to_le_bytes());
        write_model(dir.path(), "version-two.gguf", &version_two);
        validate_selection(dir.path(), "version-two.gguf").unwrap();
    }

    #[test]
    fn prepare_pins_current_copy_and_changes_require_explicit_reprepare() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_model(dir.path(), "local.gguf", &gguf(&[]));
        assert!(prepared(dir.path(), "local.gguf").is_err());
        let original = prepare(dir.path(), "local.gguf").unwrap();
        assert_eq!(original.path, path.canonicalize().unwrap());
        original.revalidate().unwrap();
        prepared(dir.path(), "local.gguf")
            .unwrap()
            .revalidate()
            .unwrap();
        let pin: LocalPin =
            serde_json::from_slice(&std::fs::read(pin_path(&path, "local.gguf")).unwrap()).unwrap();
        assert_eq!(pin.sha256, format!("{:x}", Sha256::digest(gguf(&[]))));
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        assert!(original.revalidate().is_err());
        assert!(prepared(dir.path(), "local.gguf").is_err());
        let updated = prepare(dir.path(), "local.gguf").unwrap();
        updated.revalidate().unwrap();
        prepared(dir.path(), "local.gguf")
            .unwrap()
            .revalidate()
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(updated.revalidate().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_prepared_model_is_detected_even_with_identical_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_model(dir.path(), "local.gguf", &gguf(&[]));
        let original = prepare(dir.path(), "local.gguf").unwrap();
        let mut replacement = tempfile::NamedTempFile::new_in(path.parent().unwrap()).unwrap();
        replacement.write_all(&gguf(&[])).unwrap();
        replacement.persist(&path).unwrap();
        assert!(original.revalidate().is_err());
        assert!(prepared(dir.path(), "local.gguf").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linked_models_and_folder_components_are_refused() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let external_model = outside.path().join("external.gguf");
        std::fs::write(&external_model, gguf(&[])).unwrap();
        let folder = model_directory(dir.path()).unwrap();
        symlink(&external_model, folder.join("linked.gguf")).unwrap();
        assert!(validate_selection(dir.path(), "linked.gguf").is_err());
        assert!(prepare(dir.path(), "linked.gguf").is_err());
        assert_eq!(scan(dir.path()).unwrap().warnings.len(), 1);
        std::fs::create_dir(folder.join("directory.gguf")).unwrap();
        assert!(validate_selection(dir.path(), "directory.gguf").is_err());
        let folder_link_root = tempfile::tempdir().unwrap();
        std::fs::create_dir(folder_link_root.path().join("models")).unwrap();
        symlink(
            outside.path(),
            folder_link_root.path().join("models/translation"),
        )
        .unwrap();
        assert!(model_directory(folder_link_root.path()).is_err());
        let models_link_root = tempfile::tempdir().unwrap();
        symlink(outside.path(), models_link_root.path().join("models")).unwrap();
        assert!(model_directory(models_link_root.path()).is_err());
        let root_link = dir.path().join("linked-root");
        symlink(outside.path(), &root_link).unwrap();
        assert!(model_directory(&root_link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_refuses_linked_checksum_sidecars() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let path = write_model(dir.path(), "local.gguf", &gguf(&[]));
        prepare(dir.path(), "local.gguf").unwrap();
        let sidecar = pin_path(&path, "local.gguf");
        let original = std::fs::read(&sidecar).unwrap();
        let external = dir.path().join("external-pin.json");
        std::fs::write(&external, &original).unwrap();
        std::fs::remove_file(&sidecar).unwrap();
        symlink(&external, &sidecar).unwrap();
        assert!(prepared(dir.path(), "local.gguf").is_err());
        assert_eq!(std::fs::read(&external).unwrap(), original);
    }
}
