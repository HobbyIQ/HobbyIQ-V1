# Deploy HobbyIQ3 with build metadata.
# Captures git SHA, branch, and timestamp; sets as Azure App Settings;
# deploys deploy.zip; polls Kudu until rsync completes; then issues a
# single explicit restart and verifies /api/health reports the new SHA
# AND a downstream endpoint returns 200 (feature-probe proves dist/ +
# node_modules/ actually loaded). Build metadata surfaces in /api/health.
#
# Usage (from repo root, after npm run build + node zip.js):
#   .\scripts\deploy-with-build-info.ps1
#
# Requires: az CLI logged in, deploy.zip at repo root.
#
# Per docs/phase0/deploy_infra_audit.md (commit 5cb25b8) -- 2026-05-24
# production incident hardening:
#   [0/5] Pre-deploy invariants verified BEFORE any state change. Aborts
#         cleanly on mismatch (App Settings vs zip contents) so production
#         is never touched on misconfiguration.
#   [4/5] Kudu poll surfaces actual failure detail on status=3 (prior bug:
#         Write-Error inside try was swallowed by catch -- infinite poll).
#   [5/5] SHA verification AUGMENTED with feature-probe so a broken
#         wwwroot cannot pass via the env-var-only /api/health SHA check
#         (Finding 11 residual hazard).

$ErrorActionPreference = "Stop"

$rg       = "rg-hobbyiq-dev"
$app      = "HobbyIQ3"
$scm      = "https://hobbyiq3-e5a4dgfsdnb5fbha.scm.centralus-01.azurewebsites.net"
$site     = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

# Required App Service state for the zip-with-node_modules deploy pattern.
# Yesterday's incident proved that SCM_DO_BUILD_DURING_DEPLOYMENT=true with
# our pre-baked-node_modules zip triggers Oryx behavior that loses
# node_modules during rsync. Both must be "false" for the OneDeploy path
# to rsync the zip verbatim. See docs/deployment/README.md.
$EXPECTED_APP_SETTINGS = @{
    "SCM_DO_BUILD_DURING_DEPLOYMENT" = "false"
    "ENABLE_ORYX_BUILD"              = "false"
}

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

# ===== [0/5] Pre-deploy invariant check (read-only, no state change) =====
#
# Runs BEFORE [1/5] env-var change so misconfiguration leaves production
# untouched. Reads current App Settings via az, inspects deploy.zip via
# .NET ZipFile, and aborts cleanly on any mismatch.

Write-Host ""
Write-Host "[0/5] Pre-deploy invariant check (read-only)..."

# Read current App Settings -- only the keys we care about
$invariantErrors = @()
foreach ($key in $EXPECTED_APP_SETTINGS.Keys) {
    $expected = $EXPECTED_APP_SETTINGS[$key]
    $rawActual = az webapp config appsettings list `
        --resource-group $rg `
        --name $app `
        --query "[?name=='$key'].value | [0]" `
        -o tsv 2>$null
    $actual = if ($null -ne $rawActual) { ([string]$rawActual).Trim() } else { "" }
    if ($actual -ne $expected) {
        $invariantErrors += "    App Setting $key = '$actual' (expected '$expected')"
    } else {
        Write-Host "    App Setting $key = $actual (matches expected)"
    }
}

# Inspect deploy.zip contents -- list top-level entries
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = (Resolve-Path "deploy.zip").Path
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entryNames = $zip.Entries | ForEach-Object { $_.FullName }
    $hasNodeModules = ($entryNames | Where-Object { $_ -match '^node_modules[/\\]' }).Count -gt 0
    $hasDist        = ($entryNames | Where-Object { $_ -match '^dist[/\\]' }).Count -gt 0
    $hasSrc         = ($entryNames | Where-Object { $_ -match '^src[/\\]' }).Count -gt 0
    $hasPackageJson = ($entryNames | Where-Object { $_ -eq 'package.json' }).Count -gt 0
} finally {
    $zip.Dispose()
}

Write-Host "    Zip contents: node_modules/=$hasNodeModules dist/=$hasDist src/=$hasSrc package.json=$hasPackageJson"

if (-not $hasPackageJson) {
    $invariantErrors += "    Zip missing package.json (invalid deploy artifact)"
}

