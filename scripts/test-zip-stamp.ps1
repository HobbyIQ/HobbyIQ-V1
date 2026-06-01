# test-zip-stamp.ps1 -- CF-DEPLOY-STAMP-HARDENING (2026-06-01)
#
# Scripted tests for zip.js's two new invariants. Not part of the regular
# `npm test` suite -- this is build tooling that exercises git commands +
# spawns node + reads zip contents. Runs in ~30-60 seconds depending on
# tsc cache state.
#
# Usage (from repo root, on a CLEAN backend/ tree):
#   .\scripts\test-zip-stamp.ps1
#
# Test A: 5th-mode reproduction. Pre-corrupt dist/build-info.json with a
#         fake stale SHA (simulating the pre-commit-build state), run
#         node zip.js, extract dist/build-info.json from the resulting
#         deploy.zip, assert .sha == current HEAD. With the OLD zip.js,
#         the corrupted stamp would survive into the zip (5th mode);
#         with the new zip.js, the npm-run-build re-stamp overwrites it.
#
# Test B: dirty-tree refusal. Create an untracked file under backend/,
#         run node zip.js, assert non-zero exit.

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "[test-zip-stamp] running from $projectRoot"
Write-Host ""

# Pre-flight: dist-affecting paths must be clean for Test A's pre-condition.
# Same scope zip.js itself checks. Paths inlined (PS 5.1 doesn't like splat
# after the git -- separator).
$preflightDirty = (git status --porcelain -- backend/src backend/package.json backend/package-lock.json backend/tsconfig.json) -join "`n"
if ($preflightDirty) {
    Write-Error "Pre-flight FAILED: dist-affecting paths not clean. Commit (or stash) first.`nDirty:`n$preflightDirty"
    exit 1
}
Write-Host "[test-zip-stamp] pre-flight: dist-affecting paths clean"
Write-Host ""

# Note any pre-existing deploy.zip so cleanup doesn't clobber unrelated state.
$preExistingZip = Test-Path "deploy.zip"
if ($preExistingZip) {
    Move-Item deploy.zip deploy.zip.pre-test.bak -Force
}

$testsPassed = 0
$testsFailed = 0

# =======================================================================
# TEST A -- 5th-mode reproduction: stale stamp gets overwritten by zip.js
# =======================================================================

Write-Host "=== TEST A: 5th-mode reproduction (stale stamp overwritten at package time) ==="

$expectedSha = (git rev-parse HEAD).Trim()
$expectedShaShort = (git rev-parse --short HEAD).Trim()
Write-Host "    Current HEAD: $expectedSha ($expectedShaShort)"

$biPath = "backend/dist/build-info.json"
$fakeSha = "0000000000000000000000000000000000000000"
$origBuildInfo = $null
if (Test-Path $biPath) {
    $origBuildInfo = Get-Content $biPath -Raw
}

# Pre-corrupt: simulates pre-commit build + post-commit HEAD shift.
$corruptedJson = '{"sha":"' + $fakeSha + '","shaShort":"0000000","branch":"fake-stale-stamp","builtAt":"1970-01-01T00:00:00Z"}'
New-Item -ItemType Directory -Path "backend/dist" -Force | Out-Null
Set-Content -Path $biPath -Value $corruptedJson -Encoding utf8
Write-Host "    Corrupted $biPath to sha=$fakeSha (simulating 5th-mode pre-state)"

# Run zip.js -- must succeed AND overwrite the corrupted stamp.
# Scope EAP to Continue: PS 5.1 wraps native stderr lines as ErrorRecords
# which terminate under EAP=Stop even on exit 0.
Write-Host "    Running node zip.js..."
$prevEAP_A = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $zipOutput = node zip.js 2>&1
    $zipExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevEAP_A
}

if ($zipExit -ne 0) {
    Write-Host "    Test A FAILED: node zip.js exited $zipExit (expected 0)"
    Write-Host "    Output:"
    Write-Host ($zipOutput | Out-String)
    $testsFailed++
} elseif (-not (Test-Path "deploy.zip")) {
    Write-Host "    Test A FAILED: deploy.zip not created"
    $testsFailed++
} else {
    # Extract the zip's build-info.json and inspect.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path "deploy.zip").Path)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'dist/build-info.json' } | Select-Object -First 1
        if (-not $entry) {
            Write-Host "    Test A FAILED: dist/build-info.json missing from zip"
            $testsFailed++
        } else {
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try {
                $bi = ($reader.ReadToEnd() | ConvertFrom-Json)
            } finally {
                $reader.Close()
            }
            if ($bi.sha -eq $expectedSha) {
                Write-Host "    Test A PASSED: zip's build-info.json sha=$($bi.sha) matches current HEAD"
                $testsPassed++
            } else {
                Write-Host "    Test A FAILED: zip's build-info.json sha=$($bi.sha), expected $expectedSha"
                $testsFailed++
            }
        }
    } finally {
        $zip.Dispose()
    }
}

# Cleanup Test A artifacts.
Remove-Item deploy.zip -ErrorAction SilentlyContinue
Write-Host ""

# =======================================================================
# TEST B -- dirty-tree refusal: untracked backend/ file should cause exit≠0
# =======================================================================

Write-Host "=== TEST B: dirty-tree refusal (untracked backend/ file → exit non-zero) ==="

# Marker must live inside one of the dist-affecting paths for the
# refusal to trip. backend/src is the natural home for "would-affect-
# compilation" untracked content.
$marker = "backend/src/.test-zip-stamp-dirty-marker"
Set-Content -Path $marker -Value "test marker -- should never reach prod" -Encoding utf8
Write-Host "    Created untracked $marker"

$prevEAP_B = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $zipOutputB = node zip.js 2>&1
    $zipExitB = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevEAP_B
}

# Cleanup marker BEFORE asserting so a failed test doesn't leave the marker.
Remove-Item $marker -ErrorAction SilentlyContinue
Remove-Item deploy.zip -ErrorAction SilentlyContinue

if ($zipExitB -eq 0) {
    Write-Host "    Test B FAILED: node zip.js exited 0 despite dirty backend/ tree"
    Write-Host "    Output:"
    Write-Host ($zipOutputB | Out-String)
    $testsFailed++
} else {
    Write-Host "    Test B PASSED: node zip.js exited $zipExitB (refused dirty tree)"
    $testsPassed++
}
Write-Host ""

# =======================================================================
# Restore pre-test state
# =======================================================================

if ($preExistingZip -and (Test-Path "deploy.zip.pre-test.bak")) {
    Move-Item deploy.zip.pre-test.bak deploy.zip -Force
}

# Note: zip.js's Test A run already overwrote the corrupted build-info.json
# with a correct stamp during its npm-run-build step, so nothing to restore.
# ($origBuildInfo retained for the record but no action needed.)

# =======================================================================
# Summary
# =======================================================================

Write-Host "====================================================================="
Write-Host "RESULTS: $testsPassed passed, $testsFailed failed"
Write-Host "====================================================================="

if ($testsFailed -gt 0) {
    exit 1
}
exit 0
