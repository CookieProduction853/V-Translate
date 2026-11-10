# 第三方元件

油字幕 / V-Translate 的 Rust 程式碼以 MIT 授權發布。推論引擎與模型由首次設定流程另外下載；各自的授權仍然適用，請在重新發布它們時附上原始授權和要求的聲明。

| 元件 | 用途 | 上游與授權 |
| --- | --- | --- |
| whisper.cpp v1.7.6 | CPU 語音辨識引擎 | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.7.6)，MIT |
| whisper.cpp v1.9.5 | Windows 隨附的 Vulkan 聽寫引擎 | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5)，MIT |
| Whisper Tiny／Base／Small 模型 | 多語言語音辨識權重 | [OpenAI Whisper](https://github.com/openai/whisper)，MIT；GGML 格式由 [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) 提供 |
| llama.cpp b8500 | CPU／Vulkan 文字生成引擎 | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/tree/b8500)，MIT |
| Qwen2.5-0.5B／1.5B-Instruct | 本機翻譯模型 | [Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct)，Apache-2.0；GGUF 檔案 `qwen2.5-1.5b-instruct-q4_k_m.gguf` 由 [Qwen/Qwen2.5-1.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) 提供 |

Rust 相依套件的確切版本記錄於 `Cargo.lock`，授權資訊可透過各套件的 crates.io 頁面或 `cargo metadata` 查閱。Chrome、Edge、Firefox 由使用者自行安裝，沒有隨本專案重新散布。

顯卡模式下載上游 llama.cpp b8500 的 Windows x64 Vulkan 套件，語音辨識使用套件附帶的 Vulkan whisper.cpp v1.9.5。AMD Vulkan 驅動由用家從 AMD 官方安裝，沒有隨本專案重新散布；此模式不使用 CUDA 或 ROCm。

NVIDIA 顯卡使用系統安裝的 Vulkan 驅動；驅動由用家從 NVIDIA 安裝，沒有隨套件散布。本版本使用 Vulkan，不包含 CUDA Toolkit。

低配置的 0.5B GGUF 由 [Qwen/Qwen2.5-0.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) 提供，Apache-2.0。

v0.4.0 可使用用家自行提供的相容 GGUF 翻譯模型。這些模型沒有隨本專案套件散布，其原始模型、量化版本及附帶資料的授權由各發布者決定；使用與重新發布前請查看模型頁面的授權及限制。程式產生的本機 SHA256 紀錄只用於檔案完整性檢查，不是模型來源或授權的證明。

[Ollama 翻譯模型搜尋頁](https://ollama.com/search?q=translate) 是供使用者尋找模型的外部連結。本程式沒有包含或重新散布 Ollama，亦不透過 Ollama API 執行推論。
