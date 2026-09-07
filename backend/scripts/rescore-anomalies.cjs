#!/usr/bin/env node
// CF-RESCORE-ANOMALIES (Drew, 2026-08-02).
//
// Retroactive confidence-score re-application on comps_staging rows
// with status='anomaly'. These rows were flagged at ingest time using
// hand-tuned confidence weights; since then Drew's admin clicks have
// trained learned weights (price, cardYear tightened). Any anomaly
// row that now scores >= 0.60 gets flipped to status='clean' so the
// normal promotion job picks it up in the next 5-min cron cycle.
//
// Idempotent via __rescoredAt marker. Safe to re-dispatch.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   RUN_MINUTES                work-loop budget (default 110); RESERVE_MS and
//                              VERIFY_MS override the unit reserve and the
//                              post-loop verify cap. BACKFILL_MAX_MINUTES is
//                              GONE -- it capped at the loop top, reserved
//                              nothing, and signalled through RELAUNCH_NEEDED.
//   BACKFILL_CONCURRENCY       parallel workers (default 6)
//   PROMOTE_THRESHOLD          default 0.60 (matches confidence band)

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
  console.error("Cannot import scoreRow from dist — build the backend first (npm run build)");
  console.error(e.message);
  process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 6));
const THRESHOLD = Math.max(0, Math.min(1, Number(process.env.PROMOTE_THRESHOLD || 0.60)));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

