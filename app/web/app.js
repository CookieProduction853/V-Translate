import { captionsAt, playbackDecision, captureModeSettings, wav16 } from './timeline.js';
import { MAX_QUEUED_AUDIO_SECONDS, initialBackpressure, recordInferenceTiming, beginBackpressure, backpressureStatus, finishBackpressure, settleBackpressure, initialSongBuffer, observeSongBuffer, addCompletedWindow, completedThrough, chooseResumePosition } from './backpressure.js';
import { tr, uiText, getLanguage, initializeTranslations, setLanguage } from './i18n.js';
import { normalizeAdvertisements, nextAdvertisementIndex } from './advertisements.js';

const $ = id => document.getElementById(id);
function updateBrandIcon() {
  const loaded = $('brand-image').complete && $('brand-image').naturalWidth > 0;
  $('brand-image').hidden = !loaded;
  $('brand-icon-fallback').hidden = loaded;
}
$('brand-image').addEventListener('load', updateBrandIcon);
$('brand-image').addEventListener('error', updateBrandIcon);
updateBrandIcon();
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token') || decodeURIComponent(location.hash.slice(1));
let token = hashToken;
try { token = hashToken || sessionStorage.getItem('livesub-token') || ''; if (token) sessionStorage.setItem('livesub-token', token); } catch { /* session storage can be blocked by browser privacy settings */ }
history.replaceState(null, '', location.pathname);
let engineReady = false;
let active = null;
let lastSegments = [];
let statusTimer;
let closing = false;
let onboardingLocked = true;
let latestSetupStatus = null;
let setupRequestError = '';
const presets = {
  low: { whisper_model: 'tiny', cpu_threads: 2, chunk_seconds: 8, buffer_seconds: 14 },
  balanced: { whisper_model: 'base', cpu_threads: 3, chunk_seconds: 6, buffer_seconds: 10 },
  high: { whisper_model: 'small', cpu_threads: 6, chunk_seconds: 5, buffer_seconds: 5 },
};
const defaultSettings = { backend: 'cpu', device: null, translation_model: null, performance: 'high', ...presets.high };
let currentSettings = { ...defaultSettings };
let delayAdjusted = false;
let settingsLoaded = false;
let settingsSaving = false;
let engineBusy = false;
let detectingGpu = false;
let gpuDevices = [];
let platformInfo = { os: /Linux/.test(navigator.userAgent) ? 'linux' : 'windows', arch: 'x86_64', backends: ['cpu', 'vulkan'] };
let settingsRevision = 0;
let gpuDetectionAttempt = -1;
let translationModels = [];
let translationModelsLoaded = false;
let translationModelsBusy = false;
let translationModelsError = '';
let translationModelWarnings = [];
let openingTranslationModels = false;
let vocabularyLoaded = false;
let vocabularyBusy = false;
let vocabularyState = { profiles: [], active_id: null };
const captureProfiles = {
  '720p': { width: 1280, height: 720, frameRate: 20, maxFrameRate: 24, bitrate: 2500000 },
  '1080p': { width: 1920, height: 1080, frameRate: 30, maxFrameRate: 30, bitrate: 8000000 },
  '1440p': { width: 2560, height: 1440, frameRate: 30, maxFrameRate: 30, bitrate: 14000000 },
  source: { frameRate: 30, maxFrameRate: 30 },
};
let captureQualityChosen = false;
let lastCaptureSettings = null;
try {
  const savedQuality = localStorage.getItem('livesub-capture-quality');
  if (Object.hasOwn(captureProfiles, savedQuality)) { $('capture-quality').value = savedQuality; captureQualityChosen = true; }
} catch { /* capture quality still works without storage */ }

initializeTranslations();
let storedLanguage = 'zh-Hant';
try { storedLanguage = localStorage.getItem('livesub-language') || 'zh-Hant'; } catch { /* storage may be blocked */ }
setLanguage(storedLanguage);

