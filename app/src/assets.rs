//! Verified installation of CPU speech and selectable CPU/Vulkan translation.
//! Models are shared between backends. Each runtime archive has a fixed SHA256;
//! publisher metadata pins the exact model revision and digest before use.
use crate::{
    config::{ComputeBackend, InferenceSettings, PerformancePreset},
    translation_models,
};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[path = "macos_runtime.rs"]
mod macos_runtime;

const WHISPER_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip";
const WHISPER_VULKAN_SHA: &str = "e79d089e9c57a5e2f30cf04fb0eb7ba4462e0b6d1cd2e270fb8c2b0a84a6bf36";

fn whisper_runtime(backend: ComputeBackend) -> (&'static str, &'static str, &'static str) {
    if cfg!(windows) && backend == ComputeBackend::Vulkan {
        ("whisper-vulkan", "", WHISPER_VULKAN_SHA)
    } else {
        ("whisper", WHISPER_URL, WHISPER_SHA)
    }
}

const WHISPER_SHA: &str = "0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9";
const LLAMA_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b8500/llama-b8500-bin-win-cpu-x64.zip";
const LLAMA_SHA: &str = "a23f493d8dd06de7032af0630f609b0356e7505c6597aa0bcfa06a632f6c2777";
const VULKAN_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b8500/llama-b8500-bin-win-vulkan-x64.zip";
const VULKAN_SHA: &str = "7504827944922c8cb417e7413e8b9dc83780956e002b995632148e2467645229";
const WHISPER_REPO: &str = "ggerganov/whisper.cpp";
const LLAMA_REPO: &str = "Qwen/Qwen2.5-1.5B-Instruct-GGUF";
const LLAMA_FILE: &str = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
fn model_specs(settings: &InferenceSettings) -> Vec<(&'static str, &'static str)> {
    let translation = match settings.performance {
        PerformancePreset::Low => (
            "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
            "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        ),
        _ => (LLAMA_REPO, LLAMA_FILE),
    };
    let mut models = vec![(WHISPER_REPO, settings.whisper_model.filename())];
    if settings.translation_model.is_none() {
        models.push(translation);
    }
    models
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub phase: String,
    pub detail: String,
    pub progress: f32,
}

#[derive(Clone)]
pub struct AssetManager {
    pub root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Provenance {
    repository: String,
    revision: String,
    filename: String,
    sha256: String,
}

fn translation_runtime(backend: ComputeBackend) -> (&'static str, &'static str, &'static str) {
    match backend {
        ComputeBackend::Cpu => ("llama", LLAMA_URL, LLAMA_SHA),
        ComputeBackend::Vulkan => ("llama-vulkan", VULKAN_URL, VULKAN_SHA),
        // macOS ships one native llama-server with both CPU and Metal support.
        // Its bytes are checked against the embedded bundle manifest below.
        ComputeBackend::Metal => ("llama", LLAMA_URL, LLAMA_SHA),
    }
}

fn validate_platform_backend(backend: ComputeBackend) -> Result<()> {
    if cfg!(target_os = "macos") && !cfg!(target_arch = "aarch64") {
        bail!("macOS 版本目前需要 Apple Silicon（M 系列）晶片");
    }
    if backend == ComputeBackend::Metal && !cfg!(all(target_os = "macos", target_arch = "aarch64"))
    {
        bail!("Apple Metal 翻譯只支援 Apple Silicon macOS 版本");
    }
    if backend == ComputeBackend::Vulkan && cfg!(target_os = "macos") {
        bail!("macOS 請選擇 CPU 或 Apple Metal 翻譯，不使用 Windows Vulkan 引擎");
    }
    Ok(())
}
fn download_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .https_only(true)
        .user_agent("LiveSub/0.2 (+local CPU and Vulkan subtitles)")
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(7200))
        .build()?)
}

