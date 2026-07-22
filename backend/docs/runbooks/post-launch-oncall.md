# Post-launch on-call runbook

**Purpose:** what to do when things fire in prod after launch. Focused on the
most likely early-user pain points: eBay listing publish, FMV pricing quality,
and daily-refresh regressions. Anchor every diagnostic to a concrete command;
prose is context, commands are truth.

Last updated: 2026-07-22 (Drew).

---

## The three commands you always run first

Before diagnosing anything, verify the deploy actually landed and prod is
healthy. 90% of "the app is broken" reports are actually "the last deploy is
still rolling out."

```bash
# 1. What SHA is prod on?
curl -s https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/health \
  | grep -oE '"shaShort":"[a-f0-9]+"'

# 2. What SHA is main on?
git -C <repo> log origin/main --oneline -1

# 3. Do they match?
# If yes → code is deployed; the issue is real.
# If no → deploy in flight; recheck in 5 min.
```

If prod is behind, dispatch:

```bash
gh workflow run "Daily 5AM ET Refresh & Deploy"
```

---

## eBay listing publish returns non-200

**Where to look:** Application Insights `traces` for the `ebay_api_request_failed`
event. Every failure logs the full request body + eBay's response.

```
az monitor app-insights query \
  --app 468bd437-5d16-47b4-90fb-5ee5d41726ae \
  --analytics-query "traces | where timestamp > ago(30m) | where message contains 'ebay_api_request_failed' | project timestamp, message | order by timestamp desc | take 5"
```

The `ebayField` value tells you what eBay rejected. Cross-reference:

| ebayErrorId | Meaning | Fix |
|---|---|---|
| 2004 | "Could not serialize field [X]" | X is a strict enum; check the string sent isn't a numeric ID or a made-up value |
| 25001 | "Core Inventory Service internal error" | eBay transient; retry once. If persistent, eBay is down |
| 25002 | "No <Item.Country> exists" | Missing `merchantLocationKey` on offer, OR user has no eBay inventory location. Route to POST /api/ebay/locations |
| 25058 | "Condition data is required for selected category" | `condition` field was omitted; category requires it |
| 25059 | "Condition information N is not valid for category X" | Sell API string mapped to a conditionId the category rejects. Check category via `/api/ebay/condition-policies` |
| 25060 | "Descriptor N is not valid for condition M" | conditionDescriptors mismatch base condition. Graded needs LIKE_NEW+conditionId 2750; raw needs USED_VERY_GOOD+40001 |
| 25064 | "Aspect X is a required field" | Category requires an aspect we're not sending. Check `/api/ebay/category-aspects?categoryId=261328` |
| 25066 | "Descriptor sent as NULL" | Free-text descriptor sent in `values` array instead of `additionalInfo` field |
| 25709 | "Invalid value for header Accept-Language" | Deploy regression; verify `Accept-Language: en-US` header still set in `ebayRequest` |

**Common seller-account config issues** (400 with structured error body):

| Response field | Fix |
|---|---|
| `missingPolicy: {policyType: "return", reason: "no_default_among_multiple"}` | Seller has 2+ return policies, none default. eBay Seller Hub → Business Policies → Set one as default |
| `missingLocation: {reason: "none_configured"}` | Seller has no ship-from location. iOS should prompt for address → POST /api/ebay/locations |
| `error: "eBay account not connected"` | User's eBay OAuth expired or was revoked. iOS should re-run connect flow |

---

## FMV returns null / "Can't estimate"

**Where to look:** hit `/api/compiq/price` with the offending query and read `source`.

```bash
curl -sS -X POST https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/compiq/price \
  -H "x-session-id: $SESSION" -H "Content-Type: application/json" \
  -d '{"query":"<the query>"}' | jq '{source, pricingTier, fairMarketValue, marketValue}'
```

