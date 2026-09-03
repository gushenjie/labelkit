param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_app-config.ps1"
$Config = Get-AppConfig
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "$($Config.brand.fullName) · 本地开发环境" -ForegroundColor Cyan
Write-AccessHints -BindHost $Config.runtime.host -ApiPort $Config.runtime.apiPort -WebPort $Config.runtime.webPort
Write-Host "  配置: $Root\config\app.json" -ForegroundColor DarkGray
if ($Clean) {
  Write-Host "  模式: 清理缓存后启动 (-Clean)" -ForegroundColor Yellow
}

$serverArgs = @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start-server.ps1"))
$webArgs = @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start-web.ps1"))
if ($Clean) {
  $serverArgs += "-Clean"
  $webArgs += "-Clean"
}

Start-Process powershell @serverArgs
Start-Sleep -Seconds 2
Start-Process powershell @webArgs

Write-Host "`n已在两个窗口中启动前后端。若页面报 Cannot find module './xxx.js'，请改用:" -ForegroundColor Green
Write-Host "  .\scripts\start-dev.ps1 -Clean" -ForegroundColor White