impl AssetManager {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn runtime_root(&self) -> PathBuf {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            // Preparation/verification reports an invalid bundle before execution.
            // Never substitute mutable user-data runtimes for missing app assets.
            macos_runtime::bundle_root()
                .unwrap_or_else(|_| self.root.join("missing-macos-app-bundle"))
        } else {
            self.root.join("runtime")
        }
    }
    pub fn whisper_binary(&self, backend: ComputeBackend) -> PathBuf {
        self.runtime_root()
            .join(whisper_runtime(backend).0)
            .join(if cfg!(windows) {
                "whisper-server.exe"
            } else {
                "whisper-server"
            })
    }
    pub fn llama_binary(&self, backend: ComputeBackend) -> PathBuf {
        self.runtime_root()
            .join(translation_runtime(backend).0)
            .join(if cfg!(windows) {
                "llama-server.exe"
            } else {
                "llama-server"
            })
    }
    pub fn whisper_model(&self, settings: &InferenceSettings) -> PathBuf {
        self.root.join("models").join(model_specs(settings)[0].1)
    }
    pub fn llama_model(&self, settings: &InferenceSettings) -> Result<PathBuf> {
        if let Some(filename) = &settings.translation_model {
            return Ok(translation_models::prepared(&self.root, filename)?.path);
        }
        Ok(self.root.join("models").join(model_specs(settings)[1].1))
    }

    /// Device discovery prepares an engine without downloading either model.
    pub async fn prepare_gpu_runtime_for_backend<F>(
        &self,
        backend: ComputeBackend,
        progress: F,
    ) -> Result<()>
    where
        F: Fn(String, f64) + Send + Sync,
    {
        validate_platform_backend(backend)?;
        if backend == ComputeBackend::Cpu {
            bail!("CPU 模式沒有顯卡裝置可偵測");
        }
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            progress("驗證程式內建的 Apple Metal 翻譯引擎".into(), 0.0);
            self.verify_gpu_runtime_for_backend(backend).await?;
            progress("Apple Metal 翻譯引擎已驗證".into(), 1.0);
            return Ok(());
        }
        if cfg!(windows) {
            let client = download_client()?;
            self.install_runtime(
                &client,
                "llama-vulkan",
                VULKAN_URL,
                VULKAN_SHA,
                |fraction| {
                    progress("下載及驗證 Vulkan 顯卡翻譯引擎".into(), f64::from(fraction));
                },
            )
            .await?;
        } else if !self.llama_binary(ComputeBackend::Vulkan).is_file() {
            bail!("Linux 開發請先把支援 Vulkan 的官方 llama-server 放進資料目錄 runtime/llama-vulkan；Windows 版本會自動安裝。");
        }
        self.verify_gpu_runtime_for_backend(backend).await
    }

    /// This validates executable bytes independently of the model files.
    pub async fn verify_gpu_runtime_for_backend(&self, backend: ComputeBackend) -> Result<()> {
        validate_platform_backend(backend)?;
        if backend == ComputeBackend::Cpu {
            bail!("CPU 模式沒有顯卡裝置可偵測");
        }
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                macos_runtime::verify_embedded()?;
            } else if cfg!(windows) {
                let archive = root.join("downloads/llama-vulkan.zip");
                verify_file(&archive, VULKAN_SHA)?;
                verify_extracted(&archive, &root.join("runtime/llama-vulkan"))?;
            }
            Ok(())
        })
        .await?
    }

    async fn install_runtime<F>(
        &self,
        client: &reqwest::Client,
        name: &str,
        url: &str,
        sha: &str,
        progress: F,
    ) -> Result<()>
    where
        F: Fn(f32),
    {
        std::fs::create_dir_all(self.root.join("downloads"))?;
        let archive = self.root.join("downloads").join(format!("{name}.zip"));
        if name == "whisper-vulkan" {
            if verify_file(&archive, sha).is_err() {
                let bundled = std::env::current_exe()?.with_file_name("whisper-vulkan.zip");
                verify_file(&bundled, sha)
                    .context("請把試用版隨附的 whisper-vulkan.zip 放回執行檔旁")?;
                write_atomic(&archive, &std::fs::read(bundled)?)?;
            }
            progress(1.0);
        } else {
            download(client, url, &archive, sha, progress).await?;
        }
        let output = self.root.join("runtime").join(name);
        // Re-extract the verified archive before use, replacing incomplete files.
        tokio::task::spawn_blocking(move || extract_flat(&archive, &output)).await??;
        Ok(())
    }

    pub async fn prepare<F>(&self, settings: &InferenceSettings, progress: F) -> Result<()>
    where
        F: Fn(String, f64) + Send + Sync,
    {
        self.prepare_with_progress(settings, |p| progress(p.detail, f64::from(p.progress)))
            .await
    }

    async fn prepare_with_progress<F>(
        &self,
        settings: &InferenceSettings,
        progress: F,
    ) -> Result<()>
    where
        F: Fn(Progress) + Send + Sync,
    {
        settings.validate()?;
        validate_platform_backend(settings.backend)?;
        if let Some(filename) = &settings.translation_model {
            translation_models::validate_selection(&self.root, filename)?;
        }
        std::fs::create_dir_all(self.root.join("models"))?;
        std::fs::create_dir_all(self.root.join("downloads"))?;
        let client = download_client()?;
        let (llama_name, llama_url, llama_sha) = translation_runtime(settings.backend);
        let (whisper_name, whisper_url, whisper_sha) = whisper_runtime(settings.backend);
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            progress(Progress {
                phase: "verifying".into(),
                detail: "驗證程式內建的 Apple Silicon 語音與翻譯引擎".into(),
                progress: 0.0,
            });
            tokio::task::spawn_blocking(macos_runtime::verify_embedded).await??;
        } else if cfg!(windows) {
            for (index, name, url, sha, destination) in [
                (0, "語音引擎", whisper_url, whisper_sha, whisper_name),
                (
                    1,
                    if settings.backend == ComputeBackend::Vulkan {
                        "Vulkan 顯卡翻譯引擎"
                    } else {
                        "CPU 翻譯引擎"
                    },
                    llama_url,
                    llama_sha,
                    llama_name,
                ),
            ] {
                self.install_runtime(&client, destination, url, sha, |fraction| {
                    progress(Progress {
                        phase: "downloading".into(),
                        detail: format!("下載及驗證{name}"),
                        progress: (index as f32 + fraction) / 4.0,
                    });
                })
                .await?;
            }
        } else if !self.whisper_binary(settings.backend).is_file()
            || !self.llama_binary(settings.backend).is_file()
        {
            bail!("自動安裝支援 Windows x64。Linux 開發請先將官方 whisper-server 放進 runtime/whisper，並將對應 CPU 或 Vulkan 的 llama-server 放進 runtime/{llama_name}。");
        }
        for (offset, (repo, filename)) in model_specs(settings).into_iter().enumerate() {
            let index = offset + 2;
            progress(Progress {
                phase: "downloading".into(),
                detail: format!("取得 {filename} 的官方校驗資料"),
                progress: index as f32 / 4.0,
            });
            let manifest_path = self.root.join("models").join(format!("{filename}.json"));
            let meta = if manifest_path.is_file() {
                let existing: Provenance = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
                validate_provenance(&existing, repo, filename)?;
                existing
            } else {
                resolve_model(&client, repo, filename).await?
            };
            let url = format!(
                "https://huggingface.co/{repo}/resolve/{}/{filename}",
                meta.revision
            );
            let target = self.root.join("models").join(filename);
            download(&client, &url, &target, &meta.sha256, |fraction| {
                progress(Progress {
                    phase: "downloading".into(),
                    detail: format!("下載及驗證 {filename}"),
                    progress: (index as f32 + fraction) / 4.0,
                });
            })
            .await?;
            write_atomic(&manifest_path, &serde_json::to_vec_pretty(&meta)?)?;
        }
        if let Some(filename) = settings.translation_model.clone() {
            progress(Progress {
                phase: "verifying".into(),
                detail: format!("驗證使用者提供的本機模型 {filename}"),
                progress: 0.95,
            });
            let root = self.root.clone();
            tokio::task::spawn_blocking(move || translation_models::prepare(&root, &filename))
                .await??;
        }
        self.verify_models(settings).await?;
        write_atomic(
            &self.root.join("installed.json"),
            &serde_json::to_vec(
                &serde_json::json!({"whisper": if whisper_name == "whisper-vulkan" {"v1.9.5-vulkan"} else {"v1.7.6"},"llama":"b8500","translation_backend":settings.backend}),
            )?,
        )?;
        progress(Progress {
            phase: "loading".into(),
            detail: "模型下載完成，正在載入本機引擎".into(),
            progress: 1.0,
        });
        Ok(())
    }

    pub async fn verify_models(&self, settings: &InferenceSettings) -> Result<()> {
        settings.validate()?;
        validate_platform_backend(settings.backend)?;
        let root = self.root.clone();
        let backend = settings.backend;
        let models = model_specs(settings);
        let custom_model = settings.translation_model.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            if let Some(filename) = custom_model {
                translation_models::prepared(&root, &filename)?;
            }
            for (repo, file) in models {
                let p = root.join("models").join(file);
                let meta: Provenance = serde_json::from_slice(
                    &std::fs::read(p.with_file_name(format!("{file}.json")))
                        .with_context(|| format!("缺少 {file} 校驗資料，請重新準備模型"))?,
                )?;
                validate_provenance(&meta, repo, file)?;
                verify_file(&p, &meta.sha256)?;
            }
            if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                macos_runtime::verify_embedded()?;
            } else if cfg!(windows) {
                let (name, _, sha) = translation_runtime(backend);
                let (whisper_name, _, whisper_sha) = whisper_runtime(backend);
                for (name, sha) in [(whisper_name, whisper_sha), (name, sha)] {
                    let archive = root.join("downloads").join(format!("{name}.zip"));
                    verify_file(&archive, sha)?;
                    verify_extracted(&archive, &root.join("runtime").join(name))?;
                }
            }
            Ok(())
        })
        .await?
    }
}

