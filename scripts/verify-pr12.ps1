$ErrorActionPreference = 'Continue'
$base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"
$ct = @{ "Content-Type" = "application/json" }

function Probe([string]$label, [string]$q) {
  $body = @{ query = $q } | ConvertTo-Json -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$base/api/compiq/search" -Headers $ct -Body $body -TimeoutSec 120
    [pscustomobject]@{
      case          = $label
      engineVersion = $r.engineVersion
      source        = $r.source
      compsUsed     = $r.compsUsed
      fmv           = $r.fairMarketValueLive
    }
  } catch {
    [pscustomobject]@{ case=$label; engineVersion="ERR"; source=$_.Exception.Message; compsUsed=$null; fmv=$null }
  }
}

Probe "baseline-Skenes" "2024 Topps Chrome Paul Skenes" | Format-List
Probe "case-01"         "2023 Bowman Draft Green Refractor Auto Jacob Wilson PSA 10" | Format-List
Probe "case-04b"        "2024 Bowman Draft Chrome Refractor Auto Nick Kurtz PSA 10"  | Format-List
Probe "case-19b"        "2025 Bowman Draft Chrome Green Refractor Auto Eli Willits PSA 10" | Format-List

Write-Host "--- 19b cross-endpoint probe ---"
try {
  $byId = Invoke-RestMethod -Method Post -Uri "$base/api/compiq/price-by-id" -Headers $ct `
    -Body (@{ cardHedgeCardId = "1768694490310x994446741982091500" } | ConvertTo-Json -Compress) -TimeoutSec 120
  [pscustomobject]@{
    endpoint      = "price-by-id"
    engineVersion = $byId.engineVersion
    source        = $byId.source
    compsUsed     = $byId.compsUsed
    fmv           = $byId.fairMarketValueLive
  } | Format-List
} catch {
  Write-Host "price-by-id ERR: $($_.Exception.Message)"
}
