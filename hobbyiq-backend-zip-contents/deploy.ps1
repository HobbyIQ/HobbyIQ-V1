# 🚀 HobbyIQ Azure Deploy Script (PowerShell)

$APP_NAME = "hobbyiq"
$RESOURCE_GROUP = "rg-hobbyiq-dev"
$LOCATION = "centralus"
$RANDOM_SUFFIX = -join ((97..122) | Get-Random -Count 4 | % {[char]$_})

Write-Host "🚀 Starting deployment..."

# 🔐 Login check
az account show 2>$null
if ($LASTEXITCODE -ne 0) {
    az login
}

# 📦 Create Resource Group
az group create `
  --name $RESOURCE_GROUP `
  --location $LOCATION

# 🔍 Check if app exists
$appExists = az webapp show `
  --name $APP_NAME `
  --resource-group $RESOURCE_GROUP 2>$null

if ($LASTEXITCODE -eq 0) {
    Write-Host "⚠️ App exists. Adding suffix..."
    $APP_NAME = "$APP_NAME-$RANDOM_SUFFIX"
}

Write-Host "Using App Name: $APP_NAME"

# 🚀 Deploy Bicep
az deployment group create `
  --resource-group $RESOURCE_GROUP `
  --template-file main.bicep

# ⚙️ Force Node 20
az webapp config set `
  --name $APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --linux-fx-version "NODE|20-lts"

# 📦 Build ZIP
Write-Host "📦 Creating zip..."
if (Test-Path app.zip) {
    Remove-Item app.zip -Force
}

$files = Get-ChildItem -Path . -Exclude "node_modules", ".git", "app.zip"
Compress-Archive -Path $files -DestinationPath app.zip

# 🚀 Deploy ZIP
Write-Host "🚀 Deploying app..."
az webapp deployment source config-zip `
  --resource-group $RESOURCE_GROUP `
  --name $APP_NAME `
  --src app.zip

# 🌐 Get URL
$APP_URL = az webapp show `
  --name $APP_NAME `
  --resource-group $RESOURCE_GROUP `
  --query defaultHostName `
  -o tsv

Write-Host "🌐 App URL: https://$APP_URL"

# 🧪 Test API
Start-Sleep -Seconds 15

try {
    $response = Invoke-RestMethod "https://$APP_URL/api/health"
    Write-Host "✅ API Response:" $response.status
} catch {
    Write-Host "❌ API check failed"
}

Write-Host "📡 View logs:"
Write-Host "az webapp log tail --name $APP_NAME --resource-group $RESOURCE_GROUP"
