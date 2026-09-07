#!/usr/bin/env node
// CF-NIGHTLY-REINGEST-TOP-CH-CARDS (Drew, 2026-08-01).
//
// Fills the ingest gap on low-volume-per-day cards where CH's
// snapshot (max 100 sales per call) IS the truth AND our accumulated
// pool sits below it. The 2026-08-01 audit showed:
//   - Cards >100 sales/90d: our pool is 2-5× ahead of CH's snapshot
//     (we accumulate over time; CH caps per-call)
//   - Cards <100 sales/90d: we have real 20-70% gaps (Trout PSA 10:
//     -22%, Ohtani 2018 PSA 10: -72%)
//
// This script iterates our top-N most-viewed CH cardIds, fetches
// CH's fresh full-100 comp window per grade tier, and upserts any
// row we don't already have. Vendor-agnostic downstream (sold_comps
// dedup is by cardId + contentHash, not source).
//
// Env:
//   COSMOS_CONNECTION_STRING     required
//   CARD_HEDGE_API_KEY           required
//   TOP_N                        default 1000  (top cardIds by 90d activity)
//   GRADES                       default "Raw,PSA 10,PSA 9,BGS 9.5"  (comma-separated)
//   BACKFILL_APPLY               true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES         per-slice cap (default 25)

const { CosmosClient } = require("@azure/cosmos");

