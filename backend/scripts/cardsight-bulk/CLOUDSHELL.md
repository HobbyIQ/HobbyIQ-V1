# Running the Cardsight bulk crawlers in Azure Cloud Shell

Cloud Shell runs in the same Azure region as our Cosmos DB, which drops
per-write latency from ~40ms (home) to ~3ms (Cloud Shell) — a 10× speedup
on the biggest bottleneck. Combined with the parallel-writes enhancement
(`CS_BULK_WRITE_CONCURRENCY=16` default, tunable), full baseball catalog
crawl (~600k cards) lands in **~15-20 minutes** end-to-end.

## One-time Cloud Shell setup

Open [shell.azure.com](https://shell.azure.com) → Bash. First-run only:

```sh
# Clone the repo
mkdir -p ~/hobbyiq && cd ~/hobbyiq
git clone https://github.com/HobbyIQ/HobbyIQ-V1.git
cd HobbyIQ-V1/backend

# Install deps + build (Phase B needs dist/services/portfolioiq/hobbyIqCardId.service.js)
npm install
npm run build
```

## Every-run bootstrap (paste at the top of every session)

```sh
cd ~/hobbyiq/HobbyIQ-V1
git pull origin main
cd backend

# Env — pipe direct, never write to disk
export CARDSIGHT_API_KEY=$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='CARDSIGHT_API_KEY'].value" -o tsv)
export COSMOS_CONNECTION_STRING=$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)

# Speed knobs — safe defaults for Cloud Shell same-region latency
export CS_BULK_RPS=12
export CS_BULK_WRITE_CONCURRENCY=20
```

## The three commands you actually want

### 1. Full baseball catalog (A + B + C + D) — ~30 min

```sh
node scripts/cardsight-bulk/run-all-sports.cjs --sports baseball --skip-marketplace
```

Populates `card_catalog`, `sold_comps` (batch pricing), `card_population`
(release-level rollup), `release_calendar`. Skips Phase E (marketplace
active listings) — that's the slow single-card endpoint.

### 2. Full all-sports catalog — ~2-3 hours

```sh
node scripts/cardsight-bulk/run-all-sports.cjs \
  --sports baseball,basketball,football --skip-marketplace
```

Cloud Shell has a 20-min inactivity + 60-min max session cutoff, so
this one exceeds a single session. Two options:
- Run each sport separately (three sessions), OR
- Run in tmux with a keep-alive ping so the inactivity clock stays fresh

Keep-alive one-liner: `while true; do echo -n .; sleep 60; done &` in a
separate pane before you start the crawler.

### 3. Marketplace listings for a scoped set — ~15 min per 5k cards

```sh
node scripts/cardsight-bulk/phase-e-crawl-marketplace.cjs \
  --sport baseball --year 2025 --limit-cards 5000 --resume
```

Only worth running for hot cards (recent-year rookies). Every card is
one API call, no batch endpoint — so limit hard.

## Verifying the crawl landed

```sh
# Card catalog fill
az cosmosdb sql query --account-name hobbyiq-comps \
  --database-name hobbyiq --container-name card_catalog \
  --query-text "SELECT VALUE COUNT(1) FROM c WHERE c.source='cardsight' AND c.sport='baseball'" \
  -o tsv

# sold_comps growth in the last 30 min
az cosmosdb sql query --account-name hobbyiq-comps \
  --database-name hobbyiq --container-name sold_comps \
  --query-text "SELECT VALUE COUNT(1) FROM c WHERE c.bulkCrawledAt >= '$(date -u -d '30 minutes ago' +%FT%TZ)'" \
  -o tsv

# Population coverage
az cosmosdb sql query --account-name hobbyiq-comps \
  --database-name hobbyiq --container-name card_population \
  --query-text "SELECT VALUE COUNT(1) FROM c" -o tsv
```

## If you need to resume

Every phase writes a progress file under `backend/scripts/cardsight-bulk/.state/`.
On rerun, pass `--resume` to any script and it picks up mid-flight. Delete
the state file to force a full re-crawl (upserts are idempotent — same
`id` for same source data — so no duplicates result).

## Troubleshooting

- **`CARDSIGHT_API_KEY` unset** → the az CLI is not logged in. `az login --tenant <tenantId>`.
- **429 responses** → the crawler auto-backoffs. Drop `CS_BULK_RPS` to 8 if they persist.
- **Cosmos 429 (RU exhaustion)** → drop `CS_BULK_WRITE_CONCURRENCY` to 8 or bump container throughput.
- **`Cannot find module '../../dist/…'`** → run `npm run build` in `backend/`.
- **Cloud Shell session ended mid-crawl** → the progress file has your state; open a new session, re-bootstrap env, run with `--resume`.
