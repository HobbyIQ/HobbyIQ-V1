# Grader Premium Calibration Refresh

**Status:** design + scaffold only (2026-07-15, PR #495). No timer trigger deployed yet.
**Owner:** engine team.

## Purpose

The static `GRADER_PREMIUMS` table in `backend/src/services/compiq/compiqEstimate.service.ts` holds the fallback multipliers used when the value-tier table + auto/vintage cascade misses. Those numbers are Drew's 2026-07-15 hand-anchored table — good enough for launch, but they will drift as the graded market moves. This runbook covers the eventual monthly refresh that reads the actual observed graded/raw ratios from App Insights and rewrites the numbers on disk.

## Data source

Every time the engine emits a comp-derived grade ratio it logs a `graded_ratio_observed` App Insights custom event (see `logGraderRatioObserved` in `compiqEstimate.service.ts`). Fields:

| field | example |
| --- | --- |
| `company` | `PSA` / `BGS` / `SGC` / `CGC` |
| `grade` | `10`, `9.5`, `10 Black Label` |
| `ratio` | 3.62 |
| `rawTier` | `<25`, `25-50`, `50-100`, `100+` |
| `cardClass` | `base`, `autograph`, `vintage` |
| `sampleCount` | 5 |

The `hobbyiq-insights` Application Insights instance (app-id `468bd437-5d16-47b4-90fb-5ee5d41726ae`) receives all of these — see the `[HobbyIQ3 App Insights destination]` memory.

## KQL — proposed monthly rewrite query

```kql
customEvents
| where name == "graded_ratio_observed"
| where timestamp > ago(90d)
| extend
    company = tostring(customDimensions.company),
    grade   = tostring(customDimensions.grade),
    tier    = tostring(customDimensions.rawTier),
    class   = tostring(customDimensions.cardClass),
    ratio   = todouble(customDimensions.ratio),
    n       = toint(customDimensions.sampleCount)
| where isnotempty(company) and isnotempty(grade) and isnotempty(tier)
| where n >= 3                             // drop 1-comp noise
| summarize
    p50 = percentile(ratio, 50),
    p25 = percentile(ratio, 25),
    p75 = percentile(ratio, 75),
    obs = sum(n)
  by company, grade, tier, class
| where obs >= 20                          // require ≥20 underlying comps to refresh a cell
| project company, grade, tier, class, p50, p25, p75, obs
```

## Refresh rules (safety belts)

1. **Never overwrite a cell unless `obs >= 20`** — a thin observation shouldn't dislodge Drew's anchor.
2. **Cap the delta per cycle at ±25%** — protects against a bad month cascading into product.
3. **Emit a diff artifact** to `backend/data/grader-premium-refresh-<YYYY-MM-DD>.json` before touching the table — Drew reviews before merge.
4. **Never touch `BGS 10 Black Label`** in the auto path — it's rare enough that observation-driven refresh will underreport. Keep as anchor-only.
5. **PSA 8 override stays** — the modern override (`PSA 8 = 1.0 × raw` for `year >= 1990 || year == null`) is a design decision, not a calibration point.

## Delivery

Two options considered; deferred:

- **Option A — Azure Function timer trigger** monthly. Reads AI via SDK, computes the summary, opens a PR against the repo. Preferred long-term because it audits cleanly.
- **Option B — manual runbook** invoked from `backend/scripts/`. Faster to build. Suitable for the pre-launch cadence where Drew reviews every refresh anyway.

Ship option B first if we start seeing drift within 60 days of launch. Upgrade to option A once the diff artifact stabilizes.

## What lives where

- Live table: [`backend/src/services/compiq/compiqEstimate.service.ts`](../../src/services/compiq/compiqEstimate.service.ts) — search for `GRADER_PREMIUMS`.
- Auto/vintage empirical JSON: `backend/data/multi-set-calibration-latest.json`, `backend/data/cross-class-auto-premium-latest.json`.
- Gem-rate signal service: [`backend/src/services/compiq/gemRateSignal.service.ts`](../../src/services/compiq/gemRateSignal.service.ts). This bypasses the table entirely for top grades when a card has ≥10 observed graded sales — as adoption grows, table drift matters less for the highest-liquidity cards.
