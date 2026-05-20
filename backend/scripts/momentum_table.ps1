$names = @("skenes","trout","judge","mantle","anthony","devries")
$rows = @()
foreach ($n in $names) {
  $p = "$env:TEMP\momentum-investigation-$n.json"
  $j = Get-Content -Raw $p | ConvertFrom-Json
  $xpa = $j.crossParallelAnchor
  $live = $j.fairMarketValueLive
  $mv = $j.marketTier.value
  $disc = "n/a"
  if ($null -ne $live -and $live -gt 0 -and $null -ne $mv) {
    $disc = [math]::Round((($mv - $live) / $live) * 100, 2).ToString() + "%"
  }
  $trig = if ($xpa.triggerReason) { $xpa.triggerReason } else { "not triggered" }
  $ws = if ($xpa.trend.weeklySamples) { $xpa.trend.weeklySamples } else { "n/a" }
  $sp = if ($xpa.trend.slopePctPerWeek) { [math]::Round($xpa.trend.slopePctPerWeek,2) } else { "n/a" }
  $ew = if ($xpa.effectiveWeeksApplied) { $xpa.effectiveWeeksApplied } else { "n/a" }
  $mp = if ($xpa.momentumPctApplied) { $xpa.momentumPctApplied } else { "n/a" }
  $nu = if ($xpa.neighborsUsed) { $xpa.neighborsUsed } else { "n/a" }
  $pt = if ($xpa.anchor.parallelTier) { $xpa.anchor.parallelTier } else { "n/a" }
  $row = [PSCustomObject]@{
    Card = $n
    source = $j.source
    compsUsed = $j.compsUsed
    daysSinceNewestComp = $j.daysSinceNewestComp
    fairMarketValueLive = $live
    marketTierValue = $mv
    discount = $disc
    momentumTrigger = $trig
    weeklySamples = $ws
    slopePctPerWeek = $sp
    extrapolationWeeks = $ew
    momentumPctApplied = $mp
    neighborsUsed = $nu
    parallelTier = $pt
  }
  $rows += $row
}
$rows | Format-Table -AutoSize | Out-String -Width 400
Write-Host ""
Write-Host "=== Card identity per query ==="
foreach ($n in $names) {
  $p = "$env:TEMP\momentum-investigation-$n.json"
  $j = Get-Content -Raw $p | ConvertFrom-Json
  $id = if ($j.cardIdentity) { $j.cardIdentity.card_id } else { "(null)" }
  $name = if ($j.cardIdentity) { $j.cardIdentity.name } else { "(null)" }
  Write-Host ("{0,-10} card_id={1}  name={2}" -f $n, $id, $name)
}
Write-Host ""
Write-Host "=== summaries ==="
foreach ($n in $names) {
  $p = "$env:TEMP\momentum-investigation-$n.json"
  $j = Get-Content -Raw $p | ConvertFrom-Json
  Write-Host ("[" + $n + "] " + $j.summary)
}