# The two valid deploy modes (per audit section 4):
#   Built-artifact:   App SCM_DO_BUILD=false, zip has dist/ + node_modules/  (current hobbyiq3 mode)
#   Source-deploy:    App SCM_DO_BUILD=true,  zip has src/ (no dist/, no node_modules/)
# Anything else is a misconfiguration that risks Oryx losing files during rsync.
$rawScm = az webapp config appsettings list -g $rg -n $app --query "[?name=='SCM_DO_BUILD_DURING_DEPLOYMENT'].value | [0]" -o tsv 2>$null
$scmDoBuild = if ($null -ne $rawScm) { ([string]$rawScm).Trim() } else { "" }
$isBuiltArtifactMode = ($scmDoBuild -eq "false")
$isSourceDeployMode  = ($scmDoBuild -eq "true")

if ($isBuiltArtifactMode) {
    if (-not $hasNodeModules) {
        $invariantErrors += "    Mode: built-artifact (SCM_DO_BUILD=false), but zip lacks node_modules/ -- container will fail to require('express') on startup"
    }
    if (-not $hasDist) {
        $invariantErrors += "    Mode: built-artifact (SCM_DO_BUILD=false), but zip lacks dist/ -- no compiled JS to run"
    }
} elseif ($isSourceDeployMode) {
    if ($hasNodeModules) {
        $invariantErrors += "    Mode: source-deploy (SCM_DO_BUILD=true), but zip CONTAINS node_modules/ -- yesterday's incident pattern (Oryx + compress_node_modules=tar-gz loses files during rsync)"
    }
    if ($hasDist) {
        $invariantErrors += "    Mode: source-deploy (SCM_DO_BUILD=true), but zip CONTAINS dist/ -- Oryx will overwrite, not what you want"
    }
}

if ($invariantErrors.Count -gt 0) {
    Write-Host ""
    Write-Error "Pre-deploy invariant check FAILED. Production untouched."
    foreach ($e in $invariantErrors) { Write-Host $e }
    Write-Host ""
    Write-Host "See docs/deployment/README.md for required App Settings and zip-shape pairings."
    exit 1
}
Write-Host "    All invariants passed"

# ===== [1/5] App settings (triggers implicit restart) =====
#
# Set app settings (this triggers an implicit site restart; we intentionally
# do this BEFORE the deploy so the restart cycle settles before rsync starts.
# The deploy is then issued with --restart false, and we do a final explicit
# restart only after Kudu reports the deployment complete.)
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

# ===== [2/5] Enqueue async deploy =====
Write-Host ""
Write-Host "[2/5] Enqueueing deploy (--restart false, --async true)..."
# Carry-forward #8 fix: az webapp deploy writes "WARNING: Initiating deployment..."
# to stderr on success, which under EAP=Stop terminates the script. Scope EAP
# to Continue around just this call; Kudu poll downstream is the authoritative
# success signal.
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
if ($deployExit -ne 0) {
    Write-Host "    (az exited $deployExit -- proceeding to Kudu poll; this often happens with async deploys)"
}

# ===== [3/5] AAD token for Kudu API =====
Write-Host ""
Write-Host "[3/5] Acquiring AAD token for Kudu API..."
$token = (az account get-access-token --resource "https://management.azure.com" --query accessToken -o tsv).Trim()
if (-not $token) { Write-Error "Failed to acquire AAD token"; exit 1 }
$authHeader = @{ Authorization = "Bearer $token" }

# ===== [4/5] Poll Kudu /api/deployments/latest until terminal state =====
#
# Kudu status codes: 0=Pending, 1=Building, 2=Deploying, 3=Failed, 4=Success, 5=Cancelled.
# Prior bug (2026-05-24 incident): status=3 branch did `Write-Error ...; exit 1`
# inside the `try` block. PowerShell's Write-Error generates a terminating error
# (under EAP=Stop), which the surrounding `catch` swallowed as "poll error:
# Deployment finished with non-success...". Script then looped forever.
# Fix: pull failure detection OUT of the try/catch and surface actual Kudu
# detail (status_text, message, log_url).
$maxWaitSec      = 1200
$pollIntervalSec = 15
$elapsed         = 0
$deploymentComplete = $false
$deploymentFailed   = $false
$failedDetail       = ""
$lastStatus = ""

Write-Host ""
Write-Host "[4/5] Polling Kudu /api/deployments/latest (every ${pollIntervalSec}s, max ${maxWaitSec}s)..."

