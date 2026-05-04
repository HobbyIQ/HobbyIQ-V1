# HobbyIQ Backend Smoke Test (Local)
# This script checks the health and CompIQ endpoints for a running local backend server.

param(
    [string]$BaseUrl = "http://localhost:8080"
)

Write-Host "Running HobbyIQ backend smoke test against $BaseUrl..."

# Health endpoint
$health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -Method GET
if ($health.status -ne "ok") {
    Write-Error "/api/health failed: $($health | ConvertTo-Json)"
    exit 1
}
Write-Host "/api/health passed."

# CompIQ estimate endpoint
$estimateBody = @{ symbol = "AAPL"; shares = 10; price = 150 } | ConvertTo-Json
$estimate = Invoke-RestMethod -Uri "$BaseUrl/api/compiq/estimate" -Method POST -Body $estimateBody -ContentType "application/json"

if (-not $estimate.estimate) {
    Write-Host "DEBUG: CompIQ estimate response: $($estimate | ConvertTo-Json)"
    Write-Error "/api/compiq/estimate failed: $($estimate | ConvertTo-Json)"
    exit 1
}
Write-Host "/api/compiq/estimate passed."

Write-Host "Smoke test passed."
exit 0
