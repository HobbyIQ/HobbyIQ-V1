# One-off: regenerate Tier 1 baselines for a subset of cases.
# Per PR #16 post-deploy plan: only cases 15, 17, 18, 09.
# Case 19a is intentionally excluded (CH catalog gap, blockedBy [13]).
param(
    [string]$Base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net",
    [string[]]$Only = @(
        "case-09-caleb-bonemer-2024-bowman-draft-chrome-blue-auto-raw",
        "case-15-michael-jordan-1986-fleer-psa8",
        "case-17-luka-doncic-2018-panini-prizm-silver-psa10",
        "case-18-justin-herbert-2020-panini-prizm-psa10"
    )
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$casesPath = Join-Path $root "cases.json"
$baselineDir = Join-Path $root "baselines"

$manifest = Get-Content -Raw -Path $casesPath | ConvertFrom-Json
$cases = $manifest.cases | Where-Object { $Only -contains $_.id }

if ($cases.Count -ne $Only.Count) {
    Write-Warning "Expected $($Only.Count) cases but matched $($cases.Count)."
}

foreach ($c in $cases) {
    $id = $c.id
    Write-Host "[regen] $id" -ForegroundColor Cyan

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

    $searchBody = @{ query = $c.query } | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Method POST -Uri "$Base/api/compiq/search" `
            -ContentType "application/json" -Body $searchBody -TimeoutSec 90
        $entry.search = $resp
    }
    catch {
        $entry.searchError = $_.Exception.Message
        $entry.notes += "search failed: $($_.Exception.Message)"
    }

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

    if ($cardId) {
        $pbi = @{ cardHedgeCardId = $cardId; query = $c.query }
        if ($c.grade -and $c.grade -ne "Raw") {
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
        }
        catch {
            $entry.priceByIdError = $_.Exception.Message
            $entry.notes += "price-by-id failed: $($_.Exception.Message)"
        }
    } else {
        $entry.notes += "no cardHedgeCardId found in search response"
    }

    $outPath = Join-Path $baselineDir ("{0}.json" -f $id)
    # Use utf8NoBOM by writing bytes (loadBaseline strips BOM but cleaner without).
    $json = $entry | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText($outPath, $json, [System.Text.UTF8Encoding]::new($false))

    Write-Host "  -> source=$($entry.search.source) compsUsed=$($entry.search.compsUsed) cardId=$cardId" -ForegroundColor Green
}
