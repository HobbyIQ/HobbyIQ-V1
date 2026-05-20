$ErrorActionPreference = "Stop"
$base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/compiq/search"

$mantle = Invoke-RestMethod -Uri $base -Method POST -ContentType "application/json" -Body '{"query": "1956 Topps Mickey Mantle PSA 7"}'
$mantle | ConvertTo-Json -Depth 40 | Out-File -FilePath "$env:TEMP\mantle-19-investigation-full.json" -Encoding utf8
Write-Host "MANTLE saved."

$aaron = Invoke-RestMethod -Uri $base -Method POST -ContentType "application/json" -Body '{"query": "1954 Topps Hank Aaron PSA 7"}'
$aaron | ConvertTo-Json -Depth 40 | Out-File -FilePath "$env:TEMP\mantle-19-control-aaron.json" -Encoding utf8
Write-Host "AARON saved."

Write-Host "`n=== MANTLE summary ==="
Write-Host ("engineVersion: " + $mantle.engineVersion)
Write-Host ("card_id: " + $mantle.card_id)
Write-Host ("compsUsed: " + $mantle.compsUsed)
Write-Host ("fairMarketValueLive: " + $mantle.fairMarketValueLive)
Write-Host ("marketTier.value: " + $mantle.marketTier.value)
Write-Host ("marketTier.high: " + $mantle.marketTier.high)
Write-Host ("marketTier.low: " + $mantle.marketTier.low)
Write-Host "recentComps count: $($mantle.recentComps.Count)"

Write-Host "`n=== AARON summary ==="
Write-Host ("engineVersion: " + $aaron.engineVersion)
Write-Host ("card_id: " + $aaron.card_id)
Write-Host ("compsUsed: " + $aaron.compsUsed)
Write-Host ("fairMarketValueLive: " + $aaron.fairMarketValueLive)
Write-Host ("marketTier.value: " + $aaron.marketTier.value)
Write-Host "recentComps count: $($aaron.recentComps.Count)"
