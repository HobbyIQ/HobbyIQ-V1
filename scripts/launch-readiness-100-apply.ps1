# CF-LAUNCH-READINESS-100 Phase 2 — Cosmos autoscale + 6 metric alerts.
#
# Per docs/phase0/launch_readiness_100_2026-05-29.md §9 (bundled scope
# A + B, Drew-approved).
#
# Idempotent: all az commands either create-or-update. Safe to re-run.
# All resources scoped to rg-hobbyiq-dev. Email destination: drew@justtheboysandcards.com.
#
# Verification (after each step) is the Read-Host gate built into the
# script — operator confirms each section before proceeding. NOT a
# silent batch apply.

$ErrorActionPreference = "Stop"

# ──────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────

$rg            = "rg-hobbyiq-dev"
$subId         = "ce160cf3-ee69-4832-ade2-f0cf57ba2f57"
$cosmosAcct    = "hobbyiq-comps"
$cosmosDb      = "hobbyiq"
$appName       = "HobbyIQ3"
$aiName        = "hobbyiq-insights"
$alertEmail    = "drew@justtheboysandcards.com"
$actionGroup   = "hobbyiq-ops-alerts"

$hotContainers = @("dailyiq_briefs", "portfolio")
$autoscaleMax  = 4000  # 10x current ceiling; idle bills at 400 RU/s min (10% of max)

# Resource IDs (built from constants — no live lookups needed)
$cosmosResourceId = "/subscriptions/$subId/resourceGroups/$rg/providers/Microsoft.DocumentDB/databaseAccounts/$cosmosAcct"
$appResourceId    = "/subscriptions/$subId/resourceGroups/$rg/providers/Microsoft.Web/sites/$appName"
$aiResourceId     = "/subscriptions/$subId/resourceGroups/$rg/providers/Microsoft.Insights/components/$aiName"

Write-Host ""
Write-Host "CF-LAUNCH-READINESS-100 Phase 2 — apply script"
Write-Host "==============================================="
Write-Host "Resource group : $rg"
Write-Host "Subscription   : $subId"
Write-Host "Email target   : $alertEmail"
Write-Host "Hot containers : $($hotContainers -join ', ')"
Write-Host "Autoscale max  : $autoscaleMax RU/s (min auto-derived at 10% = 400 RU/s)"
Write-Host ""

# ──────────────────────────────────────────────────────────────────────
# Step 1 — Cosmos autoscale migration on hot containers
# ──────────────────────────────────────────────────────────────────────

Write-Host "[1/3] Cosmos autoscale migration"
Write-Host "    Switches dailyiq_briefs + portfolio from manual 400 to autoscale 400-4000 RU/s."
Write-Host "    Other 19 containers untouched."
Read-Host "    Press Enter to apply, Ctrl+C to abort"

foreach ($c in $hotContainers) {
    Write-Host "    → migrating $c to autoscale..."
    # The migrate command first switches to autoscale mode (defaults to 4000 max RU/s
    # when called without --max-throughput; we set explicitly to be safe).
    az cosmosdb sql container throughput migrate `
        --resource-group $rg `
        --account-name $cosmosAcct `
        --database-name $cosmosDb `
        --name $c `
        --throughput-type autoscale `
        --output none

    # Then update the autoscale max to the agreed 4000.
    az cosmosdb sql container throughput update `
        --resource-group $rg `
        --account-name $cosmosAcct `
        --database-name $cosmosDb `
        --name $c `
        --max-throughput $autoscaleMax `
        --output none

    # Confirm the new mode.
    $confirm = az cosmosdb sql container throughput show `
        --resource-group $rg `
        --account-name $cosmosAcct `
        --database-name $cosmosDb `
        --name $c `
        --query "{provisioned:resource.throughput, autoscaleMax:resource.autoscaleSettings.maxThroughput}" `
        -o json
    Write-Host "      $c → $confirm"
}
Write-Host "[1/3] DONE."
Write-Host ""

# ──────────────────────────────────────────────────────────────────────
# Step 2 — Action group (email destination for alerts)
# ──────────────────────────────────────────────────────────────────────

Write-Host "[2/3] Action group (alert destination)"
Write-Host "    Creates 'hobbyiq-ops-alerts' with email receiver $alertEmail."
Read-Host "    Press Enter to apply, Ctrl+C to abort"

