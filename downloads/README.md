# 油字幕 / V-Translate · Windows v0.4.5 測試版

**油字幕 - 本地 AI Vtuber 即時字幕**

**V-Translate - Real time local AI translator for Vtuber viewers**

下載 [V-Translate-v0.4.5-Windows-x64.zip](https://github.com/CookieProduction853/V-Translate/raw/refs/heads/main/downloads/V-Translate-v0.4.5-Windows-x64.zip)（[固定下載名稱](V-Translate-Windows-x64.zip)），解壓後開啟 `V-Translate.exe`。

- Windows 10／11 64 位元，使用已安裝的 Chrome 或 Edge；不需要 Python。
- 頁首直接切換繁體中文（zh-Hant）／English（en），主題僅提供 Dark（studio）及 Daylight（light）。語言、主題與配置會保存，重新開啟後沿用。
- v0.4.5 使用 `assets/TASK BAR ICON.png` 作播放器頁首、分頁及 Windows 程式／視窗／工作列圖示。
- 新增 720p／1080p（預設）／1440p／來源解析度擷取，並顯示實際擷取尺寸。原直播也需先選高清；高畫質需要更多編碼資源。播放與語言設定已放在 AI 引擎／翻譯模型設定上方。
- 四張隨附廣告與合作邀請每 10 秒輪播，圖片填滿版位，按圖開啟配對 `.url` 的網址；可暫停。維護者更新 `assets/ad` 後可透過 GitHub Pages 發佈。遠端廣告更新尚待一次性啟用 Pages → GitHub Actions 及部署，未連線時仍可顯示隨附圖片。
- 首次使用預設為高配置：Whisper Small、6 個 CPU 執行緒、5 秒音訊片段及 20 秒起始緩衝。更新會保留已有設定；卡頓時可改選中或低配置，亦可手動調整。
- 可選用自行取得的相容 chat／instruct GGUF 翻譯模型。將單一完整 `.gguf` 放入 `%LOCALAPPDATA%\LiveSub\LiveSub\data\models\translation`，按「重新掃描」並在「翻譯模型」選取；選擇會自動儲存，再準備 AI。內建 Qwen 仍是預設；使用自訂模型只下載引擎與 Whisper，不另下載 Qwen。操作詳見 ZIP 內的 `docs/custom-models.md`。
- 可選 CPU 或顯卡 Vulkan 翻譯；聽寫仍使用 CPU。AMD／NVIDIA 用家請更新顯卡驅動，再偵測及選取顯卡。不需要 CUDA、ROCm 或 Vulkan SDK。兩個模式共用已下載的模型；先結束擷取再切換。
- 結束觀看時先按「結束擷取」，再按其下方的大按鈕「關閉背景聽寫程式(whisper)」。
- 若引擎提示缺少 DLL，安裝 [Microsoft Visual C++ x64 Runtime](https://aka.ms/vs/17/release/vc_redist.x64.exe)。

Download and extract the ZIP, then run `V-Translate.exe`. Choose **English** in the page header. Fresh installs use the High profile (Small, 6 threads, 5-second chunks, 20-second buffer); saved settings remain in place. Choose Medium or Low if playback or processing falls behind.

To use a custom translation model, stop capture and place one complete chat/instruct GGUF compatible with llama.cpp b8500 in `%LOCALAPPDATA%\LiveSub\LiveSub\data\models\translation`. Click **Refresh models**, select it under **Translation model** (saved automatically), then prepare AI. **Find translation models (Ollama) ↗** opens a model search page; Ollama packages and Modelfiles are not guaranteed to be usable GGUF files. Read `docs/custom-models.md` inside the ZIP.

套件包含程式、開始使用說明及授權資訊。SHA256 校驗碼見 [SHA256SUMS.txt](SHA256SUMS.txt)。舊版資料目錄沿用，已下載的模型與詞彙包可重用；不需要刪除資料目錄。

更新時先在舊播放器按「關閉背景聽寫程式(whisper)」（早期版本名為「關閉本機程式」），再開啟新套件的 `V-Translate.exe`；新版頁首應顯示 v0.4.5。只關閉瀏覽器視窗可能讓舊程式繼續在背景執行。若已確認使用新版而 Windows 釘選圖示仍未更新，取消釘選舊捷徑，再從新版重新釘選。

「模型資料夾」按鈕只開啟資料夾，不會刪檔。自行刪除模型前，先結束擷取並關閉背景程式。VTuber 詞彙包支援 JSON／CSV／TSV／TXT，匯入後須明確選取才會啟用；它提供人名、讀音、口頭禪及譯名提示，沒有重新訓練模型，也不保證精準度提升。格式及範例見 ZIP 內的 `docs/vocabulary.md`。

這是測試版。自動測試與合成影音驗證不等於 Windows 真機、實際 CPU／GPU 效能、真實模型或會員直播驗證；Windows 桌面圖示外觀亦尚未真機確認。高／中／低是起始建議，尚未在各目標電腦實測，不承諾特定 CPU 使用率、加速幅度或字幕延遲。完整使用方式與驗證範圍見 [儲存庫首頁](../README.md)。

左上語言選單新增「介面語言 (Language)」標示，廣告下方固定顯示 Fans AD Contact 電郵。輪播支援 10 張以上，最多 32 張、圖片合計 30 MiB。
