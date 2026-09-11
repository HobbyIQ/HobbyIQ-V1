#!/usr/bin/env node
// CF-CLEANLINESS-ANOMALY-BUDGET (Drew / triage, 2026-09-11).
//
// detectAnomalies({force:true}) (services/portfolioiq/anomalyDetection
// .service.ts) walks the WHOLE sold_comps container in one unbounded
// cross-partition query -- no paging cap, no wall-clock budget of its own,
// unlike its sibling baseline-pool-snapshot.cjs. nightly-cleanliness.yml's
// forced rescan (?force=true, dispatched via longJobTracker + polled by
// poll-admin-job.cjs) has gone two nights straight (09-10, 09-11) without a
// single terminal answer inside the poller's 1,501s ceiling -- the "~30s"
// comment that used to justify skipping a budget was stale (sold_comps has
// grown well past the row count that estimate was based on) and is now
// removed from that file. #1809/#1799/#1361's own lesson applies here
// unchanged: a killed job cannot report progress, so the scan has to become a
// bounded, resumable lane instead of a bigger timeout.
//
// THIS LANE replaces the HTTP dispatch with a backfill-runner lane that scans
// sold_comps by (cardYear, sportClass) UNIT -- scripts/lib/anomaly-scan-units
// .cjs, the same composite axis rematch-sold-comps.cjs measured and
// documented -- persisting a cursor in crawl_state so a budget stop resumes
// from the next unit rather than restarting the whole container walk.
//
// THE STATISTIC IS THE REPORT, SO A PARTIAL SCAN REFUSES TO PUBLISH ONE.
// Same doctrine as baseline-pool-snapshot.cjs and promote-sold-comps-trust-
// tier.cjs: the anomaly report's driftPct per slug is computed from the
// CURRENT median across the WHOLE pool, so a report built from part of the
// pool is a DIFFERENT report, not a smaller one -- it would report drift that
// never happened or hide drift that did, on the one night ops actually reads
// it. So a scan-phase budget stop writes NOTHING to the final report, only
// advances the cursor, and exits 5 (a refusal, not a failure) so the runner's
// relaunch-on-marker composite re-dispatches with a full clock and the lane
// resumes from the unit it stopped at. Only a run that finishes EVERY unit in
// one continuous chain of dispatches computes and writes the report.
//
// THE CACHED (non-force) /cleanliness/anomalies PATH IS UNTOUCHED. This lane
// does not import, call, or otherwise change anomalyDetection.service.ts --
// the admin dashboard's 5-minute in-process cache keeps working exactly as
// before. This lane writes its OWN durable artifact (anomaly_scan_reports,
// keyed by scanDate) that nightly-cleanliness.yml reads directly instead of
// polling the HTTP endpoint.
//
// Env: COSMOS_CONNECTION_STRING   required
//      BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry) -- APPLY
//                                        writes the cursor AND, on a full
//                                        sweep, the final report; a dry run
//                                        computes and prints but writes
//                                        nothing (report-first, like every
//                                        other lane on this runner).
//      RUN_MINUTES=110             budget; prints the marker when units
//                                   remain, exactly as baseline-pool-snapshot
//                                   .cjs's scan phase does.
//
// THE THREE CONSTANTS. One unit's worst case, measured against
// data/rematch-shard-table.json (2026-09-01 GROUP BY over the live pool): the
// largest single (cardYear, sportClass) unit is 2025 pokemon at 484,940 raw
// rows. This lane's predicate is narrower (STARTSWITH hiq: + defined price),
// so the true read is smaller, but the reserve is sized to the PAGE, not the
// unit -- exactly like baseline-pool-snapshot.cjs's scan phase -- because
// every unit's read loop checks outOfClock() before EACH 5,000-row page, not
// only between units. A unit that is still in flight when the budget expires
// is abandoned mid-unit (nothing written for it), and the NEXT run re-reads
// that same unit from its own start -- safe, because the read is pure
// accumulation into an in-memory per-slug array, never a write.
// RESERVE_MS = 60s (one page). VERIFY_MS is nominal: this lane reads nothing
// after its own work. Worst case 110 + 1 + 1 + 1(startup) = 113m under the
// 150m ceiling -- the same arithmetic baseline-pool-snapshot.cjs carries.
"use strict";

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const {
  enumerateUnits, unitQuery,
} = require(path.join(__dirname, "lib", "anomaly-scan-units.cjs"));

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const APPLY = process.env.BACKFILL_APPLY === "true" || (process.env.BACKFILL_MODE || "dry").toLowerCase() === "apply";
const PAGE_SIZE = Number(process.env.ANOMALY_SCAN_PAGE_SIZE || 5000);