az monitor action-group create `
    --resource-group $rg `
    --name $actionGroup `
    --short-name "hbiqOps" `
    --action email "$($alertEmail.Replace('@','at'))" $alertEmail `
    --output none

Write-Host "[2/3] DONE."
Write-Host ""

# ──────────────────────────────────────────────────────────────────────
# Step 3 — 6 metric alert rules
# ──────────────────────────────────────────────────────────────────────

Write-Host "[3/3] Metric alert rules (6 alerts on existing telemetry)"
Write-Host "    Each alert evaluates every 5 min over a 5-15 min window."
Read-Host "    Press Enter to apply, Ctrl+C to abort"

$actionGroupId = "/subscriptions/$subId/resourceGroups/$rg/providers/microsoft.insights/actionGroups/$actionGroup"

# Alert 1 — Cosmos 429s
# Fires when any container records a single 429 in a 5-min window.
# Single-throttle threshold (>0) is intentional — the discovery doc
# shows the existing pattern is bursty (86, 55, 259 in 3 hour-buckets,
# silent in between). Catching even one throttle is the signal we want.
#
# Empirical correction (Phase 2 apply): `TotalRequests` metric only
# supports `count` aggregation, not `total`. And the dimension `where`
# clause comes AFTER the threshold, not before. Final form below
# matches what the az CLI parser actually accepts.
Write-Host "    → alert 1/6: cosmos-throttle-429"
az monitor metrics alert create `
    --resource-group $rg `
    --name "cosmos-throttle-429" `
    --scopes $cosmosResourceId `
    --description "Cosmos container returned 429 (rate-limit). At 100-user tier autoscale should absorb peaks; any 429 means autoscale wasn't fast enough or the ceiling needs raising." `
    --condition "count TotalRequests > 0 where StatusCode includes 429" `
    --window-size 5m `
    --evaluation-frequency 5m `
    --severity 2 `
    --action $actionGroupId `
    --output none

# Alert 2 — App Service HTTP 5xx
Write-Host "    → alert 2/6: appservice-http5xx"
az monitor metrics alert create `
    --resource-group $rg `
    --name "appservice-http5xx" `
    --scopes $appResourceId `
    --description "HobbyIQ3 returned HTTP 5xx. Currently zero in 24h; any non-zero means a backend regression or upstream-dep failure surfaced as 5xx." `
    --condition "total Http5xx > 0" `
    --window-size 5m `
    --evaluation-frequency 5m `
    --severity 1 `
    --action $actionGroupId `
    --output none

# Alert 3 — App Service availability (health check)
# Uses the HealthCheckStatus metric; threshold = anything less than 100% over 5 min.
Write-Host "    → alert 3/6: appservice-health-degraded"
az monitor metrics alert create `
    --resource-group $rg `
    --name "appservice-health-degraded" `
    --scopes $appResourceId `
    --description "HobbyIQ3 health check below 100% for 5 min. Single-instance plan; means the instance is failing checks or restarting." `
    --condition "avg HealthCheckStatus < 100" `
    --window-size 5m `
    --evaluation-frequency 5m `
    --severity 1 `
    --action $actionGroupId `
    --output none

# Alert 4 — App Service response time degradation
# AverageResponseTime is per-request; 2s sustained over 15 min is well
# beyond the 270ms current avg. Catches saturation before user-facing pain.
Write-Host "    → alert 4/6: appservice-response-time-p95"
az monitor metrics alert create `
    --resource-group $rg `
    --name "appservice-response-time-elevated" `
    --scopes $appResourceId `
    --description "HobbyIQ3 AverageResponseTime > 2s sustained over 15 min. Current baseline 270ms; this catches saturation before user-facing pain." `
    --condition "avg AverageResponseTime > 2" `
    --window-size 15m `
    --evaluation-frequency 5m `
    --severity 2 `
    --action $actionGroupId `
    --output none

# Alert 5 — App Insights failure count
# Originally designed as a 1% failure-rate alert, but az monitor metrics
# does not natively compute ratios across two metrics; `requests/failed`
# supports only Count aggregation. Reframed as a count threshold (5
# failures / 15 min) which at the current ~0-1 failures/hour baseline
# is ~10x baseline-per-15min — a defensible spike signal.
#
# Log-based KQL alerts could compute the ratio properly; reserve for a
# future iteration if count-based proves too noisy or too quiet.
Write-Host "    → alert 5/6: appinsights-failure-count"
az monitor metrics alert create `
    --resource-group $rg `
    --name "appinsights-failure-count" `
    --scopes $aiResourceId `
    --description "App Insights failed requests > 5 in 15 min. Baseline 0-1/hour; threshold is ~10x baseline-per-15min." `
    --condition "count requests/failed > 5" `
    --window-size 15m `
    --evaluation-frequency 5m `
    --severity 2 `
    --action $actionGroupId `
    --output none

# Alert 6 — App Insights exception surge
# Threshold 10 exceptions in 15 min. Baseline today is ~0-3 per hour;
# 10 over 15 min is a clear surge.
Write-Host "    → alert 6/6: appinsights-exception-surge"
az monitor metrics alert create `
    --resource-group $rg `
    --name "appinsights-exception-surge" `
    --scopes $aiResourceId `
    --description "App Insights exceptions > 10 in 15 min. Baseline today 0-3/hour. Catches sustained exception spikes (vs single-incident noise)." `
    --condition "count exceptions/count > 10" `
    --window-size 15m `
    --evaluation-frequency 5m `
    --severity 2 `
    --action $actionGroupId `
    --output none

Write-Host "[3/3] DONE."
Write-Host ""

# ──────────────────────────────────────────────────────────────────────
# Final verification — print summary
# ──────────────────────────────────────────────────────────────────────

Write-Host "Final verification — current state:"
Write-Host ""
Write-Host "Cosmos hot-container throughput:"
foreach ($c in $hotContainers) {
    $t = az cosmosdb sql container throughput show `
        --resource-group $rg `
        --account-name $cosmosAcct `
        --database-name $cosmosDb `
        --name $c `
        --query "{provisioned:resource.throughput, autoscaleMax:resource.autoscaleSettings.maxThroughput}" `
        -o json | ConvertFrom-Json
    Write-Host "  $c → provisioned $($t.provisioned) RU/s, autoscale max $($t.autoscaleMax) RU/s"
}
Write-Host ""
Write-Host "Alert rules in $rg :"
az monitor metrics alert list --resource-group $rg --query "[].{name:name, enabled:enabled, severity:severity}" -o table
Write-Host ""
Write-Host "Action group:"
az monitor action-group show --resource-group $rg --name $actionGroup --query "{name:name, enabled:enabled, receivers:emailReceivers[].{name:name, email:emailAddress}}" -o json
Write-Host ""
Write-Host "DONE — CF-LAUNCH-READINESS-100 Phase 2 applied."
Write-Host "Next: Phase 3 verification (load test). See discovery doc §10."
