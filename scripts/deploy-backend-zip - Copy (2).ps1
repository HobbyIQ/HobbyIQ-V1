param(
  [string]$ResourceGroup,
  [string]$AppName,
  [string]$BackendPath = "./backend",
  [string]$ZipPath = "./backend-deploy.zip",
  [switch]$InspectOnly,
  [switch]$KeepZip = $true
)

$ErrorActionPreference = "Stop"

Write-Host "[HobbyIQ] Cleaning previous build..."
Push-Location $BackendPath
npm ci
npm run build
Pop-Location


# --- BEGIN: Bulletproof ZIP packaging for Azure App Service ---
$packageDir = "_backend_package_temp"
if (Test-Path $packageDir) { Remove-Item $packageDir -Recurse -Force }
New-Item -ItemType Directory -Path $packageDir | Out-Null

# Copy dist/ and package files to temp dir root
Copy-Item "$BackendPath/dist" "$packageDir/dist" -Recurse
Copy-Item "$BackendPath/package.json" "$packageDir/package.json"
if (Test-Path "$BackendPath/package-lock.json") {
  Copy-Item "$BackendPath/package-lock.json" "$packageDir/package-lock.json"
}

# Install production dependencies in temp dir
Push-Location $packageDir
if (Test-Path "package-lock.json") {
  npm ci --omit=dev
} else {
  npm install --omit=dev
}
Pop-Location

# Validate entry point
if (-not (Test-Path "$packageDir/dist/server.js")) {
  Write-Error "dist/server.js missing in package. Aborting."
  exit 1
}

# Remove old ZIP if present
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

# Create ZIP with correct root (dist/, package.json, node_modules/)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($packageDir, $ZipPath)

Write-Host "[HobbyIQ] Listing ZIP contents:"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
$zip.Entries | ForEach-Object { $_.FullName }
$zip.Dispose()

if ($InspectOnly) {
  Write-Host "[HobbyIQ] InspectOnly mode: ZIP created and validated. No deployment performed."
  if (-not $KeepZip) { Remove-Item $ZipPath -Force }
  Remove-Item $packageDir -Recurse -Force
  exit 0
}

Write-Host "[HobbyIQ] Deploying ZIP to Azure App Service..."
az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $ZipPath --type zip --restart true

if (-not $KeepZip) { Remove-Item $ZipPath -Force }
Remove-Item $packageDir -Recurse -Force
Write-Host "[HobbyIQ] Deployment complete."
# --- END: Bulletproof ZIP packaging ---
