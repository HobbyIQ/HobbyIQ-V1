# Cardsight bulk catalog + data crawl

Ops scripts that seed HobbyIQ's own containers from Cardsight's API.
Nothing in `backend/src` — pure scripts, no deploy, no runtime changes.

## What each phase does

| Phase | Script | Endpoint | Writes to | Expected runtime (full baseball) |
|-------|--------|----------|-----------|----------------------------------|
| A1 | `phase-a-crawl-releases.cjs` | `GET /v1/catalog/releases?segment=X` | `.state/releases-<sport>.json` | ~5s (1,992 baseball releases) |
| A2 | `phase-a-crawl-cards.cjs` | `GET /v1/catalog/releases/{id}/cards` | `card_catalog` container | ~15-30 min (~100k baseball cards) |
| B  | `phase-b-crawl-pricing.cjs` | `POST /v1/pricing/` (batch 100) | `sold_comps` container | ~15-30 min (~1,000 batches, many upserts per batch) |
| C  | `phase-c-crawl-population.cjs` | `GET /v1/population/release/{id}` | `card_population` container | ~5-10 min (1,992 releases) |
| D  | `phase-d-crawl-release-calendar.cjs` | `GET /v1/release-calendar/` | `release_calendar` container | ~30s |
| E  | `phase-e-crawl-marketplace.cjs` | `GET /v1/marketplace/{card_id}` | `active_listings` container | ~3-5 h (no batch endpoint, single-card) |

## Prereqs

Two env vars, sourced without echoing to stdout or disk:

```sh
# From HobbyIQ3 App Service (bash — Windows Git Bash also works)
export CARDSIGHT_API_KEY=$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='CARDSIGHT_API_KEY'].value" -o tsv | tr -d '\r\n')

export COSMOS_CONNECTION_STRING=$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv | tr -d '\r\n')

# optional overrides
export COSMOS_DATABASE=hobbyiq    # default
export CS_BULK_RPS=8              # default; higher = faster + more API load
```

## Run everything (baseball)

```sh
node backend/scripts/cardsight-bulk/run-all-baseball.cjs
```

Total expected wall-clock for full baseball: **~4-6 hours** (Phase E
dominates). Every phase is resumable via `--resume`.

## Run one phase at a time

```sh
# Catalog first (Phase A is prerequisite for B/C/E)
node backend/scripts/cardsight-bulk/phase-a-crawl-releases.cjs
node backend/scripts/cardsight-bulk/phase-a-crawl-cards.cjs --min-year 2020

# Pricing (recent + graded sales for every catalog card)
node backend/scripts/cardsight-bulk/phase-b-crawl-pricing.cjs \
  --year 2025 --period 1y --listing-type auction

# Population (scarcity signal)
node backend/scripts/cardsight-bulk/phase-c-crawl-population.cjs --level release
node backend/scripts/cardsight-bulk/phase-c-crawl-population.cjs \
  --level card --year 2025 --limit-cards 5000

# Release calendar (upcoming products)
node backend/scripts/cardsight-bulk/phase-d-crawl-release-calendar.cjs

# Active marketplace listings (asks)
node backend/scripts/cardsight-bulk/phase-e-crawl-marketplace.cjs \
  --year 2025 --limit-cards 5000
```

## Common flags

| Flag | Applies to | Meaning |
|------|-----------|---------|
| `--sport <name>` | A/B/C/D/E | Segment shortname: baseball (default), basketball, football, etc. `all` for D. |
| `--year <yyyy>` | A/B/C/E | Restrict to a single release year. |
| `--min-year <yyyy>` | A2, C release | Skip releases older than this. |
| `--limit-cards <N>` | B/C card/E | Cap the number of catalog cards processed. |
| `--period <s>` | B | Pricing lookback: `7d`, `14d`, `2w`, `3m`, `1y`, `all`. Default `all`. |
| `--listing-type <t>` | B | `auction` (completed sales), `fixed` (asks), `both`. Default `auction`. |
| `--per-card-limit <N>` | B | Max records CS returns per card (1-100). Default 100. |
| `--level <lvl>` | C | `release` (rollup, fast) or `card` (per-card, slow). Default release. |
| `--resume` | A2/B/C/E | Skip units already recorded in `.state/*-progress-*.json`. |
| `--dry-run` | all | No Cosmos writes — just count what WOULD upsert. |

`run-all-baseball.cjs` accepts the same flags and passes them through, plus:
`--skip-catalog --skip-pricing --skip-population --skip-calendar --skip-marketplace`.

## State + progress

Every crawler writes a progress state file under `.state/` (gitignored)
so re-running with `--resume` picks up exactly where the last run left
off. To restart from scratch, delete the relevant file.

## Rate limits + retry

- Global 8 rps limiter (override with `CS_BULK_RPS`)
- 429 / 5xx trigger exponential backoff + Retry-After honored
- 5 retries per request before giving up; the script continues past
  failed units and records the error in the progress file

## Cosmos containers created

If they don't already exist, these are created on first write via
`createIfNotExists`. Partition key noted:

| Container | Partition | Written by |
|-----------|-----------|-----------|
| `card_catalog` | `/cardId` | Phase A2 |
| `sold_comps` | `/cardId` | Phase B (existing container, extended) |
| `card_population` (level=release) | `/releaseId` | Phase C release |
| `card_population` (level=card) | `/cardId` | Phase C card |
| `release_calendar` | `/segmentId` | Phase D |
| `active_listings` | `/cardId` | Phase E |

## Rollback

`card_catalog`, `sold_comps` are shared with runtime persistence — do
not drop. If you need to purge a bulk-crawled slice, filter by
`source = "cardsight" AND bulkCrawledAt >= <ts>` for sold_comps, or
`id LIKE "cardsight::%::bulk"` for card_catalog.

The `card_population`, `release_calendar`, and `active_listings`
containers are bulk-crawler-only. Safe to drop and reseed.
