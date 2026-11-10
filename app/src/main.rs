#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod ads;
mod assets;
mod config;
mod engine;
mod player_browser;
mod player_lifecycle;
mod translation_models;
mod vocabulary;
#[cfg(windows)]
mod windows_app;
#[cfg(windows)]
mod windows_close;

use anyhow::{Context, Result};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use config::{AppearanceSettings, ComputeBackend, InferenceSettings, UiLanguage, UiTheme};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};
use vocabulary::{VocabularyPack, VocabularyState, VocabularyStore};

const BUNDLED_ADS: &[ads::BundledAd] = include!("../assets/ad/bundle-data.rs");

#[derive(Clone, Serialize)]
struct Status {
    ready: bool,
    backend: ComputeBackend,
    device: Option<String>,
    phase: String,
    detail: String,
    progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            ready: false,
            backend: ComputeBackend::Cpu,
            device: None,
            phase: "idle".into(),
            detail: "首次使用請下載本機 AI 元件與模型。".into(),
            progress: 0.,
            error: None,
        }
    }
}

struct Session {
    id: String,
    next_start: f64,
    vocabulary: Option<VocabularyPack>,
}
struct App {
    token: String,
    origin: String,
    status: Mutex<Status>,
    settings: Mutex<InferenceSettings>,
    appearance: Mutex<AppearanceSettings>,
    operation: Mutex<()>,
    vocabulary: Mutex<VocabularyStore>,
    engine: AsyncMutex<Option<engine::Engine>>,
    session: Mutex<Option<Session>>,
    assets: assets::AssetManager,
    ads: ads::AdsManager,
    quit: Notify,
    cancel: watch::Sender<bool>,
    last_capture: Mutex<Instant>,
    players: player_lifecycle::Registry,
}
type Shared = Arc<App>;
type ApiResult<T> = std::result::Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;
fn error(code: StatusCode, message: impl ToString) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({"error":message.to_string()})))
}
fn random_id() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn secure(State(app): State<Shared>, req: Request, next: Next) -> Response {
    let expected_host = app.origin.trim_start_matches("http://");
    if req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        != Some(expected_host)
    {
        return error(StatusCode::FORBIDDEN, "無效的本機主機名稱").into_response();
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(app.origin.as_str()) {
            return error(StatusCode::FORBIDDEN, "拒絕外部網站存取").into_response();
        }
    }
    if req.uri().path().starts_with("/api/") {
        let auth = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok());
        if auth != Some(format!("Bearer {}", app.token).as_str()) {
            return error(
                StatusCode::UNAUTHORIZED,
                "請從油字幕 / V-Translate 程式重新開啟播放器",
            )
            .into_response();
        }
    }
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"));
    response
}

