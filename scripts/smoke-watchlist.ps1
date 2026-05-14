$ErrorActionPreference = "Stop"
$base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"
$login = Invoke-RestMethod -Method POST -Uri "$base/api/auth/signin" -ContentType "application/json" -Body '{"username":"HobbyIQ","password":"Baseball25"}'
if (-not $login.success) { Write-Host "LOGIN FAIL"; $login | ConvertTo-Json; exit 1 }
$sid = $login.sessionId
Write-Host "SESSION: $($sid.Substring(0,30))..."
$h = @{ "x-session-id" = $sid }

Write-Host "`n--- GET /api/watchlist (initial) ---"
Invoke-RestMethod -Uri "$base/api/watchlist" -Headers $h | ConvertTo-Json -Depth 5

Write-Host "`n--- POST /api/watchlist ---"
$add = Invoke-RestMethod -Method POST -Uri "$base/api/watchlist" -Headers $h -ContentType "application/json" -Body '{"playerId":"mlb-545361","playerName":"Mike Trout","sport":"baseball"}'
$add | ConvertTo-Json -Depth 5
$wid = $add.watchlistItemId

Write-Host "`n--- PATCH alertEnabled=true ---"
Invoke-RestMethod -Method PATCH -Uri "$base/api/watchlist/$wid" -Headers $h -ContentType "application/json" -Body '{"alertEnabled":true}' | ConvertTo-Json -Depth 5

Write-Host "`n--- GET /api/watchlist (after patch) ---"
Invoke-RestMethod -Uri "$base/api/watchlist" -Headers $h | ConvertTo-Json -Depth 5

Write-Host "`n--- DELETE ---"
Invoke-RestMethod -Method DELETE -Uri "$base/api/watchlist/$wid" -Headers $h | ConvertTo-Json -Depth 5

Write-Host "`n--- GET /api/portfolio ---"
$p = Invoke-RestMethod -Uri "$base/api/portfolio" -Headers $h
$p | ConvertTo-Json -Depth 3
Write-Host "summary present: $($null -ne $p.summary)"
