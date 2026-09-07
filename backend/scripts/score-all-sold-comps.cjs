#!/usr/bin/env node
// CF-SCORE-ALL-SOLD-COMPS (Drew, 2026-08-02).
//
// Retroactive confidence scoring on ALL sold_comps rows that don't
// carry __confidenceScore. Uses the current learned weights (from
// confidence_weights container). Idempotent — skips rows already
// scored. Writes the score + band + signals back to the row.
//
// Result: coverage jumps from 5.2% → 100% of the 3.5M pool. Every
// row carries an explicit confidence band that downstream can use
// for filtering, weighting, or display.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   RUN_MINUTES                work-loop budget (default 110); RESERVE_MS and
//                              VERIFY_MS override the unit reserve and the
//                              post-loop verify cap. BACKFILL_MAX_MINUTES is
//                              GONE -- it capped at the loop top, reserved
//                              nothing, and signalled through RELAUNCH_NEEDED.
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

let scoreRow;
try {
  ({ scoreRow } = require("../dist/services/portfolioiq/confidenceScore.service.js"));
} catch (e) {
  console.error("Cannot import scoreRow from dist — build backend first");
  console.error(e.message); process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

// -- THE CLOCK, AND WHAT IT REPLACES ----------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane stamps a confidence score
// and band onto EVERY sold_comps row -- the header states the intent as "5.2%
// -> 100% of the 3.5M pool" -- so its scope is the whole container by design.
//
// IT WAS NOT UNCLOCKED. IT WAS CLOCKED WRONG, the same class #1951 found five
// of and #1970 two more. It carried a LOCAL `BACKFILL_MAX_MINUTES` (default 25)
// with a `timeExpired()` test at the loop TOP -- reserving nothing for the page
// of 200 rows already in flight -- and signalled continuation by printing
// `RELAUNCH_NEEDED=true|false` rather than the marker.
//
// THAT PROTOCOL HAS TWO ARMS AND NO THIRD. The runner "Self-relaunch catalog
// expansion" step re-dispatches on `true`, stops on `false`, and sends
// ANYTHING ELSE -- including the empty string a KILLED step leaves, because a
// killed step prints no line at all -- to a `::warning::` that does NOT fail
// the job. So a run killed at the 150-minute ceiling went GREEN with a third
// of the pool unscored, and relaunchNeverCallsAKilledRunFinished.test.ts was
// not looking, because its population is the MARKER-keyed steps. The lane is
// moved onto the marker and off that gate here, not left on both -- two steps
// reacting to one stop would re-dispatch it twice.
//
// >>> A PARTIAL RUN HERE IS SHORTER, NOT WRONG. <<<
//
// Each row is scored from its own fields plus its OWN slug pool median, and
// the query selects only rows with no __confidenceScore. Nothing is derived
// across the rows this run happened to see, so a stop plans fewer scores and
// the next run finds the unscored remainder. No refusal is owed.
//
// THE UNIT IS ONE 200-ROW PAGE drained through a CONCURRENCY-wide (default 8)
// window, where each row may cost a `TOP 20` pool query -- cached per slug, so
// the worst page is one whose 200 rows are 200 DISTINCT slugs. 90 seconds
// covers that.
//
// VERIFY_MS is nominal: this lane reads nothing after its loop.
// Worst case 110 + 1.5 + 1 + 1 + 1 = 114.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[score-all-sold-comps] apply=${APPLY} concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  // Only rows that haven't been scored yet
  const query = "SELECT * FROM c WHERE NOT IS_DEFINED(c.__confidenceScore) " +
                "AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null " +
                "AND c.price > 0";
  const iter = sc.items.query({ query }, { maxItemCount: 200 });

  // Pool-median cache: slug -> {median, sampleCount}. Query once per
  // slug per slice; many rows share the same slug so the cache saves
  // a huge number of pool queries.
  const poolCache = new Map();
  async function getPool(slug) {
    if (poolCache.has(slug)) return poolCache.get(slug);
    try {
      const { resources } = await sc.items.query({
        query: "SELECT TOP 20 c.price FROM c WHERE c.hobbyiqCardId = @slug ORDER BY c.soldAt DESC",
        parameters: [{ name: "@slug", value: slug }],
      }).fetchAll();
      const prices = (resources || []).map(r => Number(r.price)).filter(p => Number.isFinite(p) && p > 0);
      if (prices.length === 0) { poolCache.set(slug, { median: null, sampleCount: 0 }); return { median: null, sampleCount: 0 }; }
      const sorted = [...prices].sort((a, b) => a - b);
      const val = { median: sorted[Math.floor(sorted.length / 2)], sampleCount: prices.length };
      poolCache.set(slug, val);
      return val;
    } catch { poolCache.set(slug, { median: null, sampleCount: 0 }); return { median: null, sampleCount: 0 }; }
  }

  // `scored` counted a SCORE COMPUTED, never a write that landed: the upsert
  // was awaited inside a try whose catch only incremented `errors`, so a run
  // printed `scored: N` and said nothing about how many of those N reached the
  // container. `written` is the real success counter, incremented on the line
  // after the upsert resolves.
  const stats = { scanned: 0, scored: 0, written: 0, errors: 0, bands: { autoTrust: 0, flagReview: 0, quarantine: 0, reject: 0 } };
  const inFlight = [];

  async function processRow(row) {
    try {
      const { median, sampleCount } = await getPool(row.hobbyiqCardId);
      const result = await scoreRow({
        row,
        poolMedian: median,
        poolSampleCount: sampleCount,
        catalogHasCanonicalForCardnumberYear: true,
        catalogAgreesOnSet: true,
        sellerBadActorScore: 0,
      });
      if (result.band === "auto-trust") stats.bands.autoTrust++;
      else if (result.band === "flag-review") stats.bands.flagReview++;
      else if (result.band === "quarantine") stats.bands.quarantine++;
      else stats.bands.reject++;
      stats.scored++;
      if (APPLY) {
        row.__confidenceScore = result.score;
        row.__confidenceBand = result.band;
        row.__confidenceScoredAt = new Date().toISOString();
        await withRetry(() => sc.items.upsert(row));
        stats.written++;
      }
    } catch { stats.errors++; }
  }

  let stoppedAtBudget = false;
  while (iter.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after its 200 rows
    // have each been pool-queried and upserted. A stop here is safe: the query
    // excludes rows that already carry __confidenceScore, so nothing this pass
    // wrote is ever re-read.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      stats.scanned++;
      inFlight.push(processRow(row).catch(() => { stats.errors++; }));
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
      if (stats.scanned % 2000 === 0) {
        console.log(`  scanned=${stats.scanned} scored=${stats.scored} written=${stats.written} err=${stats.errors} bands: hi=${stats.bands.autoTrust} mid=${stats.bands.flagReview} lo=${stats.bands.quarantine} rej=${stats.bands.reject} poolCache=${poolCache.size}`);
      }
      // The INNER check stops mid-page, so the reserve is not the whole page
      // once the outer one has already admitted it.
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    }
    if (stoppedAtBudget) break;
  }
  // Every row already dispatched is drained before the counts are reported --
  // reconciling over work still in flight is how a banner balances on numbers
  // that are still moving.
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:      ${stats.scanned}`);
  console.log(`  scored:       ${stats.scored}`);
  if (APPLY) console.log(`  written:      ${stats.written}`);
  console.log(`  errors:       ${stats.errors}`);
  console.log(`  pool cache:   ${poolCache.size} distinct slugs`);
  console.log(`  bands:`);
  console.log(`    auto-trust (>=.85):  ${stats.bands.autoTrust}`);
  console.log(`    flag-review (.60-.85): ${stats.bands.flagReview}`);
  console.log(`    quarantine (.40-.60):  ${stats.bands.quarantine}`);
  console.log(`    reject (<.40):        ${stats.bands.reject}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);

  // RECONCILE OVER WHAT THIS RUN SAW. This lane DISCOVERS its work page by
  // page, so there is no denominator for the rows the budget did not reach and
  // no honest "not reached" count to report: it reconciles the three-term way
  // over the rows it scanned (a slice is not a sibling counter). `scanned`
  // splits exactly into scored-and-written, failed, and -- when APPLY is off --
  // scored-but-deliberately-unwritten.
  if (APPLY) {
    const notWritten = Math.max(0, stats.scanned - stats.written - stats.errors);
    console.log(`  reconciled: intended ${stats.scanned} = written ${stats.written} + skipped ${notWritten} + failed ${stats.errors}`);
    if (stats.written + notWritten + stats.errors !== stats.scanned) {
      console.error("  !! RECONCILE MISMATCH -- a scanned row was neither written, skipped nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "score-all-sold-comps",
      intended: stats.scanned, written: stats.written, skipped: notWritten, failed: stats.errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables. This REPLACES the `RELAUNCH_NEEDED=<bool>` line, whose third
  // arm went green on a kill -- see THE CLOCK above.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass wrote: the scan selects only rows"
      + " with NO __confidenceScore, so a scored row drops out of the population entirely.");
  }
  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
//
// AND A FATAL IS NO LONGER SWALLOWED INTO A GREEN RUN. The old tail was
// `.catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); })`
// -- a crash printed a re-dispatch request and exited ZERO, so the step went
// green, the job went green, and the only evidence was a stack trace nobody
// was told to look for. It exits 1 through finishLane now, which the relaunch
// reads as outcome (d): a verdict, re-dispatch withheld, chain red.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