async fn version() -> Json<serde_json::Value> {
    Json(serde_json::json!({"version": env!("CARGO_PKG_VERSION")}))
}
fn supported_backends() -> &'static [ComputeBackend] {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        &[ComputeBackend::Cpu, ComputeBackend::Metal]
    } else {
        &[ComputeBackend::Cpu, ComputeBackend::Vulkan]
    }
}
fn validate_backend(backend: ComputeBackend) -> Result<()> {
    anyhow::ensure!(supported_backends().contains(&backend), "此平台不支援選定的運算方式，macOS M 系列請選 CPU 或 Apple Metal，Windows 請選 CPU 或 Vulkan");
    Ok(())
}
async fn platform() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"backends":supported_backends()}),
    )
}
async fn advertisements(State(app): State<Shared>) -> Json<ads::AdSnapshot> {
    Json(app.ads.snapshot())
}
async fn advertisement_image(State(app): State<Shared>, Path(id): Path<String>) -> Response {
    match app.ads.image(&id) {
        Some(image) => ([(header::CONTENT_TYPE, image.content_type)], image.bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn status(State(app): State<Shared>) -> Json<Status> {
    Json(app.status.lock().unwrap().clone())
}
fn operation_busy(status: &Status) -> bool {
    matches!(
        status.phase.as_str(),
        "downloading" | "loading" | "detecting"
    )
}
async fn cancelled(cancel: &watch::Sender<bool>) {
    let mut receiver = cancel.subscribe();
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}
async fn get_settings(State(app): State<Shared>) -> Json<InferenceSettings> {
    Json(app.settings.lock().unwrap().clone())
}
async fn validate_translation_selection(
    app: &App,
    settings: &InferenceSettings,
) -> std::result::Result<(), (StatusCode, Json<serde_json::Value>)> {
    if let Some(filename) = settings.translation_model.clone() {
        let root = app.assets.root.clone();
        tokio::task::spawn_blocking(move || {
            translation_models::validate_selection(&root, &filename)
        })
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    }
    Ok(())
}
async fn put_settings(
    State(app): State<Shared>,
    Json(settings): Json<InferenceSettings>,
) -> ApiResult<InferenceSettings> {
    settings
        .validate()
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    validate_backend(settings.backend).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    validate_translation_selection(&app, &settings).await?;
    let _operation = app.operation.lock().unwrap();
    if operation_busy(&app.status.lock().unwrap()) || app.session.lock().unwrap().is_some() {
        return Err(error(
            StatusCode::CONFLICT,
            "請先結束擷取，並等待目前的 AI 準備工作完成，再更換運算方式",
        ));
    }
    let mut engine = app.engine.try_lock().map_err(|_| {
        error(
            StatusCode::CONFLICT,
            "AI 正在處理音訊，請稍候再更換運算方式",
        )
    })?;
    let mut current = app.settings.lock().unwrap();
    if *current == settings {
        return Ok(Json(settings));
    }
    settings
        .save(&app.assets.root)
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    engine.take();
    *current = settings.clone();
    *app.status.lock().unwrap() = Status {
        backend: settings.backend,
        detail: format!(
            "已選擇{}。請按「準備 AI 模型」載入聽寫與翻譯引擎。",
            settings.backend.label()
        ),
        ..Status::default()
    };
    Ok(Json(settings))
}
async fn setup(State(app): State<Shared>) -> ApiResult<serde_json::Value> {
    let candidate = {
        let _operation = app.operation.lock().unwrap();
        let status = app.status.lock().unwrap();
        if status.ready || operation_busy(&status) {
            return Ok(Json(serde_json::json!({"accepted":true})));
        }
        if app.session.lock().unwrap().is_some() {
            return Err(error(StatusCode::CONFLICT, "請先結束擷取，再準備 AI 引擎"));
        }
        app.settings.lock().unwrap().clone()
    };
    validate_translation_selection(&app, &candidate).await?;
    let settings;
    {
        let _operation = app.operation.lock().unwrap();
        let mut status = app.status.lock().unwrap();
        if status.ready || operation_busy(&status) {
            return Ok(Json(serde_json::json!({"accepted":true})));
        }
        if app.session.lock().unwrap().is_some() {
            return Err(error(StatusCode::CONFLICT, "請先結束擷取，再準備 AI 引擎"));
        }
        settings = app.settings.lock().unwrap().clone();
        if settings != candidate {
            return Err(error(
                StatusCode::CONFLICT,
                "AI 設定剛已變更，請重新準備模型",
            ));
        }
        *status = Status {
            backend: settings.backend,
            phase: "downloading".into(),
            detail: format!("準備{}翻譯模型…", settings.backend.label()),
            ..Status::default()
        };
    }
    tokio::spawn(async move {
        let result: Result<()> = async {
            app.engine.lock().await.take();
            let progress_app = app.clone();
            app.assets
                .prepare(&settings, move |detail, progress| {
                    let mut status = progress_app.status.lock().unwrap();
                    status.detail = detail;
                    status.progress = progress;
                })
                .await?;
            {
                let mut status = app.status.lock().unwrap();
                status.phase = "loading".into();
                status.detail = format!("載入聽寫及{}翻譯引擎…", settings.backend.label());
            }
            activate_engine(&app, &settings).await?;
            Ok(())
        }
        .await;
        if let Err(e) = result {
            *app.status.lock().unwrap() = Status {backend:settings.backend,phase:"error".into(),detail:match settings.backend {
                ComputeBackend::Cpu => "無法啟動本機 AI，請檢查網路、可用記憶體及模型目錄。".into(),
                ComputeBackend::Vulkan => "顯卡聽寫或翻譯啟動失敗。請更新 AMD／NVIDIA 顯卡的 Vulkan 驅動，或選擇 CPU 後重新準備模型。".into(),
                ComputeBackend::Metal => "Apple Metal 聽寫或翻譯啟動失敗。請確認 macOS 版本及可用記憶體，或選擇 CPU 後重新準備模型。".into(),
            },error:Some(format!("{e:#}")),..Status::default()};
        }
    });
    Ok(Json(serde_json::json!({"accepted":true})))
}
async fn activate_engine(app: &Shared, settings: &InferenceSettings) -> Result<()> {
    let loaded = engine::Engine::start(&app.assets, settings).await?;
    let device = loaded.device_name().map(str::to_owned);
    let detail = format!(
        "Whisper {:?} · {} 聽寫 · {} · {} 翻譯{}",
        settings.whisper_model,
        if cfg!(windows) && settings.backend == ComputeBackend::Vulkan {
            "Vulkan".to_owned()
        } else if settings.backend == ComputeBackend::Metal {
            "Metal".to_owned()
        } else {
            format!("CPU {} 執行緒", settings.cpu_threads)
        },
        settings.translation_model_label(),
        settings.backend.label(),
        device
            .as_ref()
            .map(|d| format!("：{d}"))
            .unwrap_or_default()
    );
    *app.engine.lock().await = Some(loaded);
    *app.last_capture.lock().unwrap() = Instant::now();
    *app.status.lock().unwrap() = Status {
        ready: true,
        backend: settings.backend,
        device,
        phase: "ready".into(),
        detail,
        progress: 1.,
        error: None,
    };
    Ok(())
}
async fn recover(State(app): State<Shared>) -> ApiResult<serde_json::Value> {
    let settings;
    {
        let _operation = app.operation.lock().unwrap();
        let mut status = app.status.lock().unwrap();
        if status.ready || operation_busy(&status) {
            return Ok(Json(serde_json::json!({"accepted":true})));
        }
        settings = app.settings.lock().unwrap().clone();
        *status = Status {
            backend: settings.backend,
            phase: "loading".into(),
            detail: "AI 暫時中斷，正在重新載入已有模型；播放器會保留。".into(),
            ..Status::default()
        };
    }
    tokio::spawn(async move {
        app.engine.lock().await.take();
        if let Err(e) = activate_engine(&app, &settings).await {
            *app.status.lock().unwrap() = Status {
                backend: settings.backend,
                phase: "error".into(),
                detail: "AI 暫時無法重啟，可稍候重試；播放器不會因此結束。".into(),
                error: Some(format!("{e:#}")),
                ..Status::default()
            };
        }
    });
    Ok(Json(serde_json::json!({"accepted":true})))
}
async fn get_devices(State(app): State<Shared>) -> ApiResult<serde_json::Value> {
    let devices = tokio::select! {
        _ = cancelled(&app.cancel) => return Err(error(StatusCode::SERVICE_UNAVAILABLE,"程式正在關閉")),
        result = engine::list_gpu_devices(&app.assets) => result.map_err(|e| error(StatusCode::CONFLICT,format!("{e:#}")))?,
    };
    Ok(Json(serde_json::json!({"devices":devices})))
}
async fn prepare_devices(State(app): State<Shared>) -> ApiResult<serde_json::Value> {
    let backend;
    {
        let _operation = app.operation.lock().unwrap();
        let mut status = app.status.lock().unwrap();
        backend = app.settings.lock().unwrap().backend;
        if backend == ComputeBackend::Cpu {
            return Err(error(StatusCode::CONFLICT, "請先選擇顯卡翻譯"));
        }
        validate_backend(backend).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
        if operation_busy(&status) || status.ready || app.session.lock().unwrap().is_some() {
            return Err(error(
                StatusCode::CONFLICT,
                "請先結束擷取並等待引擎工作完成，再偵測顯卡；已就緒時可直接使用現有裝置",
            ));
        }
        *status = Status {
            backend,
            phase: "detecting".into(),
            detail: format!("準備 {} 引擎並偵測顯卡…", backend.label()),
            ..Status::default()
        };
    }
    // Keep the operation alive if the browser cancels its HTTP request.
    let job_app = app.clone();
    let job = tokio::spawn(async move {
        let app = job_app;
        let result: Result<Vec<engine::GpuDevice>> = async {
            let progress_app = app.clone();
            app.assets
                .prepare_gpu_runtime_for_backend(backend, move |detail, progress| {
                    let mut status = progress_app.status.lock().unwrap();
                    status.detail = detail;
                    status.progress = progress;
                })
                .await?;
            engine::list_gpu_devices_for_backend(&app.assets, backend).await
        }
        .await;
        match result {
            Ok(devices) => {
                *app.status.lock().unwrap() = Status {
                    backend,
                    detail: format!(
                        "已偵測到 {} 個 {} 裝置。請選擇裝置後準備 AI 模型。",
                        devices.len(),
                        backend.label()
                    ),
                    ..Status::default()
                };
                Ok(Json(serde_json::json!({"devices":devices})))
            }
            Err(e) => {
                let detail = format!("{e:#}");
                *app.status.lock().unwrap() = Status {
                    backend,
                    phase: "error".into(),
                    detail: "顯卡偵測失敗，可更新驅動後重試，或選擇 CPU。".into(),
                    error: Some(detail.clone()),
                    ..Status::default()
                };
                Err(error(StatusCode::INTERNAL_SERVER_ERROR, detail))
            }
        }
    });
    tokio::select! {
        _ = cancelled(&app.cancel) => Err(error(StatusCode::SERVICE_UNAVAILABLE,"程式正在關閉")),
        result = job => result.map_err(|e|error(StatusCode::INTERNAL_SERVER_ERROR,e))?,
    }
}
async fn get_appearance(State(app): State<Shared>) -> Json<AppearanceSettings> {
    Json(app.appearance.lock().unwrap().clone())
}
async fn translation_model_catalog(
    State(app): State<Shared>,
) -> ApiResult<translation_models::ModelCatalog> {
    let root = app.assets.root.clone();
    tokio::task::spawn_blocking(move || translation_models::scan(&root))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_REQUEST, format!("{e:#}")))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppearanceUpdate {
    theme: UiTheme,
    language: Option<UiLanguage>,
    onboarding_complete: Option<bool>,
}
async fn put_appearance(
    State(app): State<Shared>,
    Json(update): Json<AppearanceUpdate>,
) -> ApiResult<AppearanceSettings> {
    let mut current = app.appearance.lock().unwrap();
    let appearance = AppearanceSettings {
        theme: update.theme,
        language: update.language.unwrap_or(current.language),
        onboarding_complete: current.onboarding_complete
            || update.onboarding_complete.unwrap_or(false),
    };
    appearance
        .save(&app.assets.root)
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    *current = appearance.clone();
    Ok(Json(appearance))
}
async fn vocabulary_state(State(app): State<Shared>) -> Json<VocabularyState> {
    Json(app.vocabulary.lock().unwrap().state())
}
fn can_edit_vocabulary(
    app: &App,
) -> std::result::Result<(), (StatusCode, Json<serde_json::Value>)> {
    if app.session.lock().unwrap().is_some() {
        return Err(error(
            StatusCode::CONFLICT,
            "請先結束擷取，再匯入或切換 VTuber 詞彙包",
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextVocabularyImport {
    format: String,
    name: String,
    content: String,
}
async fn import_vocabulary(State(app): State<Shared>, body: Bytes) -> ApiResult<VocabularyState> {
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|e| error(StatusCode::BAD_REQUEST, format!("詞彙檔案格式無效：{e}")))?;
    let pack: VocabularyPack = if value.get("format").is_some() {
        let text: TextVocabularyImport =
            serde_json::from_value(value).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
        vocabulary::parse_text_pack(&text.format, &text.name, &text.content)
            .map_err(|e| error(StatusCode::BAD_REQUEST, e))?
    } else {
        if body.len() > 64 * 1024 {
            return Err(error(StatusCode::PAYLOAD_TOO_LARGE, "詞彙包最多 64 KiB"));
        }
        serde_json::from_value(value).map_err(|e| {
            error(
                StatusCode::BAD_REQUEST,
                format!("不是支援的 JSON 詞彙包：{e}"),
            )
        })?
    };
    pack.validate()
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    let _operation = app.operation.lock().unwrap();
    can_edit_vocabulary(&app)?;
    app.vocabulary
        .lock()
        .unwrap()
        .import(pack)
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))
}
#[derive(Deserialize)]
struct ExportVocabulary {
    format: String,
}
async fn export_vocabulary(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(query): Query<ExportVocabulary>,
) -> ApiResult<serde_json::Value> {
    let pack = app
        .vocabulary
        .lock()
        .unwrap()
        .get_pack(&id)
        .map_err(|e| error(StatusCode::NOT_FOUND, e))?;
    let content = vocabulary::export_text_pack(&pack, &query.format)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(
        serde_json::json!({"filename":format!("V-Translate-vocabulary.{}",query.format),"content":content}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActiveVocabulary {
    id: Option<String>,
}
async fn select_vocabulary(
    State(app): State<Shared>,
    Json(selection): Json<ActiveVocabulary>,
) -> ApiResult<VocabularyState> {
    let _operation = app.operation.lock().unwrap();
    can_edit_vocabulary(&app)?;
    app.vocabulary
        .lock()
        .unwrap()
        .activate(selection.id)
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))
}
async fn remove_vocabulary(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<VocabularyState> {
    let _operation = app.operation.lock().unwrap();
    can_edit_vocabulary(&app)?;
    app.vocabulary
        .lock()
        .unwrap()
        .remove(&id)
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))
}
fn models_folder(root: &std::path::Path) -> Result<PathBuf> {
    let models = root.join("models");
    std::fs::create_dir_all(&models).context("無法建立模型資料夾")?;
    let path = std::fs::canonicalize(models).context("無法取得模型資料夾位置")?;
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(normal) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(normal));
        }
    }
    Ok(path)
}
async fn open_models(State(app): State<Shared>) -> ApiResult<serde_json::Value> {
    let folder =
        models_folder(&app.assets.root).map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    open_model_folder(folder)
}
async fn open_translation_models(State(app): State<Shared>) -> ApiResult<serde_json::Value> {
    let folder = translation_models::model_directory(&app.assets.root)
        .map_err(|e| error(StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    open_model_folder(explorer_path(folder))
}
fn explorer_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(normal) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(normal);
        }
    }
    path
}
fn open_model_folder(folder: PathBuf) -> ApiResult<serde_json::Value> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let windows = std::env::var_os("WINDIR").ok_or_else(|| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "無法取得 Windows 系統路徑",
            )
        })?;
        let mut command = std::process::Command::new(PathBuf::from(windows).join("explorer.exe"));
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(&folder)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("無法開啟資料夾 {}：{e}", folder.display()),
            )
        })?;
    Ok(Json(
        serde_json::json!({"path":folder.to_string_lossy(),"opened":true}),
    ))
}
const CAPTURE_IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);

