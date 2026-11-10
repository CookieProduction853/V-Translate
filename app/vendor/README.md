# Windows Whisper Vulkan runtime

`whisper-vulkan.zip` is built from [whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5) for Windows x64. The build uses Vulkan and AVX2, with AVX-512 and AVX-VNNI disabled. Its license is in `whisper.cpp-LICENSE.txt`.

The app and Windows packaging script verify the archive against the SHA-256 in `src/assets.rs`. The archive is shipped beside `V-Translate.exe` so Vulkan transcription can be prepared using the packaged runtime.
