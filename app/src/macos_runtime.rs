//! Validate the native runtime shipped inside the Apple Silicon application.
//! The manifest is embedded in the Rust executable, not read from mutable data.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    files: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    sha256: String,
    size_bytes: u64,
}

pub fn root_from_executable(executable: &Path) -> Result<PathBuf> {
    let macos = executable.parent().context("macOS 程式路徑無效")?;
    let contents = macos.parent().context("macOS 程式套件路徑無效")?;
    let app = contents.parent().context("macOS 程式套件路徑無效")?;
    if macos.file_name().and_then(|n| n.to_str()) != Some("MacOS")
        || contents.file_name().and_then(|n| n.to_str()) != Some("Contents")
        || app.extension().and_then(|n| n.to_str()) != Some("app")
    {
        bail!("請從完整的 V-Translate.app 開啟，不能單獨搬移其內的執行檔");
    }
    Ok(contents.join("Resources/runtime"))
}

pub fn bundle_root() -> Result<PathBuf> {
    root_from_executable(&std::env::current_exe().context("無法取得 macOS 程式位置")?)
}

pub fn verify_embedded() -> Result<()> {
    verify(
        &bundle_root()?,
        include_bytes!(concat!(env!("OUT_DIR"), "/macos-runtime-manifest.json")),
    )
}

