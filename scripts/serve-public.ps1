# Start inspectctl HTTP + cloudflared tunnel, print the public MCP URL.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\serve-public.ps1
#
# Ctrl+C stops both processes.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$port = 7878

$exe = Join-Path $root "bundle\inspectctl.exe"
$cloudflared = Join-Path $root "tools\cloudflared.exe"

if (-not (Test-Path $exe)) {
    Write-Error "missing $exe — run 'npm run build:exe' first"
    exit 1
}
if (-not (Test-Path $cloudflared)) {
    Write-Error "missing $cloudflared"
    exit 1
}

Write-Host "starting inspectctl on http://127.0.0.1:$port ..." -ForegroundColor Cyan
$mcp = Start-Process -FilePath $exe -ArgumentList "--http",$port -PassThru -NoNewWindow `
    -RedirectStandardError "$root\inspectctl.err.log" -RedirectStandardOutput "$root\inspectctl.out.log"

Start-Sleep -Seconds 2

# Probe healthz to make sure inspectctl is up before starting the tunnel.
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 5
    Write-Host "inspectctl healthz: $($h | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Stop-Process -Id $mcp.Id -Force
    Write-Error "inspectctl never came up: $_"
    exit 1
}

Write-Host "starting cloudflared tunnel ..." -ForegroundColor Cyan
$tunnelLog = "$root\cloudflared.log"
if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }

$tunnel = Start-Process -FilePath $cloudflared `
    -ArgumentList "tunnel","--url","http://localhost:$port","--no-autoupdate" `
    -PassThru -NoNewWindow `
    -RedirectStandardError $tunnelLog -RedirectStandardOutput "$root\cloudflared.out.log"

# Poll the cloudflared log for the trycloudflare.com URL it prints.
$publicUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $tunnelLog) {
        $content = Get-Content $tunnelLog -Raw
        if ($content -match "(https://[a-z0-9\-]+\.trycloudflare\.com)") {
            $publicUrl = $Matches[1]
            break
        }
    }
}

if (-not $publicUrl) {
    Write-Warning "tunnel URL not detected in 30s — check $tunnelLog"
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $mcp.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ""
Write-Host "===================================================" -ForegroundColor Yellow
Write-Host "  MCP endpoint for Letta Code:" -ForegroundColor Yellow
Write-Host "  $publicUrl/mcp" -ForegroundColor White
Write-Host "===================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Paste that URL into Letta Code: /mcp add -> Streamable HTTP"
Write-Host "Ctrl+C here to stop both processes."

# Wait until either process dies or user Ctrl+C.
try {
    while (-not $mcp.HasExited -and -not $tunnel.HasExited) {
        Start-Sleep -Seconds 1
    }
} finally {
    if (-not $mcp.HasExited)    { Stop-Process -Id $mcp.Id -Force -ErrorAction SilentlyContinue }
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "stopped." -ForegroundColor Cyan
}