const CH_KEY = process.env.CARD_HEDGE_API_KEY;
const CH_BASE = "https://api.cardhedger.com/v1";
if (!CH_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(1); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const nodePath = require("node:path");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(nodePath.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const TOP_N = Math.max(10, Number(process.env.TOP_N || 1000));
const GRADES = String(process.env.GRADES || "Raw,PSA 10,PSA 9,BGS 9.5").split(",").map(s => s.trim()).filter(Boolean);

const CH_HEAD = { "X-API-Key": CH_KEY, "Content-Type": "application/json" };

// -- THE CLOCK --------------------------------------------------------------
//
// THIS LANE WAS NOT UNCLOCKED -- IT WAS CLOCKED WRONG, the same distinction the
// wave-2 census (#1951) made for five others. It carried a LOCAL
// `BACKFILL_MAX_MINUTES` (default 25) read by `timeExpired()` at the loop TOP
// -- reserving nothing for the card already in flight, which is a whole
// GRADES-wide fan of network calls -- and signalled continuation with
// `RELAUNCH_NEEDED=true|false` rather than the marker.
//
// THAT PROTOCOL HAS TWO ARMS AND NO THIRD: `true` re-dispatches, `false` stops,
// and ANYTHING ELSE -- including the empty string a KILLED step leaves, because
// a killed step prints no line at all -- reaches a `::warning::` that does NOT
// fail the job, so a lane killed at the 150-minute ceiling went GREEN with its
// work half done. Taking the shared clock and the marker puts this lane inside
// relaunchNeverCallsAKilledRunFinished's population, and it is REMOVED from the
// RELAUNCH_NEEDED gate rather than left on both.
//
// THE UNIT IS ONE CARD, and it is the largest unit on this wave's list: for
// each cardId the lane runs one partition query for existing hashes and then
// ONE CARDHEDGE HTTP CALL PER GRADE (four by default). A vendor API is not a
// database -- a slow or retrying host can hold a single card for tens of
// seconds with no throttle signal we control -- so the reserve is sized to a
// whole card's fan rather than to a page: 180 seconds, checked BEFORE the card
// is entered.
//
// A PARTIAL PASS CANNOT PRODUCE A WRONG WRITE: each card is compared against
// its OWN existing contentHash set, and the top-N ranking is read from the
// activity scan before any card is touched. A stop costs coverage, never
// correctness.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 3 + 1 + 1 = 115m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 180 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function chComps(cardId, grade, count) {
  try {
    const res = await fetch(`${CH_BASE}/cards/comps`, {
      method: "POST",
      headers: CH_HEAD,
      body: JSON.stringify({ card_id: cardId, count, grade, include_raw_prices: true }),
    });
    if (!res.ok) return { sales: [], error: `HTTP ${res.status}` };
    const body = await res.json();
    return { sales: Array.isArray(body?.raw_prices) ? body.raw_prices : [] };
  } catch (e) { return { sales: [], error: e.message }; }
}

function contentHashOf(price, soldAt, title, source) {
  const s = `${price}|${String(soldAt).slice(0, 10)}|${(title || "").slice(0, 50)}|${source || "cardhedge"}`;
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[nightly-reingest-top-ch-cards]  apply=${APPLY}  top-N=${TOP_N}  grades=[${GRADES.join(", ")}]`);
  console.log(`  ${CLOCK.describe()}`);

  // Step 1: find top-N cardIds by recent sold_comps activity
  const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  console.log("\nFinding top cardIds by 30d activity...");
  const query = "SELECT c.cardId, COUNT(1) as n FROM c WHERE c.source = 'cardhedge' AND c.soldAt >= @from AND IS_DEFINED(c.cardId) GROUP BY c.cardId";
  const iter = sc.items.query({ query, parameters: [{ name: "@from", value: cutoff30 }] }, { maxItemCount: 5000 });
  const activity = new Map();
  let scanStoppedAtBudget = false;
  while (iter.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is read.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) if (r.cardId && r.n) activity.set(r.cardId, r.n);
  }
  const topCards = [...activity.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([cid, n]) => ({ cardId: cid, activity: n }));
  console.log(`  distinct cardIds seen: ${activity.size}`);
  console.log(`  processing top: ${topCards.length}`);
  if (scanStoppedAtBudget) {
    // NOT a refusal. The ranking is a means of ORDERING work, not a statistic
    // anything is written from: a partial activity map yields a top-N drawn
    // from fewer candidates, so the pass measures the gap on a smaller and
    // possibly less active set of cards. That is coverage, and the relaunch
    // re-runs the scan from the top with a full clock.
    console.log(`  the activity scan was CUT SHORT by the budget, so this top-${TOP_N} is drawn`
      + ` from ${activity.size} candidates rather than the whole 30-day window.`);
  }

  // Step 2: for each cardId × grade, fetch CH's fresh 100-comp window
  const seenHashes = new Map();  // per (cardId, grade) — hashes we've already probed for
  const stats = { chCallsMade: 0, salesReturned: 0, newInserts: 0, alreadyHad: 0, errors: 0 };
  let cardsStoppedAtBudget = false;
  let cardsNotReached = 0;

  for (const [i, { cardId, activity: act }] of topCards.entries()) {
    // THE PRE-CHECK, before the card is entered. One card is a partition query
    // plus one CardHedge HTTP call per grade -- see THE CLOCK above for why the
    // reserve is sized to that fan rather than to a page.
    if (CLOCK.outOfClock()) {
      cardsStoppedAtBudget = true;
      cardsNotReached = topCards.length - i;
      console.log(`  budget reached at card ${i}/${topCards.length}`);
      break;
    }

    // Pre-load our existing hashes for this cardId (last 90d)
    const cutoff90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const existing = new Set();
    try {
      const { resources } = await sc.items.query({
        query: "SELECT c.contentHash FROM c WHERE c.cardId = @cid AND c.soldAt >= @from",
        parameters: [{ name: "@cid", value: cardId }, { name: "@from", value: cutoff90 }],
      }).fetchAll();
      for (const r of resources) if (r.contentHash) existing.add(r.contentHash);
    } catch {}

    for (const grade of GRADES) {
      const { sales, error } = await chComps(cardId, grade, 100);
      stats.chCallsMade++;
      if (error) { stats.errors++; continue; }
      if (!sales.length) continue;
      stats.salesReturned += sales.length;

      for (const s of sales) {
        const price = Number(s.price);
        const soldAt = s.sale_date;
        if (!Number.isFinite(price) || price <= 0 || !soldAt) continue;
        const contentHash = contentHashOf(price, soldAt, s.title, s.price_source);
        if (existing.has(contentHash)) { stats.alreadyHad++; continue; }
        stats.newInserts++;
        if (!APPLY) continue;
        // Real insert would go through the persistVendorSalesToPool
        // service. This dry-run script only COUNTS the gap. The
        // fix action is: (a) let ordinary user-search traffic
        // accumulate at count=100 (already deployed via
        // cardhedgeVendorSource change), or (b) build a proper
        // backfill worker that calls the persist service.
      }
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  card ${i + 1}/${topCards.length}  chCalls=${stats.chCallsMade}  new=${stats.newInserts}  had=${stats.alreadyHad}  errors=${stats.errors}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  CH calls made:        ${stats.chCallsMade}`);
  console.log(`  Sales returned:       ${stats.salesReturned}`);
  console.log(`  Already had (dedup):  ${stats.alreadyHad}`);
  console.log(`  New (gap):            ${stats.newInserts}`);
  console.log(`  Errors:               ${stats.errors}`);
  const gapPct = stats.salesReturned === 0 ? 0 : Math.round(stats.newInserts / stats.salesReturned * 100);
  console.log(`  Gap %:                ${gapPct}%`);
  console.log(`  Cards not reached:    ${cardsNotReached}`);
  if (!APPLY) console.log(`\n  (dry-run only — reports gap; does not write)`);

  // RECONCILE HONESTLY: THIS LANE WRITES NOTHING, AND SAYS SO.
  //
  // The APPLY branch in the loop is a `continue` under a comment -- "Real
  // insert would go through the persistVendorSalesToPool service" -- so the
  // gate is present, the count is real, and the write is NOT IMPLEMENTED. The
  // reconciliation states exactly that rather than reporting `newInserts` as
  // written, which would be the shape of a lane claiming writes it never made
  // (feedback: verify OUTPUT, not existence). `intended` is 0 because nothing
  // was ever intended to land; the gap count is reported alongside it as the
  // measurement it actually is.
  if (APPLY) {
    console.log(`  reconciled: intended 0 = written 0 + failed 0`
      + `  -- this lane MEASURES the gap (${stats.newInserts} rows) and does not write it;`
      + ` the insert path is a documented TODO through persistVendorSalesToPool.`);
    reportWrites({
      job: "nightly-reingest-top-ch-cards",
      intended: 0, written: 0, skipped: 0, failed: 0,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, and it REPLACES the
  // `RELAUNCH_NEEDED=` line this lane used to print -- see THE CLOCK above for
  // why that protocol could not tell a budget stop from a kill. The lane is
  // removed from the RELAUNCH_NEEDED gate in backfill-runner.yml in the same
  // change; printing both would double-dispatch every stop.
  if (cardsStoppedAtBudget || scanStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this pass is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation re-runs the activity scan and re-walks the top-N from the top."
      + " Nothing is written, so a re-read costs CardHedge calls and no duplicate rows: each"
      + " card's comps are compared against its own existing contentHash set.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
