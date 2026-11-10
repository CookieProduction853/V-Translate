//! A public, credential-free ad feed. Only verified raster bytes reach the UI.
use anyhow::{bail, Context, Result};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

pub const DEFAULT_FEED_URL: &str =
    "https://cookieproduction853.github.io/V-Translate/ads/manifest.json";
const VERSION_URL: &str = "https://cookieproduction853.github.io/V-Translate/version.json";
const MAX_ADS: usize = 32;
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 30 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 128 * 1024;

pub struct BundledAd {
    pub id: &'static str,
    pub image: &'static str,
    pub bytes: &'static [u8],
    pub sha256: &'static str,
    pub link_url: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkedAd {
    pub id: String,
    pub image_url: String,
    pub link_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdSnapshot {
    pub ads: Vec<LinkedAd>,
    pub state: &'static str,
    pub detail: String,
}

#[derive(Clone)]
pub struct AdImage {
    pub bytes: Bytes,
    pub content_type: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    ads: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    image: String,
    sha256: String,
    size_bytes: u64,
    link_url: String,
}

#[derive(Clone)]
struct Asset {
    entry: Entry,
    image: AdImage,
}

struct Current {
    assets: Vec<Asset>,
    state: &'static str,
    detail: String,
    show_update_ad: bool,
}

impl Current {
    fn visible_ads(&self) -> impl Iterator<Item = &Asset> {
        self.assets.iter().filter(move |asset| {
            self.show_update_ad
                || !Path::new(&asset.entry.image)
                    .file_stem()
                    .is_some_and(|stem| {
                        stem.eq_ignore_ascii_case("AD1") || stem.eq_ignore_ascii_case("AD 1")
                    })
        })
    }
}

pub struct AdsManager {
    root: PathBuf,
    feed_url: Option<String>,
    current: Mutex<Current>,
    refresh_started: AtomicBool,
}

impl AdsManager {
    /// Bad caches or unavailable feeds must never prevent the local AI starting.
    pub fn new(root: PathBuf, bundled: &[BundledAd]) -> Self {
        let feed = option_env!("VTRANSLATE_AD_FEED_URL").unwrap_or(DEFAULT_FEED_URL);
        Self::with_feed(
            root,
            bundled,
            (!feed.trim().is_empty() && !std::env::args().any(|arg| arg == "--no-network-updates"))
                .then(|| feed.to_owned()),
        )
    }

    fn with_feed(root: PathBuf, bundled: &[BundledAd], feed_url: Option<String>) -> Self {
        let fallback = load_bundle(bundled);
        let (assets, detail) = match load_cache(&root) {
            Ok(Some(assets)) => (assets, "使用已驗證的本機廣告快取".into()),
            Ok(None) => match fallback {
                Ok(assets) => (assets, "使用隨程式附帶的廣告".into()),
                Err(_) => (Vec::new(), "沒有可用的廣告，顯示合作預留版位".into()),
            },
            Err(_) => (
                fallback.unwrap_or_default(),
                "廣告快取無法驗證，使用隨程式附帶的廣告或預留版位".into(),
            ),
        };
        Self {
            root,
            current: Mutex::new(Current {
                assets,
                state: if feed_url.is_some() {
                    "checking"
                } else {
                    "unconfigured"
                },
                detail,
                show_update_ad: false,
            }),
            feed_url,
            refresh_started: AtomicBool::new(false),
        }
    }

    pub fn snapshot(&self) -> AdSnapshot {
        let current = self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        AdSnapshot {
            ads: current
                .visible_ads()
                .map(|asset| LinkedAd {
                    id: asset.entry.id.clone(),
                    image_url: format!("/ad-assets/{}", asset.entry.sha256.to_ascii_lowercase()),
                    link_url: asset.entry.link_url.clone(),
                })
                .collect(),
            state: current.state,
            detail: current.detail.clone(),
        }
    }

    pub fn image(&self, id: &str) -> Option<AdImage> {
        if !valid_id(id) {
            return None;
        }
        let current = self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let image = current
            .visible_ads()
            .find(|asset| asset.entry.sha256.eq_ignore_ascii_case(id) || asset.entry.id == id)
            .map(|asset| asset.image.clone());
        image
    }

    /// Called in a detached startup task, once per process. No audio, cookies,
    /// local API token, credentials, or user settings are attached to requests.
    pub async fn refresh(&self) {
        if self.refresh_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(feed) = &self.feed_url else {
            return;
        };
        let previous = self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .assets
            .clone();
        let (result, show_update_ad) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(20), fetch_feed(feed, &previous)),
            async { feed == DEFAULT_FEED_URL && check_update_ad().await.unwrap_or(false) },
        );
        let downloaded = match result {
            Ok(result) => result,
            Err(_) => Err(anyhow::anyhow!("公開廣告來源連線逾時")),
        };
        let result = match downloaded {
            Ok((manifest, assets)) => {
                let root = self.root.clone();
                let persisted = assets.clone();
                match tokio::task::spawn_blocking(move || {
                    publish_cache(&root, &manifest, &persisted)
                })
                .await
                {
                    Ok(Ok(())) => Ok(assets),
                    Ok(Err(error)) => Err(error),
                    Err(error) => Err(error.into()),
                }
            }
            Err(error) => Err(error),
        };
        let mut current = self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        current.show_update_ad = show_update_ad;
        match result {
            Ok(assets) => {
                current.assets = assets;
                current.state = "ready";
                current.detail = "已更新並驗證公開廣告素材".into();
            }
            Err(_) => {
                current.state = "offline";
                current.detail =
                    "公開廣告來源暫時無法更新，繼續使用已驗證的快取、隨附廣告或合作預留版位".into();
            }
        }
    }
}