async fn pause_inactive_engine(app: &Shared, now: Instant) {
    // Never interrupt an in-flight inference; retry after it releases the engine.
    let Ok(mut engine) = app.engine.try_lock() else {
        return;
    };
    let _operation = app.operation.lock().unwrap();
    let mut status = app.status.lock().unwrap();
    if !status.ready
        || now.saturating_duration_since(*app.last_capture.lock().unwrap()) < CAPTURE_IDLE_TIMEOUT
    {
        return;
    }
    engine.take(); // Engine::drop terminates Whisper and the translation child process.
    app.session.lock().unwrap().take();
    *status = Status {
        backend: status.backend,
        phase: "paused".into(),
        detail: "直播分頁已超過 20 分鐘沒有回應，AI 已暫停並釋放資源。".into(),
        ..Status::default()
    };
}

async fn capture_heartbeat(
    State(app): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<serde_json::Value> {
    let _operation = app.operation.lock().unwrap();
    if app
        .session
        .lock()
        .unwrap()
        .as_ref()
        .is_none_or(|session| session.id != id)
    {
        return Err(error(StatusCode::CONFLICT, "字幕工作階段已結束"));
    }
    *app.last_capture.lock().unwrap() = Instant::now();
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn new_session(State(app): State<Shared>) -> ApiResult<serde_json::Value> {
    let _operation = app.operation.lock().unwrap();
    if app.session.lock().unwrap().is_some() {
        return Err(error(
            StatusCode::CONFLICT,
            "另一個播放器正在擷取。請先在原本的瀏覽器／Profile 結束擷取，再開始。",
        ));
    }
    if !app.status.lock().unwrap().ready {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "請先完成本機 AI 初始化",
        ));
    }
    let id = random_id();
    *app.last_capture.lock().unwrap() = Instant::now();
    let vocabulary = app.vocabulary.lock().unwrap().active_pack();
    *app.session.lock().unwrap() = Some(Session {
        id: id.clone(),
        next_start: 0.,
        vocabulary,
    });
    let settings = app.settings.lock().unwrap();
    Ok(Json(
        serde_json::json!({"id":id,"chunk_seconds":settings.chunk_seconds,"buffer_seconds":settings.buffer_seconds}),
    ))
}
async fn end_session(State(app): State<Shared>, Path(id): Path<String>) -> Json<serde_json::Value> {
    let mut session = app.session.lock().unwrap();
    if session.as_ref().is_some_and(|s| s.id == id) {
        *session = None;
    }
    Json(serde_json::json!({"ok":true}))
}
#[derive(Deserialize)]
struct InferenceQuery {
    session: String,
    start: f64,
    language: String,
    target: String,
    #[serde(default)]
    preview: bool,
    #[serde(default)]
    replay: bool,
}
fn validate_wav(wav: &[u8]) -> Result<f64> {
    let reader = hound::WavReader::new(std::io::Cursor::new(wav)).context("不是有效的 WAV 音訊")?;
    let spec = reader.spec();
    anyhow::ensure!(
        spec.channels == 1
            && spec.sample_rate == 16000
            && spec.bits_per_sample == 16
            && spec.sample_format == hound::SampleFormat::Int,
        "需要 16kHz 單聲道 PCM16 WAV"
    );
    let seconds = reader.duration() as f64 / 16000.;
    anyhow::ensure!(seconds > 0. && seconds <= 12., "音訊片段需介於 0 至 12 秒");
    Ok(seconds)
}
async fn transcribe(
    State(app): State<Shared>,
    Query(q): Query<InferenceQuery>,
    wav: Bytes,
) -> ApiResult<engine::InferenceResult> {
    if !q.start.is_finite() || q.start < 0. || q.start > 604800. {
        return Err(error(StatusCode::BAD_REQUEST, "無效的音訊時間"));
    }
    if !["auto", "ja", "en", "zh", "ko"].contains(&q.language.as_str())
        || !["繁體中文", "简体中文", "English", "日本語", "한국어"].contains(&q.target.as_str())
    {
        return Err(error(StatusCode::BAD_REQUEST, "不支援的語言"));
    }
    let duration = validate_wav(&wav).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    let mut guard = app
        .engine
        .try_lock()
        .map_err(|_| error(StatusCode::TOO_MANY_REQUESTS, "AI 正在處理上一段音訊"))?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "AI 引擎尚未就緒"))?;
    let vocabulary = {
        let session = app.session.lock().unwrap();
        let session = session
            .as_ref()
            .filter(|s| s.id == q.session)
            .ok_or_else(|| error(StatusCode::CONFLICT, "字幕工作階段已結束"))?;
        if q.start + 0.05 < session.next_start {
            return Err(error(StatusCode::CONFLICT, "已處理過此音訊片段"));
        }
        session.vocabulary.clone()
    };
    if q.preview {
        let result = tokio::select! {
            _ = cancelled(&app.cancel) => return Err(error(StatusCode::SERVICE_UNAVAILABLE, "程式正在關閉")),
            result = engine.preview(&wav,q.start,&q.language,vocabulary.as_ref()) => result,
        };
        return result
            .map(Json)
            .map_err(|cause| error(StatusCode::BAD_GATEWAY, cause));
    }
    let inference = tokio::select! {
        _ = cancelled(&app.cancel) => return Err(error(StatusCode::SERVICE_UNAVAILABLE,"程式正在關閉")),
        result = engine.transcribe(&wav,q.start,&q.language,&q.target,vocabulary.as_ref(),q.replay) => result,
    };
    let result = match inference {
        Ok(result) => result,
        Err(cause) => {
            let detail = format!("{cause:#}");
            guard.take();
            *app.status.lock().unwrap() = Status {
                backend: app.settings.lock().unwrap().backend,
                phase: "error".into(),
                detail: "AI 處理中斷。請按「準備 AI 模型」重新啟動引擎。".into(),
                error: Some(detail.clone()),
                ..Status::default()
            };
            return Err(error(StatusCode::INTERNAL_SERVER_ERROR, detail));
        }
    };
    let mut session = app.session.lock().unwrap();
    let session = session
        .as_mut()
        .filter(|s| s.id == q.session)
        .ok_or_else(|| error(StatusCode::CONFLICT, "字幕工作階段已結束"))?;
    session.next_start = q.start + duration;
    Ok(Json(result))
}
async fn quit(State(app): State<Shared>) -> Json<serde_json::Value> {
    app.cancel.send_replace(true);
    app.quit.notify_one();
    Json(serde_json::json!({"ok":true}))
}

