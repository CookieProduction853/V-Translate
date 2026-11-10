# Publishing downloadable updates

Application source is in `AI-Vtuber-Translate-Codex2`. The public product site and its ZIP files are in `CookieProduction853/V-Translate`. Pushing source alone does not replace the public ZIP.

Pushes to source `main` now trigger native Windows and Apple Silicon builds. Each platform must pass its existing checks before the publication job can copy the versioned ZIP, fixed-name ZIP and SHA256 checksums into the public repository. Publication verifies the checksums and that the two archives match, and records the version/source commit in `downloads/release-<platform>.json`. The public repository's Pages workflow then deploys the site. Windows publication serializes writes to the public repository. The Apple Silicon maintenance workflow retains a verified private artifact; download and publish that artifact with scripts/publish-downloads.cjs after all native checks pass.

## One-time access configuration

In the **source repository** Settings → Secrets and variables → Actions, add `PUBLIC_RELEASE_TOKEN`. Use a fine-grained GitHub token scoped to **CookieProduction853/V-Translate** with **Contents: read and write**. Store the value only in GitHub's secret editor. A normal source-repository `GITHUB_TOKEN` cannot write to a different repository. The publication credential must also be permitted to trigger the public repository's Pages workflow.

If this secret is absent, native builds still retain their verified packages and artifact-branch build reports, but the publication job fails with an explicit configuration message. Do not describe the public download as updated until its fixed-name ZIP and release metadata have been verified.

To retry after configuring access, re-run the failed publication job from the desired source commit's Actions run. Do not publish a failed or unverified build. Download links remain:

- `https://github.com/CookieProduction853/V-Translate/raw/refs/heads/main/downloads/V-Translate-Windows-x64.zip`
- `https://github.com/CookieProduction853/V-Translate/raw/refs/heads/main/downloads/V-Translate-macOS-arm64.zip`

Users must close the previous background app, extract the new package and launch its executable. The application does not replace its own executable automatically.
