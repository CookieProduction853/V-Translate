# Developer packaging helper. The distributed app needs neither Python nor Node.
param(
    [string]$WhisperVulkanArchive = (Join-Path $PSScriptRoot '../vendor/whisper-vulkan.zip'),
    [string]$WhisperVulkanLicense = (Join-Path $PSScriptRoot '../vendor/whisper.cpp-LICENSE.txt')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$WhisperVulkanArchive = (Resolve-Path -LiteralPath $WhisperVulkanArchive).Path
$WhisperVulkanLicense = (Resolve-Path -LiteralPath $WhisperVulkanLicense).Path
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    $metadataJson = & cargo metadata --locked --no-deps --format-version 1
    if ($LASTEXITCODE -ne 0) { throw 'Could not read Cargo package metadata' }
    $metadata = $metadataJson | ConvertFrom-Json
    $version = ($metadata.packages | Where-Object name -eq 'livesub').version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid application version' }
    $runtimeHash = [regex]::Match((Get-Content -Raw 'src/assets.rs'), 'WHISPER_VULKAN_SHA: &str = "([a-f0-9]{64})";').Groups[1].Value
    if (!$runtimeHash -or (Get-FileHash -LiteralPath $WhisperVulkanArchive).Hash -ne $runtimeHash) {
        throw 'Whisper Vulkan runtime does not match the SHA-256 pinned by this application.'
    }

    $dist = Join-Path $projectRoot 'dist'
    $packageName = 'V-Translate-Windows-x64'
    $package = Join-Path $dist $packageName
    if (Test-Path $package) { Remove-Item -Recurse -Force $package }
    New-Item -ItemType Directory -Path $package -Force | Out-Null
    Copy-Item 'scripts/stop-tools/Start-Without-Network-Updates.cmd' $package
    Copy-Item 'scripts/stop-tools/Stop-Whisper.cmd' $package
    Copy-Item 'scripts/stop-tools/Stop-Whisper.ps1' $package
    Copy-Item 'target/release/livesub.exe' (Join-Path $package 'V-Translate.exe')
    Copy-Item -LiteralPath $WhisperVulkanArchive -Destination (Join-Path $package 'whisper-vulkan.zip')
    Copy-Item -LiteralPath $WhisperVulkanLicense -Destination (Join-Path $package 'whisper.cpp-LICENSE.txt')
    foreach ($name in @('README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt', 'PRIVACY.md', 'CODE_SIGNING.md')) {
        Copy-Item $name (Join-Path $package $name)
    }
    foreach ($folder in @('docs', 'examples')) {
        Copy-Item $folder -Destination $package -Recurse
    }
    @"
V-Translate / 油字幕 $version
Windows x86_64 preview
Traditional Chinese / English; CPU / Vulkan GPU transcription and translation
"@ | Set-Content (Join-Path $package 'VERSION.txt') -Encoding utf8
    @"
油字幕 - 本地 AI Vtuber 即時字幕
V-Translate v$version · Windows 10/11 64 位元測試版

1. 先在舊播放器按「關閉背景聽寫程式(whisper)」，再開啟此套件的 V-Translate.exe。不需要 Python。
2. 右上角可選 CPU 或 Vulkan。兩個引擎都使用所選運算模式。請保留執行檔旁的 whisper-vulkan.zip。
3. 按右上角 Settings 齒輪，使用主題、模型資料夾、效能設定、顯卡裝置偵測及翻譯模型等進階功能。
4. 首次使用先選語言和效能，再跟隨導覽。模型會在背景準備，完成後可開始擷取。
5. 在同一個 Chrome／Edge 開啟直播及正常登入，再分享直播「分頁」及「分頁音訊」。Firefox 不適用。
6. 字幕紀錄有獨立分頁，切換時保留擷取。可在紀錄分頁匯出字幕。
7. 廣告可按左右按鈕切換，也會每 10 秒循環。Fans AD Contact 電郵會固定顯示於廣告下方。
8. 高效能預設為 5 秒起始緩衝，滑桿最低可手動調到 3 秒。分享分頁前可選歌回、雜談或回放模式。
9. 若缺少 DLL，可安裝 Microsoft Visual C++ x64 Runtime：https://aka.ms/vs/17/release/vc_redist.x64.exe
10. 模型、詞彙包及詳情見套件內 README.md、docs 及 examples。不要在引擎執行期間自行刪除模型。

這是測試版。原生 Windows 建置與本機服務測試不等於使用者 CPU/GPU、真實模型或會員直播的端到端效能驗證。
"@ | Set-Content (Join-Path $package '開始使用.txt') -Encoding utf8
    @"
V-Translate - Real time local AI translator for Vtuber viewers.
Version $version · Windows x64 preview

1. Close the previous background app using its quit button, then run V-Translate.exe. Python is not required.
2. Choose CPU or Vulkan in the top bar. Transcription and translation use the selected mode. Keep whisper-vulkan.zip next to the executable.
3. Open the Settings gear for themes, model folders, performance, GPU detection and translation model options.
4. On first launch, choose a language and performance preset, then follow the tour. Models are prepared in the background.
5. Open the stream normally in the same Chrome or Edge browser, sign in, then share the live-stream tab with tab audio. Firefox is unsupported.
6. Caption history has its own tab. Switching tabs preserves capture, and history can be exported.
7. Ads cycle every 10 seconds and have previous/next controls. Fans AD Contact remains below the banner.
8. High starts with a 5-second buffer. The player slider goes down to 3 seconds. Choose Song, Chat or Replay before sharing a tab.
9. If a DLL is missing, install the Microsoft Visual C++ x64 Runtime: https://aka.ms/vs/17/release/vc_redist.x64.exe
10. Read README.md and docs/examples for model and vocabulary instructions. Stop the engines before manually removing models.

This preview is verified by native Windows build and local-server tests. That does not establish real CPU/GPU performance, model quality or member-only-stream capture compatibility on user hardware.
"@ | Set-Content (Join-Path $package 'Start Here.txt') -Encoding utf8

    $hashLines = Get-ChildItem $package -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($package, $_.FullName).Replace('\', '/')
        '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
    }
    $hashLines | Set-Content (Join-Path $package 'SHA256SUMS.txt') -Encoding utf8
    $versioned = Join-Path $dist "V-Translate-v$version-Windows-x64.zip"
    if (Test-Path $versioned) { Remove-Item $versioned }
    Compress-Archive -Path $package -DestinationPath $versioned -CompressionLevel Optimal

    # Read the archive itself and verify every internal checksum, not only disk copies.
    $archive = [IO.Compression.ZipFile]::OpenRead($versioned)
    try {
        $entries = @{}
        foreach ($entry in $archive.Entries) { $entries[$entry.FullName.Replace('\', '/')] = $entry }
        foreach ($line in $hashLines) {
            $parts = $line -split '  ', 2
            $entryName = "$packageName/$($parts[1])"
            if (-not $entries.ContainsKey($entryName)) { throw "Archive is missing $entryName" }
            $stream = $entries[$entryName].Open()
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $digest = [Convert]::ToHexString($hasher.ComputeHash($stream)).ToLowerInvariant() }
            finally { $stream.Dispose(); $hasher.Dispose() }
            if ($digest -ne $parts[0]) { throw "Archive checksum mismatch: $entryName" }
        }
    }
    finally { $archive.Dispose() }
    $alias = Join-Path $dist 'V-Translate-Windows-x64.zip'
    Copy-Item $versioned $alias -Force
    @($versioned, $alias) | ForEach-Object {
        '{0}  {1}' -f (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($_)
    } | Set-Content (Join-Path $dist 'SHA256SUMS-Windows-x64.txt') -Encoding utf8
    Write-Output "Packaged and verified $versioned"
}
finally { Pop-Location }
