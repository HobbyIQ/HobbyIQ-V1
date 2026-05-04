# HobbyIQ Azure Smoke Test (PowerShell)
# Usage: .\scripts\smoke-test-azure.ps1 -BaseUrl "https://<your-app-service-name>.azurewebsites.net"
param(
    [string]$BaseUrl = "https://<your-app-service-name>.azurewebsites.net"
)

function Test-Endpoint {
    param(
        [string]$Endpoint
    )
    Write-Host "Testing $BaseUrl$Endpoint ..."
    try {
        $response = Invoke-RestMethod -Uri "$BaseUrl$Endpoint" -Method Get -ErrorAction Stop
        Write-Host "PASS: $Endpoint returned 200"
    } catch {
        Write-Host "FAIL: $Endpoint"
        Write-Host $_.Exception.Message
        exit 1
    }
}

# Main API health
Test-Endpoint "/api/health"

# Pricing endpoint basic check (GET for health, POST for estimate)
Test-Endpoint "/api/compiq/health"

# Pricing estimate (POST)
$body = @{ 
    playerName = "Blake Burke"
    cardYear = 2024
    product = "Bowman Chrome"
    parallel = "Orange Wave Auto"
    gradeCompany = "PSA"
    gradeValue = 10
    isAuto = $true
} | ConvertTo-Json

try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/api/compiq/estimate" -Method Post -ContentType "application/json" -Body $body -ErrorAction Stop
    Write-Host "PASS: /api/compiq/estimate returned 200"
} catch {
    Write-Host "FAIL: /api/compiq/estimate"
    Write-Host $_.Exception.Message
    exit 1
}

Write-Host "All smoke tests passed!"