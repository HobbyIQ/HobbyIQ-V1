<#
.SYNOPSIS
Deploys the HobbyIQ backend to Azure App Service using a clean ZIP (run-from-package) deployment.

.DESCRIPTION
- Always creates or leaves backend-deploy.zip at the workspace root for inspection.
- Prints the full resolved ZIP path after creation.
- Lists the ZIP contents after creation.
- Explicitly checks for dist/src/server.js in the ZIP.
- If dist/src/server.js is missing: prints FAIL, does not deploy, exits non-zero.
- If dist/src/server.js is present: prints PASS, continues deployment.
- Supports -KeepZip (default: keeps ZIP) and -InspectOnly (build/package/inspect only, no deploy).

.EXAMPLES
# Deploy to Azure and keep ZIP for inspection
.\scripts\deploy-backend-zip.ps1 `
  -ResourceGroup "rg-hobbyiq-dev" `
  -AppName "HobbyIQ"

# Inspect only (no deploy)
.\scripts\deploy-backend-zip.ps1 `
  -ResourceGroup "rg-hobbyiq-dev" `
  -AppName "HobbyIQ" `
  -InspectOnly
#
# After running, inspect ZIP contents:
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path ".\backend-deploy.zip")).Entries |
  Select-Object FullName, Length |
  Sort-Object FullName |
  Format-Table -Auto

# Check for dist/src/server.js directly:
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path ".\backend-deploy.zip")).Entries |
  Where-Object { $_.FullName -eq "dist/src/server.js" } |
  Select-Object FullName, Length
#
#
.PARAMETER ResourceGroup
Azure resource group name.
.PARAMETER AppName
Azure App Service name.
.PARAMETER KeepZip
If set, always keep backend-deploy.zip after deploy (default: true).
.PARAMETER InspectOnly
If set, only build/package/inspect ZIP, do not deploy.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,
    [Parameter(Mandatory=$true)]
    [string]$AppName,
    [switch]$KeepZip = $true,
    [switch]$InspectOnly
)

$ErrorActionPreference = 'Stop'

$backendPath = $PSScriptRoot | Split-Path -Parent | Resolve-Path | ForEach-Object { $_.Path }
$zipPath = Join-Path $backendPath 'backend-deploy.zip'

Write-Host "[INFO] Backend path: $backendPath"
Write-Host "[INFO] ZIP output path: $zipPath"

# Clean build
Push-Location $backendPath
Write-Host "[INFO] Running clean build (npm ci && npm run build)..."
npm ci
npm run build
Pop-Location

# Remove old ZIP if exists
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

# Copy backend contents to temp folder for flat ZIP
$tempDir = Join-Path $env:TEMP ("hobbyiq-backend-zip-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tempDir | Out-Null

Get-ChildItem -Path $backendPath -Exclude 'node_modules', '.git', '.gitignore', 'backend-deploy.zip', '.env', '.azureignore', 'scripts', 'tests', 'deploy*', 'docs', '*.md' -Recurse | \
    Where-Object { -not $_.PSIsContainer } | \
    ForEach-Object {
        $dest = Join-Path $tempDir ($_.FullName.Substring($backendPath.Length+1))
        $destDir = Split-Path $dest -Parent
        if (!(Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item $_.FullName $dest -Force
    }

# Create ZIP at workspace root
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($tempDir, $zipPath)

# Cleanup temp folder
Remove-Item $tempDir -Recurse -Force

# Print ZIP path
$resolvedZip = Resolve-Path $zipPath
Write-Host "[INFO] Deployment ZIP created at: $resolvedZip"

# List ZIP contents
Write-Host "[INFO] Listing ZIP contents:"
$entries = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip).Entries
$entries | Select-Object FullName, Length | Sort-Object FullName | Format-Table -Auto

# Check for dist/src/server.js
$serverEntry = $entries | Where-Object { $_.FullName -eq 'dist/src/server.js' }
if ($null -eq $serverEntry) {
    Write-Host "[FAIL] dist/src/server.js is MISSING from ZIP.`nDeployment ABORTED." -ForegroundColor Red
    exit 1
} else {
    Write-Host "[PASS] dist/src/server.js found in ZIP." -ForegroundColor Green
}

if ($InspectOnly) {
    Write-Host "[INFO] InspectOnly mode: skipping Azure deployment."
    exit 0
}

# Deploy ZIP to Azure
Write-Host "[INFO] Deploying ZIP to Azure App Service..."
az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $resolvedZip --type zip

Write-Host "[INFO] Deployment complete."

if (-not $KeepZip) {
    Write-Host "[INFO] Removing ZIP as -KeepZip was not set."
    Remove-Item $resolvedZip -Force
}
