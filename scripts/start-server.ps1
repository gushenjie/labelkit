param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_app-config.ps1"
$Config = Get-AppConfig
$Root = Split-Path -Parent $PSScriptRoot
$Port = $Config.runtime.apiPort

Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Set-Location $Root

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

$venvPython = Join-Path $Root ".venv\Scripts\python.exe"
& $venvPython -m pip install -q -r server/requirements.txt

$env:PYTHONPATH = $Root
$DisplayHost = Get-DisplayHost $Config.runtime.host
Write-Host ("[server] start {0} api http://{1}:{2} (bind {3})" -f $Config.brand.fullName, $DisplayHost, $Port, $Config.runtime.host) -ForegroundColor Green
& $venvPython -m server.run --reload
