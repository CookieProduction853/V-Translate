# Code signing policy

Status: preparation for a SignPath Foundation application. No application approval or signed release is claimed. Existing downloads remain unchanged.

Once approved: Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Only the V-Translate Windows executable, built from this public repository by `.github/workflows/windows-signpath.yml` on a GitHub-hosted Windows runner, is submitted for signing. Third-party binaries, including whisper.cpp and llama.cpp, are not signed using this project's certificate. The portable ZIP contains the signed executable and retains upstream license notices. macOS signing is outside this policy.

The project maintainer [CookieProduction853](https://github.com/CookieProduction853) is the designated author, reviewer and release approver. External contributions require maintainer review. Before production signing is enabled, the maintainer must enable multi-factor authentication on GitHub and SignPath. Each signing request requires manual approval in SignPath. Automated submission does not replace approval.

SignPath must restrict the trusted build system to this public repository, the Windows workflow, GitHub-hosted runners and the `main` branch. Product name must be `V-Translate`; product version must match the build's Cargo package version. Returned signatures and timestamps are verified before packaging; checksums are calculated after signing.

See [Privacy policy](PRIVACY.md) for network requests and how to disable background requests, and [setup instructions](docs/signpath-setup.md) for the remaining account configuration.
