# Stops only the authenticated V-Translate instance. No process-name killing.
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'LiveSub\LiveSub\data'))
$ErrorActionPreference = 'Stop'
try {
    $file = Join-Path $DataDir 'player.url'
    if (-not (Test-Path -LiteralPath $file)) { Write-Host 'V-Translate is not running (no saved local address).'; exit 0 }
    $address = [IO.File]::ReadAllText($file).Trim()
    if ($address -notmatch '^http://127\.0\.0\.1:([0-9]{1,5})/#token=([a-fA-F0-9]{64})$') { throw 'Invalid local V-Translate address.' }
    $port = [int]$Matches[1]
    $token = $Matches[2]
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid local port.' }
    $origin = "http://127.0.0.1:$port"
    $headers = @{Authorization="Bearer $token"}
    try { $version = Invoke-RestMethod "$origin/api/version" -Headers $headers -TimeoutSec 5 }
    catch { Write-Host 'No reachable V-Translate server. It may already be stopped.'; exit 0 }
    if ($version.version -notmatch '^\d+\.\d+\.\d+$') { throw 'The service is not a recognized V-Translate instance.' }
    Invoke-RestMethod "$origin/api/quit" -Method Post -Headers $headers -TimeoutSec 15 | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try { Invoke-RestMethod "$origin/api/version" -Headers $headers -TimeoutSec 1 | Out-Null }
        catch { Write-Host 'Whisper and the V-Translate local server have stopped.'; exit 0 }
    }
    throw 'Shutdown is taking longer than expected. Please retry.'
} catch { Write-Error 'Unable to stop V-Translate. Please check the data folder or retry.'; exit 1 }