while ($elapsed -lt $maxWaitSec) {
    Start-Sleep -Seconds $pollIntervalSec
    $elapsed += $pollIntervalSec

    $latest = $null
    try {
        $latest = Invoke-RestMethod `
            -Uri "$scm/api/deployments/latest" `
            -Headers $authHeader `
            -TimeoutSec 30
        $lastStatus = "status=$($latest.status) progress='$($latest.progress)' complete=$($latest.complete)"
        Write-Host "    [${elapsed}s] $lastStatus"
    } catch {
        Write-Host "    [${elapsed}s] poll error: $($_.Exception.Message)"
        continue  # transient -- try again on next interval
    }

    # Terminal-state decisions OUTSIDE the catch so Write-Error / throw can
    # propagate cleanly (yesterday's bug was the swallow).
    if ($latest.complete -ne $true) { continue }

    if ($latest.status -eq 4) {
        $deploymentComplete = $true
        Write-Host "    SUCCESS at ${elapsed}s. deployment_id=$($latest.id)"
        break
    }

    # status != 4 with complete=true -> terminal failure. Capture detail.
    $deploymentFailed = $true
    $failedDetail = "status=$($latest.status) status_text='$($latest.status_text)' message='$($latest.message)' id=$($latest.id)"
    Write-Host "    Kudu reports deployment FAILED at ${elapsed}s: $failedDetail"
    if ($latest.log_url) { Write-Host "    Diagnostic log_url: $($latest.log_url)" }
    break
}

if ($deploymentFailed) {
    Write-Error "Kudu deployment failed: $failedDetail"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Inspect log_url above for Oryx / rsync / startup detail."
    Write-Host "  2. Check current /api/health on hobbyiq3 -- if 503, container is crash-looping."
    Write-Host "  3. See docs/phase0/deploy_infra_audit.md and docs/deployment/README.md for recovery."
    exit 1
}

if (-not $deploymentComplete) {
    Write-Error "Deploy did not complete within ${maxWaitSec}s. Last status: $lastStatus. Check Kudu manually at $scm/api/deployments/latest"
    exit 1
}

# ===== [5/5] Explicit restart + verification (SHA + feature-probe) =====
#
# Now restart the app explicitly so the new container picks up the new bits
Write-Host ""
Write-Host "[5/5] Restarting App Service (single controlled restart)..."
az webapp restart --resource-group $rg --name $app --output none
if ($LASTEXITCODE -ne 0) { Write-Error "Restart failed"; exit 1 }

Write-Host "    Waiting 45s for container warmup..."
Start-Sleep -Seconds 45

# Verify /api/health reports the SHA we just deployed (coarse signal --
# /api/health reads from process.env.GIT_SHA which we set at [1/5], so this
# check alone is insufficient per Finding 11. The feature-probe below
# verifies dist/ + node_modules/ actually loaded.)
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

# Feature-probe (closes Finding 11 residual hazard). /api/health proves the
# Express process is up and reading env. The feature-probe proves the
# compiled JS actually loaded -- if dist/ is missing or node_modules/ is
# absent (yesterday's incident pattern), this returns 5xx or times out.
# /api/compiq/normalization-dictionary is a code-derived dictionary, GET
# with no body, no upstream dependencies -- safe + reliable probe.
Write-Host ""
Write-Host "Feature-probe: /api/compiq/normalization-dictionary (verifies dist/ + node_modules/ loaded)..."
$probeVerified = $false
for ($i = 0; $i -lt 4; $i++) {
    try {
        $probe = Invoke-RestMethod -Uri "$site/api/compiq/normalization-dictionary" -TimeoutSec 30
        if ($probe -and $probe.success -eq $true -and $probe.dictionary) {
            $keyCount = $probe.dictionary.PSObject.Properties.Name.Count
            Write-Host "    attempt $($i+1): 200 OK, dictionary keys=$keyCount"
            $probeVerified = $true
            break
        } else {
            Write-Host "    attempt $($i+1): 200 but unexpected body shape"
        }
    } catch {
        Write-Host "    attempt $($i+1): probe error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 15
}

if (-not $probeVerified) {
    Write-Error "Feature-probe FAILED. /api/health reports the new SHA but dist/ + node_modules/ are not actually serving traffic. This is the Finding 11 incident pattern -- production may be crash-looping. Investigate before declaring deploy successful."
    exit 1
}

Write-Host ""
Write-Host "Deploy complete. SHA $shaShort live on $app."
Write-Host "  /api/health: SHA verified"
Write-Host "  Feature-probe: dist/ + node_modules/ verified loaded"
