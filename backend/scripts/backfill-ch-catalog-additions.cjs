#!/usr/bin/env node
// CF-BACKFILL-CH-CATALOG-ADDITIONS (Drew, 2026-08-01).
//
// Nightly wrapper for chAdditionsIngest.service.ts. Pulls CH's
// /cards/additions-summary since our last checkpoint and upserts
// new SKUs into ch_catalog_additions. Container was empty — this
// starts the flow.
//
// Env:
//   CARD_HEDGE_API_KEY         required (fetched by workflow from App Service)
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   LOOKBACK_DAYS              default 14 on cold start (per service default)

let ingestCatalogAdditions;
try {
  ({ ingestCatalogAdditions } = require("../dist/services/catalog/chAdditionsIngest.service.js"));
} catch (e) {
  console.error("Cannot import ingestCatalogAdditions from dist — build backend first (npm run build)");
  console.error(e.message);
  process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
if (!process.env.CARD_HEDGE_API_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(1); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

async function main() {
  console.log(`[backfill-ch-catalog-additions] apply=${APPLY}`);
  if (!APPLY) {
    console.log("  (dry run — the service is idempotent so we still call it, but skip if you don't want writes)");
    console.log("  (there is no separate dry-run mode; ingest writes to Cosmos on every APPLY=true call)");
    console.log("  RELAUNCH_NEEDED=false");
    return;
  }
  const summary = await ingestCatalogAdditions({});
  console.log(`\n=== Ingest summary ===`);
  console.log(`  startDate:      ${summary.startDate}`);
  console.log(`  endDate:        ${summary.endDate}`);
  console.log(`  pagesFetched:   ${summary.pagesFetched}`);
  console.log(`  rowsSeen:       ${summary.rowsSeen}`);
  console.log(`  rowsUpserted:   ${summary.rowsUpserted}`);
  console.log(`  firstError:     ${summary.firstError ?? "none"}`);
  console.log(`  elapsedMs:      ${summary.elapsedMs}`);
  console.log(`RELAUNCH_NEEDED=false`);
}

main().catch(e => { console.error(e); process.exit(1); });
