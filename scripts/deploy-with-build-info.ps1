# Deploy HobbyIQ3 with build metadata.
# Captures git SHA, branch, and timestamp; sets as Azure App Settings;
# deploys deploy.zip; polls Kudu until rsync completes; then issues a
# single explicit restart and verifies /api/health reports the new SHA.
# Build metadata surfaces in /api/health.
#
# Usage (from repo root, after npm run build + node zip.js):
#   .\scripts\deploy-with-build-info.ps1
#
# Requires: az CLI logged in, deploy.zip at repo root.

$ErrorActionPreference = "Stop"

$rg       = "rg-hobbyiq-dev"
$app      = "HobbyIQ3"
$scm      = "https://hobbyiq3-e5a4dgfsdnb5fbha.scm.centralus-01.azurewebsites.net"
$site     = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

# Capture build metadata from git state at deploy time
$sha        = (git rev-parse HEAD).Trim()
$shaShort   = (git rev-parse --short HEAD).Trim()
$branch     = (git rev-parse --abbrev-ref HEAD).Trim()
$deployedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

Write-Host "Deploying:"
Write-Host "  SHA:        $sha"
Write-Host "  Branch:     $branch"
Write-Host "  Deployed:   $deployedAt"

if (-not (Test-Path deploy.zip)) {
    Write-Error "deploy.zip not found in cwd. Run 'node zip.js' first."
    exit 1
}

# Set app settings (this triggers an implicit site restart; we intentionally
# do this BEFORE the deploy so the restart cycle settles before rsync starts.
# The deploy is then issued with --restart false, and we do a final explicit
# restart only after Kudu reports the deployment complete. This avoids the
# race that froze deployment 8aca4f4a on 2026-05-20.)
Write-Host ""
Write-Host "[1/5] Setting app settings (implicit restart, will settle before deploy)..."
az webapp config appsettings set `
    --resource-group $rg `
    --name $app `
    --settings GIT_SHA=$sha GIT_SHA_SHORT=$shaShort GIT_BRANCH=$branch DEPLOYED_AT=$deployedAt `
    --output none
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set app settings"; exit 1 }

# Give the implicit restart 30s to begin/settle before kicking off rsync.
Write-Host "    Sleeping 30s to let restart settle..."
Start-Sleep -Seconds 30

# Deploy WITHOUT restart (we'll restart explicitly after Kudu reports done)
Write-Host ""
Write-Host "[2/5] Enqueueing deploy (--restart false, --async true)..."
# Carry-forward #8 fix: az webapp deploy writes "WARNING: Initiating deployment..."
# to stderr on success, which under $ErrorActionPreference=Stop (set at top of script)
# terminates the script before the Kudu poll can establish ground truth. Scope EAP
# to Continue around just this call; Kudu poll downstream is the authoritative
# success signal. try/finally guarantees EAP is restored even on unexpected throw.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    az webapp deploy `
        --resource-group $rg `
        --name $app `
        --src-path deploy.zip `
        --type zip `
        --restart false `
        --async true `
        --output none
    $deployExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevEAP
}
# az may return non-zero on async polling timeout while deploy is queued
# successfully; treat any exit code as advisory and proceed to poll Kudu.
if ($deployExit -ne 0) {
    Write-Host "    (az exited $deployExit — proceeding to Kudu poll; this often happens with async deploys)"
}

# Get AAD bearer token for Kudu API (basic auth is disabled on this site)
Write-Host ""
Write-Host "[3/5] Acquiring AAD token for Kudu API..."
$token = (az account get-access-token --resource "https://management.azure.com" --query accessToken -o tsv).Trim()
if (-not $token) { Write-Error "Failed to acquire AAD token"; exit 1 }
$authHeader = @{ Authorization = "Bearer $token" }

# Poll Kudu deployment status until complete (max 20 min for 79 MB zip + rsync)
# Kudu status codes: 0=Pending, 1=Building, 2=Deploying, 3=Failed, 4=Success, 5=Cancelled
$maxWaitSec      = 1200
$pollIntervalSec = 15
$elapsed         = 0
$deploymentComplete = $false
$lastStatus = ""

Write-Host ""
Write-Host "[4/5] Polling Kudu /api/deployments/latest (every ${pollIntervalSec}s, max ${maxWaitSec}s)..."

while ($elapsed -lt $maxWaitSec) {
    Start-Sleep -Seconds $pollIntervalSec
    $elapsed += $pollIntervalSec

    try {
        $latest = Invoke-RestMethod `
            -Uri "$scm/api/deployments/latest" `
            -Headers $authHeader `
            -TimeoutSec 30
        $lastStatus = "status=$($latest.status) progress='$($latest.progress)' complete=$($latest.complete)"
        Write-Host "    [${elapsed}s] $lastStatus"

        if ($latest.complete -eq $true) {
            if ($latest.status -eq 4) {
                $deploymentComplete = $true
                Write-Host "    SUCCESS at ${elapsed}s. deployment_id=$($latest.id)"
                break
            }
            Write-Error "Deployment finished with non-success status=$($latest.status) status_text='$($latest.status_text)'"
            exit 1
        }
    } catch {
        Write-Host "    [${elapsed}s] poll error: $($_.Exception.Message)"
    }
}

if (-not $deploymentComplete) {
    Write-Error "Deploy did not complete within ${maxWaitSec}s. Last status: $lastStatus. Check Kudu manually at $scm/api/deployments/latest"
    exit 1
}

# Now restart the app explicitly so the new container picks up the new bits
Write-Host ""
Write-Host "[5/5] Restarting App Service (single controlled restart)..."
az webapp restart --resource-group $rg --name $app --output none
if ($LASTEXITCODE -ne 0) { Write-Error "Restart failed"; exit 1 }

Write-Host "    Waiting 45s for container warmup..."
Start-Sleep -Seconds 45

# Verify /api/health reports the SHA we just deployed
Write-Host ""
Write-Host "Verifying /api/health reports shaShort=$shaShort ..."
$verified = $false
for ($i = 0; $i -lt 6; $i++) {
    try {
        $health = Invoke-RestMethod -Uri "$site/api/health" -TimeoutSec 30
        $reportedShort = $health.build.shaShort
        Write-Host "    attempt $($i+1): build.shaShort=$reportedShort"
        if ($reportedShort -eq $shaShort) {
            $verified = $true
            break
        }
    } catch {
        Write-Host "    attempt $($i+1): /api/health error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 15
}

if (-not $verified) {
    Write-Error "Mismatch after retries: /api/health did not report shaShort=$shaShort"
    exit 1
}

Write-Host ""
Write-Host "Deploy complete. SHA $shaShort live on $app."