function text(id, render) { uiText($(id), render); }
// View changes only toggle existing panels; media and capture resources stay mounted.
function setView(view, focus = false) {
  for (const name of ['player', 'transcript']) {
    const selected = name === view;
    $(`${name}-view`).hidden = !selected;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
  }
  if (focus) $(`${view}-tab`).focus();
  if (view === 'transcript') $('transcript').scrollTop = $('transcript').scrollHeight;
}
for (const [index, name] of ['player', 'transcript'].entries()) {
  $(`${name}-tab`).addEventListener('click', () => setView(name));
  $(`${name}-tab`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
    setView(['player', 'transcript'][next], true);
  });
}
let settingsOpener = null;
function openSettings(opener = $('open-settings')) {
  if (closing) return;
  settingsOpener = opener;
  $('settings-header-controls').append(document.querySelector('.header-controls'));
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
}
$('open-settings').addEventListener('click', () => openSettings());
$('open-engine-settings').addEventListener('click', () => {
  if (closing) return;
  if (!engineReady) { if (!$('setup').disabled) $('setup').click(); }
  else openSettings($('open-engine-settings'));
});
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { document.querySelector('.topbar').append(document.querySelector('.header-controls')); settingsOpener?.focus(); });
function message(value = '') {
  const render = typeof value === 'function' ? value : () => tr(value);
  text('message', render);
  $('message').hidden = !render();
}
function timestamp(seconds, decimals = false) {
  const safe = Math.max(0, seconds || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor(safe / 60) % 60;
  const secs = Math.floor(safe % 60);
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${decimals ? `.${Math.floor((safe % 1) * 1000).toString().padStart(3, '0')}` : ''}`;
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  if (!response.ok) {
    let detail;
    try { const data = await response.json(); detail = data.error || data.detail; } catch { /* response can be plain text */ }
    const error = new Error(detail || `本機程式回應錯誤（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
function updateComputeControls() {
  const locked = !!active || settingsSaving || engineBusy || detectingGpu || translationModelsBusy || !settingsLoaded || closing;
  $('backend').disabled = locked;
  $('capture-quality').disabled = !!active || closing;
  $('translation-model').disabled = locked || !translationModelsLoaded;
  $('refresh-translation-models').disabled = locked;
  $('open-translation-models').disabled = closing || openingTranslationModels;
  $('gpu-device').disabled = locked || !gpuDevices.length;
  $('detect-gpu').disabled = locked || detectingGpu;
  $('gpu-settings').hidden = !isGpuBackend(currentSettings.backend);
  $('start').disabled = locked || vocabularyBusy || !vocabularyLoaded || translationModelMissing();
  $('setup').disabled = locked || engineReady;
  $('open-engine-settings').disabled = !engineReady && $('setup').disabled;
  $('model-settings').disabled = locked;
  updateVocabularyControls();
  $('open-models').disabled = closing;
  updateBrowserTransfer();
}
function applySettings(settings) {
  currentSettings = { ...defaultSettings, ...settings, backend: platformInfo.backends.includes(settings.backend) ? settings.backend : 'cpu', device: settings.device || null, translation_model: typeof settings.translation_model === 'string' && settings.translation_model ? settings.translation_model : null };
  if (!delayAdjusted) {
    $('delay').value = currentSettings.buffer_seconds;
    $('delay-value').textContent = $('delay').value;
  }
  $('backend').value = currentSettings.backend;
  if (!captureQualityChosen) $('capture-quality').value = currentSettings.performance === 'low' ? '720p' : '1080p';
  renderDeviceOptions();
  renderTranslationModels();
  updateComputeControls();
}
function isGpuBackend(backend) { return backend === 'vulkan' || backend === 'metal'; }
function waitingComputeBadge(backend) { return backend === 'metal' ? tr('○ Metal · 待啟動') : backend === 'vulkan' ? tr('○ Vulkan · 待啟動') : tr('○ CPU · 待啟動'); }
function renderPlatform() {
  const select = $('backend');
  select.replaceChildren(new Option(tr('CPU（所有電腦）'), 'cpu'));
  for (const backend of platformInfo.backends) {
    if (backend === 'metal') select.add(new Option(tr('Apple Metal（M 系列）'), 'metal'));
    else if (backend === 'vulkan') select.add(new Option(tr('顯卡 Vulkan（AMD／NVIDIA）'), 'vulkan'));
  }
  select.value = currentSettings.backend;
  if (platformInfo.os === 'macos') {
    const labels = { high: '高效能', balanced: '均衡', low: '入門' };
    for (const option of document.querySelectorAll('#performance option, #first-performance option[value]:not([value=""])')) {
      uiText(option, () => tr(labels[option.value]));
    }
  }
  text('compute-hint', () => platformInfo.backends.includes('metal')
    ? tr('Apple M 系列 Mac 可選「Apple Metal」加速聽寫和翻譯，再按「偵測顯卡」確認裝置。')
    : tr('使用 AMD Radeon／NVIDIA GeForce：先選「顯卡 Vulkan」，再按「偵測顯卡」選取裝置。顯卡同時加速 Whisper 聽寫和文字翻譯。'));
  text('gpu-platform-note', () => platformInfo.backends.includes('metal')
    ? tr('Apple M 系列 Mac 可使用 Metal 加速聽寫和翻譯。若 Metal 無法啟動，請選 CPU 後重新準備 AI。')
    : tr('AMD Radeon（包括 RX 9070）及支援 Vulkan 的 NVIDIA GeForce 可使用顯卡聽寫和翻譯；請更新對應品牌的顯卡驅動，不需另外安裝 CUDA Toolkit。若顯卡模式無法啟動，請選 CPU 後重新準備 AI。'));
  $('macos-capture-hint').hidden = platformInfo.os !== 'macos';
  $('windows-runtime-note').hidden = platformInfo.os !== 'windows';
  text('open-models', () => platformInfo.os === 'macos' ? tr('▧ 在 Finder 開啟模型') : tr('▧ 模型資料夾'));
  text('open-translation-models', () => platformInfo.os === 'macos' ? tr('在 Finder 開啟自訂模型') : tr('開啟自訂模型資料夾'));
}
async function loadPlatform() {
  try {
    const info = await api('/api/platform');
    if (['macos', 'windows', 'linux'].includes(info.os) && Array.isArray(info.backends)) {
      const backends = [...new Set(['cpu', ...info.backends.filter(backend => ['cpu', 'vulkan', 'metal'].includes(backend))])];
      platformInfo = { os: info.os, arch: info.arch, backends };
    }
  } catch { /* older Windows/Linux services do not expose platform capabilities */ }
  renderPlatform();
  text('gpu-detail', () => platformInfo.backends.includes('metal')
    ? tr('按「偵測顯卡」確認 Apple Metal 裝置，再準備 AI 模型。')
    : tr('可先按「偵測顯卡」下載 Vulkan 元件並選取顯卡，再準備 AI 模型。'));
}
function renderDeviceOptions() {
  const selected = currentSettings.device || '';
  const select = $('gpu-device');
  select.replaceChildren(new Option(tr('自動選擇'), ''));
  for (const device of gpuDevices) select.add(new Option(device.name, device.id));
  if (selected && !gpuDevices.some(device => device.id === selected)) select.add(new Option(tr`${selected}（尚未偵測）`, selected));
  select.value = selected;
}
function translationModelMissing() {
  return !!currentSettings.translation_model && translationModelsLoaded && !translationModels.some(model => model.filename === currentSettings.translation_model);
}
function translationModelSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}
function renderTranslationModels() {
  const selected = currentSettings.translation_model || '';
  const select = $('translation-model');
  select.replaceChildren(new Option(tr('內建 Qwen（依效能設定自動選擇）'), ''));
  for (const model of translationModels) {
    const size = translationModelSize(model.size_bytes);
    select.add(new Option(`${model.name || model.filename}${size ? ` · ${size}` : ''}`, model.filename));
  }
  if (selected && !translationModels.some(model => model.filename === selected)) {
    select.add(new Option(translationModelsLoaded ? tr`${selected}（找不到檔案）` : selected, selected));
  }
  select.value = selected;
  $('translation-model-detail').classList.toggle('model-error', translationModelMissing() || !!translationModelsError);
  text('translation-model-detail', () => {
    if (translationModelsError) return tr`無法掃描自訂翻譯模型：${tr(translationModelsError)}`;
    if (!translationModelsLoaded) return tr('正在掃描自訂翻譯模型…');
    const summary = translationModelMissing()
      ? tr`找不到已選模型 ${selected}。請放回檔案後重新掃描，或選擇其他模型；不會自動改用內建模型。`
      : selected ? tr`已選自訂模型：${selected}。變更後請重新準備 AI。`
        : tr`使用內建 Qwen，依效能設定自動選擇。找到 ${translationModels.length} 個自訂模型。`;
    return translationModelWarnings.length ? tr`${summary} 提示：${translationModelWarnings.map(item => tr(item)).join(getLanguage() === 'en' ? '; ' : '；')}` : summary;
  });
}
async function loadTranslationModels() {
  if (closing || translationModelsBusy) return;
  translationModelsBusy = true;
  updateComputeControls();
  text('refresh-translation-models', () => tr('正在掃描…'));
  try {
    const state = await api('/api/translation-models');
    translationModels = Array.isArray(state.models) ? state.models.filter(model => typeof model.filename === 'string' && model.filename) : [];
    translationModelWarnings = Array.isArray(state.warnings) ? state.warnings.filter(item => typeof item === 'string') : [];
    translationModelsLoaded = true;
    translationModelsError = '';
  } catch (error) { translationModelsError = error.message; }
  finally {
    translationModelsBusy = false;
    renderTranslationModels();
    text('refresh-translation-models', () => tr('重新掃描'));
    updateComputeControls();
  }
}
async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    settingsLoaded = true;
    applySettings(settings);
  } catch (error) { message(() => tr`無法讀取運算設定：${tr(error.message)}`); }
  updateComputeControls();
}
async function saveSettings(settings) {
  if (closing) return false;
  settingsRevision++;
  const previous = { ...currentSettings };
  settingsSaving = true;
  updateComputeControls();
  message();
  try {
    const saved = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    applySettings(saved);
    engineReady = false;
    $('engine-dot').classList.remove('ready');
    text('engine-title', () => tr('運算設定已儲存'));
    text('engine-detail', () => tr('請按「準備 AI 模型」載入選定的翻譯引擎。'));
    text('setup', () => tr('準備 AI 模型'));
    text('compute-badge', () => waitingComputeBadge(currentSettings.backend));
    return true;
  } catch (error) {
    applySettings(previous);
    message(() => tr`無法切換運算模式：${tr(error.message)}`);
    return false;
  } finally {
    settingsSaving = false;
    updateComputeControls();
    clearTimeout(statusTimer);
    pollStatus();
  }
}
async function detectDevices(quiet = false) {
  if (detectingGpu || !isGpuBackend(currentSettings.backend)) return;
  detectingGpu = true;
  updateComputeControls();
  text('detect-gpu', () => tr('正在偵測…'));
  try {
    const response = await api('/api/devices', { method: quiet || engineReady ? 'GET' : 'POST' });
    gpuDevices = Array.isArray(response.devices) ? response.devices.filter(device => typeof device.id === 'string' && typeof device.name === 'string') : [];
    renderDeviceOptions();
    text('gpu-detail', () => gpuDevices.length ? tr('可選擇要用於翻譯的顯卡。變更後請重新準備 AI。') : currentSettings.backend === 'metal' ? tr('沒有找到可用的 Apple Metal 裝置。可切回 CPU 後重新準備 AI。') : tr('沒有找到可用的 Vulkan 顯卡。可更新顯卡驅動，或切回 CPU。'));
  } catch (error) {
    text('gpu-detail', () => tr(error.message));
    if (!quiet) message(() => tr`顯卡偵測未完成：${tr(error.message)}`);
  } finally {
    detectingGpu = false;
    text('detect-gpu', () => tr('偵測顯卡'));
    updateComputeControls();
  }
}
async function pollStatus() {
  if (closing) return;
  const revision = settingsRevision;
  try {
    const status = await api('/api/status');
    if (closing) return;
    if (status.phase === 'paused') {
      await stopCapture();
      if (!onboardingLocked && !$('idle-overlay').open) $('idle-overlay').showModal();
    } else if (status.ready && $('idle-overlay').open) { $('idle-overlay').close(); }
    if ($('idle-overlay').open && status.error) { text('resume-error', () => tr(status.error)); $('resume-error').hidden = false; }
    if (active && (status.phase === 'error' || status.error)) recoverEngines(active);
    if (!settingsSaving && revision === settingsRevision) {
      latestSetupStatus = status;
      renderFirstPreparation();
      engineReady = !!status.ready;
      engineBusy = !engineReady && !status.error && !['idle', 'paused', 'error', 'failed'].includes(status.phase);
      const backend = status.backend || currentSettings.backend;
      text('compute-badge', () => engineReady ? backend === 'metal' ? tr('● Metal GPU · 本機處理') : isGpuBackend(backend) ? tr('● GPU · 本機翻譯') : tr('● CPU · 本機處理') : waitingComputeBadge(backend));
      $('engine-dot').classList.toggle('ready', engineReady);
      const progress = typeof status.progress === 'number' && status.progress > 0 ? ` · ${Math.round(status.progress <= 1 ? status.progress * 100 : status.progress)}%` : '';
      text('engine-title', () => engineReady ? tr('本機 AI 已就緒') : status.phase === 'paused' ? tr('Whisper 已暫停') : status.error ? tr('AI 準備失敗') : status.phase === 'idle' ? tr('請準備 AI 模型') : tr`正在準備 AI${progress}`);
      const device = () => engineReady && isGpuBackend(backend) && status.device ? tr`AI 顯卡：${status.device}。` : '';
      text('engine-detail', () => status.error ? `${isGpuBackend(backend) ? tr('顯卡模式未啟動，可選 CPU 後重新準備。') : ''}${tr(status.error)}` : `${device()}${status.detail ? tr(status.detail) : (engineReady ? tr('可以選擇直播分頁') : tr('下載期間請保持本機程式開啟'))}`);
      text('setup', () => engineReady ? tr('模型已就緒 ✓') : engineBusy ? tr('正在準備…') : tr('準備 AI 模型'));
      if (engineReady && isGpuBackend(backend)) {
        text('gpu-detail', () => status.device ? tr`目前使用：${status.device}` : tr('顯卡翻譯引擎已啟動。'));
        if (!gpuDevices.length && gpuDetectionAttempt !== settingsRevision) { gpuDetectionAttempt = settingsRevision; detectDevices(true); }
      }
    }
  } catch (error) {
    if (revision === settingsRevision) {
      latestSetupStatus = { phase: 'error', error: error.message };
      renderFirstPreparation();
    }
    engineReady = false;
    engineBusy = false;
    $('engine-dot').classList.remove('ready');
    text('engine-title', () => tr('無法連接本機程式'));
    text('engine-detail', () => token ? tr('請重新開啟油字幕執行檔，再使用新開啟的播放器。') : tr('請從油字幕執行檔開啟此播放器。'));
  }
  $('engine-detail').title = $('engine-detail').textContent;
  $('resume-whisper').disabled = engineBusy;
  updateComputeControls();
  statusTimer = setTimeout(pollStatus, 1800);
}
$('backend').addEventListener('change', () => saveSettings({ ...currentSettings, backend: $('backend').value, device: null }));
$('gpu-device').addEventListener('change', () => saveSettings({ ...currentSettings, device: $('gpu-device').value || null }));
$('detect-gpu').addEventListener('click', () => detectDevices());
$('translation-model').addEventListener('change', async () => {
  if (active || settingsSaving || engineBusy || detectingGpu || closing) { renderTranslationModels(); return; }
  const selected = $('translation-model').value || null;
  if (selected !== currentSettings.translation_model) await saveSettings({ ...currentSettings, translation_model: selected });
});
$('refresh-translation-models').addEventListener('click', () => { if (!active) loadTranslationModels(); });
$('open-translation-models').addEventListener('click', async () => {
  if (closing || openingTranslationModels) return;
  openingTranslationModels = true;
  updateComputeControls();
  try {
    const result = await api('/api/translation-models/open', { method: 'POST' });
    text('translation-model-path', () => result.path || 'models/translation');
    $('translation-model-path').hidden = false;
    if (!result.opened) message(() => tr('未能自動開啟資料夾，可複製畫面上的模型路徑。'));
  } catch (error) { message(() => tr`無法開啟自訂模型資料夾：${tr(error.message)}`); }
  finally { openingTranslationModels = false; updateComputeControls(); }
});
async function prepareModels() {
  if (active || closing) return;
  setupRequestError = '';
  if (translationModelMissing()) {
    setupRequestError = tr`找不到已選模型 ${currentSettings.translation_model}。請放回檔案後重新掃描，或選擇其他模型；不會自動改用內建模型。`;
    message(setupRequestError);
    renderFirstPreparation();
    return;
  }
  message();
  settingsRevision++;
  engineBusy = true;
  latestSetupStatus = null;
  renderFirstPreparation();
  updateComputeControls();
  try { await api('/api/setup', { method: 'POST' }); clearTimeout(statusTimer); pollStatus(); }
  catch (error) {
    engineBusy = false;
    setupRequestError = error.message;
    renderFirstPreparation();
    message(() => tr`無法準備 AI：${tr(error.message)}`);
    updateComputeControls();
  }
}
function presetDescription() {
  text('preset-detail', () => {
    const performance = $('performance').value;
    const description = performance === 'low'
      ? tr('tiny 聽寫、2 執行緒。起始緩衝 14 秒（8 秒音訊＋6 秒後備）。')
      : performance === 'high'
        ? tr('small 聽寫、6 執行緒。起始緩衝 5 秒，音訊片段 5 秒。')
        : tr('base 聽寫、3 執行緒。起始緩衝 10 秒（6 秒音訊＋4 秒後備）。');
    return currentSettings.translation_model
      ? tr`${description} 翻譯使用自訂模型：${currentSettings.translation_model}，資源需求與品質依模型而異。`
      : tr`${description} 翻譯使用內建 Qwen ${performance === 'low' ? '0.5B' : '1.5B'}。`;
  });
}
function fillAdvanced(settings) {
  $('whisper-model').value = settings.whisper_model;
  $('cpu-threads').value = settings.cpu_threads;
  $('chunk-seconds').value = settings.chunk_seconds;
  $('buffer-seconds').value = settings.buffer_seconds;
  updateValidation();
}
function updateValidation() {
  for (const id of ['cpu-threads', 'chunk-seconds', 'buffer-seconds']) {
    const input = $(id);
    input.setCustomValidity('');
    if (!input.validity.valid) input.setCustomValidity(tr`請輸入 ${input.min} 到 ${input.max} 之間的整數。`);
  }
}
['cpu-threads', 'chunk-seconds', 'buffer-seconds'].forEach(id => $(id).addEventListener('input', updateValidation));
$('setup-form').addEventListener('invalid', updateValidation, true);
function openModelSettings() {
  if (active || settingsSaving || engineBusy || closing) return;
  $('performance').value = currentSettings.performance;
  fillAdvanced(currentSettings);
  presetDescription();
  $('setup-error').hidden = true;
  $('setup-dialog').showModal();
}
async function commitModelSettings(prepare) {
  if (!$('setup-form').reportValidity() || settingsSaving) return;
  const settings = { ...currentSettings, performance: $('performance').value, whisper_model: $('whisper-model').value, cpu_threads: Number($('cpu-threads').value), chunk_seconds: Number($('chunk-seconds').value), buffer_seconds: Number($('buffer-seconds').value) };
  if (settings.buffer_seconds < settings.chunk_seconds) {
    text('setup-error', () => tr('起始緩衝必須大於或等於每段音訊長度。'));
    $('setup-error').hidden = false;
    return;
  }
  $('save-model-settings').disabled = true;
  $('save-and-setup').disabled = true;
  const saved = await saveSettings(settings);
  $('save-model-settings').disabled = false;
  $('save-and-setup').disabled = false;
  if (!saved) return;
  $('setup-dialog').close();
  if (prepare) await prepareModels();
}
$('idle-overlay').addEventListener('cancel', event => event.preventDefault());
$('resume-whisper').addEventListener('click', async () => {
  $('resume-whisper').disabled = true;
  $('resume-error').hidden = true;
  try {
    await api('/api/setup', { method: 'POST' });
    clearTimeout(statusTimer);
    pollStatus();
  } catch (error) {
    text('resume-error', () => tr(error.message));
    $('resume-error').hidden = false;
    $('resume-whisper').disabled = false;
  }
});
$('setup').addEventListener('click', openModelSettings);
$('model-settings').addEventListener('click', openModelSettings);
$('close-model-settings').addEventListener('click', () => $('setup-dialog').close());
$('performance').addEventListener('change', () => { fillAdvanced(presets[$('performance').value]); presetDescription(); });
$('apply-preset-buffer').addEventListener('click', () => {
  const preset = presets[$('performance').value];
  $('chunk-seconds').value = preset.chunk_seconds;
  $('buffer-seconds').value = preset.buffer_seconds;
  updateValidation();
});
$('save-model-settings').addEventListener('click', () => commitModelSettings(false));
$('setup-form').addEventListener('submit', event => { event.preventDefault(); commitModelSettings(true); });

