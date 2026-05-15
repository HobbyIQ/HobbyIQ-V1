# Captures Tier 1 baselines against production.
# Reads backend/harness/tier1/cases.json, hits /api/compiq/search for each,
# then /api/compiq/price-by-id if a cardHedgeCardId was returned.
# Writes one JSON file per case to backend/harness/tier1/baselines/<case-id>.json.

param(
    [string]$Base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$casesPath = Join-Path $root "cases.json"
$baselineDir = Join-Path $root "baselines"
New-Item -ItemType Directory -Path $baselineDir -Force | Out-Null

$manifest = Get-Content -Raw -Path $casesPath | ConvertFrom-Json
$cases = $manifest.cases

$summary = @{
    total = $cases.Count
    captured = 0
    withCardId = 0
    priceByIdCaptured = 0
    errors = @()
    flags = @()
}

foreach ($c in $cases) {
    $id = $c.id
    Write-Host ("[{0}/{1}] {2}" -f ($summary.captured + 1), $cases.Count, $id) -ForegroundColor Cyan

    $entry = [ordered]@{
        caseId = $id
        category = $c.category
        query = $c.query
        grade = $c.grade
        capturedAt = (Get-Date).ToUniversalTime().ToString("o")
        search = $null
        searchError = $null
        cardHedgeCardId = $null
        priceById = $null
        priceByIdError = $null
        notes = @()
    }

    # ---- /api/compiq/search ----
    $searchBody = @{ query = $c.query } | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Method POST -Uri "$Base/api/compiq/search" `
            -ContentType "application/json" -Body $searchBody -TimeoutSec 90
        $entry.search = $resp
    }
    catch {
        $entry.searchError = $_.Exception.Message
        $summary.errors += @{ caseId = $id; phase = "search"; error = $_.Exception.Message }
        $entry.notes += "search failed: $($_.Exception.Message)"
    }

    # Try to extract cardHedgeCardId from search response (multiple known fields).
    # Canonical location is search.cardIdentity.card_id; others are defensive.
    $cardId = $null
    if ($entry.search) {
        $candidates = @(
            $entry.search.cardIdentity.card_id,
            $entry.search.cardIdentity.cardHedgeCardId,
            $entry.search.cardHedgeCardId,
            $entry.search.cardHedgeId,
            $entry.search.matchedCardId
        )
        foreach ($cand in $candidates) {
            if ($cand -and ($cand -is [string]) -and $cand.Length -gt 0) {
                $cardId = $cand
                break
            }
        }
    }
    $entry.cardHedgeCardId = $cardId

    # ---- /api/compiq/price-by-id ----
    if ($cardId) {
        $summary.withCardId++
        $pbi = @{ cardHedgeCardId = $cardId; query = $c.query }
        if ($c.grade -and $c.grade -ne "Raw") {
            # parse "PSA 10" / "PSA 9" / "PSA 8" etc.
            $parts = $c.grade -split "\s+"
            if ($parts.Length -ge 2) {
                $pbi.gradeCompany = $parts[0]
                $val = 0.0
                if ([double]::TryParse($parts[1], [ref]$val)) { $pbi.gradeValue = $val }
            }
        }
        $pbiBody = $pbi | ConvertTo-Json -Compress
        try {
            $resp2 = Invoke-RestMethod -Method POST -Uri "$Base/api/compiq/price-by-id" `
                -ContentType "application/json" -Body $pbiBody -TimeoutSec 90
            $entry.priceById = $resp2
            $summary.priceByIdCaptured++
        }
        catch {
            $entry.priceByIdError = $_.Exception.Message
            $summary.errors += @{ caseId = $id; phase = "price-by-id"; error = $_.Exception.Message }
            $entry.notes += "price-by-id failed: $($_.Exception.Message)"
        }
    } else {
        $entry.notes += "no cardHedgeCardId found in search response"
    }

    # ---- Save baseline ----
    $outPath = Join-Path $baselineDir ("{0}.json" -f $id)
    $entry | ConvertTo-Json -Depth 20 | Out-File -FilePath $outPath -Encoding utf8 -Force

    if ($entry.search) { $summary.captured++ }

    # Surface noteworthy signals
    $src = $entry.search.source
    $compsUsed = $entry.search.compsUsed
    if ($null -ne $compsUsed -and $compsUsed -eq 0) {
        $summary.flags += @{ caseId = $id; flag = "compsUsed=0 in /search"; source = $src }
    }
    if ($src -eq "no-recent-comps") {
        $summary.flags += @{ caseId = $id; flag = "source=no-recent-comps in /search" }
    }
    if ($entry.priceById) {
        $pbiCu = $entry.priceById.compsUsed
        $pbiSrc = $entry.priceById.source
        if ($null -ne $pbiCu -and $pbiCu -eq 0) {
            $summary.flags += @{ caseId = $id; flag = "compsUsed=0 in /price-by-id"; source = $pbiSrc }
        }
    }

    Start-Sleep -Milliseconds 200
}

Write-Host ""
Write-Host "===== Tier 1 Baseline Capture Summary =====" -ForegroundColor Yellow
Write-Host ("Total cases:           {0}" -f $summary.total)
Write-Host ("Search captured:       {0}" -f $summary.captured)
Write-Host ("Cases w/ cardId:       {0}" -f $summary.withCardId)
Write-Host ("price-by-id captured:  {0}" -f $summary.priceByIdCaptured)
Write-Host ("Errors:                {0}" -f $summary.errors.Count)
Write-Host ("Flags:                 {0}" -f $summary.flags.Count)

$summaryPath = Join-Path $root "capture-summary.json"
$summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $summaryPath -Encoding utf8 -Force
Write-Host ("`nSummary written to: {0}" -f $summaryPath)