// -- THE CLOCK, AND WHAT IT REPLACES ----------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane flips comps_staging rows
// from status='anomaly' to status='clean', which hands them to the 5-minute
// promotion cron -- it decides what enters the pool -- and its population is
// the ~181K anomaly backlog the header describes.
//
// IT WAS NOT UNCLOCKED. IT WAS CLOCKED WRONG, the same class as its sibling
// score-all-sold-comps: a LOCAL `BACKFILL_MAX_MINUTES` (default 25) tested at
// the loop TOP, reserving nothing for the 200-row page already in flight, and
// a `RELAUNCH_NEEDED=true|false` line instead of the marker. That protocol has
// two arms and no third -- a KILLED step prints no line at all, so `RN` parses
// EMPTY and the runner falls through to a `::warning::` that does NOT fail the
// job. A run killed at the 150-minute ceiling went GREEN mid-backlog. The lane
// moves onto the marker and off that gate here, not onto both.
//
// >>> A PARTIAL RUN HERE IS SHORTER, NOT WRONG. <<<
//
// Each row is scored from its own clean payload plus its OWN slug pool median
// (a TOP 20 point lookup), and the scan selects rows not yet rescored or
// rescored below 0.60. Nothing is derived across the rows this run saw, so a
// stop leaves the remainder for the next pass. No refusal is owed.
//
// THE UNIT IS ONE 200-ROW PAGE drained through a CONCURRENCY-wide (default 6)
// window, each row costing a pool query plus an upsert. 90 seconds covers it.
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
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const staging = db.container("comps_staging");
  const soldComps = db.container("sold_comps");
  console.log(`[rescore-anomalies] apply=${APPLY} concurrency=${CONCURRENCY} threshold=${THRESHOLD}`);
  console.log(`  ${CLOCK.describe()}`);

  // CF-RESCORE-SHAPE-FIX (Drew, 2026-08-02). Include rows previously
  // rescored below 0.60 — the prior script passed wrong input shape
  // to scoreRow (StagingClean.slug vs row.hobbyiqCardId, missing
  // title/source), producing uniform 0.58 across all 181K anomalies.
  // Re-scoring those with correct field mapping should show real
  // variance and let genuinely-clean rows promote.
  const query = "SELECT * FROM c WHERE c.status = 'anomaly' " +
                "AND (NOT IS_DEFINED(c.__rescoredAt) OR " +
                "     (IS_DEFINED(c.__rescoreScore) AND c.__rescoreScore < 0.60))";
  const iter = staging.items.query({ query }, { maxItemCount: 200 });

  // `promoted` and `stillLow` are VERDICTS -- what the score decided -- and the
  // old run reported them as if they were writes. Both arms upsert, and both
  // upserts could fail into the single `catch { stats.errors++ }` below, so a
  // run printed `promoted: N` while saying nothing at all about how many of
  // those N reached comps_staging. `written` is the real success counter,
  // incremented after each upsert resolves, on both arms.
  const stats = { scanned: 0, rescored: 0, promoted: 0, stillLow: 0, written: 0, errors: 0, distribution: { high: 0, mid: 0, low: 0, veryLow: 0 } };
  const inFlight = [];

  async function processRow(row) {
    try {
      // Build ConfidenceInput from staging clean payload
      const clean = row.clean;
      if (!clean) { stats.errors++; return; }

      // Fetch pool median for priceInBand signal — TOP 20 recent sales
      let poolMedian = null, poolSampleCount = 0;
      if (clean.hobbyiqCardId) {
        try {
          const { resources: pool } = await soldComps.items.query({
            query: "SELECT TOP 20 c.price FROM c WHERE c.hobbyiqCardId = @slug ORDER BY c.soldAt DESC",
            parameters: [{ name: "@slug", value: clean.hobbyiqCardId }],
          }).fetchAll();
          const prices = (pool || []).map(r => Number(r.price)).filter(p => Number.isFinite(p) && p > 0);
          if (prices.length > 0) {
            const sorted = [...prices].sort((a, b) => a - b);
            poolMedian = sorted[Math.floor(sorted.length / 2)];
            poolSampleCount = prices.length;
          }
        } catch { /* soft */ }
      }

      // CF-RESCORE-SHAPE-MAP (Drew, 2026-08-02). scoreRow expects
      // RecordSoldCompInput field names (hobbyiqCardId, title, source,
      // playerName). StagingClean uses `slug` and doesn't carry title
      // or source. Build a proper scoring row.
      const scoringRow = {
        hobbyiqCardId: clean.slug,
        cardNumber: clean.cardNumber,
        playerName: clean.playerName,
        parallel: clean.parallel,
        isAuto: clean.isAuto,
        printRun: clean.printRun,
        gradeCompany: clean.gradeCompany,
        gradeValue: clean.gradeValue,
        setName: clean.setName,
        cardYear: clean.cardYear,
        sport: clean.sport,
        price: clean.price,
        soldAt: clean.soldAt,
        source: row.source ?? "unknown",
        title: row.raw?.title ?? row.title ?? null,
      };
      const result = await scoreRow({
        row: scoringRow,
        poolMedian,
        poolSampleCount,
        catalogHasCanonicalForCardnumberYear: !!clean.slug,
        catalogAgreesOnSet: true,
        sellerBadActorScore: 0,
      });

      const score = result.score;
      if (score >= 0.85) stats.distribution.high++;
      else if (score >= 0.60) stats.distribution.mid++;
      else if (score >= 0.40) stats.distribution.low++;
      else stats.distribution.veryLow++;

      stats.rescored++;

      if (score >= THRESHOLD) {
        // Promote by flipping status
        stats.promoted++;
        if (APPLY) {
          row.status = "clean";
          row.__rescoredAt = new Date().toISOString();
          row.__rescoreScore = score;
          row.__rescoreBand = result.band;
          await withRetry(() => staging.items.upsert(row));
          stats.written++;
        }
      } else {
        stats.stillLow++;
        if (APPLY) {
          row.__rescoredAt = new Date().toISOString();
          row.__rescoreScore = score;
          row.__rescoreBand = result.band;
          await withRetry(() => staging.items.upsert(row));
          stats.written++;
        }
      }
    } catch (e) { stats.errors++; }
  }

  let stoppedAtBudget = false;
  while (iter.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after its 200 rows
    // have each been pool-queried, scored and upserted. A stop here is safe:
    // every written row carries __rescoredAt, and the scan admits an already-
    // rescored row only when its stored score is still below 0.60 -- so a
    // promoted row leaves the population and a still-low one is re-scored to
    // the same verdict against the same inputs.
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
      if (stats.scanned % 500 === 0) {
        console.log(`  scanned=${stats.scanned} rescored=${stats.rescored} promoted=${stats.promoted} stillLow=${stats.stillLow} written=${stats.written} err=${stats.errors}`);
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
  console.log(`  scanned:     ${stats.scanned}`);
  console.log(`  rescored:    ${stats.rescored}`);
  console.log(`  promoted (score >= ${THRESHOLD}): ${stats.promoted}  ← flipped to status=clean`);
  console.log(`  still low:   ${stats.stillLow}`);
  if (APPLY) console.log(`  written:     ${stats.written}`);
  console.log(`  errors:      ${stats.errors}`);
  console.log(`  distribution: high(>=.85)=${stats.distribution.high}  mid(.60-.85)=${stats.distribution.mid}  low(.40-.60)=${stats.distribution.low}  veryLow(<.40)=${stats.distribution.veryLow}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);

  // RECONCILE OVER WHAT THIS RUN SAW. This lane DISCOVERS its work page by
  // page, so there is no denominator for the rows the budget did not reach --
  // it reconciles the three-term way over the rows it scanned (a slice is not
  // a sibling counter). BOTH arms write, so `written` covers promotions and
  // stay-lows alike; a row that reached neither is the residual.
  if (APPLY) {
    const notWritten = Math.max(0, stats.scanned - stats.written - stats.errors);
    console.log(`  reconciled: intended ${stats.scanned} = written ${stats.written} + skipped ${notWritten} + failed ${stats.errors}`);
    if (stats.written + notWritten + stats.errors !== stats.scanned) {
      console.error("  !! RECONCILE MISMATCH -- a scanned row was neither written, skipped nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "rescore-anomalies",
      intended: stats.scanned, written: stats.written, skipped: notWritten, failed: stats.errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables. This REPLACES the `RELAUNCH_NEEDED=<bool>` line, whose third arm
  // went green on a kill -- see THE CLOCK above.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass PROMOTED: a promoted row is"
      + " status='clean' and the scan takes only status='anomaly'. A stay-low row IS re-read by"
      + " design -- that is the __rescoreScore < 0.60 arm of the query, and it re-scores to the"
      + " same verdict from the same inputs.");
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