fn validate_provenance(p: &Provenance, repo: &str, filename: &str) -> Result<()> {
    if p.repository != repo
        || p.filename != filename
        || p.revision.len() != 40
        || !p.revision.bytes().all(|c| c.is_ascii_hexdigit())
        || p.sha256.len() != 64
        || !p.sha256.bytes().all(|c| c.is_ascii_hexdigit())
    {
        bail!("模型校驗資料格式不正確，請移除損壞的模型資料後重新準備");
    }
    Ok(())
}

async fn resolve_model(client: &reqwest::Client, repo: &str, filename: &str) -> Result<Provenance> {
    let url = format!("https://huggingface.co/api/models/{repo}/revision/main?blobs=true");
    let response = client
        .get(url)
        .send()
        .await
        .context("無法連接 Hugging Face，請檢查網路及防火牆")?
        .error_for_status()?;
    let meta: serde_json::Value = response.json().await?;
    let sha = meta["siblings"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["rfilename"].as_str() == Some(filename)))
        .and_then(|f| f["lfs"]["sha256"].as_str())
        .ok_or_else(|| anyhow!("官方模型未提供 SHA256，已停止安裝，沒有略過驗證"))?;
    let p = Provenance {
        repository: repo.into(),
        revision: meta["sha"].as_str().context("官方模型缺少 commit")?.into(),
        filename: filename.into(),
        sha256: sha.into(),
    };
    validate_provenance(&p, repo, filename)?;
    Ok(p)
}