// Same vocabulary detectAnomalies() itself uses -- not re-derived.
const DRIFT_THRESHOLD = 0.30;
const MIN_BASELINE_SAMPLES = 5;
const HIGH_SUSPICIOUS_THRESHOLD = 0.50;
const CONFIRMED_SOURCES = new Set([
  "cardhedge", "ebay-user-purchase", "manual-user-entry", "ebay-user-sale", "ebay-account", "ebay-browse-ended",
]);

const CONTROL_CONTAINER = process.env.CONTROL_CONTAINER || "crawl_state";
const BASELINE_CONTAINER = process.env.COSMOS_BASELINE_CONTAINER || "pool_baseline_snapshots";
const REPORT_CONTAINER = process.env.ANOMALY_REPORT_CONTAINER || "anomaly_scan_reports";

// ── THE CURSOR ───────────────────────────────────────────────────────────
//
// One control doc, id-partitioned like every other crawl_state row
// (tca-firehose-ingest.cjs, ingest-universe-driver.cjs). CURSOR_ID is a
// SOURCE LITERAL -- a run whose cursor id drifted from the id the next
// dispatch reads would resume from nothing and re-scan from unit 0, silently
// discarding every unit already recorded, which is the resumability defect
// this whole lane exists to prevent.
const CURSOR_ID = "anomaly-force-scan::cursor";

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function readCursor(control) {
  try {
    const { resource } = await control.item(CURSOR_ID, CURSOR_ID).read();
    return resource || null;
  } catch (e) {
    if (e.code === 404) return null;
    throw e;
  }
}

/**
 * Persist progress. `pool` is serialised as [slug, prices[]] pairs so a
 * resumed run can pick the accumulator back up rather than re-merge from
 * empty -- a stop mid-sweep must not forget the units it already scanned.
 */
async function writeCursor(control, { nextUnitIndex, totalUnits, scanDate, pool }) {
  const doc = {
    id: CURSOR_ID,
    docType: "anomaly_scan_cursor",
    scanDate,
    nextUnitIndex,
    totalUnits,
    // A cursor from an EARLIER scanDate is stale -- the pool has moved on and
    // a resumed sweep must start over rather than splice yesterday's partial
    // accumulation onto today's. The lane checks this before trusting a read
    // cursor; it is recorded here purely so an operator reading the doc can
    // see when it was last written without a second query.
    updatedAt: new Date().toISOString(),
    poolSnapshot: Array.from(pool.entries()),
  };
  await control.items.upsert(doc);
  return doc;
}

async function clearCursor(control) {
  try {
    await control.item(CURSOR_ID, CURSOR_ID).delete();
  } catch (e) {
    if (e.code !== 404) throw e;
  }
}

/**
 * anomaly_scan_reports does not already exist (unlike crawl_state and
 * pool_baseline_snapshots, which every other lane's prior runs already
 * created) -- CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS's own lesson does not
 * excuse skipping createIfNotExists just because baseline-pool-snapshot.cjs
 * (this lane's reference implementation) never needed to call it for a
 * container that already existed.
 *
 * Partition key is /id: one doc per scanDate, id `<scanDate>::anomaly-scan-
 * report`, read back with a plain item(id, id) -- check-anomaly-scan-report
 * .cjs assumes exactly this shape.
 */
