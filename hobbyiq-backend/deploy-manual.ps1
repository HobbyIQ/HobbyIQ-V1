# deploy-manual.ps1
# Manual deployment script for Azure App Service

$ErrorActionPreference = "Stop"

$appName = "HobbyIQ"
$resourceGroup = "rg-hobbyiq-dev"
$liveUrl = "https://hobbyiq-andjgvhgfbhfcuhv.centralus-01.azurewebsites.net"

Write-Host "Starting manual deploy..."

# 1. Delete any old zip
if (Test-Path "app.zip") {
    Remove-Item "app.zip" -Force
    Write-Host "Old app.zip deleted."
}

# 2. Build a clean zip from backend root
Write-Host "Creating app.zip..."

$files = Get-ChildItem -Force | Where-Object {
    $_.Name -notin @("node_modules", ".git", "app.zip")
}


Compress-Archive -Path $files.FullName -DestinationPath "app.zip" -Force

Write-Host "Zip created."

# 2.5. List contents of app.zip for verification
Write-Host "Listing contents of app.zip:"
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead("app.zip")
    foreach ($entry in $zip.Entries) {
        Write-Host $entry.FullName
    }
    $zip.Dispose()
} catch {
    Write-Host "Could not list zip contents: $_"
}

# 3. Deploy with Azure CLI
Write-Host "Deploying app.zip to Azure App Service..."

az webapp deploy `
  --resource-group $resourceGroup `
  --name $appName `
  --src-path "app.zip" `
  --type zip

if ($LASTEXITCODE -ne 0) {
    throw "Azure deploy failed."
}

# 4. Restart App Service for reliability
Write-Host ""
Write-Host "Restarting Azure App Service..."
az webapp restart --name $appName --resource-group $resourceGroup
if ($LASTEXITCODE -ne 0) {
    Write-Host "App Service restart failed, continuing anyway."
} else {
    Write-Host "App Service restarted."
}

# 5. Print live URL
Write-Host ""
Write-Host "Deployment complete. App URL:"
Write-Host $liveUrl

# 6. Health check
Write-Host ""
Write-Host "Checking /api/health ..."
Start-Sleep -Seconds 10

try {
    $response = Invoke-WebRequest -Uri "$liveUrl/api/health" -UseBasicParsing -TimeoutSec 15
    Write-Host "Health check response:"
    Write-Host $response.Content
} catch {
    Write-Host "Health check failed:"
    Write-Host $_.Exception.Message
    Write-Host ""
    Write-Host "Check logs with:"
    Write-Host "az webapp log tail --name $appName --resource-group $resourceGroup"
}