async fn index() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("../web/index.html"),
    )
}
async fn style() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../web/style.css"),
    )
}
async fn app_icon() -> Response {
    let bytes: &'static [u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app-icon.png"));
    if bytes.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
}
async fn favicon() -> Response {
    let bytes: &'static [u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app-icon.ico"));
    if bytes.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    ([(header::CONTENT_TYPE, "image/x-icon")], bytes).into_response()
}
async fn web_manifest() -> Response {
    let mut manifest = serde_json::json!({
        "id":"/", "name":"油字幕 / V-Translate", "short_name":"V-Translate",
        "start_url":"/", "scope":"/", "display":"standalone",
        "background_color":"#0c1017", "theme_color":"#101720",
        "description":"Real time local AI translator for Vtuber viewers."
    });
    if !include_bytes!(concat!(env!("OUT_DIR"), "/app-icon.png")).is_empty() {
        manifest["icons"] = serde_json::json!([
            {"src":"/app-icon.png", "sizes":"any", "type":"image/png", "purpose":"any"}
        ]);
    }
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        Json(manifest),
    )
        .into_response()
}
async fn script(Path(name): Path<String>) -> Response {
    let source = match name.as_str() {
        "app.js" => include_str!("../web/app.js"),
        "i18n.js" => include_str!("../web/i18n.js"),
        "backend-i18n.js" => include_str!("../web/backend-i18n.js"),
        "audio-worklet.js" => include_str!("../web/audio-worklet.js"),
        "timeline.js" => include_str!("../web/timeline.js"),
        "backpressure.js" => include_str!("../web/backpressure.js"),
        "advertisements.js" => include_str!("../web/advertisements.js"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        source,
    )
        .into_response()
}
fn app_router(app: Shared) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/style.css", get(style))
        .route(
            "/ui-performance.png",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/png")],
                    &include_bytes!("../assets/Icon_performance.png")[..],
                )
            }),
        )
        .route(
            "/ui-language.png",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/png")],
                    &include_bytes!("../assets/Icon_language.png")[..],
                )
            }),
        )
        .route("/app-icon.png", get(app_icon))
        .route("/favicon.ico", get(favicon))
        .route("/manifest.webmanifest", get(web_manifest))
        .route("/{name}", get(script))
        .route("/api/status", get(status))
        .route("/api/player/open", post(open_player_browser))
        .route("/api/player/presence", post(player_lifecycle::presence))
        .route("/api/ads", get(advertisements))
        .route("/ad-assets/{id}", get(advertisement_image))
        .route("/api/version", get(version))
        .route("/api/platform", get(platform))
        .route("/api/setup", post(setup))
        .route("/api/recover", post(recover))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/devices", get(get_devices).post(prepare_devices))
        .route("/api/session", post(new_session))
        .route(
            "/api/session/{id}",
            delete(end_session).post(capture_heartbeat),
        )
        .route("/api/transcribe", post(transcribe))
        .route("/api/models/open", post(open_models))
        .route("/api/translation-models", get(translation_model_catalog))
        .route(
            "/api/translation-models/open",
            post(open_translation_models),
        )
        .route("/api/appearance", get(get_appearance).put(put_appearance))
        .route("/api/vocabulary", get(vocabulary_state))
        .route(
            "/api/vocabulary/import",
            post(import_vocabulary).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            "/api/vocabulary/active",
            axum::routing::put(select_vocabulary),
        )
        .route("/api/vocabulary/{id}", delete(remove_vocabulary))
        .route("/api/vocabulary/{id}/export", get(export_vocabulary))
        .route("/api/quit", post(quit))
        .layer(DefaultBodyLimit::max(512 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), secure))
        .with_state(app)
}
fn data_dir() -> Result<PathBuf> {
    directories::ProjectDirs::from("org", "LiveSub", "LiveSub")
        .map(|d| d.data_local_dir().to_path_buf())
        .context("找不到本機資料目錄")
}
fn valid_player_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let Some((port, token)) = rest.split_once("/#token=") else {
        return false;
    };
    port.parse::<u16>().is_ok_and(|p| p != 0)
        && token.len() == 64
        && token.bytes().all(|c| c.is_ascii_hexdigit())
}

