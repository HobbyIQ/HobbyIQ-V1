#!/usr/bin/env node
// CF-EXPAND-CATALOG-FROM-TCDB (Drew, 2026-08-01). Complements the
// CardHedge catalog-expansion loop with data from TCDB (Trading Card
// DB) — a community-maintained checklist source that covers products
// CH doesn't have (older sets, non-baseball sports, indie brands).
//
// Strategy:
//   1. Iterate KNOWN_SETS (year × product) tuples where CH catalog
//      is thin (fewer than N entries) or missing entirely.
//   2. For each set, hit TCDB's public list endpoint (or scrape
//      HTML checklist).
//   3. Parse the checklist → cardNumber + player + variant tuples.
//   4. Upsert to card_catalog with source="tcdb".
//   5. Track processed tuples in a checkpoint doc, self-relaunch.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   TCDB_API_BASE              optional override (default https://www.tcdb.com/API/)
//   TCDB_API_KEY               optional (some endpoints require auth)
//   BACKFILL_APPLY             apply | dry (default dry)
//
// NOTE: This is a SCAFFOLD. TCDB does not have a stable public JSON
// API — most integrations scrape their HTML checklist pages. When Drew
// authorizes, replace the fetchChecklist() stub with either:
//   (a) A subscription to TCDB's data feed, OR
//   (b) An HTML scraper using their /Checklist/{setId}/ URLs, OR
//   (c) A different source (Beckett API, sportscardsdb.com, etc.).
// Until then this script logs a friendly "not-yet-wired" message so
// the workflow slot exists.

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CHECKPOINT_ID = "expand-catalog-from-tcdb::checkpoint";
const TCDB_API_KEY = process.env.TCDB_API_KEY || null;
const TCDB_API_BASE = process.env.TCDB_API_BASE || "https://www.tcdb.com/API/";

// (year, product) tuples to attempt. Start narrow — the same products
// we care most about for HobbyIQ pricing. Expand as we validate data
// quality.
const TARGET_SETS = [
  { sport: "baseball", year: 2024, product: "Topps Chrome Update" },
  { sport: "baseball", year: 2023, product: "Bowman Chrome" },
  { sport: "baseball", year: 2022, product: "Topps Chrome Platinum" },
  // Add more when Drew authorizes broader coverage.
];

async function fetchChecklist(_set) {
  // Stub. When Drew provides the credential/method for TCDB access,
  // replace with real fetch logic. For now returns null so the script
  // reports the gap without failing.
  if (!TCDB_API_KEY) return { unavailable: "TCDB_API_KEY not configured — set it in App Service to enable this backfill" };
  return { unavailable: "TCDB fetch not yet implemented — awaiting auth details" };
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[expand-catalog-from-tcdb]  mode=${MODE}  base=${TCDB_API_BASE}  hasKey=${!!TCDB_API_KEY}`);

  let inserted = 0;
  let unavailableCount = 0;
  for (const set of TARGET_SETS) {
    const result = await fetchChecklist(set);
    if (result.unavailable) {
      unavailableCount++;
      console.log(`  [SKIP] ${set.year} ${set.product}: ${result.unavailable}`);
      continue;
    }
    // Would upsert cards here — TODO once fetch is wired
  }

  // Checkpoint (informational for now)
  if (MODE === "apply" && inserted > 0) {
    await cc.items.upsert({
      id: CHECKPOINT_ID,
      cardId: CHECKPOINT_ID,
      lastRunAt: new Date().toISOString(),
      totalInserted: inserted,
    });
  }
  console.log(`\n=== Done ===  inserted=${inserted}  unavailable=${unavailableCount}/${TARGET_SETS.length}`);
  if (unavailableCount === TARGET_SETS.length) {
    console.log("\nTo enable TCDB catalog import:");
    console.log("  1. Register at https://www.tcdb.com/Register.cfm and get an API key or credentials");
    console.log("  2. Set TCDB_API_KEY in HobbyIQ3 App Service application settings");
    console.log("  3. Wire real fetch logic in fetchChecklist() (replace stub)");
    console.log("  4. Re-dispatch this workflow — catalog will grow from TCDB checklists");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
