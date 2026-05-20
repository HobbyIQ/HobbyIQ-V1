param([string]$Name = "skenes")
$j = Get-Content -Raw "$env:TEMP\momentum-investigation-$Name.json" | ConvertFrom-Json
Write-Host "=== $Name top-level keys ==="
$j.PSObject.Properties.Name -join ", "
Write-Host ""
Write-Host "marketTier: $($j.marketTier | ConvertTo-Json -Compress)"
Write-Host "buyZone: $($j.buyZone -join ',')  holdZone: $($j.holdZone -join ',')  sellZone: $($j.sellZone -join ',')"
Write-Host "fairMarketValueLive=$($j.fairMarketValueLive)  gradeUsed=$($j.gradeUsed)  daysSinceNewestComp=$($j.daysSinceNewestComp)"
Write-Host "variantWarning=$($j.variantWarning -join ', ')"
Write-Host "crossParallelAnchor null? $($null -eq $j.crossParallelAnchor)"
Write-Host "neighborSynthesis null? $($null -eq $j.neighborSynthesis)"
Write-Host ""
Write-Host "Top 10 recentComps:"
$j.recentComps | Select-Object -First 10 | ForEach-Object { "{0,-22} {1,8} {2}" -f $_.soldDate, ("$" + $_.price), $_.title }