async function ensureReportContainer(db) {
  const { container } = await db.containers.createIfNotExists({
    id: REPORT_CONTAINER,
    partitionKey: { paths: ["/id"] },
    defaultTtl: -1,
  });
  return container;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sc = db.container("sold_comps");
  const control = db.container(CONTROL_CONTAINER);
  const baseline = db.container(BASELINE_CONTAINER);
  const scanDate = new Date().toISOString().slice(0, 10);

  console.log(`[anomaly-force-scan]  apply=${APPLY}  scanDate=${scanDate}`);
  console.log(`  ${CLOCK.describe()}`);

  const units = enumerateUnits();
  const total = units.length;
  console.log(`  units: ${total} (cardYear x sportClass, MIN_CARD_YEAR..maxCardYear+absent/null buckets)`);

  // ── RESUME FROM THE CURSOR, IF ONE EXISTS FOR TODAY ───────────────────────
  //
  // A cursor from a PRIOR scanDate is discarded rather than trusted: the pool
  // has moved on since, and splicing yesterday's partial per-slug price
  // arrays onto today's would misstate the median exactly as a partial scan
  // would. A fresh sweep starts at unit 0 with an empty accumulator, same as
  // the very first run ever.
  const priorCursor = await readCursor(control);
  const resuming = !!(priorCursor && priorCursor.scanDate === scanDate);
  let startUnitIndex = resuming ? Number(priorCursor.nextUnitIndex) || 0 : 0;
  const pool = new Map();
  if (resuming && Array.isArray(priorCursor.poolSnapshot)) {
    for (const [slug, prices] of priorCursor.poolSnapshot) pool.set(slug, prices);
  }
  console.log(resuming
    ? `  RESUMING from unit ${startUnitIndex}/${total} (cursor scanDate=${priorCursor.scanDate}, ${pool.size} slugs accumulated so far)`
    : `  starting a fresh sweep (unit 0/${total})`);

  let unitsScanned = 0;
  let rowsScanned = 0;
  let stoppedAtBudget = false;
  let stopUnitIndex = null;

  for (let i = startUnitIndex; i < total; i++) {
    // THE PRE-CHECK, before the unit's first page. A unit whose largest page
    // cannot fit in what is left is not started at all -- see THE THREE
    // CONSTANTS above.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; stopUnitIndex = i; break; }

    const unit = units[i];
    const { query, parameters } = unitQuery(unit, 0);
    const iter = sc.items.query({ query, parameters }, { maxItemCount: PAGE_SIZE });
    let unitStoppedAtBudget = false;
    while (iter.hasMoreResults()) {
      // THE PRE-CHECK, before EACH PAGE inside the unit -- not only between
      // units. The largest single unit measured (2025 pokemon, 484,940 raw
      // rows) is itself many pages; without this a unit still in flight when
      // the budget expires is exactly the #1799 loop-top defect one level
      // down.
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; unitStoppedAtBudget = true; stopUnitIndex = i; break; }
      const { resources } = await iter.fetchNext();
      if (!Array.isArray(resources)) break;
      for (const r of resources) {
        rowsScanned++;
        if (!CONFIRMED_SOURCES.has(r.source)) continue;
        const p = Number(r.price);
        if (!Number.isFinite(p) || p <= 0) continue;
        const slug = String(r.hobbyiqCardId);
        if (!pool.has(slug)) pool.set(slug, []);
        pool.get(slug).push(p);
      }
    }
    if (unitStoppedAtBudget) break; // this unit is UNFINISHED; do not count it done, do not advance past it
    unitsScanned++;
    if (unitsScanned % 50 === 0) {
      console.log(`  narrate: ${unitsScanned} units scanned (at unit ${i}/${total}), ${rowsScanned} rows read, ${pool.size} slugs accumulated`);
    }
  }

  console.log(`  units scanned this run: ${unitsScanned}  rows read: ${rowsScanned}  slugs accumulated: ${pool.size}`);

  // ── A SCAN-PHASE STOP: ADVANCE THE CURSOR, REFUSE THE REPORT ──────────────
  //
  // Same shape as baseline-pool-snapshot.cjs's scan refusal: exit 5 is a
  // VERDICT, not a crash. The marker prints FIRST because the relaunch's
  // marker arm runs BEFORE its outcome check, so a refusal re-dispatches and
  // the next run resumes from stopUnitIndex with this run's accumulator
  // intact -- not from unit 0, and not from an empty pool.
  if (stoppedAtBudget) {
    if (APPLY) {
      await writeCursor(control, { nextUnitIndex: stopUnitIndex, totalUnits: total, scanDate, pool });
      console.log(`  cursor written: nextUnitIndex=${stopUnitIndex}/${total}`);
    } else {
      console.log(`  DRY: would write cursor nextUnitIndex=${stopUnitIndex}/${total} (no write in dry mode)`);
    }
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the (cardYear, sportClass) sweep is UNFINISHED (${stopUnitIndex}/${total} units); `
      + `the relaunch continues from here`);
    console.error("  REFUSING TO WRITE THE ANOMALY REPORT: driftPct is computed from the CURRENT"
      + " median across the WHOLE pool, and a partial scan is a DIFFERENT set of medians, not a"
      + " smaller one. Publishing it would report drift that never happened or hide drift that"
      + " did. Nothing was written to " + REPORT_CONTAINER + " this run; the cursor above lets the"
      + " next dispatch resume the sweep instead of restarting it.");
    if (APPLY) {
      reportWrites({
        job: "anomaly-force-scan",
        intended: 0, written: 0, skipped: 0, failed: 0,
      });
    }
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  // ── THE SWEEP FINISHED: LOAD THE BASELINE AND COMPUTE THE REPORT ─────────
  console.log(`\nSweep complete (${total} units). Loading most recent baseline...`);
  const { resources: dateRes } = await baseline.items.query({
    query: "SELECT VALUE MAX(c.snapshotDate) FROM c",
  }).fetchAll();
  const latestDate = dateRes[0];
  let report = null;
  if (!latestDate) {
    console.log("  no baseline found -- run baseline-pool-snapshot first. Report is null (same shape detectAnomalies() returns for this case).");
  } else {
    const { resources: baselineRows } = await baseline.items.query({
      query: "SELECT * FROM c WHERE c.snapshotDate = @d",
      parameters: [{ name: "@d", value: latestDate }],
    }, { partitionKey: latestDate }).fetchAll();
    const baselineMap = new Map(baselineRows.map((r) => [r.slug, r]));
    console.log(`  baseline date: ${latestDate}  baseline rows: ${baselineMap.size}`);

    const anomalies = [];
    for (const [slug, base] of baselineMap) {
      if (Number(base.sampleCount) < MIN_BASELINE_SAMPLES) continue;
      const current = pool.get(slug);
      if (!current || current.length === 0) continue;
      const curMedian = median(current);
      const baseMedian = Number(base.median);
      const drift = Math.abs(curMedian - baseMedian) / baseMedian;
      if (drift < DRIFT_THRESHOLD) continue;
      const sampleGrowth = (current.length - base.sampleCount) / Math.max(base.sampleCount, 1);
      const suspiciousness =
        drift >= HIGH_SUSPICIOUS_THRESHOLD && sampleGrowth < 0.20 ? "high"
        : drift >= DRIFT_THRESHOLD && sampleGrowth < 0.50 ? "medium"
        : "low";
      anomalies.push({
        slug,
        baselineMedian: baseMedian,
        currentMedian: curMedian,
        driftPct: Math.round(drift * 10000) / 100,
        driftDirection: curMedian > baseMedian ? "up" : "down",
        baselineSample: base.sampleCount,
        currentSample: current.length,
        sampleGrowthPct: Math.round(sampleGrowth * 10000) / 100,
        suspiciousness,
      });
    }
    anomalies.sort((a, b) => b.driftPct - a.driftPct);
    report = {
      baselineDate: latestDate,
      slugsWithBaseline: baselineMap.size,
      slugsChanged: anomalies.length,
      anomalies,
      computedAt: new Date().toISOString(),
    };
    const high = anomalies.filter((a) => a.suspiciousness === "high").length;
    console.log(`  anomalies: ${anomalies.length} total, ${high} high-suspiciousness`);
  }

  let written = 0;
  let failed = 0;
  if (APPLY) {
    const doc = {
      id: `${scanDate}::anomaly-scan-report`,
      docType: "anomaly_scan_report",
      scanDate,
      unitsScanned: total,
      rowsScanned,
      report,
      computedAt: new Date().toISOString(),
    };
    try {
      const reportContainer = await ensureReportContainer(db);
      await reportContainer.items.upsert(doc);
      written = 1;
    } catch (e) {
      failed = 1;
      console.error("  ERR writing anomaly report:", e && e.message);
    }
    if (written === 1) {
      // The sweep finished AND the report landed, so the cursor is retired --
      // a stale cursor left behind would make TOMORROW's run believe it can
      // resume mid-sweep from a scanDate that is no longer today's, and
      // readCursor()'s scanDate check already guards that, but clearing it
      // is what makes the doc's own state match reality rather than relying
      // solely on that guard.
      await clearCursor(control);
    } else {
      // The sweep's own work -- every unit read, the whole pool assembled --
      // is real and worth keeping even though the report upsert failed.
      // Writing a cursor at nextUnitIndex=total (rather than leaving
      // whatever cursor state predates this run, or none at all) means the
      // NEXT dispatch's `for` loop runs zero iterations, falls straight
      // through to the report-compute-and-write section with this run's
      // full pool already restored, and simply retries the one write that
      // failed -- rather than re-scanning all `total` units from scratch.
      await writeCursor(control, { nextUnitIndex: total, totalUnits: total, scanDate, pool });
      console.log("  cursor written at nextUnitIndex=total: the report write failed, so the next"
        + " dispatch retries the write against this run's FINISHED sweep rather than re-scanning it");
    }
  } else {
    console.log(`\nDRY: would write 1 anomaly report doc to ${REPORT_CONTAINER} and clear the cursor.`);
  }

  console.log(`  reconciled: intended ${APPLY ? 1 : 0} = written ${written} + failed ${failed}`);
  reportWrites({
    job: "anomaly-force-scan",
    intended: APPLY ? 1 : 0, written, failed,
  });

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