fn is_outdated(installed: &str, latest: &str) -> bool {
    fn series(version: &str) -> Option<(u32, u32)> {
        let mut parts = version.split('.');
        let mut number = || {
            let part = parts.next()?;
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            part.parse::<u32>().ok()
        };
        let (major, minor, _) = (number()?, number()?, number()?);
        parts.next().is_none().then_some((major, minor))
    }
    matches!((series(installed), series(latest)), (Some(installed), Some(latest)) if installed < latest)
}

async fn check_update_ad() -> Result<bool> {
    #[derive(Deserialize)]
    struct PublishedVersion {
        version: String,
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(6))
        .build()?;
    let response = client.get(VERSION_URL).send().await?;
    let published: PublishedVersion =
        serde_json::from_slice(&response_bytes(response, 1024).await?)?;
    Ok(is_outdated(env!("CARGO_PKG_VERSION"), &published.version))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn https_url(value: &str) -> Result<reqwest::Url> {
    anyhow::ensure!(
        value == value.trim() && !value.chars().any(char::is_control),
        "廣告網址含有無效字元"
    );
    let url = reqwest::Url::parse(value).context("廣告網址格式不正確")?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "廣告網址必須使用不含登入資訊的 HTTPS"
    );
    Ok(url)
}

/// Read InternetShortcut as inert text; never ask Windows to open a .url file.
#[allow(dead_code)]
pub fn parse_shortcut(bytes: &[u8]) -> Result<String> {
    anyhow::ensure!(
        !bytes.is_empty() && bytes.len() <= 8192,
        ".url 檔案為空或超過大小限制"
    );
    let text = std::str::from_utf8(bytes)
        .context(".url 檔案必須使用 UTF-8")?
        .trim_start_matches('\u{feff}')
        .trim();
    if !text.contains(['\r', '\n']) && !text.starts_with('[') {
        https_url(text)?;
        return Ok(text.to_owned());
    }
    let mut in_shortcut = false;
    let mut result = None;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_shortcut = line.eq_ignore_ascii_case("[InternetShortcut]");
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("URL") {
                anyhow::ensure!(
                    in_shortcut && result.is_none(),
                    ".url 檔案含有重複或不明確的 URL"
                );
                let value = value.trim();
                https_url(value)?;
                result = Some(value.to_owned());
            }
        }
    }
    result.context(".url 檔案缺少 InternetShortcut URL")
}

fn image_extension(filename: &str) -> Result<&'static str> {
    anyhow::ensure!(
        !filename.is_empty()
            && filename.len() <= 240
            && !filename.starts_with('.')
            && filename == filename.trim()
            && !filename
                .chars()
                .any(|c| c.is_control() || "/\\:%?#<>\"|*".contains(c)),
        "廣告圖片必須是單一安全檔名"
    );
    match filename
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Ok("jpg"),
        "png" => Ok("png"),
        "webp" => Ok("webp"),
        _ => bail!("廣告只接受 JPEG、PNG 或 WebP 圖片"),
    }
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    anyhow::ensure!(
        manifest.format_version == 1 && manifest.ads.len() <= MAX_ADS,
        "廣告清單版本或數量不正確"
    );
    let mut ids = HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.ads {
        anyhow::ensure!(
            valid_id(&entry.id) && ids.insert(entry.id.to_ascii_lowercase()),
            "廣告 ID 無效或重複"
        );
        image_extension(&entry.image)?;
        https_url(&entry.link_url)?;
        anyhow::ensure!(
            entry.size_bytes > 0
                && entry.size_bytes <= MAX_IMAGE_BYTES
                && entry.sha256.len() == 64
                && entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "廣告圖片大小或 SHA256 不正確"
        );
        total = total
            .checked_add(entry.size_bytes)
            .context("廣告總大小溢出")?;
        anyhow::ensure!(total <= MAX_TOTAL_BYTES, "廣告總大小超過限制");
    }
    Ok(())
}

