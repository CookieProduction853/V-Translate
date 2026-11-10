# SignPath Foundation setup

Current state: source and integration prepared; application has not been submitted or approved. Production signing has not been exercised.

## Application brief

- Project: V-Translate / 油字幕
- Website and existing downloads: https://cookieproduction853.github.io/V-Translate/
- Public source: https://github.com/CookieProduction853/V-Translate/tree/main/app
- License: MIT; bundled dependency notices are in `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.txt`.
- Maintainer / author / reviewer / approver: CookieProduction853
- Description: A local, real-time AI speech transcription and translation application for VTuber viewers. A Rust loopback server and browser player process user-selected tab audio locally, using separately downloaded whisper.cpp/llama.cpp engines and Whisper/Qwen models.
- Signing scope: the project's Windows x64 application executable, packaged in a portable ZIP. Upstream binaries are excluded from signing. Existing releases are linked on the website; new builds run in the public repository.
- Code signing policy: https://github.com/CookieProduction853/V-Translate/blob/main/app/CODE_SIGNING.md
- Privacy policy: https://github.com/CookieProduction853/V-Translate/blob/main/app/PRIVACY.md
- Build: `.github/workflows/windows-signpath.yml`, GitHub-hosted Windows runner, `cargo test --locked`, release build, metadata check, package checksum verification and packaged-server test.

Submit at https://signpath.org/apply using the maintainer's own contact email. Confirm third-party/artwork redistribution rights and all program terms. SignPath assesses reputation and eligibility independently; publishing the source does not guarantee acceptance.

## After acceptance

1. Enable MFA for GitHub and SignPath. Install the SignPath GitHub App for this repository if requested. Add GitHub.com as a trusted build system and link it to the project.
2. Configure a production signing policy with **manual approval on every request**, the maintainer as approver, and the CI token as submitter only. Restrict origin to `CookieProduction853/V-Translate`, `main`, `.github/workflows/windows-signpath.yml`, and GitHub-hosted runners.
3. Import `app/signpath/artifact-configuration.xml`; define its `version` parameter as required. Review the XML with SignPath before production use.
4. In this repository's Actions settings, create secret `SIGNPATH_API_TOKEN`. Never put it in source or chat. Create variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`, and `SIGNPATH_CERTIFICATE_THUMBPRINT` using actual values from the approved project/certificate.
5. Run **Windows build and SignPath** on `main` with `sign = true`, then manually approve the signing request in SignPath within 30 minutes. Missing configuration fails the run; signing failure cannot fall back to an unsigned release.
6. Download the `signed` artifact, inspect the Authenticode publisher, timestamp and final ZIP hashes, and publish it only after validation. The workflow retains artifacts and does not replace website downloads automatically. Certificate renewal requires updating the expected thumbprint.

`sign = false` and ordinary pushes build clearly labeled unsigned artifacts without SignPath credentials. Existing website downloads remain unsigned until a validated signed build is published. Windows SmartScreen reputation is separate from signature validity.
