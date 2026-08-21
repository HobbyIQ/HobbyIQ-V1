// CF-TOKEN-COVERAGE-CANARY (2026-08-20). Cron-driven canary that asks the
// DATA how much of card_catalog is missing searchTokens, and fails loudly when
// coverage regresses.
//
// MOTIVATING CASE. The "Nightly searchTokens backfill" ran GREEN every night
// for months while structurally unable to touch almost anything: its scan was
// scoped `WHERE c.source = 'cardsight' AND c.sport = @sp`, and Cardsight was
// retired from matching on 2026-08-16. Measured 2026-08-20: 3,030,193 rows had
// no searchTokens.
//
// The cost was not cosmetic. searchTokens is the ONLY index-accelerated
// predicate catalogSearch has (ARRAY_CONTAINS). A row without them cannot be
// found by the fast anchor arm, so the request falls through to fallback
// queries carrying seven unindexed CONTAINS branches — a scan of ~35.7M rows.
// Measured effect on /api/compiq/search: catalogMs averaged 31,214ms on cache
// HITS while the pricing engine itself cost 6ms.
//
// WHY A CANARY AND NOT A GREENER JOB. Nothing about the backfill's exit code
// was ever wrong; it did exactly what it was scoped to do. Three separate
// numbers that same day read as complete while being wrong: this job's green
// runs, an enrichment report whose buckets summed to 98.4%, and a bulk error
// counter that under-reported unwritten rows 19x by counting batches instead of
// rows. Counters describe the run. Only a query describes the data.
//
// See feedback_green_workflow_is_not_data_flow.
//
// Exit codes:  0 = within threshold   1 = regression (alert)   2 = misconfigured

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

// Sized off the 2026-08-20 backfill. After it, steady state should be small —
// only newly-ingested rows awaiting their next nightly pass. A sustained number
// far above that means the backfill is scoped wrong again, or has stopped.
const MAX_MISSING = Number(process.env.MAX_MISSING_TOKENS || 250000);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) {
    console.error("::error::COSMOS_CONNECTION_STRING required");
    process.exit(2);
  }

  const cc = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || "hobbyiq")
    .container("card_catalog");

  const missingPredicate =
    "(NOT IS_DEFINED(c.searchTokens) OR c.searchTokens = null OR ARRAY_LENGTH(c.searchTokens) = 0)";

  const { resources: totals } = await cc.items
    .query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @pfx) AND ${missingPredicate}`,
      parameters: [{ name: "@pfx", value: "hiq:" }],
    })
    .fetchAll();

  const missing = Array.isArray(totals) ? totals[0] : null;
  if (typeof missing !== "number") {
    console.error("::error::[token-coverage] count query returned no value — treating as FAILURE");
    process.exit(1);
  }

  console.log(`[token-coverage] rows missing searchTokens: ${missing.toLocaleString()}`);
  console.log(`[token-coverage] threshold:                 ${MAX_MISSING.toLocaleString()}`);

  // Break down by sport, because the historical failure was a SCOPE bug: one
  // sport covered and the rest silently ignored. A single total would have
  // looked healthy while football sat at zero coverage.
  try {
    const { resources: bySport } = await cc.items
      .query({
        query:
          `SELECT c.sport AS sport, COUNT(1) AS n FROM c ` +
          `WHERE STARTSWITH(c.id, @pfx) AND ${missingPredicate} ` +
          `GROUP BY c.sport`,
        parameters: [{ name: "@pfx", value: "hiq:" }],
      })
      .fetchAll();
    if (bySport && bySport.length) {
      console.log("[token-coverage] missing by sport:");
      for (const r of bySport.sort((a, b) => (b.n || 0) - (a.n || 0))) {
        console.log(`    ${String(r.sport ?? "(unset)").padEnd(12)} ${String(r.n).padStart(10)}`);
      }
    }
  } catch (e) {
    console.warn(`[token-coverage] per-sport breakdown unavailable: ${e.message}`);
  }

  if (missing > MAX_MISSING) {
    console.error(
      `::error::[token-coverage] ${missing.toLocaleString()} rows lack searchTokens ` +
        `(threshold ${MAX_MISSING.toLocaleString()}). catalogSearch cannot use its index for these, ` +
        `so /search falls back to scanning ~35.7M rows. Check the nightly backfill's SCOPE ` +
        `(--sport, source filter) before assuming it merely needs another run.`,
    );
    process.exit(1);
  }

  console.log("[token-coverage] OK — within threshold.");
}

main().catch((e) => {
  console.error("::error::[token-coverage] FAILED:", e?.message || e);
  process.exit(1);
});