fn image_url(feed: &reqwest::Url, filename: &str) -> Result<reqwest::Url> {
    image_extension(filename)?;
    let image = feed.join(filename)?;
    anyhow::ensure!(
        image.origin() == feed.origin()
            && image.scheme() == "https"
            && image.username().is_empty()
            && image.password().is_none(),
        "廣告圖片必須與清單位於相同來源"
    );
    Ok(image)
}

fn verified_image(entry: &Entry, bytes: Bytes) -> Result<AdImage> {
    anyhow::ensure!(
        bytes.len() as u64 == entry.size_bytes && bytes.len() as u64 <= MAX_IMAGE_BYTES,
        "廣告圖片長度不符"
    );
    anyhow::ensure!(
        format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(&entry.sha256),
        "廣告圖片 SHA256 校驗不符"
    );
    let extension = image_extension(&entry.image)?;
    let content_type = match extension {
        "jpg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => "image/jpeg",
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        "webp"
            if bytes.len() >= 12
                && &bytes[..4] == b"RIFF"
                && &bytes[8..12] == b"WEBP"
                && u32::from_le_bytes(bytes[4..8].try_into()?) as usize + 8 == bytes.len() =>
        {
            "image/webp"
        }
        _ => bail!("廣告圖片內容不是宣告的點陣圖片格式"),
    };
    Ok(AdImage {
        bytes,
        content_type,
    })
}

fn load_bundle(bundled: &[BundledAd]) -> Result<Vec<Asset>> {
    let manifest = Manifest {
        format_version: 1,
        ads: bundled
            .iter()
            .map(|ad| Entry {
                id: ad.id.into(),
                image: ad.image.into(),
                sha256: ad.sha256.into(),
                size_bytes: ad.bytes.len() as u64,
                link_url: ad.link_url.into(),
            })
            .collect(),
    };
    validate_manifest(&manifest)?;
    manifest
        .ads
        .into_iter()
        .zip(bundled)
        .map(|(entry, ad)| {
            let image = verified_image(&entry, Bytes::from_static(ad.bytes))?;
            Ok(Asset { entry, image })
        })
        .collect()
}

async fn response_bytes(mut response: reqwest::Response, limit: u64) -> Result<Bytes> {
    anyhow::ensure!(response.status().is_success(), "公開廣告來源未回傳成功狀態");
    anyhow::ensure!(
        response.content_length().is_none_or(|size| size <= limit),
        "公開廣告回應超過大小限制"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            (bytes.len() as u64).saturating_add(chunk.len() as u64) <= limit,
            "公開廣告回應超過大小限制"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.into())
}

async fn fetch_feed(feed: &str, previous: &[Asset]) -> Result<(Manifest, Vec<Asset>)> {
    let feed = https_url(feed)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .user_agent(concat!(
            "V-Translate/",
            env!("CARGO_PKG_VERSION"),
            " public-ad-feed"
        ))
        .build()?;
    let bytes = response_bytes(client.get(feed.clone()).send().await?, MAX_MANIFEST_BYTES).await?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    validate_manifest(&manifest)?;
    let mut assets = Vec::new();
    for entry in &manifest.ads {
        let image = if let Some(existing) = previous.iter().find(|asset| {
            asset.entry.sha256.eq_ignore_ascii_case(&entry.sha256)
                && asset.entry.size_bytes == entry.size_bytes
        }) {
            verified_image(entry, existing.image.bytes.clone())?
        } else {
            let bytes = response_bytes(
                client.get(image_url(&feed, &entry.image)?).send().await?,
                entry.size_bytes,
            )
            .await?;
            verified_image(entry, bytes)?
        };
        assets.push(Asset {
            entry: entry.clone(),
            image,
        });
    }
    Ok((manifest, assets))
}