fn safe_path(value: &str) -> bool {
    let Some((folder, filename)) = value.split_once('/') else {
        return false;
    };
    matches!(folder, "whisper" | "llama")
        && !filename.is_empty()
        && value.len() <= 160
        && !filename.starts_with('.')
        && filename
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn ordinary(path: &Path, directory: bool) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).with_context(|| {
        format!(
            "macOS 內建引擎檔案缺失：{}，請重新下載完整程式",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        bail!("macOS 內建引擎不允許連結或非一般檔案：{}", path.display());
    }
    Ok(metadata)
}

fn verify(root: &Path, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > 128 * 1024 {
        bail!("macOS 程式未包含有效的內建引擎校驗資料，請重新下載完整程式");
    }
    let manifest: Manifest = serde_json::from_slice(bytes).context("macOS 引擎校驗資料格式無效")?;
    if manifest.format_version != 1 || manifest.files.is_empty() || manifest.files.len() > 256 {
        bail!("macOS 引擎校驗資料版本或檔案數量無效");
    }
    ordinary(root, true)?;
    let mut expected = HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        if !safe_path(&entry.path)
            || !expected.insert(entry.path.clone())
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || entry.size_bytes == 0
            || entry.size_bytes > 512 * 1024 * 1024
        {
            bail!("macOS 引擎校驗資料包含無效路徑、重複檔案或大小");
        }
        total = total
            .checked_add(entry.size_bytes)
            .context("macOS 引擎大小無效")?;
        if total > 1024 * 1024 * 1024 {
            bail!("macOS 引擎總大小超過限制");
        }
        let path = root.join(&entry.path);
        ordinary(path.parent().unwrap(), true)?;
        let metadata = ordinary(&path, false)?;
        if metadata.len() != entry.size_bytes {
            bail!("macOS 內建引擎大小校驗失敗：{}", entry.path);
        }
        let mut file = fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut header = Vec::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if header.is_empty() {
                header.extend_from_slice(&buffer[..count.min(32)]);
            }
            hasher.update(&buffer[..count]);
        }
        if !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&entry.sha256) {
            bail!(
                "macOS 內建引擎 SHA256 校驗失敗：{}，請重新下載完整程式",
                entry.path
            );
        }
        let executable = matches!(
            entry.path.as_str(),
            "whisper/whisper-server" | "llama/llama-server"
        );
        if executable || entry.path.ends_with(".dylib") {
            let kind = if executable { 2u32 } else { 6u32 };
            if header.len() < 32
                || header[..4] != [0xcf, 0xfa, 0xed, 0xfe]
                || u32::from_le_bytes(header[4..8].try_into().unwrap()) != 0x0100_000c
                || u32::from_le_bytes(header[12..16].try_into().unwrap()) != kind
            {
                bail!("macOS 引擎不是原生 Apple Silicon 執行檔：{}", entry.path);
            }
            #[cfg(unix)]
            if executable {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    bail!("macOS 引擎沒有執行權限：{}", entry.path);
                }
            }
        } else if !(entry.path.ends_with(".metal") || entry.path.ends_with(".metallib")) {
            bail!("macOS 引擎含不支援的資源檔案：{}", entry.path);
        }
    }
    for server in ["whisper/whisper-server", "llama/llama-server"] {
        if !expected.contains(server) {
            bail!("macOS 程式缺少必要引擎：{server}");
        }
    }
    let mut actual = HashSet::new();
    for directory in fs::read_dir(root)? {
        let directory = directory?;
        let name = directory
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("macOS 引擎目錄名稱無效"))?;
        if !matches!(name.as_str(), "whisper" | "llama") {
            bail!("macOS 引擎包含未列出的目錄或檔案");
        }
        ordinary(&directory.path(), true)?;
        for file in fs::read_dir(directory.path())? {
            let file = file?;
            ordinary(&file.path(), false)?;
            let filename = file
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("macOS 引擎檔名無效"))?;
            actual.insert(format!("{name}/{filename}"));
        }
    }
    if actual != expected {
        bail!("macOS 引擎包含缺失或未列入校驗的檔案，請重新下載完整程式");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path) -> Vec<u8> {
        let mut files = Vec::new();
        for name in [
            "whisper/whisper-server",
            "llama/llama-server",
            "llama/libggml-metal.dylib",
        ] {
            let file = root.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            let mut bytes = vec![0u8; 40];
            bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
            bytes[4..8].copy_from_slice(&0x0100_000cu32.to_le_bytes());
            bytes[12..16].copy_from_slice(
                &(if name.ends_with(".dylib") { 6u32 } else { 2u32 }).to_le_bytes(),
            );
            fs::write(&file, &bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
            }
            files.push(serde_json::json!({"path":name,"sha256":format!("{:x}",Sha256::digest(&bytes)),"size_bytes":bytes.len()}));
        }
        serde_json::to_vec(&serde_json::json!({"format_version":1,"files":files})).unwrap()
    }
    #[test]
    fn app_paths_are_independent_of_working_directory_and_data_folder() {
        assert_eq!(
            root_from_executable(Path::new(
                "/Applications/V-Translate.app/Contents/MacOS/V-Translate"
            ))
            .unwrap(),
            PathBuf::from("/Applications/V-Translate.app/Contents/Resources/runtime")
        );
        assert!(root_from_executable(Path::new("/tmp/livesub")).is_err());
    }
    #[test]
    fn verified_arm64_bundle_rejects_tampering_missing_files_and_unlisted_libraries() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let manifest = fixture(root);
        verify(root, &manifest).unwrap();
        fs::write(root.join("llama/injected.dylib"), b"unexpected").unwrap();
        assert!(verify(root, &manifest).is_err());
        fs::remove_file(root.join("llama/injected.dylib")).unwrap();
        fs::write(root.join("llama/llama-server"), b"tampered").unwrap();
        assert!(verify(root, &manifest).is_err());
        fs::remove_file(root.join("llama/llama-server")).unwrap();
        assert!(verify(root, &manifest).is_err());
    }
    #[test]
    fn manifests_reject_traversal_duplicate_files_and_wrong_architecture() {
        let directory = tempfile::tempdir().unwrap();
        let manifest = fixture(directory.path());
        let mut value: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
        value["files"][0]["path"] = "../escape".into();
        assert!(verify(directory.path(), &serde_json::to_vec(&value).unwrap()).is_err());
        let mut value: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
        let duplicate = value["files"][0].clone();
        value["files"].as_array_mut().unwrap().push(duplicate);
        assert!(verify(directory.path(), &serde_json::to_vec(&value).unwrap()).is_err());
        let file = directory.path().join("whisper/whisper-server");
        let mut bytes = fs::read(&file).unwrap();
        bytes[4..8].copy_from_slice(&0x0100_0007u32.to_le_bytes());
        fs::write(file, &bytes).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
        value["files"][0]["sha256"] = format!("{:x}", Sha256::digest(&bytes)).into();
        assert!(verify(directory.path(), &serde_json::to_vec(&value).unwrap()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn runtime_symlinks_and_missing_execute_permissions_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let manifest = fixture(directory.path());
        let file = directory.path().join("llama/llama-server");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(verify(directory.path(), &manifest).is_err());
        fs::remove_file(&file).unwrap();
        symlink(directory.path().join("whisper/whisper-server"), file).unwrap();
        assert!(verify(directory.path(), &manifest).is_err());
    }
}
