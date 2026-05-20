$ErrorActionPreference = "Stop"
$mantle = Get-Content "$env:TEMP\mantle-19-investigation-full.json" -Raw | ConvertFrom-Json
$aaron  = Get-Content "$env:TEMP\mantle-19-control-aaron.json" -Raw | ConvertFrom-Json

Write-Host "=== MANTLE top-level keys ==="
$mantle.PSObject.Properties.Name | Sort-Object | ForEach-Object { Write-Host (" - {0}" -f $_) }

Write-Host ""
Write-Host "=== MANTLE recentComps ==="
$idx = 0
foreach ($c in $mantle.recentComps) {
  $idx++
  $price = $c.price
  $mult = if ($price) { $price * 19 } else { 0 }
  Write-Host ("[{0}] price={1}  x19={2}  date={3}  grade={4}" -f $idx,$price,$mult,$c.date,$c.grade)
  Write-Host ("     title: {0}" -f $c.title)
}

Write-Host ""
Write-Host "=== MANTLE numeric top-level fields ==="
foreach ($p in $mantle.PSObject.Properties) {
  $v = $p.Value
  if ($v -is [double] -or $v -is [int] -or $v -is [long]) {
    Write-Host (" {0} = {1}" -f $p.Name, $v)
  }
}

Write-Host ""
Write-Host "=== MANTLE marketTier ==="
$mantle.marketTier | ConvertTo-Json -Depth 6

Write-Host ""
Write-Host "=== MANTLE id-ish fields ==="
foreach ($k in @('card_id','cardId','id','pinnedCardId','cardHedgeId','cardhedgeId')) {
  $v = $mantle.$k
  if ($null -ne $v -and $v -ne '') { Write-Host (" {0} = {1}" -f $k,$v) }
}

Write-Host ""
Write-Host "=== AARON recentComps ==="
$idx = 0
foreach ($c in $aaron.recentComps) {
  $idx++
  $price = $c.price
  $mult = if ($price) { $price * 19 } else { 0 }
  Write-Host ("[{0}] price={1}  x19={2}  date={3}  grade={4}" -f $idx,$price,$mult,$c.date,$c.grade)
  Write-Host ("     title: {0}" -f $c.title)
}

Write-Host ""
Write-Host "=== AARON numeric top-level fields ==="
foreach ($p in $aaron.PSObject.Properties) {
  $v = $p.Value
  if ($v -is [double] -or $v -is [int] -or $v -is [long]) {
    Write-Host (" {0} = {1}" -f $p.Name, $v)
  }
}
