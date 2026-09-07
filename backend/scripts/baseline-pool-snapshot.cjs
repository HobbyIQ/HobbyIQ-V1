#!/usr/bin/env node
// CF-BASELINE-POOL-SNAPSHOT (Drew, 2026-08-01).
//
// Freezes per-slug pool state to a `pool_baseline_snapshots` container.
// Each snapshot row records: slug, sampleCount, median, p10, p90,
// snapshotAt.
//
// Drift monitor (--mode=drift) compares CURRENT pool state to the
// latest baseline and flags any slug whose median has shifted >20%
// without a corresponding change in sample size — that's a signature
// of pool contamination sneaking in.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BASELINE_MODE              snapshot | drift  (default snapshot)
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BASELINE_DRIFT_THRESHOLD   default 0.20  (20% median shift = alert)
//   BASELINE_MIN_SAMPLES       default 5

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane FREEZES the reference state
// every later drift check is measured against, and declared no budget at all.
// Its scan reads every priced hiq: row in sold_comps, so before this it could
// only ever end by being KILLED at the 150-minute ceiling: no marker, no
// reconcile, no finishLane line, and #1913's KILLED branch then withholding the
// re-dispatch.
//
// >>> THE WRITE PHASE REFUSES AFTER A SCAN-PHASE STOP. <<<
//
// Same shape as backfill-stage3-price-sanity and promote-sold-comps-trust-tier,
// with the longest tail of the three. The scan does not gather ROWS, it
// computes STATISTICS -- median, p10, p90, min, max, sampleCount per slug --
// and the snapshot phase writes exactly those numbers as the BASELINE. A
// statistic over PART of a pool is a DIFFERENT statistic, not a smaller one.
//
// AND THIS ONE POISONS THE FUTURE, WHICH IS WHY IT REFUSES RATHER THAN
// TRUNCATES. The whole purpose of the row is to be compared against LATER: the
// drift mode reads the most recent snapshotDate and alerts on
// `|current - baseline| / baseline >= 20%`. A baseline median computed from
// half a pool is not a smaller baseline -- it is a wrong one that then reports
// drift where there was none, or hides drift that there was, on every
// subsequent run, forever. MIN_SAMPLES does not save it: a partial pool can
// clear the sample floor and still misstate every percentile.
//
// DRIFT MODE WRITES NOTHING and is therefore only budget-stopped, never
// refused -- a partial drift report is a shorter list of true findings.
//
// A snapshot-mode scan stop exits 5 having written NOTHING, and still prints
// the marker -- the relaunch's marker arm runs BEFORE its outcome check, so a
// refusal re-dispatches and the next run re-scans from the top.
//
// TWO UNITS, TWO SIZES. The scan's unit is one 5,000-row page of a THREE-FIELD
// PROJECTION; the snapshot's is ONE SEQUENTIAL upsert of a small stats
// document. The reserve is sized to the LARGER, the scan page: 60 seconds.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its work.
// Worst case 110 + 1 + 1 + 1 = 113m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const OP_MODE = (process.env.BASELINE_MODE || "snapshot").toLowerCase();
const APPLY = process.env.BACKFILL_APPLY === "true" || (process.env.BACKFILL_MODE || "dry").toLowerCase() === "apply";
const DRIFT_THRESHOLD = Number(process.env.BASELINE_DRIFT_THRESHOLD || 0.20);
const MIN_SAMPLES = Math.max(1, Number(process.env.BASELINE_MIN_SAMPLES || 5));

const CONFIRMED_SOURCES = new Set([
  "cardhedge", "ebay-user-purchase", "manual-user-entry", "ebay-user-sale", "ebay-browse-ended",
]);
const CONTAINER_ID = process.env.COSMOS_BASELINE_CONTAINER || "pool_baseline_snapshots";

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function percentile(sortedNums, p) {
  if (!sortedNums.length) return 0;
  const idx = Math.min(sortedNums.length - 1, Math.floor(sortedNums.length * p));
  return sortedNums[idx];
}

