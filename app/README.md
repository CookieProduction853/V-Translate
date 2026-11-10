# 油字幕 · V-Translate — public source

A local, real-time AI speech transcription and translation application for VTuber viewers. It uses a Rust loopback server and a Chrome/Edge player to translate user-selected tab audio into Chinese or English subtitles. Speech recognition and translation run locally using whisper.cpp and llama.cpp with Whisper and Qwen models.

本倉庫是 V-Translate 桌面程式的公開原始碼，以 MIT 授權發布。官網及既有下載：[V-Translate](https://cookieproduction853.github.io/V-Translate/)。

## Build

Install Rust 1.89 or later, Node.js 22, and on Windows the MSVC build tools and Windows SDK. Then run:

```sh
node scripts/build-ad-feed.cjs
cargo test --locked
cargo build --locked --release
```

On Windows, package with:

```powershell
node scripts/collect-licenses.cjs
./scripts/package-windows.ps1
```

The package is written to `dist/`. The shipped app does not require Rust, Node or Python. It requires Windows 10/11 x64 and Chrome or Edge. AI setup downloads engines and model weights; Vulkan support requires a compatible driver. The bundled Whisper runtime and its pinned checksum are documented in [vendor/README.md](vendor/README.md). Third-party software retains its own licenses: [notices](THIRD_PARTY_NOTICES.md), [license texts](THIRD_PARTY_LICENSES.txt).

Version 1.6.3 starts from the 1.6.2 source snapshot, source commit `1c58d2a48d986bf27d0e3b6152b0e42251be07a9`, with additional release metadata, background-request opt-out and signing integration. The previous private repository and its history have not been published. Source lives in `app/` in the website repository; run build commands from that directory. Existing downloadable 1.6.2 binaries predate these integration changes; a new public build must be validated before replacing them.

## Code signing policy

SignPath integration is prepared; the application has **not** been submitted or approved, and production signing has not been tested. See [Code signing policy](CODE_SIGNING.md) and [SignPath setup/application brief](docs/signpath-setup.md). Existing downloads remain unchanged. The public Windows workflow builds unsigned artifacts by default; production signing requires the approved SignPath account, configured credentials and manual approval for each request.

## Privacy and removal

Read [Privacy policy / 隱私政策](PRIVACY.md) before starting. To disable background advertisement and version requests, close the background app and use `Start-Without-Network-Updates.cmd` from the new Windows package. AI preparation still downloads models and engines when requested. Removal instructions are included in the privacy policy.

## More documentation

[Custom models](docs/custom-models.md) · [Vocabulary](docs/vocabulary.md) · [macOS](docs/macos.md) · [Playback recovery](docs/playback-recovery.md)

This is preview software. Automated build and local-server checks do not establish real-world CPU/GPU performance, subtitle accuracy or compatibility with every streaming site.