function setCaptureControls(on) {
  $('pause').disabled = !on;
  $('stop').disabled = !on;
  $('language').disabled = on;
  $('target').disabled = on;
  $('delay').disabled = on;
  $('empty').hidden = on;
  $('player-state').hidden = !on;
  updateComputeControls();
}
function captureVideoOptions(quality) {
  const profile = captureProfiles[quality] || captureProfiles['1080p'];
  const options = { displaySurface: 'browser', frameRate: { ideal: profile.frameRate, max: profile.maxFrameRate } };
  if (profile.width) { options.width = { ideal: profile.width, max: profile.width }; options.height = { ideal: profile.height, max: profile.height }; }
  return options;
}
function captureVideoBitrate(quality, settings) {
  const profile = captureProfiles[quality] || captureProfiles['1080p'];
  if (profile.bitrate) return profile.bitrate;
  const pixelsPerSecond = (settings.width || 1920) * (settings.height || 1080) * Math.min(30, settings.frameRate || 30);
  return Math.round(Math.min(24000000, Math.max(12000000, pixelsPerSecond * 0.14)));
}
function renderCaptureQualityDetail() {
  text('capture-quality-detail', () => !lastCaptureSettings ? tr('開始擷取後顯示實際解析度。')
    : lastCaptureSettings.width && lastCaptureSettings.height
      ? lastCaptureSettings.frameRate > 0
        ? tr`實際擷取：${lastCaptureSettings.width} × ${lastCaptureSettings.height} · ${Math.round(lastCaptureSettings.frameRate)} fps。`
        : tr`實際擷取：${lastCaptureSettings.width} × ${lastCaptureSettings.height}。`
      : tr('瀏覽器未提供實際擷取解析度。'));
}
$('capture-quality').addEventListener('change', () => {
  if (active || closing) { $('capture-quality').value = active?.captureQuality || $('capture-quality').value; return; }
  captureQualityChosen = true;
  lastCaptureSettings = null;
  renderCaptureQualityDetail();
  try { localStorage.setItem('livesub-capture-quality', $('capture-quality').value); } catch { /* the selection remains usable */ }
});
function captureError(error) {
  if (platformInfo.os === 'macos' && ['NotAllowedError', 'NotReadableError'].includes(error.name)) return tr('分享已取消或 macOS 未允許擷取。請在「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」允許 Chrome／Edge，必要時重新開啟瀏覽器，再選擇直播分頁並分享分頁音訊。');
  if (error.name === 'NotAllowedError') return tr('已取消分享，或瀏覽器未允許擷取。請重新選擇直播分頁，並勾選分享分頁音訊。');
  if (error.name === 'NotReadableError') return tr('瀏覽器無法擷取這個分頁。請確認系統允許螢幕錄製，並選擇正常播放的直播。');
  return (error.message && tr(error.message)) || tr('無法開始擷取，請改用最新版 Chrome 或 Edge。');
}
async function startCapture(mode) {
  if (active || closing) return;
  message();
  if (translationModelMissing()) { message(() => tr`找不到已選模型 ${currentSettings.translation_model}。請放回檔案後重新掃描，或選擇其他模型；不會自動改用內建模型。`); return; }
  if (!engineReady) { message(() => tr('請先開啟右上角 Settings 齒輪，準備 AI 模型後再選擇直播分頁。')); openSettings(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaSource || !window.MediaRecorder || !window.AudioWorkletNode) {
    message(() => tr('此瀏覽器不支援需要的影音擷取功能。請使用最新版 Chrome 或 Edge，在同一個瀏覽器內開啟直播與播放器。')); return;
  }
  if (/Firefox\//.test(navigator.userAgent)) {
    message(() => tr('Firefox 目前無法提供這個播放器需要的分頁音訊。請用 Chrome 或 Edge 開啟直播與播放器。')); return;
  }
  if (platformInfo.os === 'macos' && /Safari\//.test(navigator.userAgent) && !/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)) {
    message(() => tr('Safari 無法提供此播放器需要的分頁音訊。請改用最新版 Chrome／Edge，並允許 macOS 螢幕與系統音訊錄製。')); return;
  }
  const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus'].find(type => MediaRecorder.isTypeSupported(type) && MediaSource.isTypeSupported(type));
  if (!mime) { message(() => tr('這個瀏覽器缺少 WebM 影音錄製／播放支援，請更新 Chrome 或 Edge。')); return; }
  const session = { id: null, stream: null, recorder: null, context: null, worklet: null, media: null, url: null, sourceBuffer: null, mediaQueue: [], mediaBytes: 0, audioQueue: [], processing: false, segments: [], readyUntil: 0, primed: false, playing: true, timer: null, frame: null, stopped: false, abort: new AbortController(), appendChain: Promise.resolve(), delay: Number($('delay').value), chunkSeconds: currentSettings.chunk_seconds, sourceLanguage: $('language').value, target: $('target').value, nextTrim: 0, silentChunks: 0, recovering: false, recoveryNextAt: 0, bypassSubtitles: false, quotaTrims: 0, pressure: initialBackpressure(currentSettings.performance), completed: [], rejoinFloor: 0, audioCutoff: 0, resumePending: false };
  session.preview = null;
  session.skipPreviewUntil = 0;
  session.captureQuality = $('capture-quality').value;
  session.mode = mode;
  session.previousWaitForSubtitles = $('wait-subtitles').checked;
  active = session;
  updateComputeControls();
  try {
    // This call must run directly in the button's user gesture, before the first await.
    session.stream = await navigator.mediaDevices.getDisplayMedia({
      video: captureVideoOptions(session.captureQuality),
      audio: { suppressLocalAudioPlayback: true },
      selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', systemAudio: 'exclude', preferCurrentTab: false,
    });
    if (session.stopped) { session.stream.getTracks().forEach(track => track.stop()); return; }
    const videoTrack = session.stream.getVideoTracks()[0];
    videoTrack?.addEventListener('ended', () => stopCapture(session));
    try { if (videoTrack) videoTrack.contentHint = 'detail'; } catch { /* older browsers may not expose content hints */ }
    session.videoSettings = videoTrack?.getSettings() || {};
    lastCaptureSettings = { ...session.videoSettings };
    renderCaptureQualityDetail();
    session.stream.getAudioTracks()[0]?.addEventListener('ended', () => failSession(session, () => tr('來源分頁的音訊分享已結束，請重新選擇直播分頁。')));
    if (!session.stream.getAudioTracks().length) throw new Error('沒有收到直播音訊。請選擇「Chrome／Edge 分頁」，勾選「分享分頁音訊」，不要選整個螢幕或視窗。');
    const surface = session.stream.getVideoTracks()[0]?.getSettings().displaySurface;
    if (surface && surface !== 'browser') throw new Error('請分享直播的瀏覽器「分頁」。整個螢幕或視窗擷取可能把播放器自己的聲音再次收進來。');
    const captureSettings = session.stream.getAudioTracks()[0].getSettings();
    if (captureSettings.suppressLocalAudioPlayback !== true) message(() => tr('瀏覽器未確認已停播來源分頁的聲音。若聽到直播和延遲影音重疊，請檢查來源分頁的靜音設定；如果靜音後字幕停止，請取消靜音並重新選擇分頁音訊。'));
    const created = await api('/api/session', { method: 'POST', signal: session.abort.signal });
    session.id = created.id;
    session.chunkSeconds = created.chunk_seconds || currentSettings.chunk_seconds;
    if (!delayAdjusted && Number.isFinite(created.buffer_seconds)) session.delay = created.buffer_seconds;
    Object.assign(session, captureModeSettings(mode, session.delay, session.chunkSeconds, presets[currentSettings.performance]));
    session.songBuffer = mode === 'song' ? initialSongBuffer(session.delay) : null;
    if (session.stopped) return;
    session.context = new AudioContext();
    await session.context.audioWorklet.addModule('/audio-worklet.js');
    if (session.stopped) return;
    const source = session.context.createMediaStreamSource(new MediaStream(session.stream.getAudioTracks()));
    session.worklet = new AudioWorkletNode(session.context, 'tab-audio');
    const muted = session.context.createGain(); muted.gain.value = 0;
    source.connect(session.worklet).connect(muted).connect(session.context.destination);
    $('live-source').hidden = false;
    renderLiveSource('', false);
    session.worklet.port.onmessage = event => {
      if (session.stopped) return;
      if (event.data.preview) {
        if (mode !== 'replay') requestPreview(session, event.data);
        return;
      }
      const samples = new Int16Array(event.data.samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / samples.length);
      session.silentChunks = rms < 0.001 ? session.silentChunks + 1 : 0;
      if (session.silentChunks === 3) {
        const silentSeconds = session.chunkSeconds * 3;
        message(() => tr`連續 ${silentSeconds} 秒沒有偵測到明顯音訊。若直播正在說話，請確認已勾選「分享分頁音訊」，並檢查來源分頁是否被靜音。`);
      }
      session.audioQueue.push(event.data);
      trimAudioQueue(session);
      processAudio(session);
    };
    session.media = new MediaSource();
    session.url = URL.createObjectURL(session.media);
    const video = $('video');
    const opened = new Promise((resolve, reject) => {
      session.media.addEventListener('sourceopen', resolve, { once: true });
      session.abort.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    });
    video.src = session.url;
    setPlaybackVolume(Number($('volume').value));
    await opened;
    if (session.stopped) return;
    session.sourceBuffer = session.media.addSourceBuffer(mime);
    session.sourceBuffer.mode = 'segments';
    session.sourceBuffer.addEventListener('updateend', () => drainMedia(session));
    session.sourceBuffer.addEventListener('error', () => failSession(session, () => tr('瀏覽器無法接續播放擷取的影音，請重新選擇分頁。')));
    session.media.addEventListener('sourceended', () => { if (!session.stopped) failSession(session, () => tr('影音來源已結束，請重新選擇直播分頁。')); });
    session.recorder = new MediaRecorder(session.stream, { mimeType: mime, videoBitsPerSecond: captureVideoBitrate(session.captureQuality, session.videoSettings), audioBitsPerSecond: session.songBuffer ? 256000 : 128000 });
    session.recorder.addEventListener('dataavailable', event => {
      if (!event.data.size || session.stopped) return;
      // Activity comes from captured media, not UI polling or speech volume.
      if (!session.heartbeatAt || Date.now() - session.heartbeatAt >= 15000) {
        session.heartbeatAt = Date.now();
        api(`/api/session/${encodeURIComponent(session.id)}`, { method: 'POST', signal: session.abort.signal }).catch(() => {});
      }
      session.appendChain = session.appendChain.then(async () => {
        const data = await event.data.arrayBuffer();
        if (session.stopped) return;
        session.mediaBytes += data.byteLength;
        session.mediaQueue.push(data);
        drainMedia(session);
      }).catch(error => failSession(session, () => tr`無法讀取影音：${tr(error.message)}`));
    });
    session.recorder.addEventListener('error', () => failSession(session, () => tr('分頁影音錄製中斷。請保持直播分頁播放，再重新選擇分頁。')));
    await session.context.resume();
    if (session.stopped) return;
    // Both clocks begin in the same turn. The fine adjustment control covers browser start jitter.
    session.recorder.start(1000);
    session.worklet.port.postMessage({ type: 'start', chunkSeconds: session.chunkSeconds });
    lastSegments = session.segments;
    $('transcript').replaceChildren();
    $('export').disabled = true;
    setCaptureControls(true);
    if (mode === 'replay') {
      $('wait-subtitles').checked = true;
      $('wait-subtitles').disabled = true;
    }
    const title = document.querySelector(`[data-capture-mode="${mode}"] strong`);
    const initialDelay = session.delay;
    const chunkSeconds = session.chunkSeconds;
    text('capture-mode-status', () => tr`本次擷取：${title.textContent} · 起始緩衝 ${initialDelay} 秒 · 每段音訊 ${chunkSeconds} 秒`);
    $('capture-mode-status').hidden = false;
    text('pause', () => tr('暫停'));
    session.timer = setInterval(() => updatePlayback(session), 180);
    const draw = () => {
      if (session.stopped) return;
      renderCaptions(session);
      session.frame = requestAnimationFrame(draw);
    };
    draw();
    updatePlayback(session);
  } catch (error) {
    await stopCapture(session);
    if (error.name !== 'AbortError') message(() => captureError(error));
  }
}
function drainMedia(session) {
  const buffer = session.sourceBuffer;
  if (session.stopped || !buffer || buffer.updating || session.media?.readyState !== 'open') return;
  const current = $('video').currentTime;
  if (buffer.buffered.length && current > 35 && buffer.buffered.start(0) < current - 35 && current >= session.nextTrim) {
    session.nextTrim = current + 10;
    try { buffer.remove(buffer.buffered.start(0), current - 30); return; }
    catch { /* append may continue if this browser cannot trim yet */ }
  }
  const data = session.mediaQueue[0];
  if (!data) return;
  try {
    buffer.appendBuffer(data);
    session.mediaQueue.shift();
    session.mediaBytes -= data.byteLength;
    session.quotaTrims = 0;
  } catch (error) {
    if (error.name === 'QuotaExceededError' && buffer.buffered.length && session.quotaTrims++ < 3) {
      const end = buffer.buffered.end(buffer.buffered.length - 1);
      const start = buffer.buffered.start(0);
      const keepFrom = Math.max(start, end - Math.min(120, (end - start) / 2));
      if (keepFrom > buffer.buffered.start(0) + 1) {
        startCatchup(session);
        session.rejoinFloor = Math.max(session.rejoinFloor, keepFrom + 1);
        session.primed = true;
        if (current < keepFrom + 1) $('video').currentTime = keepFrom + 1;
        if (session.pressure.phase !== 'cooldown') message(() => tr('已清理較早的影音緩衝，來源分享保持連線。'));
        try { buffer.remove(buffer.buffered.start(0), keepFrom); return; } catch { /* a real buffer failure is handled below */ }
      }
    }
    failSession(session, () => error.name === 'QuotaExceededError' ? tr('瀏覽器無法釋放影音緩衝空間。請重新選擇直播分頁。') : tr`影音播放失敗：${tr(error.message)}`);
  }
}
function showCatchupCountdown(session, status) {
  const remaining = status.remainingSeconds;
  const total = status.totalSeconds;
  const manuallyPaused = !session.playing;
  $('buffer-cover').hidden = false;
  $('catchup-countdown').hidden = false;
  text('catchup-countdown', () => tr`${remaining} 秒`);
  text('buffer-title', () => tr('AI 正在追趕，暫停播放'));
  text('buffer-detail', () => manuallyPaused
    ? tr`本次預計緩衝 ${total} 秒。已手動暫停，倒數結束後仍會保持暫停。`
    : tr`本次預計緩衝 ${total} 秒，倒數後自動繼續。擷取及 AI 處理保持運作。`);
  text('playback-label', () => tr`AI 緩衝 · 剩餘 ${remaining} 秒`);
}
function startCatchup(session) {
  if (session.stopped) return false;
  const next = beginBackpressure(session.pressure, performance.now());
  if (next === session.pressure) return false;
  session.pressure = next;
  const queue = session.audioQueue;
  const current = $('video').currentTime;
  const newest = queue.at(-1)?.end ?? current;
  const cutoff = Math.max(current, newest - next.baseSeconds);
  while (queue.length && queue[0].end <= cutoff) queue.shift();
  session.rejoinFloor = Math.max(current, queue[0]?.start ?? current);
  session.audioCutoff = Math.max(session.audioCutoff, session.rejoinFloor);
  session.resumePending = true;
  session.bypassSubtitles = true;
  $('video').pause();
  const total = next.totalSeconds;
  message(() => tr`AI 暫時落後，先暫停播放並緩衝約 ${total} 秒；擷取保持連線，AI 會繼續處理較新的音訊。`);
  showCatchupCountdown(session, backpressureStatus(next, performance.now()));
  return true;
}
function trimAudioQueue(session) {
  const queue = session.audioQueue;
  const newest = queue.at(-1)?.end ?? 0;
  const current = $('video').currentTime;
  if (queue.length && (newest - queue[0].start > MAX_QUEUED_AUDIO_SECONDS || queue[0].end < current - 5)) startCatchup(session);
  const cutoff = Math.max(newest - MAX_QUEUED_AUDIO_SECONDS, current - 5, session.audioCutoff);
  while (queue.length && queue[0].end <= cutoff) queue.shift();
}
function resumeCatchup(session, ranges) {
  const video = $('video');
  const result = chooseResumePosition({ ranges, completed: session.completed, current: video.currentTime, floor: session.rejoinFloor, delay: session.delay });
  session.resumePending = result.waitingForMedia;
  if (result.waitingForMedia) return;
  if (result.position > video.currentTime + 0.05) video.currentTime = result.position;
  session.primed = true;
  const offset = Math.max(0, Number($('offset').value));
  session.bypassSubtitles = !result.captionsReady || result.readyUntil - result.position - offset < Math.max(1, session.chunkSeconds - 0.1);
  trimAudioQueue(session);
  const manuallyPaused = !session.playing;
  if (session.bypassSubtitles) message(() => manuallyPaused
    ? tr('緩衝倒數已完成，仍保持手動暫停。AI 仍在追趕，部分內容可能暫時沒有字幕。')
    : tr('緩衝倒數已完成，影音會繼續播放；AI 仍在追趕，部分內容可能暫時沒有字幕。'));
  else message();
}
async function recoverEngines(session) {
  if (session.stopped || session.recovering || Date.now() < session.recoveryNextAt) return;
  session.recoveryNextAt = Date.now() + 15000;
  session.recovering = true;
  message(() => tr('AI 引擎暫時中斷，正在重新啟動現有模型。播放器與來源分享會保持連線。'));
  try { await api('/api/recover', { method: 'POST', signal: session.abort.signal }); }
  catch (error) { if (!session.stopped) message(() => tr`AI 暫時無法重新啟動：${tr(error.message)}。影音分享仍在繼續，字幕會自動重試。`); }
  finally { session.recovering = false; }
}
function retryDelay(session, milliseconds) {
  return new Promise((resolve, reject) => {
    if (session.stopped) { reject(new DOMException('Stopped', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
    const timer = setTimeout(() => { session.abort.signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    session.abort.signal.addEventListener('abort', onAbort, { once: true });
  });
}
function renderLiveSource(source, confirmed) {
  text('live-source-label', () => getLanguage() === 'en'
    ? (confirmed ? 'Live source · confirmed' : 'Live source · provisional')
    : (confirmed ? '即時原文 · 已確認' : '即時原文 · 暫定'));
  $('live-source-text').textContent = source || '…';
}
function requestPreview(session, chunk) {
  if (session.preview || session.processing || session.audioQueue.length || performance.now() < session.skipPreviewUntil) return;
  const query = new URLSearchParams({ session: session.id, start: chunk.start, language: session.sourceLanguage, target: session.target, preview: 'true' });
  const began = performance.now();
  session.preview = api(`/api/transcribe?${query}`, {
    method: 'POST', body: wav16(new Int16Array(chunk.samples)),
    headers: { 'Content-Type': 'audio/wav' }, signal: session.abort.signal,
  }).then(data => {
    if (session.stopped) return;
    const source = data.segments.map(item => item.text).filter(Boolean).join(' ');
    if (source) renderLiveSource(source, false);
  }).catch(() => {
    // A missing preview never interrupts finalized subtitles.
  }).finally(() => {
    const elapsed = performance.now() - began;
    if (elapsed > 850) session.skipPreviewUntil = performance.now() + elapsed;
    session.preview = null;
  });
}
async function processAudio(session) {
  if (session.processing || session.stopped) return;
  session.processing = true;
  try {
    await session.preview;
    while (!session.stopped && session.audioQueue.length) {
      const chunk = session.audioQueue.shift();
      const query = new URLSearchParams({ session: session.id, start: chunk.start, language: session.sourceLanguage, target: session.target });
      if (session.mode === 'replay') query.set('replay', 'true');
      const body = wav16(new Int16Array(chunk.samples));
      let data;
      let retries = 0;
      while (!session.stopped) {
        try {
          data = await api(`/api/transcribe?${query}`, { method: 'POST', body, headers: { 'Content-Type': 'audio/wav' }, signal: session.abort.signal });
          session.recoveryNextAt = 0;
          break;
        } catch (error) {
          if (session.stopped || error.name === 'AbortError') throw error;
          if (error.status === 503) await recoverEngines(session);
          const transient = !error.status || [429, 500, 502, 503, 504].includes(error.status);
          if (!transient) {
            message(() => tr`這段字幕無法處理：${tr(error.message)}。影音繼續，將嘗試下一段音訊。`);
            session.readyUntil = Math.max(session.readyUntil, chunk.end);
            session.bypassSubtitles = true;
            break;
          }
          const seconds = [2, 5, 10, 15][Math.min(retries++, 3)];
          message(() => tr`AI 字幕暫時中斷：${tr(error.message)}。${seconds} 秒後重試同一段音訊；影音分享保持連線。`);
          await retryDelay(session, seconds * 1000);
          trimAudioQueue(session);
          if (chunk.end <= session.audioCutoff || chunk.end < $('video').currentTime - 5 || (session.audioQueue.at(-1)?.end || 0) - chunk.end > MAX_QUEUED_AUDIO_SECONDS) {
            startCatchup(session);
            break;
          }
        }
      }
      if (session.stopped) return;
      if (!data) continue;
      const segments = Array.isArray(data.segments) ? data.segments.filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && typeof item.text === 'string') : [];
      renderLiveSource(segments.map(item => item.text).filter(Boolean).join(' '), true);
      session.segments.push(...segments);
      // An empty result still means that this window has been checked (it may be silence).
      session.readyUntil = Math.max(session.readyUntil, chunk.end);
      session.completed = addCompletedWindow(session.completed, chunk.start, chunk.end);
      session.pressure = recordInferenceTiming(session.pressure, Number(data.elapsed_ms), chunk.end - chunk.start);
      if (session.segments.length > 4000) session.segments.splice(0, session.segments.length - 4000);
      $('processed').textContent = timestamp(session.readyUntil);
      const elapsedSeconds = ((data.elapsed_ms || 0) / 1000).toFixed(1);
      const audioSeconds = (chunk.end - chunk.start).toFixed(0);
      text('inference-time', () => tr`${elapsedSeconds} 秒 / ${audioSeconds} 秒音訊`);
      if (Array.isArray(data.warnings) && data.warnings.length) message(() => tr`字幕提示：${data.warnings.filter(item => typeof item === 'string').map(item => tr(item)).join(getLanguage() === 'en' ? '; ' : '；')}`);
      appendTranscript(segments);
      $('export').disabled = !session.segments.length;
    }
  } catch (error) {
    if (!session.stopped && error.name !== 'AbortError') message(() => tr`字幕暫時無法處理：${tr(error.message)}。影音分享保持連線。`);
  } finally { session.processing = false; }
}
function updatePlayback(session) {
  if (session.stopped) return;
  const video = $('video');
  const buffered = video.buffered;
  const ranges = Array.from({ length: buffered.length }, (_, index) => [buffered.start(index), buffered.end(index)]);
  const end = ranges.at(-1)?.[1] ?? 0;
  let current = video.currentTime;
  let lead = end - current;
  const now = performance.now();
  if (lead >= 180 && completedThrough(session.completed, current) < current + session.chunkSeconds) startCatchup(session);
  if (lead > 210) {
    startCatchup(session);
    // Seeking while paused lets MediaSource discard old frames without ever
    // detaching the capture source or discarding undecodable WebM pieces.
    const safe = chooseResumePosition({ ranges, completed: [], current, floor: end - 180, delay: 180 });
    if (!safe.waitingForMedia) video.currentTime = current = safe.position;
    session.rejoinFloor = Math.max(session.rejoinFloor, current);
    lead = end - current;
    trimAudioQueue(session);
  }
  const pressure = backpressureStatus(session.pressure, now);
  if (pressure.active) {
    if (session.songBuffer) observeSongBuffer(session.songBuffer, now, false);
    if (!video.paused) video.pause();
    showCatchupCountdown(session, pressure);
    text('live-delay', () => tr`比擷取來源延遲約 ${Math.max(0, lead).toFixed(1)} 秒`);
    return;
  }
  if (pressure.expired) session.pressure = finishBackpressure(session.pressure);
  if (session.resumePending) resumeCatchup(session, ranges);
  current = video.currentTime;
  lead = end - current;
  const checkedThrough = completedThrough(session.completed, current);
  if (session.bypassSubtitles && checkedThrough >= current + session.chunkSeconds + Math.max(0, Number($('offset').value))) session.bypassSubtitles = false;
  session.pressure = settleBackpressure(session.pressure, { now, healthy: !session.resumePending && !session.bypassSubtitles && checkedThrough >= current + 1 && lead < Math.max(60, session.delay * 2) && (session.audioQueue.at(-1)?.end ?? current) - (session.audioQueue[0]?.start ?? current) < 30 });
  let decision = session.resumePending && session.playing
    ? { play: false, reason: 'buffering' }
    : playbackDecision({ playing: session.playing, current, bufferedEnd: end, delay: session.delay, readyUntil: session.bypassSubtitles ? session.readyUntil : checkedThrough - Math.max(0, Number($('offset').value)), waitForSubtitles: $('wait-subtitles').checked && !session.bypassSubtitles, primed: session.primed });
  const waitingForData = session.primed && !session.resumePending && ['buffering', 'inference'].includes(decision.reason);
  if (session.songBuffer && observeSongBuffer(session.songBuffer, now, waitingForData)) {
    session.delay = session.songBuffer.delay;
    session.primed = false;
    decision = { play: false, reason: 'buffering' };
    const delay = session.delay;
    text('song-mode-status', () => tr`歌回音質模式已把本次緩衝增至 ${delay} 秒。`);
    $('song-mode-status').hidden = false;
  }
  if (decision.play && video.paused) {
    session.primed = true;
    video.play().catch(error => {
      if (session.stopped || error.name === 'AbortError') return;
      session.playing = false;
      text('pause', () => tr('播放'));
      message(() => tr('瀏覽器暫停了自動播放。請按「播放」繼續。'));
    });
  } else if (!decision.play && !video.paused) video.pause();
  text('live-delay', () => tr`比擷取來源延遲約 ${Math.max(0, lead).toFixed(1)} 秒`);
  const waiting = decision.reason !== 'playing';
  $('buffer-cover').hidden = !waiting;
  $('catchup-countdown').hidden = true;
  if (decision.reason === 'inference') {
    const readyThrough = timestamp(checkedThrough);
    text('buffer-title', () => tr('等待 AI 字幕，影音一起暫停'));
    text('buffer-detail', () => tr`已處理到 ${readyThrough}，完成後會自動繼續。CPU 較慢時，延遲會增加。`);
    text('playback-label', () => tr('等待字幕'));
  } else if (decision.reason === 'paused') {
    text('buffer-title', () => tr('已暫停播放'));
    text('buffer-detail', () => tr('分頁擷取仍在繼續，按「播放」繼續觀看；長時間離開請結束擷取。'));
    text('playback-label', () => tr('已暫停'));
  } else if (decision.reason === 'buffering') {
    const initialDelay = session.delay;
    text('buffer-title', () => tr('正在緩衝影音'));
    text('buffer-detail', () => session.resumePending ? tr('倒數已完成，正在等候可播放的影音。來源擷取保持連線。') : tr`已緩衝 ${Math.max(0, lead).toFixed(0)} / ${initialDelay} 秒。請讓直播來源保持播放。`);
    text('playback-label', () => tr('緩衝中'));
  } else {
    const bypassSubtitles = session.bypassSubtitles;
    text('playback-label', () => bypassSubtitles ? tr('播放中 · AI 正在追趕') : $('wait-subtitles').checked ? tr('同步播放中') : tr('播放中 · 不等待字幕'));
  }
}
function renderCaptions(session) {
  const captions = captionsAt(session.segments, $('video').currentTime, Number($('offset').value));
  $('translated').textContent = captions.map(item => item.translation || item.text).filter(Boolean).join('\n');
  $('original').textContent = $('show-original').checked ? captions.filter(item => item.translation).map(item => item.text).join('\n') : '';
}
function appendTranscript(segments) {
  const container = $('transcript');
  const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
  for (const segment of segments) {
    const row = document.createElement('div'); row.className = 'transcript-row';
    const time = document.createElement('time'); time.textContent = timestamp(segment.start);
    const body = document.createElement('div');
    const target = document.createElement('p'); target.textContent = segment.translation || segment.text;
    body.append(target);
    if (segment.translation) { const source = document.createElement('p'); source.className = 'source'; source.textContent = segment.text; body.append(source); }
    row.append(time, body); container.append(row);
  }
  while (container.childElementCount > 300) container.firstElementChild.remove();
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
function failSession(session, detail) { if (!session.stopped) { message(detail); stopCapture(session); } }
async function stopCapture(session = active) {
  if (!session || session.stopped) return;
  session.stopped = true;
  session.abort.abort();
  clearInterval(session.timer);
  cancelAnimationFrame(session.frame);
  try { session.worklet?.port.postMessage('stop'); session.worklet?.disconnect(); } catch { /* graph already stopped */ }
  try { if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* source may already have ended */ }
  session.stream?.getTracks().forEach(track => track.stop());
  if (session.context && session.context.state !== 'closed') session.context.close().catch(() => {});
  session.mediaQueue.length = 0;
  session.audioQueue.length = 0;
  session.completed.length = 0;
  session.pressure = initialBackpressure();
  session.resumePending = false;
  if (active === session) {
    active = null;
    resetVolumeBoost();
    const video = $('video'); video.pause(); video.removeAttribute('src'); video.load();
    $('buffer-cover').hidden = true;
    $('catchup-countdown').hidden = true;
    text('catchup-countdown', () => '');
    $('translated').textContent = ''; $('original').textContent = '';
    $('live-source').hidden = true;
    $('song-mode-status').hidden = true;
    $('capture-mode-status').hidden = true;
    if (session.mode === 'replay') {
      $('wait-subtitles').checked = session.previousWaitForSubtitles;
      $('wait-subtitles').disabled = false;
    }
    $('live-source-text').textContent = '';
    text('live-delay', () => tr('擷取已結束'));
    text('pause', () => tr('暫停'));
    text('buffer-title', () => tr('正在緩衝影音'));
    text('buffer-detail', () => tr('準備第一批同步字幕'));
    text('playback-label', () => tr('準備中'));
    setCaptureControls(false);
  }
  if (session.url) URL.revokeObjectURL(session.url);
  // A translated notice can outlive capture. It must not keep browser media
  // buffers or stopped audio resources alive through its rendering callback.
  session.stream = session.recorder = session.context = session.worklet = null;
  session.media = session.sourceBuffer = session.url = null;
  if (session.id) try { await api(`/api/session/${encodeURIComponent(session.id)}`, { method: 'DELETE' }); } catch { /* UI still closes if the backend is gone */ }
}
$('start').addEventListener('click', () => $('capture-mode-dialog').showModal());
document.querySelectorAll('[data-capture-mode]').forEach(button => button.addEventListener('click', () => {
  $('capture-mode-dialog').close();
  startCapture(button.dataset.captureMode);
}));
$('stop').addEventListener('click', () => stopCapture());
$('pause').addEventListener('click', () => {
  if (!active) return;
  active.playing = !active.playing;
  text('pause', () => active?.playing ? tr('暫停') : tr('播放'));
  updatePlayback(active);
});
let playbackAudio = null;
let playbackGain = null;
let boostAllowed = false;
let requestedBoost = 1;
function setPlaybackVolume(volume) {
  $('video').volume = Math.min(1, volume);
  if (playbackGain) playbackGain.gain.value = Math.max(1, volume);
  $('volume').value = volume;
  $('volume').classList.toggle('volume-boosted', volume > 1);
  $('volume-value').textContent = `${Math.round(volume * 100)}%`;
  $('boost-active').hidden = volume <= 1;
}
function resetVolumeBoost() {
  boostAllowed = false;
  if ($('volume-warning').open) $('volume-warning').close('cancel');
  setPlaybackVolume(Math.min(1, Number($('volume').value)));
}
$('volume').addEventListener('input', () => {
  const volume = Number($('volume').value);
  if (volume <= 1 || boostAllowed) { setPlaybackVolume(volume); return; }
  requestedBoost = volume;
  setPlaybackVolume(1);
  $('volume-warning').returnValue = 'cancel';
  $('volume-warning').showModal();
});
$('volume-warning').querySelector('form').addEventListener('submit', async event => {
  if (event.submitter?.value !== 'confirm') return;
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    playbackAudio ??= new AudioContext();
    await playbackAudio.resume();
    if (!$('volume-warning').open) return;
    if (!playbackGain) {
      const gain = playbackAudio.createGain();
      gain.connect(playbackAudio.destination);
      playbackAudio.createMediaElementSource($('video')).connect(gain);
      playbackGain = gain;
    }
    boostAllowed = true;
    setPlaybackVolume(requestedBoost);
  } catch {
    resetVolumeBoost();
    message(() => tr('目前無法啟用音量增益。'));
  } finally {
    if ($('volume-warning').open) $('volume-warning').close();
    button.disabled = false;
  }
});
setPlaybackVolume(0.8);
$('delay').addEventListener('input', () => { delayAdjusted = true; $('delay-value').textContent = $('delay').value; });
$('offset').addEventListener('input', () => { $('offset-value').textContent = Number($('offset').value).toFixed(1); });
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('player-shell').requestFullscreen(); }
  catch { message(() => tr('此瀏覽器不允許全螢幕。')); }
});
$('export').addEventListener('click', () => {
  const srtTime = time => { const value = timestamp(time, true).replace('.', ','); return value.split(':').length === 2 ? `00:${value}` : value; };
  const content = lastSegments.map((item, i) => `${i + 1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${item.translation ? `${item.translation}\n` : ''}${item.text}\n`).join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: 'application/x-subrip;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `V-Translate-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.srt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('quit').addEventListener('click', async () => {
  if (closing) return;
  closing = true;
  clearInterval(advertisementTimer);
  clearTimeout(advertisementPollTimer);
  $('quit').disabled = true;
  updateComputeControls();
  try { sessionStorage.removeItem('livesub-token'); } catch { /* storage may be blocked */ }
  clearTimeout(statusTimer);
  await stopCapture();
  try { await api('/api/quit', { method: 'POST' }); } catch { /* server can close before sending a response */ }
  engineReady = false;
  text('engine-title', () => tr('本機程式已關閉'));
  text('engine-detail', () => tr('可以關閉這個分頁；下次直接開啟油字幕執行檔。'));
  $('setup').disabled = true;
  $('start').disabled = true;
  message(() => tr('本機程式已關閉。可以關閉這個分頁。'));
});
// A fresh ID per document lets reloads and other Profiles cancel pending shutdown.
const playerPageId = crypto.randomUUID();
const playerBrowser = /Edg\//.test(navigator.userAgent) ? 'edge' : /Chrome\//.test(navigator.userAgent) ? 'chrome' : null;
function reportPlayerPresence(closed = false) {
  if (!token || closing) return;
  fetch('/api/player/presence', { method: 'POST', keepalive: true,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: playerPageId, closed, english: getLanguage() === 'en', browser: playerBrowser }),
  }).catch(() => {});
}
reportPlayerPresence();
let presenceTimer = setInterval(reportPlayerPresence, 10000);
window.addEventListener('pageshow', () => {
  reportPlayerPresence();
  clearInterval(presenceTimer);
  presenceTimer = setInterval(reportPlayerPresence, 10000);
});
window.addEventListener('pagehide', () => {
  clearInterval(presenceTimer);
  reportPlayerPresence(true);
  if (!active) return;
  const session = active;
  session.stream?.getTracks().forEach(track => track.stop());
  if (session.id) fetch(`/api/session/${encodeURIComponent(session.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
});
if (!token) message(() => tr('這個播放器需要由本機程式開啟。請執行油字幕，而不要直接開啟 HTML 檔案。'));


const allowedThemes = ['studio', 'light'];
function setTheme(theme) {
  if (!allowedThemes.includes(theme)) theme = 'studio';
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
  try { localStorage.setItem('livesub-theme', theme); } catch { /* visual choice still works without storage */ }
}
let storedTheme = 'studio';
try { storedTheme = localStorage.getItem('livesub-theme') || 'studio'; } catch { /* storage may be blocked */ }
setTheme(storedTheme);
let appearanceRevision = 0;
let appearanceWrites = Promise.resolve();
function applyInterfaceLanguage(language) {
  setLanguage(language);
  try { localStorage.setItem('livesub-language', getLanguage()); } catch { /* language still works without storage */ }
  renderPlatform();
  renderDeviceOptions();
  renderTranslationModels();
  if (vocabularyLoaded) renderVocabulary(vocabularyState);
  updateValidation();
}
async function saveAppearance(theme, language) {
  const revision = ++appearanceRevision;
  setTheme(theme);
  applyInterfaceLanguage(language);
  if (closing) return;
  const appearance = { theme: document.documentElement.dataset.theme, language: getLanguage() };
  // Preserve click order even when one storage request is slower than the next.
  appearanceWrites = appearanceWrites.catch(() => {}).then(() => api('/api/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(appearance) }));
  try { await appearanceWrites; }
  catch (error) { if (!closing && revision === appearanceRevision) message(() => tr`介面已切換，但無法保存下次開啟的設定：${tr(error.message)}`); }
}
async function loadAppearance() {
  const revision = appearanceRevision;
  const settings = await api('/api/appearance');
  if (revision === appearanceRevision) { setTheme(settings.theme); applyInterfaceLanguage(settings.language); }
  return settings;
}
document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => saveAppearance(button.dataset.themeChoice, getLanguage())));
$('interface-language').addEventListener('change', () => saveAppearance(document.documentElement.dataset.theme, $('interface-language').value));
$('open-models').addEventListener('click', async () => {
  $('open-models').disabled = true;
  try {
    const result = await api('/api/models/open', { method: 'POST' });
    text('model-path', () => result.path || tr('模型資料夾已開啟'));
    $('model-location').hidden = false;
    if (!result.opened) message(() => tr('未能自動開啟資料夾，可複製畫面上的模型路徑。'));
  } catch (error) { message(() => tr`無法開啟模型資料夾：${tr(error.message)}`); }
  finally { $('open-models').disabled = closing; }
});
function updateVocabularyControls() {
  const locked = !!active || vocabularyBusy || !vocabularyLoaded || closing;
  $('vocabulary-select').disabled = locked;
  $('import-vocabulary').disabled = locked;
  $('remove-vocabulary').disabled = locked || !vocabularyState.active_id;
  $('export-vocabulary-csv').disabled = locked || !vocabularyState.active_id;
  $('export-vocabulary-tsv').disabled = locked || !vocabularyState.active_id;
}
function renderVocabulary(state) {
  vocabularyState = { profiles: Array.isArray(state.profiles) ? state.profiles : [], active_id: state.active_id || null, warnings: Array.isArray(state.warnings) ? state.warnings : [] };
  const select = $('vocabulary-select');
  select.replaceChildren(new Option(tr('不使用詞彙包'), ''));
  for (const profile of vocabularyState.profiles) select.add(new Option(tr`${profile.name} · ${profile.terms_count} 個用語`, profile.id));
  select.value = vocabularyState.active_id || '';
  const selected = vocabularyState.profiles.find(profile => profile.id === vocabularyState.active_id);
  text('vocabulary-detail', () => {
    const summary = selected ? tr`使用中：${selected.name}（${selected.terms_count} 個用語）` : tr('未啟用詞彙包；可匯入 JSON／CSV／TSV／TXT，或下載範例修改。');
    return vocabularyState.warnings.length ? tr`${summary} 提示：${vocabularyState.warnings.map(item => tr(item)).join(getLanguage() === 'en' ? '; ' : '；')}` : summary;
  });
  updateComputeControls();
}
async function loadVocabulary() {
  try { const state = await api('/api/vocabulary'); vocabularyLoaded = true; renderVocabulary(state); }
  catch (error) { text('vocabulary-detail', () => tr`無法讀取詞彙包：${tr(error.message)}`); }
}
async function changeVocabulary(path, options) {
  if (active || closing || vocabularyBusy) return;
  vocabularyBusy = true;
  updateComputeControls();
  try { renderVocabulary(await api(path, options)); message(); }
  catch (error) { message(() => tr`詞彙包操作失敗：${tr(error.message)}`); $('vocabulary-select').value = vocabularyState.active_id || ''; }
  finally { vocabularyBusy = false; updateComputeControls(); }
}
$('vocabulary-select').addEventListener('change', () => changeVocabulary('/api/vocabulary/active', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: $('vocabulary-select').value || null }) }));
$('import-vocabulary').addEventListener('click', () => $('vocabulary-file').click());
$('vocabulary-file').addEventListener('change', async () => {
  const file = $('vocabulary-file').files?.[0];
  $('vocabulary-file').value = '';
  if (!file || active || closing || vocabularyBusy) return;
  const format = file.name.match(/\.(json|csv|tsv|txt)$/i)?.[1].toLowerCase();
  if (!format || file.size > 64 * 1024) { message(() => tr('請匯入不超過 64 KiB 的 UTF-8 JSON／CSV／TSV／TXT 詞彙包。XLSX、TBX、TMX、模型權重或壓縮檔不適用。')); return; }
  let pack;
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, '');
    pack = format === 'json' ? JSON.parse(content) : { format, name: file.name.replace(/\.[^.]+$/, '').slice(0, 80), content };
  } catch (error) { message(() => format === 'json' && error instanceof SyntaxError ? tr('詞彙包不是有效的 JSON，請參考範例檔案格式。') : tr('詞彙包必須使用 UTF-8 編碼，請從編輯器或試算表另存 UTF-8 後再匯入。')); return; }
  await changeVocabulary('/api/vocabulary/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pack) });
});
async function exportVocabulary(format) {
  if (!vocabularyState.active_id || vocabularyBusy || active || closing) return;
  vocabularyBusy = true;
  updateComputeControls();
  try {
    const result = await api(`/api/vocabulary/${encodeURIComponent(vocabularyState.active_id)}/export?format=${format}`);
    const url = URL.createObjectURL(new Blob(['\ufeff', result.content], { type: `${format === 'csv' ? 'text/csv' : 'text/tab-separated-values'};charset=utf-8` }));
    const link = document.createElement('a'); link.href = url; link.download = result.filename || `V-Translate-vocabulary.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { message(() => tr`無法匯出詞彙包：${tr(error.message)}`); }
  finally { vocabularyBusy = false; updateComputeControls(); }
}
$('export-vocabulary-csv').addEventListener('click', () => exportVocabulary('csv'));
$('export-vocabulary-tsv').addEventListener('click', () => exportVocabulary('tsv'));
$('remove-vocabulary').addEventListener('click', () => {
  if (vocabularyState.active_id) changeVocabulary(`/api/vocabulary/${encodeURIComponent(vocabularyState.active_id)}`, { method: 'DELETE' });
});
$('example-vocabulary').addEventListener('click', () => {
  const example = { format_version: 1, name: '我的 VTuber 用語', language: 'ja', terms: [{ source: '星見ルナ', reading: 'ほしみるな', target: '星見露娜' }, { source: 'おつルナ', target: '露娜辛苦了' }] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(example, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'V-Translate-vocabulary-example.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

let advertisementSlides = [null];
let advertisementIndex = 0;
let advertisementPaused = false;
let advertisementHovered = false;
let advertisementFocused = false;
let advertisementTimer;
let advertisementPollTimer;
const advertisementImages = new Map();
function restartAdvertisementRotation() {
  clearInterval(advertisementTimer);
  if (closing || advertisementPaused || advertisementHovered || advertisementFocused || document.hidden || advertisementSlides.length < 2) return;
  advertisementTimer = setInterval(() => {
    advertisementIndex = nextAdvertisementIndex(advertisementIndex, advertisementSlides.length);
    renderAdvertisement();
  }, 10000);
}
function renderAdvertisement() {
  const ad = advertisementSlides[advertisementIndex];
  $('sponsor-placeholder').hidden = !!ad;
  $('sponsor-image-link').hidden = !ad;
  $('sponsor-slot').classList.toggle('has-ad', !!ad);
  if (ad) {
    $('sponsor-image-link').href = ad.link_url;
    if ($('sponsor-image').getAttribute('src') !== ad.image_url) $('sponsor-image').src = ad.image_url;
  } else {
    $('sponsor-image-link').removeAttribute('href');
    $('sponsor-image').removeAttribute('src');
  }
  text('sponsor-slide-position', () => tr`${advertisementIndex + 1} / ${advertisementSlides.length}`);
  text('sponsor-rotation-pause', () => advertisementPaused ? tr('繼續輪播') : tr('暫停輪播'));
  $('sponsor-rotation-pause').setAttribute('aria-pressed', String(advertisementPaused));
  $('sponsor-rotation-pause').disabled = advertisementSlides.length < 2;
  $('sponsor-previous').disabled = $('sponsor-next').disabled = advertisementSlides.length < 2;
}
function preloadAdvertisement(ad) {
  if (advertisementImages.has(ad.image_url)) return advertisementImages.get(ad.image_url).then(loaded => loaded ? ad : null);
  const loading = new Promise(resolve => {
    const preview = new Image();
    const finish = loaded => { clearTimeout(timeout); preview.onload = null; preview.onerror = null; resolve(loaded); };
    const timeout = setTimeout(() => finish(false), 8000);
    preview.onload = () => finish(preview.naturalWidth > 0 && preview.naturalHeight > 0);
    preview.onerror = () => finish(false);
    preview.referrerPolicy = 'no-referrer';
    preview.src = ad.image_url;
  });
  advertisementImages.set(ad.image_url, loading);
  return loading.then(loaded => loaded ? ad : null);
}
async function loadAdvertisements(attempt = 0) {
  if (closing) return;
  try {
    const payload = await api('/api/ads');
    const ads = (await Promise.all(normalizeAdvertisements(payload, location.origin).map(preloadAdvertisement))).filter(Boolean);
    if (closing) return;
    const currentId = advertisementSlides[advertisementIndex]?.id;
    advertisementSlides = [null, ...ads];
    advertisementIndex = Math.max(0, advertisementSlides.findIndex(ad => ad?.id === currentId));
    renderAdvertisement();
    restartAdvertisementRotation();
    if (payload.state === 'checking' && attempt < 11) advertisementPollTimer = setTimeout(() => loadAdvertisements(attempt + 1), 5000);
  } catch { /* the local sponsorship card remains available when ads are unavailable */ }
}
$('sponsor-image').addEventListener('error', () => {
  const failed = advertisementSlides[advertisementIndex];
  if (!failed) return;
  advertisementSlides = advertisementSlides.filter(ad => ad?.id !== failed.id);
  advertisementIndex %= advertisementSlides.length;
  renderAdvertisement();
  restartAdvertisementRotation();
});
function moveAdvertisement(direction) {
  if (advertisementSlides.length < 2 || closing) return;
  advertisementIndex = (advertisementIndex + direction + advertisementSlides.length) % advertisementSlides.length;
  renderAdvertisement();
  restartAdvertisementRotation();
}
$('sponsor-previous').addEventListener('click', () => moveAdvertisement(-1));
$('sponsor-next').addEventListener('click', () => moveAdvertisement(1));
$('sponsor-rotation-pause').addEventListener('click', () => {
  advertisementPaused = !advertisementPaused;
  renderAdvertisement();
  restartAdvertisementRotation();
});
$('sponsor-slot').addEventListener('mouseenter', () => { advertisementHovered = true; restartAdvertisementRotation(); });
$('sponsor-slot').addEventListener('mouseleave', () => { advertisementHovered = false; restartAdvertisementRotation(); });
$('sponsor-slot').addEventListener('focusin', () => { advertisementFocused = true; restartAdvertisementRotation(); });
$('sponsor-slot').addEventListener('focusout', event => { advertisementFocused = $('sponsor-slot').contains(event.relatedTarget); restartAdvertisementRotation(); });
document.addEventListener('visibilitychange', restartAdvertisementRotation);
window.addEventListener('pagehide', () => { clearInterval(advertisementTimer); clearTimeout(advertisementPollTimer); });
renderAdvertisement();
loadAdvertisements();

$('capture-browser-help').addEventListener('click',()=>{openSettings($('capture-browser-help'));$('browser-transfer-title').scrollIntoView({block:'center'});});
let openingPlayerBrowser=false;
function updateBrowserTransfer(){
  for(const id of ['open-in-chrome','open-in-edge'])$(id).disabled=!!active||closing||openingPlayerBrowser;
  $('copy-player-link').disabled=closing||!token;
}
for(const browser of ['chrome','edge'])$(`open-in-${browser}`).addEventListener('click',async()=>{
  if(active||closing||openingPlayerBrowser)return;
  openingPlayerBrowser=true;updateBrowserTransfer();
  try{await api('/api/player/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browser})});text('browser-transfer-status',()=>tr('已開啟播放器。如直播在另一個 Profile，請複製連結到該 Profile。'));}
  catch(error){text('browser-transfer-status',()=>tr(error.message));}
  finally{openingPlayerBrowser=false;updateBrowserTransfer();}
});
$('copy-player-link').addEventListener('click',async()=>{
  if(!token||closing)return;
  const url=`${location.origin}/#token=${encodeURIComponent(token)}`;
  try{await navigator.clipboard.writeText(url);$('player-link-fallback').hidden=true;text('browser-transfer-status',()=>tr('播放器連結已複製。請貼到直播所在的瀏覽器／Profile，再開始擷取。'));}
  catch{$('player-link-fallback').hidden=false;$('player-link').value=url;$('player-link').focus();$('player-link').select();text('browser-transfer-status',()=>tr('無法自動複製，請複製下方連結。'));}
});

const tourSteps = [
  { targets: ['language', 'target'], title: '設定原文和譯文語言', detail: '「直播語言」是聽寫的原文，「翻譯語言」是字幕要顯示的語言。' },
  { targets: ['delay-tour-target'], title: '調整起始緩衝', detail: '開始擷取前，在這裡調整影片落後直播的時間。緩衝較長時，字幕有更多時間準備。' },
  { targets: ['model-settings'], title: '更改效能模式', detail: '按 Performance 可重新選擇高效能、均衡或入門配置。' },
  { targets: ['start'], title: '開始擷取', detail: '按「選擇直播分頁」，先選擇擷取模式，再分享分頁並勾選分頁音訊。' },
  { targets: ['pause', 'stop'], title: '暫停播放與結束擷取', detail: '「暫停」會暫停播放，按「結束擷取」會停止分享。' },
  { targets: ['open-settings'], title: '開啟設定頁', detail: '按右上角的設定齒輪，開啟播放器設定。' },
  { targets: ['open-in-chrome', 'open-in-edge'], panel: 'settings-dialog', title: '切換 Chrome 或 Edge', detail: '在設定頁選擇用哪個瀏覽器開啟播放器。播放器和直播需要在同一個瀏覽器和 Profile。' },
  { targets: ['quit'], title: '關閉 Whisper', detail: '看完後按這個按鈕，關閉背景的聽寫和翻譯程式。' },
  { targets: ['header-engine-status', 'setup'], title: '查看模型準備狀態', detail: '這裡會顯示模型正在準備，或已就緒。模型就緒後，就可以開始擷取。' },
];
let tourIndex = 0;
let tourPanel = null;
function unlockPlayer() {
  onboardingLocked = false;
  document.querySelector('.topbar').inert = false;
  document.querySelector('main').inert = false;
}
function finishFirstPreparation() {
  if ($('first-model-preparation').open) $('first-model-preparation').close();
  unlockPlayer();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function renderFirstPreparation() {
  if (!$('first-model-preparation').open) return;
  const status = latestSetupStatus;
  if (status?.ready) { finishFirstPreparation(); return; }
  const failed = setupRequestError || status?.error || status?.phase === 'paused';
  const progress = Math.max(0, Math.min(100, Math.round((Number(status?.progress) || 0) * 100)));
  text('first-model-title', () => tr(failed ? 'AI 模型準備未完成' : status?.phase === 'loading' ? '正在載入 AI 模型，請等待' : '正在下載及準備 AI 模型，請等待'));
  text('first-model-detail', () => tr(setupRequestError || status?.error || status?.detail || '正在開始準備模型…'));
  $('first-model-progress').value = progress;
  $('first-model-percent').textContent = `${progress}%`;
  $('first-model-progress-row').hidden = !!failed;
  $('first-model-actions').hidden = !failed;
}
function positionTour() {
  if (!$('first-tour').open) return;
  const rects = tourSteps[tourIndex].targets.map(id => {
    const control = $(id);
    return (control.closest('label') ?? control).getBoundingClientRect();
  });
  const left = Math.max(0, Math.min(...rects.map(rect => rect.left)) - 6);
  const top = Math.max(0, Math.min(...rects.map(rect => rect.top)) - 6);
  const right = Math.min(innerWidth, Math.max(...rects.map(rect => rect.right)) + 6);
  const bottom = Math.min(innerHeight, Math.max(...rects.map(rect => rect.bottom)) + 6);
  Object.assign($('tour-spotlight').style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px` });
  $('tour-card').classList.toggle('tour-card-top', innerHeight - bottom < top);
}
function showTourStep() {
  if (tourPanel) { tourPanel.close(); tourPanel.classList.remove('tour-panel'); }
  const step = tourSteps[tourIndex];
  tourPanel = step.panel ? $(step.panel) : null;
  if (tourPanel) {
    tourPanel.classList.add('tour-panel');
    tourPanel.show();
  }
  const target = $(step.targets[0]);
  (target.closest('label') ?? target).scrollIntoView({ block: 'center', behavior: 'instant' });
  text('tour-step', () => tr`操作導覽 ${tourIndex + 1} / ${tourSteps.length}`);
  text('tour-title', () => tr(step.title));
  text('tour-detail', () => tr(step.detail));
  text('tour-next', () => tr(tourIndex === tourSteps.length - 1 ? '完成導覽' : '下一步'));
  $('tour-next').focus({ preventScroll: true });
  positionTour();
}
for (const id of ['first-setup', 'first-tour', 'first-model-preparation']) $(id).addEventListener('cancel', event => event.preventDefault());
$('first-model-retry').addEventListener('click', prepareModels);
$('first-model-settings').addEventListener('click', () => {
  finishFirstPreparation();
  openSettings();
});
window.addEventListener('resize', positionTour);
document.addEventListener('scroll', positionTour, true);
$('first-language').addEventListener('change', event => {
  if (event.target.value) applyInterfaceLanguage(event.target.value);
});
$('first-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('first-next');
  if (button.disabled) return;
  button.disabled = true;
  $('first-error').hidden = true;
  try {
    if (!settingsLoaded) await loadSettings();
    const performance = $('first-performance').value;
    const preset = presets[performance];
    const alreadySelected = performance === currentSettings.performance && Object.entries(preset).every(([key, value]) => currentSettings[key] === value);
    if (!settingsLoaded || (!alreadySelected && !await saveSettings({ ...currentSettings, performance, ...preset }))) {
      throw new Error('無法儲存效能設定，請稍候重試。');
    }
    applyInterfaceLanguage($('first-language').value);
    void prepareModels();
    $('first-setup').close();
    $('first-tour').showModal();
    showTourStep();
  } catch (error) {
    text('first-error', () => tr(error.message));
    $('first-error').hidden = false;
  } finally { button.disabled = false; }
});
$('tour-next').addEventListener('click', async () => {
  if (tourIndex < tourSteps.length - 1) { tourIndex++; showTourStep(); return; }
  const button = $('tour-next');
  button.disabled = true;
  $('tour-error').hidden = true;
  try {
    await api('/api/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: document.documentElement.dataset.theme, language: getLanguage(), onboarding_complete: true }) });
    $('first-tour').close();
    $('first-model-preparation').showModal();
    renderFirstPreparation();
  } catch {
    text('tour-error', () => tr('無法儲存導覽進度，請再試一次。'));
    $('tour-error').hidden = false;
  } finally { button.disabled = false; }
});
(async () => {
  await loadPlatform();
  await loadSettings();
  try {
    const appearance = await loadAppearance();
    if (appearance.onboarding_complete) unlockPlayer();
  } catch {
    text('first-error', () => tr('無法讀取首次設定，請確認本機程式正在執行。'));
    $('first-error').hidden = false;
  }
  if (onboardingLocked) {
    $('first-language').selectedIndex = -1;
    $('first-setup').showModal();
  }
  pollStatus();
  loadVocabulary();
  loadTranslationModels();
})();
