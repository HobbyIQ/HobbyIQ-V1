# Catalog data pipeline — quick reference

_Everything you need to refresh HobbyIQ's canonical catalog. One entrypoint (`catalog-full-refresh.sh`) runs all 11 steps end-to-end and prints a final match-rate report._

## TL;DR

```bash
export COSMOS_CONNECTION_STRING=$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)
bash backend/scripts/catalog-full-refresh.sh
```

Runs everything: scrape → import → match → sales → anomalies → drop RU. ~3 hrs cold. Idempotent — safe to re-run.

## Common fast-paths

```bash
# I just want to re-run match (JSON already scraped, no new sales data):
CATALOG_SKIP_SCRAPE=1 CATALOG_SKIP_SALES=1 CATALOG_SKIP_ANOM=1 \
  bash backend/scripts/catalog-full-refresh.sh

# BCCP is soft-blocking me — use only CLC:
CATALOG_SKIP_BCCP=1 bash backend/scripts/catalog-full-refresh.sh

# Just refresh sales + anomalies (data-quality pass):
CATALOG_SKIP_SCRAPE=1 bash backend/scripts/catalog-full-refresh.sh
```

## Skip-flag reference

| Env var | Skips |
| --- | --- |
| `CATALOG_SKIP_SCRAPE` | steps 1-3 (both scrapes + xlsx) |
| `CATALOG_SKIP_BCCP`   | step 1 only (BCCP scrape) |
| `CATALOG_SKIP_XLSX`   | step 3 only (xlsx download) |
| `CATALOG_SKIP_SALES`  | step 8 (attach salesSummary) |
| `CATALOG_SKIP_ANOM`   | step 9 (flag priceAnomalies) |

## Pipeline steps

| # | What | Script | Duration |
| --- | --- | --- | --- |
| 0 | Bump card_catalog RU 4K → 10K | `az` | 5s |
| 1 | Scrape baseballcardpedia (2025..1900) | `run-all-bccp-scrape.sh` | ~90 min |
| 2 | Scrape checklistcenter (547 URLs) | `scrape-clc-checklist.mjs` | ~10 min |
| 3 | Download CLC xlsx per product | `download-clc-xlsx.mjs` | ~15 min |
| 4 | Repair BCCP JSON regex fixes | `repair-bccp-json-names.mjs` | 30s |
| 5 | Import BCCP → card_catalog | `import-bccp-to-catalog.ts --all` | 5s |
| 6 | Import CLC → card_catalog | `import-clc-to-catalog.ts --all` | 3s |
| 7 | Match every year against unified index | `match-catalog-to-bccp.ts` loop | ~15 min |
| 8 | Attach salesSummary per year | `attach-sales-summary-to-catalog.ts` loop | ~30 min |
| 9 | Flag priceAnomalies (2015+) | `flag-price-anomalies.ts` loop | ~5 min |
| 10 | Drop card_catalog RU 10K → 4K | `az` | 5s |
| 11 | Print final match-rate breakdown | inline node | 10s |

## Data sources (order of preference)

1. **baseballcardpedia (BCCP)** — deepest coverage (3,075 products, 1900-2025), wikitext MediaWiki API. Soft-blocked by WAF after burst scraping — clears in 4-24 hrs.
2. **checklistcenter (CLC)** — 547 products, mostly 2018-2026. Fills BCCP's 2026 gap (BCCP tops at 2025). Plain HTML.
3. **xlsx** — one per CLC product. Full player-per-card checklists (BCCP + CLC HTML don't have those). Used for playerName backfill.

## Session progress notes (2026-08-05)

- Baseline match rate: 47% confirmed
- After Cosmos bulk() throughput + normalizer regex fix: 60%
- After multi-product fix (Chrome + Chrome Update collision): 68.3%
- After CLC dual-source: 68.3% (added 21pp to y=2026 alone)
- After plural-singular fix ("Refractors" ≡ "Refractor"): TBD
- Target: 95% confirmed

## Where things live

| Path | Contents |
| --- | --- |
| `c:/tmp/bccp/{year}/*.json` | BCCP scraped product structures |
| `c:/tmp/clc/{year}/*.json` | CLC scraped product structures |
| `c:/tmp/clc-xlsx/{year}/*.xlsx` | CLC downloaded checklists |
| Cosmos `card_catalog` | Unified catalog (all sources) |
| Cosmos `sold_comps` | Every observed transaction (priceAnomaly flags land here) |