| `source` value | Meaning | Diagnostic |
|---|---|---|
| `live` | Priced from real comps | Working as intended. If FMV feels wrong, check `recentComps` in the response |
| `no-recent-comps` with FMV | Priced via Tier 7 setdoc-baseline fall-through (PR #682) | Working as intended — no recent comps but era-typed baseline available |
| `no-recent-comps` with null FMV | Tier ladder exhausted | Query lacks `product` + `cardYear`, OR era baseline missing. Check `predictedPriceAttribution.mechanism` |
| `setdoc-baseline` | Tier 7 direct hit | Working. Confidence is 15%; the baseline is era-typed only |
| `catalog-miss` | CH couldn't identify the card | Query wording issue OR card genuinely not in CH catalog. Try CS via `/api/search/cards` |
| `unsupported_sport` | Card identified as non-baseball | Real limitation; CompIQ is baseball-only. Expected for football/basketball unless expanded |

**If a real card returns null with `source: "no-recent-comps"`:** most common
cause is missing empirical grade calibration for the product family (post-
empirical-only-multiplier-doctrine, PR #633). Run:

```bash
# Check family classification + calibration coverage
grep -A 2 "classifyFamily" backend/src/services/compiq/gradeCalibrationConfig.ts
# Then grep the family key in the calibration data file
grep "\"<family-key>\"" backend/src/services/compiq/gradeCalibrationData.ts
```

If the family isn't in the data file, add empirical calibration by running:

```bash
gh workflow run "Grade Calibration Refresh"
```

Weekly this runs auto; you can also dispatch it manually.

---

## Daily 5AM ET workflow shows red but deploy landed

**Almost always a false red on `Smoke test pricing tiers` step** — the deploy
succeeded, one of the 8 synthetic pricing cases just tripped an assertion.
Historically:
- Cache-warm timeout during era-baselines step (memory:
  `reference_era_baselines_timeout_expected.md`)
- Tier 7 transition assertion (memory rule after PR #682 — should be resolved,
  but if returns, loosen with mustNotNull: false)

**Always verify via `/api/health` shaShort BEFORE treating as a real deploy
failure.** If shaShort matches origin/main, the deploy landed successfully and
the smoke assertion is the noise.

**To see what specifically failed:**

```bash
gh run view <run-id> --job=$(gh run view <run-id> --json jobs --jq '.jobs[0].databaseId') --log-failed | tail -50
```

---

## Sold_comps grew way beyond CH (data quality drift)

**Where to look:** compare `sold_comps` count per sport vs `ch_daily_sales`
count. Under normal steady-state, sold_comps should be ~96-99% of CH (some CH
rows have data-quality issues that filter out).

```bash
# See scripts/_sport.cjs pattern; query directly:
# SELECT VALUE COUNT(1) FROM c WHERE c.sport='baseball' (sold_comps)
# SELECT VALUE COUNT(1) FROM c WHERE c['group']='Baseball' (ch_daily_sales)
```

**If sold_comps is significantly LOWER than CH** (e.g., 60%), the FB/BB
promotion workflow needs to be re-run:

```bash
gh workflow run "Sold Comps CH Backfill" \
  -f from_date=2019-01-01 -f to_date=2026-12-31 \
  -f sport=<sport> -f ch_group=<Sport> \
  -f concurrency=8 -f dry_run=false
```

**If sold_comps is HIGHER than CH** (unlikely but possible), duplicates are
accumulating. Check:

```bash
# App Insights: how often is pre-write dedup firing?
az monitor app-insights query \
  --app 468bd437-5d16-47b4-90fb-5ee5d41726ae \
  --analytics-query "traces | where timestamp > ago(24h) | where message contains 'sold_comps_prewrite_dedup_replaced' | count"
```

Any significant count means real cross-source duplicates are being detected
and collapsed — that's good, the system is working. If the count spikes
suddenly (10x baseline), something is generating duplicate ingestion.

---

## eBay Taxonomy Drift check fires

Nightly workflow `.github/workflows/ebay-taxonomy-drift-nightly.yml` compares
eBay category 261328's aspects + condition IDs against a committed baseline
(`backend/data/ebay-taxonomy-baseline-261328.json`). Fails visibly on any
schema change.

**When it fires:** eBay changed the category schema. Two paths:

1. **Trivial changes** (added a new optional aspect): review the diff on the
   workflow log; if benign, update baseline:

   ```bash
   gh workflow run "eBay Taxonomy Drift (nightly)" -f update_baseline=true
   ```

   Then download the updated JSON artifact and open a PR against
   `backend/data/ebay-taxonomy-baseline-261328.json`.

2. **Breaking changes** (aspect required that we don't send, condition ID
   removed, etc.): dispatch a listing publish test on a known good holding
   BEFORE updating the baseline. If publish fails, the code needs updating
   too (see the eBay publish failure section above for common patterns).

---

## Cosmos throttling (429 errors) in Application Insights

Look for `RequestRateTooLarge` in traces. Root cause is usually one of:

1. **Batch backfill process hammering sold_comps** — check for a running
   `Sold Comps *` workflow. If yes, verify concurrency ≤ 5 in its input.
   Concurrency 20 causes throttling (learned 2026-07-21).

2. **New pricing endpoint blew up traffic** — check `requests` telemetry for
   a spike on a specific endpoint. If yes, may need Cosmos autoscale or a
   query optimization on the hot path.

---

## App Store review rejected

Most common causes and how to preempt:

| Reason | Fix |
|---|---|
| No account delete flow | Backend already has DELETE /api/account (Apple 5.1.1(v) compliant). Verify iOS is calling it |
| Privacy Policy inaccessible | iOS Settings screen must link to a hosted Privacy Policy URL |
| ATT (App Tracking Transparency) missing | If iOS collects any identifier for advertising, ATT prompt is mandatory |
| Camera / photo permissions unexplained | Info.plist `NSCameraUsageDescription` must be plain-English purpose |
| In-app purchase products not configured | App Store Connect → In-App Purchases must have all tier products approved before review |

---

## Common environment vars — where they live

Prod values are in Azure App Service application settings on HobbyIQ3 in the
`rg-hobbyiq-dev` resource group. Never echo them to chat.

```bash
# Retrieve one (e.g. for a diagnostic script)
az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='<NAME>'].value" -o tsv
```

Key ones to know:
- `COSMOS_CONNECTION_STRING` — Cosmos DB access
- `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` — eBay OAuth (used by Taxonomy drift check)
- `AUTH_SESSION_SECRET` — session HMAC signing key (auth-root; never forge from it)
- `CARDSIGHT_API_KEY` — Cardsight catalog augment
- `CARD_HEDGE_API_KEY` — CH sold comps

---

## Ops alert email

Drew's alert destination is `drew@justtheboysandcards.com` (NOT `dvabulas@outlook.com`).
Wire up Azure Monitor alerts to that address.