fn ordinary(metadata: &std::fs::Metadata) -> bool {
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

fn cache_directory(root: &Path, create: bool) -> Result<Option<PathBuf>> {
    let root = root.canonicalize()?;
    let directory = root.join("ads");
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => anyhow::ensure!(
            ordinary(&metadata) && metadata.is_dir(),
            "廣告快取不能是連結或重新解析點"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Ok(None);
            }
            std::fs::create_dir(&directory)?;
        }
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    anyhow::ensure!(
        ordinary(&metadata)
            && metadata.is_dir()
            && directory.canonicalize()?.parent() == Some(root.as_path()),
        "廣告快取路徑無效"
    );
    Ok(Some(directory))
}

fn read_local(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        ordinary(&metadata) && metadata.is_file() && metadata.len() <= limit,
        "廣告快取檔案無效或過大"
    );
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() as u64 <= limit, "廣告快取檔案過大");
    Ok(bytes)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachePointer {
    version: u32,
    generation: String,
}

fn valid_generation(generation: &str) -> bool {
    generation.len() == 32 && generation.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn load_cache(root: &Path) -> Result<Option<Vec<Asset>>> {
    let Some(directory) = cache_directory(root, false)? else {
        return Ok(None);
    };
    let pointer_path = directory.join("current.json");
    if !pointer_path.try_exists()? {
        return Ok(None);
    }
    let pointer: CachePointer = serde_json::from_slice(&read_local(&pointer_path, 1024)?)?;
    anyhow::ensure!(
        pointer.version == 1 && valid_generation(&pointer.generation),
        "廣告快取索引無效"
    );
    let generation = directory.join(pointer.generation);
    let metadata = std::fs::symlink_metadata(&generation)?;
    anyhow::ensure!(ordinary(&metadata) && metadata.is_dir(), "廣告快取目錄無效");
    let manifest: Manifest = serde_json::from_slice(&read_local(
        &generation.join("manifest.json"),
        MAX_MANIFEST_BYTES,
    )?)?;
    validate_manifest(&manifest)?;
    let mut assets = Vec::new();
    for entry in manifest.ads {
        let bytes = read_local(&generation.join(&entry.id), entry.size_bytes)?;
        let image = verified_image(&entry, bytes.into())?;
        assets.push(Asset { entry, image });
    }
    Ok(Some(assets))
}

fn publish_cache(root: &Path, manifest: &Manifest, assets: &[Asset]) -> Result<()> {
    validate_manifest(manifest)?;
    anyhow::ensure!(manifest.ads.len() == assets.len(), "廣告候選清單不完整");
    let directory = cache_directory(root, true)?.context("無法建立廣告快取")?;
    let candidate = tempfile::Builder::new()
        .prefix(".candidate-")
        .tempdir_in(&directory)?;
    for (entry, asset) in manifest.ads.iter().zip(assets) {
        anyhow::ensure!(entry.id == asset.entry.id, "廣告候選 ID 不符");
        verified_image(entry, asset.image.bytes.clone())?;
        let mut file = std::fs::File::create(candidate.path().join(&entry.id))?;
        file.write_all(&asset.image.bytes)?;
        file.sync_all()?;
    }
    let mut manifest_file = std::fs::File::create(candidate.path().join("manifest.json"))?;
    manifest_file.write_all(&serde_json::to_vec(manifest)?)?;
    manifest_file.sync_all()?;
    drop(manifest_file);
    let generation = format!("{:032x}", rand::random::<u128>());
    let generation_path = directory.join(&generation);
    std::fs::rename(candidate.path(), &generation_path)?;
    let pointer = CachePointer {
        version: 1,
        generation: generation.clone(),
    };
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(&serde_json::to_vec(&pointer)?)?;
    file.as_file().sync_all()?;
    if let Err(error) = file.persist(directory.join("current.json")) {
        let _ = std::fs::remove_dir_all(generation_path);
        return Err(error.into());
    }
    // Images are served from immutable Bytes snapshots, so deleting older disk
    // generations cannot break a response that is already in flight.
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let filename = entry.file_name();
            let Some(filename) = filename.to_str() else {
                continue;
            };
            if filename != generation && valid_generation(filename) {
                if let Ok(metadata) = std::fs::symlink_metadata(entry.path()) {
                    if ordinary(&metadata) && metadata.is_dir() {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn update_ad_requires_an_older_major_or_minor_series() {
        assert!(super::is_outdated("0.4.9", "0.5.9"));
        assert!(super::is_outdated("0.12.1", "1.0.0"));
        assert!(!super::is_outdated("0.5.8", "0.5.9"));
        assert!(!super::is_outdated("0.5.10", "0.5.9"));
        assert!(!super::is_outdated("0.6.0", "0.5.9"));
        assert!(!super::is_outdated("0.4.9", "invalid"));
        assert!(super::is_outdated("0.5.10", "1.6.0"));
        assert!(!super::is_outdated("1.6.1", "1.6.0"));
        assert!(super::is_outdated("1.9.9", "1.10.0"));
        assert!(super::is_outdated("1.99.0", "2.0.0"));

        let mut asset = asset("update", JPEG);
        asset.entry.image = "AD 1.jpg".into();
        let current = super::Current {
            assets: vec![asset],
            state: "ready",
            detail: String::new(),
            show_update_ad: super::is_outdated("1.6.0", "1.6.1"),
        };
        assert_eq!(current.visible_ads().count(), 0);
        let current = super::Current {
            show_update_ad: super::is_outdated("1.6.1", "1.7.0"),
            ..current
        };
        assert_eq!(current.visible_ads().count(), 1);
    }
    use super::*;

    const JPEG: &[u8] = &[0xff, 0xd8, 0xff];
    const JPEG_SHA: &str = "6e568e1f67fba258184c78181539e5e8fdee447e49bb706fc0ea34fbf12336a5";

    fn entry(id: &str, filename: &str, bytes: &[u8]) -> Entry {
        Entry {
            id: id.into(),
            image: filename.into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            size_bytes: bytes.len() as u64,
            link_url: "https://example.com/sponsor".into(),
        }
    }

    fn asset(id: &str, bytes: &[u8]) -> Asset {
        let entry = entry(id, "banner.jpg", bytes);
        let image = verified_image(&entry, Bytes::copy_from_slice(bytes)).unwrap();
        Asset { entry, image }
    }

    fn manifest(assets: &[Asset]) -> Manifest {
        Manifest {
            format_version: 1,
            ads: assets.iter().map(|asset| asset.entry.clone()).collect(),
        }
    }

    fn bundled() -> [BundledAd; 1] {
        [BundledAd {
            id: "bundled",
            image: "bundled.jpg",
            bytes: JPEG,
            sha256: JPEG_SHA,
            link_url: "https://example.com/bundled",
        }]
    }

    fn generation(root: &Path) -> PathBuf {
        let directory = root.join("ads");
        let pointer: CachePointer =
            serde_json::from_slice(&std::fs::read(directory.join("current.json")).unwrap())
                .unwrap();
        directory.join(pointer.generation)
    }

    #[test]
    fn shortcuts_are_inert_utf8_https_text_with_one_unambiguous_url() {
        for input in [
            "https://example.com/sponsor?campaign=one#details",
            "\u{feff}https://example.com/sponsor?campaign=one#details\r\n",
            "[InternetShortcut]\r\nURL=https://example.com/sponsor?campaign=one#details\r\n",
            "\u{feff}; Windows shortcut\n[InternetShortcut]\nIconFile=ignored.ico\nurl = https://example.com/sponsor?campaign=one#details\n",
        ] {
            assert_eq!(parse_shortcut(input.as_bytes()).unwrap(), "https://example.com/sponsor?campaign=one#details");
        }
        for input in [
            "",
            "http://example.com",
            "file:///C:/Windows/system32/cmd.exe",
            "javascript:alert(1)",
            "data:text/html,hello",
            "mailto:person@example.com",
            "https://user:password@example.com",
            "https://user@example.com",
            "https://example.com/\0bad",
            "[InternetShortcut]\nIconFile=ignored.ico",
            "[Other]\nURL=https://example.com",
            "[InternetShortcut]\nURL=https://example.com\nURL=https://other.example",
            "[InternetShortcut]\nURL=https://example.com\n[Other]\nURL=https://other.example",
            "https://example.com\nhttps://other.example",
        ] {
            assert!(parse_shortcut(input.as_bytes()).is_err(), "{input:?}");
        }
        assert!(parse_shortcut(&[0xff, 0xfe, 0xff]).is_err());
        assert!(parse_shortcut(&vec![b'a'; 8193]).is_err());
    }

    #[test]
    fn manifest_requires_unique_safe_ids_and_safe_raster_basenames() {
        let original = manifest(&[asset("safe-ID_1", JPEG)]);
        validate_manifest(&original).unwrap();
        for id in [
            "",
            "../outside",
            "a/b",
            "a\\b",
            "a%2fb",
            "a?query",
            "a#fragment",
            "a.b",
            "廣告",
            "a\n",
        ] {
            let mut invalid = original.clone();
            invalid.ads[0].id = id.into();
            assert!(validate_manifest(&invalid).is_err(), "{id:?}");
        }
        let mut invalid = original.clone();
        invalid.ads[0].id = "a".repeat(81);
        assert!(validate_manifest(&invalid).is_err());
        invalid = original.clone();
        invalid.ads.push(invalid.ads[0].clone());
        assert!(validate_manifest(&invalid).is_err());
        invalid.ads[1].id = invalid.ads[0].id.to_ascii_uppercase();
        assert!(
            validate_manifest(&invalid).is_err(),
            "Windows cache filenames must also be unique without regard to case"
        );
        for filename in [
            "",
            ".hidden.jpg",
            "../outside.jpg",
            "sub/banner.jpg",
            "sub\\banner.jpg",
            "C:banner.jpg",
            "banner%2f.jpg",
            "banner.jpg?raw=1",
            "banner.jpg#fragment",
            "banner.svg",
            "banner.html",
            " banner.jpg",
            "banner.jpg ",
        ] {
            let mut invalid = original.clone();
            invalid.ads[0].image = filename.into();
            assert!(validate_manifest(&invalid).is_err(), "{filename:?}");
        }
        for filename in ["banner.JPG", "banner.jpeg", "banner.png", "banner.webp"] {
            let mut allowed = original.clone();
            allowed.ads[0].image = filename.into();
            validate_manifest(&allowed).unwrap();
        }
    }

    #[test]
    fn manifest_enforces_schema_counts_checksums_and_aggregate_budgets_before_fetch() {
        let original = manifest(&[asset("one", JPEG)]);
        let mut invalid = original.clone();
        invalid.format_version = 2;
        assert!(validate_manifest(&invalid).is_err());
        for size in [0, MAX_IMAGE_BYTES + 1, u64::MAX] {
            let mut invalid = original.clone();
            invalid.ads[0].size_bytes = size;
            assert!(validate_manifest(&invalid).is_err());
        }
        for checksum in ["0".repeat(63), "0".repeat(65), "g".repeat(64)] {
            let mut invalid = original.clone();
            invalid.ads[0].sha256 = checksum;
            assert!(validate_manifest(&invalid).is_err());
        }
        let mut bounded = Manifest {
            format_version: 1,
            ads: Vec::new(),
        };
        for index in 0..6 {
            let mut item = original.ads[0].clone();
            item.id = format!("ad-{index}");
            item.size_bytes = MAX_IMAGE_BYTES;
            bounded.ads.push(item);
        }
        validate_manifest(&bounded).unwrap();
        bounded.ads.push(Entry {
            id: "over-total".into(),
            ..bounded.ads[0].clone()
        });
        assert!(validate_manifest(&bounded).is_err());
        let too_many = Manifest {
            format_version: 1,
            ads: (0..=MAX_ADS)
                .map(|index| Entry {
                    id: format!("ad-{index}"),
                    ..original.ads[0].clone()
                })
                .collect(),
        };
        assert!(validate_manifest(&too_many).is_err());
        let mut json = serde_json::to_value(&original).unwrap();
        json["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Manifest>(json).is_err());
        let mut json = serde_json::to_value(&original).unwrap();
        json["ads"][0]["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Manifest>(json).is_err());
        let mut json = serde_json::to_value(&original).unwrap();
        json["ads"][0]["size_bytes"] = serde_json::json!(-1);
        assert!(serde_json::from_value::<Manifest>(json).is_err());
    }

    #[test]
    fn image_urls_stay_in_the_feed_directory_and_canonical_https_origin() {
        let feed =
            https_url("HTTPS://EXAMPLE.COM:443/public/feed/manifest.json?version=1").unwrap();
        assert_eq!(
            image_url(&feed, "banner.jpg").unwrap().as_str(),
            "https://example.com/public/feed/banner.jpg"
        );
        for value in [
            "http://example.com/manifest.json",
            "https://user@example.com/manifest.json",
            "https://user:secret@example.com/manifest.json",
            " https://example.com/manifest.json",
            "https://example.com/\nmanifest.json",
        ] {
            assert!(https_url(value).is_err(), "{value:?}");
        }
        for filename in [
            "https://other.example/banner.jpg",
            "//other.example/banner.jpg",
            "../banner.jpg",
            "%2e%2e%2fbanner.jpg",
            "banner.jpg?redirect=https://other.example",
        ] {
            assert!(image_url(&feed, filename).is_err(), "{filename:?}");
        }
    }

    #[test]
    fn raster_verification_checks_declared_size_digest_and_matching_magic() {
        let png = b"\x89PNG\r\n\x1a\n";
        let webp = b"RIFF\x04\0\0\0WEBP";
        for (filename, bytes, content_type) in [
            ("banner.jpg", JPEG, "image/jpeg"),
            ("banner.png", png.as_slice(), "image/png"),
            ("banner.webp", webp.as_slice(), "image/webp"),
        ] {
            let descriptor = entry("one", filename, bytes);
            let verified = verified_image(&descriptor, Bytes::copy_from_slice(bytes)).unwrap();
            assert_eq!(verified.content_type, content_type);
            let mut uppercase = descriptor.clone();
            uppercase.sha256.make_ascii_uppercase();
            verified_image(&uppercase, verified.bytes.clone()).unwrap();
            let mut bad_size = descriptor.clone();
            bad_size.size_bytes += 1;
            assert!(verified_image(&bad_size, verified.bytes.clone()).is_err());
            let mut bad_digest = descriptor;
            bad_digest.sha256 = "0".repeat(64);
            assert!(verified_image(&bad_digest, verified.bytes).is_err());
        }
        for (filename, bytes) in [
            ("banner.png", JPEG),
            ("banner.jpg", b"<html>not an image</html>".as_slice()),
            ("banner.webp", b"RIFF\x05\0\0\0WEBP".as_slice()),
        ] {
            let descriptor = entry("one", filename, bytes);
            assert!(verified_image(&descriptor, Bytes::copy_from_slice(bytes)).is_err());
        }
    }

    #[test]
    fn a_late_bad_candidate_preserves_the_entire_previous_cache_generation() {
        let dir = tempfile::tempdir().unwrap();
        let previous = vec![asset("previous", JPEG)];
        publish_cache(dir.path(), &manifest(&previous), &previous).unwrap();
        let pointer = std::fs::read(dir.path().join("ads/current.json")).unwrap();
        let previous_generation = generation(dir.path());
        let mut candidate = vec![asset("first", &[0xff, 0xd8, 0xff, 1]), asset("last", JPEG)];
        let candidate_manifest = manifest(&candidate);
        candidate[1].image.bytes = Bytes::from_static(b"bad");
        assert!(publish_cache(dir.path(), &candidate_manifest, &candidate).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("ads/current.json")).unwrap(),
            pointer
        );
        assert!(previous_generation.is_dir());
        let restored = load_cache(dir.path()).unwrap().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].entry.id, "previous");
        assert_eq!(restored[0].image.bytes.as_ref(), JPEG);
        assert_eq!(
            std::fs::read_dir(dir.path().join("ads")).unwrap().count(),
            2,
            "failed candidates must be removed without touching the old pointer or generation"
        );
    }

    #[test]
    fn corrupt_cache_falls_back_to_verified_bundled_images() {
        let dir = tempfile::tempdir().unwrap();
        let cached = vec![asset("cached", JPEG)];
        publish_cache(dir.path(), &manifest(&cached), &cached).unwrap();
        std::fs::write(generation(dir.path()).join("cached"), b"corrupted").unwrap();
        assert!(load_cache(dir.path()).is_err());
        let manager = AdsManager::with_feed(dir.path().to_owned(), &bundled(), None);
        assert_eq!(manager.snapshot().state, "unconfigured");
        assert_eq!(manager.snapshot().ads[0].id, "bundled");
        assert_eq!(manager.image("bundled").unwrap().bytes.as_ref(), JPEG);
        assert!(manager.image("../bundled").is_none());
        assert!(manager.image("cached").is_none());
    }

    #[test]
    fn image_snapshots_remain_verified_and_immutable_after_disk_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cached = vec![asset("cached", JPEG)];
        publish_cache(dir.path(), &manifest(&cached), &cached).unwrap();
        let manager = AdsManager::with_feed(dir.path().to_owned(), &bundled(), None);
        let in_flight = manager.image("cached").unwrap();
        std::fs::write(generation(dir.path()).join("cached"), b"different bytes").unwrap();
        assert_eq!(in_flight.bytes.as_ref(), JPEG);
        assert_eq!(manager.image("cached").unwrap().bytes.as_ref(), JPEG);
        assert_eq!(
            manager.snapshot().ads[0].image_url,
            format!("/ad-assets/{JPEG_SHA}")
        );
        assert_eq!(manager.image(JPEG_SHA).unwrap().bytes.as_ref(), JPEG);
        assert!(load_cache(dir.path()).is_err());
    }

    #[test]
    fn updating_the_same_ad_id_changes_its_image_url_and_preserves_byte_pairing() {
        let dir = tempfile::tempdir().unwrap();
        let original = vec![asset("same-id", JPEG)];
        publish_cache(dir.path(), &manifest(&original), &original).unwrap();
        let first = AdsManager::with_feed(dir.path().to_owned(), &[], None);
        let before = first.snapshot().ads.remove(0);
        let original_key = before.image_url.strip_prefix("/ad-assets/").unwrap();
        assert_eq!(first.image(original_key).unwrap().bytes.as_ref(), JPEG);

        let changed_bytes = &[0xff, 0xd8, 0xff, 7];
        let replacement = vec![asset("same-id", changed_bytes)];
        publish_cache(dir.path(), &manifest(&replacement), &replacement).unwrap();
        let second = AdsManager::with_feed(dir.path().to_owned(), &[], None);
        let after = second.snapshot().ads.remove(0);
        assert_eq!(before.id, after.id);
        assert_ne!(before.image_url, after.image_url);
        let updated_key = after.image_url.strip_prefix("/ad-assets/").unwrap();
        assert_eq!(
            second.image(updated_key).unwrap().bytes.as_ref(),
            changed_bytes
        );
        assert!(second.image(original_key).is_none());
        assert_eq!(first.image(original_key).unwrap().bytes.as_ref(), JPEG);
    }

    #[tokio::test]
    async fn failed_refresh_keeps_a_verified_cache_or_bundle_without_network_access() {
        for cache_present in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            if cache_present {
                let cached = vec![asset("cached", JPEG)];
                publish_cache(dir.path(), &manifest(&cached), &cached).unwrap();
            }
            let manager = AdsManager::with_feed(
                dir.path().to_owned(),
                &bundled(),
                Some("http://invalid.example/manifest.json".into()),
            );
            let before = manager.snapshot();
            assert_eq!(before.state, "checking");
            manager.refresh().await;
            let after = manager.snapshot();
            assert_eq!(after.state, "offline");
            assert_eq!(
                after.ads[0].id,
                if cache_present { "cached" } else { "bundled" }
            );
            assert_eq!(after.ads[0].image_url, before.ads[0].image_url);
            assert_eq!(
                manager.image(&after.ads[0].id).unwrap().bytes.as_ref(),
                JPEG
            );
            manager.refresh().await;
            assert_eq!(manager.snapshot().state, "offline");
        }
    }

    #[tokio::test]
    async fn response_reads_reject_redirects_and_bound_known_or_chunked_bodies_without_sockets() {
        let redirect: reqwest::Response = axum::http::Response::builder()
            .status(302)
            .body(reqwest::Body::from("redirect"))
            .unwrap()
            .into();
        assert!(response_bytes(redirect, 1024).await.is_err());
        let oversized: reqwest::Response = axum::http::Response::builder()
            .header("Content-Length", "8")
            .body(reqwest::Body::from("12345678"))
            .unwrap()
            .into();
        assert!(response_bytes(oversized, 5).await.is_err());
        let chunks = futures_util::stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"123")),
            Ok::<_, std::io::Error>(Bytes::from_static(b"456")),
        ]);
        let chunked: reqwest::Response = axum::http::Response::builder()
            .body(reqwest::Body::wrap_stream(chunks))
            .unwrap()
            .into();
        assert!(response_bytes(chunked, 5).await.is_err());
        let exact: reqwest::Response = axum::http::Response::builder()
            .body(reqwest::Body::from("12345"))
            .unwrap()
            .into();
        assert_eq!(response_bytes(exact, 5).await.unwrap().as_ref(), b"12345");
    }

    #[cfg(unix)]
    #[test]
    fn cache_reads_and_publication_refuse_linked_directories_or_files() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), dir.path().join("ads")).unwrap();
        let cached = vec![asset("cached", JPEG)];
        assert!(load_cache(dir.path()).is_err());
        assert!(publish_cache(dir.path(), &manifest(&cached), &cached).is_err());
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
        let dir = tempfile::tempdir().unwrap();
        publish_cache(dir.path(), &manifest(&cached), &cached).unwrap();
        let image = generation(dir.path()).join("cached");
        let external = outside.path().join("external.jpg");
        std::fs::write(&external, JPEG).unwrap();
        std::fs::remove_file(&image).unwrap();
        symlink(&external, &image).unwrap();
        assert!(load_cache(dir.path()).is_err());
        assert_eq!(std::fs::read(external).unwrap(), JPEG);
        let manager = AdsManager::with_feed(dir.path().to_owned(), &bundled(), None);
        assert_eq!(manager.snapshot().ads[0].id, "bundled");
    }
}
