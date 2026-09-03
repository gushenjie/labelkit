function Get-AppConfig {
  $Root = Split-Path -Parent $PSScriptRoot
  $Path = Join-Path $Root "config\app.json"
  Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-DisplayHost {
  param([string]$BindHost)
  if ($BindHost -eq "0.0.0.0" -or $BindHost -eq "::") {
    return "127.0.0.1"
  }
  return $BindHost
}

function Test-ShareableIPv4 {
  param([string]$Ip)
  if (-not $Ip) { return $false }
  if ($Ip -like "127.*") { return $false }
  if ($Ip -like "169.254.*") { return $false }
  return $true
}

function Get-LanIPv4 {
  $rows = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { Test-ShareableIPv4 $_.IPAddress } |
      ForEach-Object {
        $adapter = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
        [PSCustomObject]@{
          IP = $_.IPAddress
          Metric = $_.InterfaceMetric
          Hardware = [bool]$adapter.HardwareInterface
          Status = [string]$adapter.Status
        }
      }
  )

  $preferred = @(
    $rows |
      Where-Object { $_.Hardware -and $_.Status -eq "Up" } |
      Sort-Object Metric
  )
  if ($preferred.Count -gt 0) {
    return $preferred[0].IP
  }

  $fallback = @($rows | Where-Object { $_.Status -eq "Up" } | Sort-Object Metric)
  if ($fallback.Count -gt 0) {
    return $fallback[0].IP
  }
  return $null
}

function Write-AccessHints {
  param(
    [string]$BindHost,
    [int]$ApiPort,
    [int]$WebPort
  )
  $local = Get-DisplayHost $BindHost
  Write-Host ("  Local: http://{0}:{1}" -f $local, $WebPort) -ForegroundColor Gray
  Write-Host ("  API:   http://{0}:{1}" -f $local, $ApiPort) -ForegroundColor Gray
  if ($BindHost -eq "0.0.0.0" -or $BindHost -eq "::") {
    $lan = Get-LanIPv4
    if ($lan) {
      Write-Host ("  LAN:   http://{0}:{1}" -f $lan, $WebPort) -ForegroundColor Cyan
      Write-Host ("  Tip: allow firewall ports {0}/{1} if LAN clients cannot connect" -f $WebPort, $ApiPort) -ForegroundColor DarkGray
    } else {
      Write-Host ("  LAN:   listening on 0.0.0.0; use ipconfig IPv4 then http://YOUR_IP:{0}" -f $WebPort) -ForegroundColor Cyan
    }
  }
}
