Write-Host "=== DEVRIES crossParallelAnchor sibling pool (first 12 of detail) ==="
$j = Get-Content -Raw "$env:TEMP\momentum-investigation-devries.json" | ConvertFrom-Json
$xpa = $j.crossParallelAnchor
Write-Host ("triggerReason=" + $xpa.triggerReason)
Write-Host ("fmv=" + $xpa.fmv + "  momentumAdjustedFmv=" + $xpa.momentumAdjustedFmv + "  momentumPctApplied=" + $xpa.momentumPctApplied)
Write-Host ("neighborsUsed=" + $xpa.neighborsUsed + "  neighborsConsidered=" + $xpa.neighborsConsidered)
Write-Host ("anchor.parallelTier=" + $xpa.anchor.parallelTier)
Write-Host ""
$xpa.detail | Select-Object -First 12 | ForEach-Object {
  "{0,-10} {1,-22} mult={2,-6} parallel='{3}'  title='{4}'" -f ("$" + $_.neighborPrice), $_.soldDate, $_.relativeMultiplier, $_.neighborParallel, $_.neighborTitle
}
Write-Host ""
Write-Host "Distinct player names in sibling pool (heuristic from titles):"
$pool = $xpa.detail | ForEach-Object { $_.neighborTitle }
$matched = $pool | Where-Object { $_ -match '(?i)de\s*vries' } | Measure-Object | Select-Object -ExpandProperty Count
$other = ($pool | Measure-Object).Count - $matched
Write-Host ("  contains 'De Vries' : " + $matched + " / " + ($pool | Measure-Object).Count)
Write-Host ("  other (no De Vries): " + $other)
if ($other -gt 0) {
  Write-Host "  Sample non-DeVries titles:"
  $pool | Where-Object { $_ -notmatch '(?i)de\s*vries' } | Select-Object -First 8 | ForEach-Object { "    - $_" }
}

Write-Host ""
Write-Host "=== ANTHONY neighborSynthesis (variant-mismatch fallback) ==="
$ja = Get-Content -Raw "$env:TEMP\momentum-investigation-anthony.json" | ConvertFrom-Json
$ns = $ja.neighborSynthesis
Write-Host ("neighborSynthesis present? " + ($null -ne $ns))
if ($ns) {
  $ns | ConvertTo-Json -Depth 4
}
Write-Host ""
Write-Host "neighborSynthesisDebug:"
if ($ja.neighborSynthesisDebug) {
  $dbg = $ja.neighborSynthesisDebug
  Write-Host ("  reason=" + $dbg.reason + "  pool=" + $dbg.poolSize + "  used=" + $dbg.used)
  if ($dbg.samples) {
    $dbg.samples | Select-Object -First 8 | ForEach-Object { "    " + ($_ | ConvertTo-Json -Compress) }
  }
}
