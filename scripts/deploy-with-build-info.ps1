# Deploy HobbyIQ3 with build metadata.
# Captures git SHA, branch, and timestamp; sets as Azure App Settings;
# then deploys deploy.zip. Build metadata surfaces in /api/health.
#
# Usage (from repo root, after npm run build + node zip.js):
#   .\scripts\deploy-with-build-info.ps1
#
# Requires: az CLI logged in, deploy.zip at repo root.

# Capture build metadata from git state at deploy time
$sha = (git rev-parse HEAD).Trim()
$shaShort = (git rev-parse --short HEAD).Trim()
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$deployedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

Write-Host "Deploying:"
Write-Host "  SHA:        $sha"
Write-Host "  Branch:     $branch"
Write-Host "  Deployed:   $deployedAt"

# Set app settings BEFORE deploy so they're live when the new code starts
az webapp config appsettings set `
    --resource-group rg-hobbyiq-dev `
    --name HobbyIQ3 `
    --settings GIT_SHA=$sha GIT_SHA_SHORT=$shaShort GIT_BRANCH=$branch DEPLOYED_AT=$deployedAt `
    --output none

if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set app settings"; exit 1 }

# Now run the actual deploy
az webapp deploy `
    --resource-group rg-hobbyiq-dev `
    --name HobbyIQ3 `
    --src-path deploy.zip `
    --type zip `
    --restart true

if ($LASTEXITCODE -ne 0) { Write-Error "Deploy failed"; exit 1 }

Write-Host "Deploy complete. SHA $shaShort live on HobbyIQ3."
