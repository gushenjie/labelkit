param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_app-config.ps1"
$Config = Get-AppConfig
$Root = Split-Path -Parent $PSScriptRoot
$WebDir = Join-Path $Root "web"
$Port = $Config.runtime.webPort

Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Set-Location $WebDir

if (-not (Test-Path "node_modules")) {
  npm install
}

if ($Clean) {
  if (Test-Path ".next") {
    Remove-Item -Recurse -Force ".next"
    Write-Host "[web] 已清理 .next 构建缓存" -ForegroundColor Yellow
  }
}

$DisplayHost = Get-DisplayHost $Config.runtime.host
Write-Host ("[web] start {0} frontend http://{1}:{2} (bind {3})" -f $Config.brand.fullName, $DisplayHost, $Port, $Config.runtime.host) -ForegroundColor Green
$Lan = Get-LanIPv4
if ($Config.runtime.host -eq "0.0.0.0" -or $Config.runtime.host -eq "::") {
  if ($Lan) {
    Write-Host ("[web] LAN url http://{0}:{1}" -f $Lan, $Port) -ForegroundColor Cyan
  } else {
    Write-Host ("[web] LAN url http://YOUR_IP:{0}" -f $Port) -ForegroundColor Cyan
  }
}
if ($Clean) {
  npm run dev:clean
} else {
  npm run dev
}