async fn check_running_version(url: &str) -> Result<()> {
    anyhow::ensure!(valid_player_url(url), "無效的本機播放器位址");
    let (origin, token) = url.split_once("/#token=").context("無效的播放器位址")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()?;
    let response = client
        .get(format!("{origin}/api/version"))
        .bearer_auth(token)
        .send()
        .await;
    let running = match response {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|json| json["version"].as_str().map(str::to_owned)),
        _ => None,
    };
    anyhow::ensure!(running.as_deref() == Some(env!("CARGO_PKG_VERSION")),
        "另一版本或舊版油字幕 / V-Translate 仍在背景執行。請到舊播放器頁面下方按「關閉本機程式」，然後重新開啟此新版執行檔（v{}）。已下載的模型會保留。只關閉播放器視窗可能仍要等約 3 分鐘才會退出。 / Another version is still running. Close it using the old player's quit button, then reopen this executable. Your downloaded models will be kept.",env!("CARGO_PKG_VERSION"));
    Ok(())
}

fn open_player(url: &str) -> Result<()> {
    player_browser::open(url, None)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenPlayerRequest {
    browser: player_browser::Browser,
}
async fn open_player_browser(
    State(app): State<Shared>,
    Json(request): Json<OpenPlayerRequest>,
) -> ApiResult<serde_json::Value> {
    if app.session.lock().unwrap().is_some() {
        return Err(error(
            StatusCode::CONFLICT,
            "請先結束目前擷取，再切換播放器的瀏覽器／Profile。",
        ));
    }
    let url = format!("{}/#token={}", app.origin, app.token);
    player_browser::open(&url, Some(request.browser))
        .map_err(|e| error(StatusCode::CONFLICT, e))?;
    Ok(Json(serde_json::json!({"opened":true})))
}
async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("油字幕 / V-Translate {}\n  --no-network-updates  停用廣告及版本檢查 / Disable ad and version requests\n  --no-open       不自動開啟瀏覽器 / Do not open the browser\n  --data-dir PATH 本機模型與引擎目錄 / Local model and engine directory\n  --port PORT     指定本機連接埠（預設隨機） / Local port (random by default)",env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let value = |flag: &str| -> Result<Option<&str>> {
        args.iter()
            .position(|a| a == flag)
            .map(|i| {
                args.get(i + 1)
                    .map(String::as_str)
                    .context(format!("{flag} 需要參數"))
            })
            .transpose()
    };
    let data = value("--data-dir")?
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(data_dir)?;
    let port: u16 = value("--port")?
        .unwrap_or("0")
        .parse()
        .context("無效的連接埠")?;
    std::fs::create_dir_all(&data).context("無法建立模型資料目錄")?;
    let instance_guard = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("instance.lock"))?;
    match instance_guard.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            for _ in 0..20 {
                if let Ok(url) = std::fs::read_to_string(data.join("player.url")) {
                    if valid_player_url(&url) {
                        check_running_version(&url).await?;
                        if args.iter().any(|a| a == "--no-open") {
                            println!("{url}");
                        } else {
                            open_player(&url)?;
                        }
                        return Ok(());
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            anyhow::bail!("油字幕 / V-Translate 已在啟動，請稍候再試。 / V-Translate is starting. Please try again shortly.");
        }
        Err(std::fs::TryLockError::Error(error)) => {
            return Err(error).context("無法鎖定本機模型資料目錄")
        }
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let settings = InferenceSettings::load(&data)?;
    validate_backend(settings.backend)?;
    let initial_status = Status {
        backend: settings.backend,
        ..Status::default()
    };
    let vocabulary = VocabularyStore::load(&data)?;
    let app = Arc::new(App {
        token: random_id(),
        origin: origin.clone(),
        status: Mutex::new(initial_status),
        settings: Mutex::new(settings),
        appearance: Mutex::new(AppearanceSettings::load(&data)?),
        operation: Mutex::new(()),
        vocabulary: Mutex::new(vocabulary),
        engine: AsyncMutex::new(None),
        session: Mutex::new(None),
        ads: ads::AdsManager::new(data.clone(), BUNDLED_ADS),
        assets: assets::AssetManager::new(data),
        quit: Notify::new(),
        cancel: watch::channel(false).0,
        last_capture: Mutex::new(Instant::now()),
        players: Default::default(),
    });
    let advertisement_app = app.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = cancelled(&advertisement_app.cancel) => {},
            _ = advertisement_app.ads.refresh() => {},
        }
    });
    if app.assets.root.join("installed.json").is_file() {
        let _ = setup(State(app.clone())).await;
    }
    let url = format!("{origin}/#token={}", app.token);
    {
        use std::io::Write;
        let path = app.assets.root.join("player.url");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(url.as_bytes())?;
    }
    if args.iter().any(|a| a == "--no-open") {
        println!("{url}");
    } else {
        open_player(&url)?;
    }
    let watchdog = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            pause_inactive_engine(&watchdog, Instant::now()).await;
        }
    });
    let shutdown = app.clone();
    axum::serve(listener, app_router(app.clone()))
        .with_graceful_shutdown(async move {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = shutdown.quit.notified() => {} }
            shutdown.cancel.send_replace(true);
        })
        .await?;
    // Stop model processes explicitly before the async runtime is torn down.
    app.engine.lock().await.take();
    Ok(())
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        let message = format!("油字幕 / V-Translate 無法啟動 / Unable to start:\n{error:#}");
        eprintln!("{message}");
        #[cfg(windows)]
        unsafe {
            let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "油字幕 / V-Translate"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                0x10,
            );
        }
        #[cfg(target_os = "macos")]
        if !std::env::args().any(|arg| arg == "--no-open") {
            let _ = std::process::Command::new("/usr/bin/osascript")
                .args(["-e", "on run argv\n display alert \"V-Translate\" message (item 1 of argv) as critical\nend run", "--", &message])
                .status();
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav(rate: u32, channels: u16, samples: usize) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(
                &mut cursor,
                hound::WavSpec {
                    channels,
                    sample_rate: rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for _ in 0..samples {
                writer.write_sample(0i16).unwrap();
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }
    #[tokio::test]
    async fn capture_idle_pauses_without_quitting_and_ignores_status_polling() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(App {
            token: "test-secret".into(),
            origin: "http://127.0.0.1:1234".into(),
            status: Mutex::new(Status::default()),
            settings: Mutex::new(InferenceSettings::default()),
            appearance: Mutex::new(AppearanceSettings::default()),
            operation: Mutex::new(()),
            vocabulary: Mutex::new(VocabularyStore::load(dir.path()).unwrap()),
            engine: AsyncMutex::new(None),
            session: Mutex::new(None),
            assets: assets::AssetManager::new(dir.path().to_owned()),
            ads: ads::AdsManager::new(dir.path().to_owned(), BUNDLED_ADS),
            quit: Notify::new(),
            cancel: watch::channel(false).0,
            last_capture: Mutex::new(Instant::now()),
            players: Default::default(),
        });
        state.status.lock().unwrap().ready = true;
        let start = Instant::now();
        *state.last_capture.lock().unwrap() = start;
        pause_inactive_engine(
            &state,
            start + CAPTURE_IDLE_TIMEOUT - Duration::from_secs(1),
        )
        .await;
        assert!(state.status.lock().unwrap().ready);
        let _ = status(State(state.clone())).await;
        assert_eq!(
            *state.last_capture.lock().unwrap(),
            start,
            "UI polling is not source activity"
        );
        assert!(
            capture_heartbeat(State(state.clone()), Path("stale".into()))
                .await
                .is_err()
        );
        *state.session.lock().unwrap() = Some(Session {
            id: "live".into(),
            next_start: 0.,
            vocabulary: None,
        });
        let _ = capture_heartbeat(State(state.clone()), Path("live".into()))
            .await
            .unwrap();
        assert!(*state.last_capture.lock().unwrap() >= start);
        let heartbeat = *state.last_capture.lock().unwrap();
        let busy = state.engine.lock().await;
        pause_inactive_engine(&state, heartbeat + CAPTURE_IDLE_TIMEOUT).await;
        assert!(
            state.status.lock().unwrap().ready,
            "in-flight inference must finish first"
        );
        drop(busy);
        pause_inactive_engine(&state, heartbeat + CAPTURE_IDLE_TIMEOUT).await;
        assert_eq!(state.status.lock().unwrap().phase, "paused");
        assert!(!state.status.lock().unwrap().ready);
        assert!(state.session.lock().unwrap().is_none());
        assert!(state.engine.lock().await.is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), state.quit.notified())
                .await
                .is_err(),
            "keep server available for restart"
        );
        assert!(capture_heartbeat(State(state.clone()), Path("live".into()))
            .await
            .is_err());
        assert_eq!(status(State(state.clone())).await.0.phase, "paused");
    }

    #[tokio::test]
    async fn loopback_api_rejects_external_and_unauthorized_requests() {
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(App {
            token: "test-secret".into(),
            origin: origin.clone(),
            status: Mutex::new(Status::default()),
            settings: Mutex::new(InferenceSettings::default()),
            appearance: Mutex::new(AppearanceSettings::default()),
            operation: Mutex::new(()),
            vocabulary: Mutex::new(VocabularyStore::load(dir.path()).unwrap()),
            engine: AsyncMutex::new(None),
            session: Mutex::new(None),
            assets: assets::AssetManager::new(dir.path().to_owned()),
            ads: ads::AdsManager::new(dir.path().to_owned(), BUNDLED_ADS),
            quit: Notify::new(),
            cancel: watch::channel(false).0,
            last_capture: Mutex::new(Instant::now()),
            players: Default::default(),
        });
        let router = app_router(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            client
                .get(format!("{origin}/api/status"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = client
            .get(format!("{origin}/api/status"))
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap()["ready"],
            false
        );
        assert_eq!(
            client
                .get(format!("{origin}/api/status"))
                .bearer_auth("test-secret")
                .header("Origin", "https://evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{origin}/api/status"))
                .bearer_auth("test-secret")
                .header("Host", "evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .post(format!("{origin}/api/session"))
                .bearer_auth("test-secret")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let running = client
            .get(format!("{origin}/api/version"))
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(running["version"], env!("CARGO_PKG_VERSION"));
        let endpoint = format!("{origin}/api/settings");
        let initial = client
            .get(&endpoint)
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(initial["backend"], "cpu");
        assert_eq!(initial["performance"], "high");
        assert_eq!(initial["whisper_model"], "small");
        assert_eq!(initial["cpu_threads"], 6);
        assert_eq!(initial["chunk_seconds"], 5);
        assert_eq!(initial["buffer_seconds"], 5);
        let (gpu_backend, gpu_id) = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            ("metal", "MTL0")
        } else {
            ("vulkan", "Vulkan1")
        };
        let gpu = serde_json::json!({"backend":gpu_backend,"device":gpu_id});
        assert_eq!(
            client
                .put(&endpoint)
                .bearer_auth("test-secret")
                .json(&gpu)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            InferenceSettings::load(dir.path())
                .unwrap()
                .device
                .as_deref(),
            Some(gpu_id)
        );
        let selected = client
            .get(format!("{origin}/api/status"))
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(selected["backend"], gpu_backend);
        assert_eq!(selected["ready"], false);
        assert_eq!(
            client
                .put(&endpoint)
                .bearer_auth("test-secret")
                .json(&serde_json::json!({"backend":"vulkan","device":"--injected"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let cpu = serde_json::json!({"backend":"cpu","device":null});
        state.status.lock().unwrap().phase = "loading".into();
        assert_eq!(
            client
                .put(&endpoint)
                .bearer_auth("test-secret")
                .json(&cpu)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        state.status.lock().unwrap().phase = "idle".into();
        *state.session.lock().unwrap() = Some(Session {
            id: "active".into(),
            next_start: 0.,
            vocabulary: None,
        });
        assert_eq!(
            client
                .put(&endpoint)
                .bearer_auth("test-secret")
                .json(&cpu)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        state.session.lock().unwrap().take();
        assert_eq!(
            client
                .put(&endpoint)
                .bearer_auth("test-secret")
                .json(&cpu)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            InferenceSettings::load(dir.path()).unwrap(),
            InferenceSettings::recommended(config::PerformancePreset::Balanced)
        );
        let pack = serde_json::json!({"format_version":1,"name":"測試用語","language":"ja","terms":[{"source":"星乃","reading":"ほしの","target":"星乃"}]});
        let imported = client
            .post(format!("{origin}/api/vocabulary/import"))
            .bearer_auth("test-secret")
            .json(&pack)
            .send()
            .await
            .unwrap();
        assert_eq!(imported.status(), StatusCode::OK);
        let imported = imported.json::<serde_json::Value>().await.unwrap();
        let id = imported["profiles"][0]["id"].as_str().unwrap().to_owned();
        assert!(imported["active_id"].is_null());
        let active = client
            .put(format!("{origin}/api/vocabulary/active"))
            .bearer_auth("test-secret")
            .json(&serde_json::json!({"id":id}))
            .send()
            .await
            .unwrap();
        assert_eq!(active.status(), StatusCode::OK);
        assert_eq!(
            VocabularyStore::load(dir.path())
                .unwrap()
                .active_pack()
                .unwrap()
                .name,
            "測試用語"
        );
        state.status.lock().unwrap().ready = true;
        let capture = client
            .post(format!("{origin}/api/session"))
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let capture = capture["id"].as_str().unwrap();
        let duplicate = client
            .post(format!("{origin}/api/session"))
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        assert_eq!(
            state.session.lock().unwrap().as_ref().unwrap().id,
            capture,
            "another profile must not replace the active capture"
        );

        assert_eq!(
            state
                .session
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .vocabulary
                .as_ref()
                .unwrap()
                .name,
            "測試用語"
        );
        assert_eq!(
            client
                .post(format!("{origin}/api/vocabulary/import"))
                .bearer_auth("test-secret")
                .json(&pack)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            client
                .delete(format!("{origin}/api/vocabulary/{id}"))
                .bearer_auth("test-secret")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            client
                .put(format!("{origin}/api/vocabulary/active"))
                .bearer_auth("test-secret")
                .json(&serde_json::json!({"id":null}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        let appearance = client
            .put(format!("{origin}/api/appearance"))
            .bearer_auth("test-secret")
            .json(&serde_json::json!({"theme":"studio","language":"en"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<AppearanceSettings>()
            .await
            .unwrap();
        assert_eq!(appearance.language, UiLanguage::English);
        let appearance = client
            .put(format!("{origin}/api/appearance"))
            .bearer_auth("test-secret")
            .json(&serde_json::json!({"theme":"cinema"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(appearance["theme"], "studio");
        assert_eq!(appearance["language"], "en");
        let appearance = client
            .put(format!("{origin}/api/appearance"))
            .bearer_auth("test-secret")
            .json(&serde_json::json!({"theme":"light"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<AppearanceSettings>()
            .await
            .unwrap();
        assert_eq!(appearance.language, UiLanguage::English);
        assert_eq!(
            AppearanceSettings::load(dir.path()).unwrap(),
            AppearanceSettings {
                theme: UiTheme::Light,
                language: UiLanguage::English,
                onboarding_complete: false,
            }
        );
        client
            .delete(format!("{origin}/api/session/{capture}"))
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap();
        state.status.lock().unwrap().ready = false;
        assert_eq!(
            client
                .delete(format!("{origin}/api/vocabulary/{id}"))
                .bearer_auth("test-secret")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(VocabularyStore::load(dir.path())
            .unwrap()
            .active_pack()
            .is_none());
        assert_eq!(
            client
                .post(format!("{origin}/api/vocabulary/import"))
                .bearer_auth("test-secret")
                .body("not a JSON pack")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .post(format!("{origin}/api/vocabulary/import"))
                .bearer_auth("test-secret")
                .body(vec![b'x'; 262145])
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let csv = serde_json::json!({"format":"csv","name":"交換詞彙","content":"source,target\n星乃,星乃露米\n"});
        let imported = client
            .post(format!("{origin}/api/vocabulary/import"))
            .bearer_auth("test-secret")
            .json(&csv)
            .send()
            .await
            .unwrap();
        assert_eq!(imported.status(), StatusCode::OK);
        let imported = imported.json::<serde_json::Value>().await.unwrap();
        let csv_id = imported["profiles"][0]["id"].as_str().unwrap();
        let exported = client
            .get(format!(
                "{origin}/api/vocabulary/{csv_id}/export?format=tsv"
            ))
            .bearer_auth("test-secret")
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert!(exported["content"]
            .as_str()
            .unwrap()
            .contains("星乃\t星乃露米"));
        assert_eq!(
            client
                .get(format!(
                    "{origin}/api/vocabulary/{csv_id}/export?format=xlsx"
                ))
                .bearer_auth("test-secret")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .post(format!("{origin}/api/models/open"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(models_folder(dir.path()).unwrap().ends_with("models"));
        let response = client.get(&origin).send().await.unwrap();
        assert_eq!(response.headers()["x-frame-options"], "DENY");
        assert!(response.text().await.unwrap().contains("油字幕"));
        for script in ["i18n.js", "backend-i18n.js"] {
            let response = client
                .get(format!("{origin}/{script}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()["content-type"],
                "text/javascript; charset=utf-8"
            );
        }
        // This process-cancellation fixture uses a mutable Linux development runtime.
        // macOS only executes signed, embedded app-bundle workers.
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            use std::os::unix::fs::PermissionsExt;
            let runtime = dir.path().join("runtime/llama-vulkan");
            std::fs::create_dir_all(&runtime).unwrap();
            let worker = runtime.join("llama-server");
            std::fs::write(&worker, "#!/bin/sh\nexec sleep 30\n").unwrap();
            std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o700)).unwrap();
            let request_client = client.clone();
            let devices_url = format!("{origin}/api/devices");
            let pending = tokio::spawn(async move {
                request_client
                    .get(devices_url)
                    .bearer_auth("test-secret")
                    .send()
                    .await
                    .unwrap()
            });
            tokio::time::sleep(Duration::from_millis(100)).await;
            client
                .post(format!("{origin}/api/quit"))
                .bearer_auth("test-secret")
                .send()
                .await
                .unwrap();
            let response = tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .expect("顯卡偵測應在關閉時取消")
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        task.abort();
    }
    #[test]
    fn only_reopens_valid_loopback_player_urls() {
        assert!(valid_player_url(&format!(
            "http://127.0.0.1:1234/#token={}",
            "a".repeat(64)
        )));
        assert!(!valid_player_url("https://evil.example/"));
        assert!(!valid_player_url("http://127.0.0.1:0/#token=bad"));
    }
    #[test]
    fn accepts_real_pcm_duration() {
        assert_eq!(validate_wav(&wav(16000, 1, 80000)).unwrap(), 5.);
    }
    #[test]
    fn rejects_wrong_format_and_overlong_audio() {
        assert!(validate_wav(&wav(48000, 1, 48000)).is_err());
        assert!(validate_wav(&wav(16000, 2, 32000)).is_err());
        assert!(validate_wav(&wav(16000, 1, 208000)).is_err());
        assert!(validate_wav(b"not a wav").is_err());
    }
}
