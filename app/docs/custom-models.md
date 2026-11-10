# 自訂 GGUF 翻譯模型

v0.4.0 可使用用家自行取得的翻譯模型。預設「內建 Qwen（依效能設定自動選擇）」仍可直接使用：低配置自動選 Qwen2.5-0.5B-Instruct，中／高配置選 1.5B，均為 Q4_K_M。

自訂模型由同一個本機 llama.cpp b8500 引擎執行，可選 CPU 或 Vulkan；Whisper 聽寫仍使用 CPU。模型選擇和運算後端分開保存，套用效能配置不會替換你選取的自訂模型。

## 選擇合適的檔案

請取得一個完整、單一檔案的 `.gguf`，並確認：

- 模型是可接受聊天指令的 chat／instruct 類型，適合你的來源與目標語言。
- 模型架構、GGUF 版本、量化格式及聊天範本可由 **llama.cpp b8500** 載入；只有 `.gguf` 副檔名不足以證明相容。
- 電腦有足夠 RAM；Vulkan 模式另需足夠可用顯存。檔案大小不等於執行時所需記憶體。

CPU 用家可先考慮約 **1–3B、Q4_K_M** 的小型模型。這是降低資源需求的起點，不保證字幕即時、CPU 使用率或翻譯品質。更大的模型不一定適合直播；若處理持續落後，可換較小模型或調整其他配置。

目前只接受直接放在指定資料夾內的單一完整 GGUF。分割 GGUF（例如 `model-00001-of-00002.gguf`）、子資料夾中的模型、LoRA、`.safetensors`、Whisper `.bin` 及 `Modelfile` 不能用這個方式載入。

## 尋找模型與 Ollama 的關係

按「尋找翻譯模型（Ollama） ↗」會在新分頁開啟 [Ollama 翻譯模型搜尋頁](https://ollama.com/search?q=translate)，供尋找模型名稱、參數量與相關資訊。本程式不使用 Ollama API，也不需要安裝或啟動 Ollama。

Ollama 下載的套件、blob 或 `Modelfile` 不保證是可直接複製使用的 GGUF。找到模型後，請到可信的模型發布頁另行取得**同一模型、相容架構的 GGUF**，並查看發布者的授權、來源及建議聊天範本。油字幕沒有宣稱支援 Ollama 模型庫中的所有模型。

## 放入、選取與準備

1. 如果正在觀看，先按「結束擷取」。翻譯模型只能在停止擷取時切換。
2. 按「開啟自訂模型資料夾」。預設位置為：

   ```text
   %LOCALAPPDATA%\LiveSub\LiveSub\data\models\translation
   ```

   若以 `--data-dir` 指定資料目錄，則使用該目錄下的 `models\translation`。按鈕只開啟固定資料夾，不會下載、上傳或刪除模型。
3. 在檔案管理員把完整 `.gguf` 直接複製到該資料夾。請先等候複製完成，再回播放器按「重新掃描」。不需要把模型透過瀏覽器上傳，也不要用詞彙包匯入器。
4. 在「翻譯模型」選取檔案，選擇會自動儲存在本機。原文語言、翻譯語言、CPU／Vulkan、裝置及手動配置會保留。
5. 按「準備 AI 模型」，確認配置後等候載入。自訂模型會使用你提供的檔案；程式只自動下載缺少的引擎與所選 Whisper，**不會另外下載內建 Qwen**。
6. 顯示 AI 就緒後才開始擷取。模型檔案通過初步檢查不代表引擎一定能載入，也不代表翻譯效果已經驗證。

要返回內建模型，先結束擷取，在「翻譯模型」選「內建 Qwen（依效能設定自動選擇）」，再準備 AI。程式不會在自訂模型出錯時偷偷改用 Qwen。

## 檔案檢查與錯誤處理

掃描會檢查檔案名稱、檔案類型及 GGUF 標頭，並顯示合格檔案的名稱與大小；不合格檔案會出現在警告中。這只是檔案結構檢查，不是完整的架構或推論相容性測試。實際能否載入，仍以 llama.cpp 的結果為準。

每次明確按「準備 AI 模型」時，程式會計算自訂檔案的 SHA256，並記錄本次載入的檔案識別、大小及修改時間。這份本機紀錄可在後續推論及自動恢復前檢查檔案是否變動；不會在每段音訊都重新雜湊整個模型。這不是發布者提供的可信校驗碼，也不能證明來源或授權；若發布者提供 SHA256，請先自行核對。

已載入檔案被修改或替換後，推論及自動恢復會停止使用該檔案並顯示錯誤。確認新檔案可信且複製完整後，請明確按「準備 AI 模型」建立新的本機校驗紀錄；程式不會在背景自動信任替換檔案。

若檔案不見、內容損壞、架構不支援或記憶體不足，畫面會顯示錯誤。請保留錯誤訊息並查看資料目錄的 `logs`，修正檔案或選另一個較小、相容的模型，再重新準備。載入失敗不會把模型選擇換回內建 Qwen；AI 推論暫時失敗時，既有播放器會保留並依等待字幕設定處理。

自行刪除或更換檔案前，先結束擷取並關閉背景程式，等引擎退出後才操作。程式不代替你管理模型授權，也不保證任意 GGUF 都可使用。

## English quick steps

Use one complete **chat/instruct GGUF compatible with llama.cpp b8500**. Stop capture, click **Open custom model folder**, and copy the file directly into `%LOCALAPPDATA%\LiveSub\LiveSub\data\models\translation`. Click **Refresh models**, choose it under **Translation model** (saved automatically), then click **Prepare AI models**. Only missing engines and the selected Whisper model are downloaded; Qwen is skipped when a custom model is selected.

The **Find translation models (Ollama) ↗** link opens [Ollama's translation-model search](https://ollama.com/search?q=translate); V-Translate does not call the Ollama API. Ollama packages and Modelfiles are not guaranteed to be directly usable GGUF files. Obtain a compatible GGUF from a trusted publisher and check its license. Split files are unsupported. A small 1–3B Q4_K_M model is a CPU starting point, without a performance or translation-quality guarantee. Unsupported or oversized models show an error; choose another model and prepare again.

Header checks and locally cached SHA256 records do not establish publisher authenticity or inference compatibility. Automated tests use fixtures and synthetic responses; real custom-model inference has not been verified in this environment.