async fn download<F: Fn(f32)>(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    sha: &str,
    progress: F,
) -> Result<()> {
    let existing = destination.to_owned();
    let digest = sha.to_owned();
    if destination.is_file()
        && tokio::task::spawn_blocking(move || verify_file(&existing, &digest).is_ok()).await?
    {
        progress(1.0);
        return Ok(());
    }
    let part = destination.with_extension("part");
    let mut response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("下載失敗：{url}"))?
        .error_for_status()?;
    let total = response.content_length().unwrap_or(0);
    if total > 4_000_000_000 {
        bail!("下載檔案超過預期大小");
    }
    let mut output = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = response.chunk().await? {
        received += chunk.len() as u64;
        if received > 4_000_000_000 {
            bail!("下載檔案超過預期大小");
        }
        output.write_all(&chunk)?;
        hasher.update(&chunk);
        progress(if total == 0 {
            0.0
        } else {
            (received as f32 / total as f32).min(0.99)
        });
    }
    output.sync_all()?;
    drop(output);
    if format!("{:x}", hasher.finalize()) != sha {
        let _ = std::fs::remove_file(&part);
        bail!(
            "下載 SHA256 校驗不符，已拒絕使用該檔案：{}",
            destination.display()
        );
    }
    if destination.exists() {
        std::fs::remove_file(destination)?;
    }
    std::fs::rename(&part, destination)?;
    progress(1.0);
    Ok(())
}

fn verify_file(path: &Path, sha: &str) -> Result<()> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    if format!("{:x}", h.finalize()) != sha {
        bail!("檔案校驗失敗：{}，請重新準備模型", path.display());
    }
    Ok(())
}

