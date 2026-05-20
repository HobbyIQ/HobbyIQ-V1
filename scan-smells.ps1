$liveFiles = (Get-Content $env:TEMP/live-closure.txt) | ForEach-Object { "backend/src/$_" }
$liveFiles += "backend/tests/compiqEstimate.test.ts"
$liveFiles += "backend/tests/compiqPricingAccuracy.test.ts"
$liveFiles = $liveFiles | Where-Object { Test-Path $_ }
Write-Host "Scanning $($liveFiles.Count) files"
Write-Host ""
Write-Host "=== TODO/FIXME/HACK ==="
foreach ($f in $liveFiles) {
  $hits = (Select-String -Path $f -Pattern "TODO|FIXME|HACK").Count
  if ($hits -gt 0) { "{0,4}  {1}" -f $hits, ($f -replace "backend/","") }
}
Write-Host ""
Write-Host "=== console.* ==="
foreach ($f in $liveFiles) {
  $hits = (Select-String -Path $f -Pattern "console\.").Count
  if ($hits -gt 0) { "{0,4}  {1}" -f $hits, ($f -replace "backend/","") }
}
Write-Host ""
Write-Host "=== debugger / .only / .skip ==="
foreach ($f in $liveFiles) {
  $hits = (Select-String -Path $f -Pattern "debugger;|\.only\(|\.skip\(").Count
  if ($hits -gt 0) { "{0,4}  {1}" -f $hits, ($f -replace "backend/","") }
}
Write-Host ""
Write-Host "=== Commented feature-flag-looking blocks (// if|/* if) ==="
foreach ($f in $liveFiles) {
  $hits = (Select-String -Path $f -Pattern "^\s*//.*FLAG|^\s*//.*ENABLE|^\s*//.*DISABLE").Count
  if ($hits -gt 0) { "{0,4}  {1}" -f $hits, ($f -replace "backend/","") }
}