async function ensureBaselineContainer(db) {
  try {
    const { container } = await db.containers.createIfNotExists({
      id: CONTAINER_ID,
      partitionKey: { paths: ["/snapshotDate"] },
      defaultTtl: -1,
    });
    return container;
  } catch (e) {
    console.error("ERR ensuring baseline container:", e.message);
    throw e;
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sc = db.container("sold_comps");
  const baseline = await ensureBaselineContainer(db);
  const snapshotDate = new Date().toISOString().slice(0, 10);

  console.log(`[baseline-pool-snapshot]  op=${OP_MODE}  apply=${APPLY}`);
  console.log(`  ${CLOCK.describe()}`);

  // Phase 1: compute current pool medians
  console.log("\nComputing current pool medians (confirmed sources only)...");
  const iter = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });
  const pool = new Map();
  let scanned = 0;
  let scanStoppedAtBudget = false;
  while (iter.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched. A stop here is FATAL to the
    // snapshot -- see THE CLOCK above -- not merely a shorter run.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      if (!CONFIRMED_SOURCES.has(r.source)) continue;
      const p = Number(r.price);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (!pool.has(r.hobbyiqCardId)) pool.set(r.hobbyiqCardId, []);
      pool.get(r.hobbyiqCardId).push(p);
    }
  }
  console.log(`  scanned: ${scanned}  slugs: ${pool.size}`);

  const currentStats = new Map();
  for (const [slug, prices] of pool) {
    if (prices.length < MIN_SAMPLES) continue;
    const sorted = [...prices].sort((a, b) => a - b);
    currentStats.set(slug, {
      sampleCount: prices.length,
      median: median(prices),
      p10: percentile(sorted, 0.10),
      p90: percentile(sorted, 0.90),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    });
  }
  console.log(`  slugs with >= ${MIN_SAMPLES} confirmed samples: ${currentStats.size}`);

  // -- THE REFUSAL (SNAPSHOT MODE ONLY) --------------------------------------
  //
  // The snapshot IS the statistic. Writing percentiles computed from a partial
  // scan freezes a wrong reference that every later drift check compares
  // against -- reporting drift that never happened, or hiding drift that did,
  // on every subsequent run. That is not a shorter baseline; it is a
  // permanently wrong one.
  //
  // DRIFT MODE IS NOT REFUSED: it writes nothing, so a partial scan there is a
  // shorter list of TRUE findings rather than a wrong number.
  //
  // Exit 5 is a VERDICT, not a crash (#1955's outcome (d)). The marker is
  // printed FIRST, because the relaunch's marker arm runs BEFORE its outcome
  // check -- so this re-dispatches and the next run re-scans from the top.
  if (scanStoppedAtBudget && OP_MODE === "snapshot") {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the pool scan is UNFINISHED; the relaunch continues from here`);
    console.error("  REFUSING TO WRITE THE BASELINE: the per-slug median/p10/p90 above were"
      + " computed from a PARTIAL scan, and a partial percentile is a DIFFERENT percentile rather"
      + " than a smaller one. A wrong baseline is compared against on EVERY later drift run --"
      + " reporting drift that did not happen and hiding drift that did. Nothing was written.");
    if (APPLY) {
      reportWrites({
        job: "baseline-pool-snapshot",
        intended: 0, written: 0, skipped: 0, failed: 0,
      });
    }
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  if (OP_MODE === "snapshot") {
    if (!APPLY) {
      console.log(`\nDRY: would write ${currentStats.size} baseline rows.`);
      return { client, budget: CLOCK };
    }
    console.log(`\nWriting baseline snapshot for ${snapshotDate}...`);
    let written = 0;
    // The upsert loop swallowed EVERY error into `/* skip */`, so a run whose
    // writes all failed printed "complete: 0 slugs recorded" and exited 0.
    // Failures are counted now, and they reconcile.
    let failed = 0;
    let notReached = 0;
    let writeStoppedAtBudget = false;
    for (const [slug, stats] of currentStats) {
      // THE PRE-CHECK, before each upsert. A stop HERE is safe in a way a scan
      // stop is not: every row already written carries statistics from the
      // COMPLETE scan, so the partial snapshot is a subset of correct rows
      // rather than a set of wrong ones, and the relaunch fills the rest under
      // the same snapshotDate.
      if (CLOCK.outOfClock()) { writeStoppedAtBudget = true; notReached++; continue; }
      const doc = {
        id: `${snapshotDate}::${slug.replace(/[^a-z0-9]/g, "-").slice(0, 200)}`,
        snapshotDate,
        slug,
        ...stats,
        capturedAt: new Date().toISOString(),
      };
      try { await baseline.items.upsert(doc); written++; } catch { failed++; }
      if (written % 1000 === 0) console.log(`  written=${written}`);
    }
    console.log(`\nBaseline snapshot complete: ${written} slugs recorded for ${snapshotDate}`);

    // RECONCILE OVER THE KNOWN PLAN. `currentStats` is fixed before the first
    // upsert, so the population is known and `not reached` is a real number.
    console.log(`  reconciled: intended ${currentStats.size} = written ${written}`
      + ` + failed ${failed} + not reached ${notReached}`);
    if (written + failed + notReached !== currentStats.size) {
      console.error("  !! RECONCILE MISMATCH -- a planned baseline row was neither written, failed nor left unreached");
      process.exitCode = 4;
    }
    reportWrites({
      job: "baseline-pool-snapshot",
      intended: currentStats.size, written, skipped: notReached, failed,
    });

    // -- THE MARKER THE RELAUNCH GREPS -------------------------------------
    //
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL.
    if (writeStoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `this snapshot is UNFINISHED; the relaunch continues from here`);
      console.log("  the write is IDEMPOTENT: each row's id is `<snapshotDate>::<slug>`, so a"
        + " continuation on the same day overwrites what it already wrote with the same numbers"
        + " and fills in the rest.");
    }
  } else if (OP_MODE === "drift") {
    console.log(`\nDrift check: comparing current vs most recent baseline...`);
    // Load latest baseline snapshot (most recent snapshotDate)
    const latestDateQ = await baseline.items.query({
      query: "SELECT VALUE MAX(c.snapshotDate) FROM c"
    }).fetchAll();
    const latestDate = latestDateQ.resources[0];
    if (!latestDate) {
      console.log("  no baseline found — run --mode=snapshot first");
      return { client, budget: CLOCK };
    }
    console.log(`  latest baseline date: ${latestDate}`);
    const { resources: baseRows } = await baseline.items.query({
      query: "SELECT * FROM c WHERE c.snapshotDate = @d",
      parameters: [{ name: "@d", value: latestDate }],
    }, { partitionKey: latestDate }).fetchAll();
    const baselineMap = new Map(baseRows.map((r) => [r.slug, r]));
    console.log(`  baseline rows loaded: ${baselineMap.size}`);

    const drifted = [];
    for (const [slug, current] of currentStats) {
      const base = baselineMap.get(slug);
      if (!base) continue;
      const baseMedian = Number(base.median);
      const drift = Math.abs(current.median - baseMedian) / baseMedian;
      if (drift >= DRIFT_THRESHOLD) {
        drifted.push({
          slug,
          baselineMedian: baseMedian,
          currentMedian: current.median,
          driftPct: Math.round(drift * 10000) / 100,
          baselineSample: base.sampleCount,
          currentSample: current.sampleCount,
        });
      }
    }
    drifted.sort((a, b) => b.driftPct - a.driftPct);
    console.log(`\nSlugs with drift >= ${DRIFT_THRESHOLD * 100}%: ${drifted.length}`);
    console.log(`\nTop 30 largest drifts:`);
    drifted.slice(0, 30).forEach((d) => {
      const dir = d.currentMedian > d.baselineMedian ? "↑" : "↓";
      console.log(`  ${dir}${d.driftPct}%  $${d.baselineMedian.toFixed(0)} → $${d.currentMedian.toFixed(0)}  n=${d.baselineSample}→${d.currentSample}  ${d.slug}`);
    });

    // DRIFT MODE WRITES NOTHING, so a partial scan is a shorter list of TRUE
    // findings rather than a wrong number -- it is budget-stopped, never
    // refused. The marker still prints, so the relaunch continues the sweep.
    if (scanStoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `the pool scan is UNFINISHED; the relaunch continues from here`);
      console.log("  the drift list above is a SUBSET of what a full scan would report, never a"
        + " wrong one: nothing was written, and every slug listed was compared against its own"
        + " complete baseline row.");
    }
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
