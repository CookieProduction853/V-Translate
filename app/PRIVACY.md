# Privacy policy / 隱私政策

V-Translate performs speech recognition and translation locally. Its normal inference path does not upload captured audio, transcripts, imported vocabulary or model settings to a translation service. The local player communicates with an authenticated loopback server on `127.0.0.1`.

At startup, the app normally checks the project's GitHub Pages version and advertisement feeds and downloads updated banner images. These HTTPS requests reveal ordinary connection information, including the IP address, to the hosting provider. They do not attach stream audio, transcripts, browser cookies, the local player token or model settings. Clicking a banner opens its linked third-party site, whose privacy policy then applies.

To disable these background advertisement and version requests **before the first launch**, extract the Windows ZIP and use `Start-Without-Network-Updates.cmd`, or run `V-Translate.exe --no-network-updates`. Close an already-running background instance first. Bundled or cached banners remain available. This option does not disable model downloads requested through AI setup.

Preparing AI downloads engines from GitHub and model files/metadata from Hugging Face. The selected browser and streaming website make their own network requests when you watch or share a tab. User-supplied model files remain subject to their publishers' licenses.

Relevant providers: [GitHub privacy](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement), [Hugging Face privacy](https://huggingface.co/privacy), [Chrome privacy](https://www.google.com/chrome/privacy/), [Microsoft privacy](https://privacy.microsoft.com/privacystatement). This project does not control these providers.

The app stores downloaded engines, models, settings, advertisement cache and imported vocabulary in its local data directory. Caption history and exports may also contain personal content; treat files you save accordingly.

## Removal / 移除

Use the player's quit control or bundled `Stop-Whisper.cmd` to stop the background process, then delete the extracted application directory. To remove saved settings and downloaded models as well, open the model/data directory from Settings before quitting, then delete that directory after quitting. This also deletes your imported vocabulary and local settings; save anything you need first. The default Windows directory is `%LOCALAPPDATA%\LiveSub\LiveSub\data`; a custom `--data-dir` overrides it. Chrome, Edge, graphics drivers and the Visual C++ Runtime are independently installed software and are not removed by deleting V-Translate.

繁體中文摘要：音訊及翻譯在本機處理。程式啟動時會向 GitHub Pages 檢查版本與更新廣告，準備 AI 時會連線 GitHub／Hugging Face 下載引擎及模型。使用 `Start-Without-Network-Updates.cmd` 可在啟動前停用背景廣告與版本請求；先關閉已執行的背景程式。點擊廣告或觀看直播時，外部網站各自的隱私政策適用。移除時先關閉背景程式，再刪除解壓縮資料夾；如需清除模型與設定，再刪除本機資料目錄。
