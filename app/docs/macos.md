# macOS Apple Silicon

macOS 版是獨立的 Apple Silicon（M 系列）下載包，與 Windows x64 下載分開。最低 macOS 13.5，不適用 Intel Mac。

解壓後，把 `V-Translate.app` 放到「應用程式」再開啟。不需要 Python、Homebrew、Rosetta，也不需要自行編譯模型引擎。首次準備 AI 模型仍需要網路；已下載模型和設定保存在 macOS 的本機應用程式資料目錄，可透過程式的模型資料夾按鈕開啟。

程式以背景服務執行，播放器在 Chrome／Edge 開啟；結束時使用播放器的「關閉背景聽寫程式(whisper)」。

本版可選 CPU 或 Apple Metal 執行 Whisper 聽寫及文字翻譯。效能選單提供高效能、均衡及入門三種配置，起始緩衝分別為 5、10、14 秒。播放器滑桿最低可手動調到 3 秒。

## 瀏覽器與錄製權限

使用 Chrome 或 Edge 開啟直播並正常登入，再分享直播的「分頁」和「分頁音訊」。Safari 和 Firefox 不提供本播放器需要的分頁音訊擷取方式。

若 macOS 要求螢幕或系統音訊錄製權限，請在「系統設定 → 隱私權與安全性」允許實際使用的瀏覽器，再重新開啟瀏覽器並分享分頁。不同 macOS 版本的權限名稱可能不同。會員直播仍受原平台的帳戶權限及內容保護限制。

## 首次開啟與簽署

測試包使用 ad-hoc 簽署，沒有 Apple Developer ID 簽署或 Apple 公證。macOS 可能阻擋首次開啟；確認下載來源後，先嘗試開啟，再使用「系統設定 → 隱私權與安全性 → 仍要開啟」。不要把 ad-hoc 簽署當作 Apple 已審核此程式。

## 建置與驗證範圍

維護者的私人程式儲存庫使用 `macos-15` Apple Silicon runner 建置 `aarch64-apple-darwin`，並檢查實際架構。此標籤的 arm64 架構已按 [GitHub 官方 runner 清單](https://github.com/actions/runner-images) 選取。

Whisper 固定在 v1.7.6（`a8d002cfd879315632a579e73f0148d06959de36`），llama.cpp 固定在 b8500（`342d6125bcda31f8bbda5df4a74afcf4b2d8c681`）。引擎及各自的動態程式庫隨 `.app` 附帶，使用程式內嵌的 SHA256 清單檢查完整性；不依賴 `/opt/homebrew` 的外部程式庫。

成功的 CI 建置須通過 Rust 測試、原生 arm64 編譯、引擎 `--help`、動態程式庫路徑、bundle 簽署／完整性、實際本機 HTTP 服務，以及透過 Launch Services 開啟 `.app` 並關閉背景服務的檢查。另以官方公開 JFK 語音樣本及 Tiny／Qwen 0.5B 模型，驗證 CPU 聽寫和翻譯確實回傳內容；測試用模型不會放入下載包。

Metal 推論的嘗試結果會另寫入建置報告，不能將裝置列舉或 CPU 測試成功視為 GPU 推論成功。託管 runner 的虛擬 GPU 不等同使用者的實體 Mac；會員直播、瀏覽器錄製授權、各種模型品質及使用者硬體效能仍需實機驗證。

CI 的 artifact-only 分支只儲存下載包、校驗碼和建置報告，與私人開發原始碼分開。只有成功產生並驗證的 macOS ZIP 才應加入公開下載頁；不要提前建立會回傳 404 的下載連結。
