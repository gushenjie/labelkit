# 强制清理 8010 并以前台单进程方式启动，便于抓上传日志
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot\_app-config.ps1"
$Config = Get-AppConfig
$Port = $Config.runtime.apiPort

Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2
Set-Location $Root
$env:PYTHONPATH = $Root
$venvPython = Join-Path $Root ".venv\Scripts\python.exe"
Write-Host "[server] no-reload debug start on $Port" -ForegroundColor Yellow
& $venvPython -m uvicorn server.main:app --host 0.0.0.0 --port $Port --log-level debug