fn extract_flat(archive: &Path, output: &Path) -> Result<()> {
    std::fs::create_dir_all(output)?;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    let mut names = std::collections::HashSet::new();
    let mut expanded = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let safe = entry
            .enclosed_name()
            .context("不安全的 ZIP 路徑")?
            .to_path_buf();
        let name = safe.file_name().context("ZIP 缺少檔名")?.to_os_string();
        if entry
            .unix_mode()
            .map(|m| m & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            bail!("ZIP 包含不允許的連結");
        }
        if !names.insert(name.clone()) {
            bail!("ZIP 包含重複檔名");
        }
        expanded += entry.size();
        if expanded > 2_000_000_000 {
            bail!("ZIP 解壓縮大小超出限制");
        }
        let path = output.join(name);
        let mut f = std::fs::File::create(path)?;
        std::io::copy(&mut entry, &mut f)?;
    }
    Ok(())
}

fn verify_extracted(archive: &Path, output: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let path = entry
            .enclosed_name()
            .context("不安全的 ZIP 路徑")?
            .to_path_buf();
        let path = output.join(path.file_name().context("ZIP 檔名錯誤")?);
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = entry.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        verify_file(&path, &format!("{:x}", hasher.finalize()))?;
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let part = path.with_extension("json.part");
    std::fs::write(&part, bytes)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(part, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backends_keep_separate_runtimes_and_share_models() {
        let assets = AssetManager::new(PathBuf::from("data"));
        let cpu = assets.llama_binary(ComputeBackend::Cpu);
        let vulkan = assets.llama_binary(ComputeBackend::Vulkan);
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(cpu, assets.llama_binary(ComputeBackend::Metal));
            assert!(cpu.ends_with("llama/llama-server"));
        } else {
            assert!(cpu.starts_with("data/runtime/llama"));
            assert!(vulkan.starts_with("data/runtime/llama-vulkan"));
        }
        assert_ne!(cpu, vulkan);
        assert_eq!(
            assets.llama_model(&InferenceSettings::default()).unwrap(),
            PathBuf::from("data/models").join(LLAMA_FILE)
        );
        assert_eq!(translation_runtime(ComputeBackend::Cpu).2, LLAMA_SHA);
        assert_eq!(translation_runtime(ComputeBackend::Vulkan).2, VULKAN_SHA);
        assert_ne!(LLAMA_SHA, VULKAN_SHA);
    }
    #[test]
    fn only_selected_model_variants_are_used_without_changing_cached_paths() {
        let assets = AssetManager::new(PathBuf::from("data"));
        let low = InferenceSettings::recommended(PerformancePreset::Low);
        let high = InferenceSettings::recommended(PerformancePreset::High);
        assert!(assets.whisper_model(&low).ends_with("ggml-tiny.bin"));
        assert!(assets
            .llama_model(&low)
            .unwrap()
            .ends_with("qwen2.5-0.5b-instruct-q4_k_m.gguf"));
        assert!(assets.whisper_model(&high).ends_with("ggml-small.bin"));
        assert_eq!(
            assets.llama_model(&high).unwrap(),
            assets.llama_model(&InferenceSettings::default()).unwrap()
        );
        assert!(assets
            .whisper_model(&InferenceSettings::default())
            .ends_with("ggml-small.bin"));
    }
    #[test]
    fn custom_selection_never_requests_a_builtin_qwen_download() {
        for performance in [
            PerformancePreset::Low,
            PerformancePreset::Balanced,
            PerformancePreset::High,
        ] {
            let mut settings = InferenceSettings::recommended(performance);
            assert_eq!(model_specs(&settings).len(), 2);
            settings.translation_model = Some("local.gguf".into());
            assert_eq!(
                model_specs(&settings),
                vec![(WHISPER_REPO, settings.whisper_model.filename())]
            );
        }
    }
    #[tokio::test]
    async fn custom_verification_uses_local_snapshot_and_preserves_official_whisper_checks() {
        let dir = tempfile::tempdir().unwrap();
        let settings = InferenceSettings {
            translation_model: Some("local.gguf".into()),
            ..InferenceSettings::default()
        };
        let model_dir = translation_models::model_directory(dir.path()).unwrap();
        let mut gguf = Vec::from(&b"GGUF"[..]);
        gguf.extend_from_slice(&3u32.to_le_bytes());
        gguf.extend_from_slice(&1u64.to_le_bytes());
        gguf.extend_from_slice(&0u64.to_le_bytes());
        gguf.extend_from_slice(&1u64.to_le_bytes());
        gguf.extend_from_slice(b"w");
        gguf.extend_from_slice(&1u32.to_le_bytes());
        gguf.extend_from_slice(&1u64.to_le_bytes());
        gguf.extend_from_slice(&0u32.to_le_bytes());
        gguf.extend_from_slice(&0u64.to_le_bytes());
        gguf.resize(68, 0);
        std::fs::write(model_dir.join("local.gguf"), gguf).unwrap();
        let assets = AssetManager::new(dir.path().to_owned());
        assert!(assets.llama_model(&settings).is_err());
        translation_models::prepare(dir.path(), "local.gguf").unwrap();
        assert_eq!(
            assets.llama_model(&settings).unwrap(),
            model_dir.join("local.gguf")
        );
        let whisper = assets.whisper_model(&settings);
        std::fs::write(&whisper, b"official whisper fixture").unwrap();
        let provenance = Provenance {
            repository: WHISPER_REPO.into(),
            revision: "0".repeat(40),
            filename: settings.whisper_model.filename().into(),
            sha256: format!("{:x}", Sha256::digest(b"official whisper fixture")),
        };
        std::fs::write(
            whisper.with_file_name(format!("{}.json", settings.whisper_model.filename())),
            serde_json::to_vec(&provenance).unwrap(),
        )
        .unwrap();
        // Native macOS engines must be verified from an actual app bundle;
        // this isolated model fixture intentionally has no bundled runtime.
        if !cfg!(any(windows, target_os = "macos")) {
            assets.verify_models(&settings).await.unwrap();
            assert!(!dir.path().join("models").join(LLAMA_FILE).exists());
            std::fs::write(&whisper, b"tampered").unwrap();
            assert!(assets.verify_models(&settings).await.is_err());
        }
        std::fs::remove_file(model_dir.join("local.gguf")).unwrap();
        assert!(assets.llama_model(&settings).is_err());
        assert!(assets.verify_models(&settings).await.is_err());
    }
    #[test]
    fn digest_mismatch_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("model");
        std::fs::write(&file, b"abc").unwrap();
        assert!(verify_file(
            &file,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        .is_ok());
        assert!(verify_file(&file, &"0".repeat(64)).is_err());
    }
    #[test]
    fn provenance_rejects_path_and_revision_injection() {
        let p = Provenance {
            repository: WHISPER_REPO.into(),
            filename: "../model".into(),
            revision: "main".into(),
            sha256: "0".repeat(64),
        };
        assert!(validate_provenance(&p, WHISPER_REPO, "ggml-base.bin").is_err());
    }
    fn archive_at(path: &Path, names: &[&str]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for name in names {
            z.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"official data").unwrap();
        }
        z.finish().unwrap();
    }
    #[test]
    fn archive_cannot_escape_directory_or_clobber_duplicate_names() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.zip");
        archive_at(&a, &["../escape.exe"]);
        assert!(extract_flat(&a, &dir.path().join("out")).is_err());
        assert!(!dir.path().join("escape.exe").exists());
        archive_at(&a, &["Release/worker.dll", "worker.dll"]);
        assert!(extract_flat(&a, &dir.path().join("out")).is_err());
    }
    #[test]
    fn extracted_runtime_tampering_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.zip");
        let out = dir.path().join("out");
        archive_at(&a, &["Release/worker.exe"]);
        extract_flat(&a, &out).unwrap();
        verify_extracted(&a, &out).unwrap();
        std::fs::write(out.join("worker.exe"), b"altered").unwrap();
        assert!(verify_extracted(&a, &out).is_err());
    }
    #[tokio::test]
    async fn download_rejects_corrupt_response_without_installing_it() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("model.bin");
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
                .unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert!(download(
            &client,
            &format!("http://{address}/model"),
            &target,
            &"0".repeat(64),
            |_| {}
        )
        .await
        .is_err());
        worker.join().unwrap();
        assert!(!target.exists());
        assert!(!target.with_extension("part").exists());
    }
}
