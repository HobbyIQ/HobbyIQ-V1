#!/usr/bin/env node
// CF-TRUST-TIER-PROMOTION (Drew, 2026-08-01).
//
// Every sold_comps row starts as verifyStatus="unverified" (via
// ingest write path — TODO to be added). This periodic job promotes
// rows to "confirmed" when they've cleared the trust bar:
//   - Age >= 7 days (fresh sales less trusted — could be re-listed)
//   - Not flagged with any of __priceOutlier / __cardsightUnverified
//     / __userFlagQuarantine / __badActorSeller
//   - Confirmed source (cardhedge / ebay-user-purchase / manual-user-entry
//     / ebay-user-sale / ebay-browse-ended)
//   - Price within 3x-0.3x of pool median (broader than the outlier
//     flag but tighter than random)
//
// Rows failing any check STAY at their current status (unverified) —
// they can still show in views that opt in, but the "trusted pool"
// filter (verifyStatus="confirmed") gets the cleanest snapshot.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_CONCURRENCY       default 8

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane promotes sold_comps rows to
// verifyStatus="confirmed" -- it decides what the TRUSTED pool contains -- and
// declared no budget at all. Both phases walk the whole container, so before
// this it could only ever end by being KILLED at the 150-minute ceiling: no
// marker, no reconcile, no finishLane line, and #1913's KILLED branch then
// withholding the re-dispatch.
//
// >>> THE WRITE PHASE REFUSES AFTER A SCAN-PHASE STOP. <<<
//
// Same shape, same reason as backfill-stage3-price-sanity and #1951's three
// instances. Phase 1 computes a STATISTIC per slug -- median(prices) over
// confirmed sources, gated on MIN_POOL_FOR_MEDIAN -- and phase 2's fourth
// filter is a band around it: `p < m * NARROW_FLOOR || p > m * NARROW_CEIL`.
// A median over PART of a pool is a DIFFERENT median, not a smaller one, so a
// partial phase 1 promotes rows the full pool would have rejected and rejects
// rows it would have promoted.
//
// AND PROMOTION IS THE DIRECTION THAT MATTERS. A row wrongly left unverified is
// re-examined by the next pass; a row wrongly stamped `confirmed` is DONE --
// phase 2's own query excludes `verifyStatus = 'confirmed'`, so no later run
// ever looks at it again. The mistake is not merely well-formed, it is
// permanent.
//
// MIN_POOL_FOR_MEDIAN does not save it: a partial pool can clear the row floor
// and still misstate the median.
//
// So a phase-1 stop exits 5 having written NOTHING, and still prints the
// marker -- the relaunch's marker arm runs BEFORE its outcome check, so a
// refusal re-dispatches and the next run re-scans from the top.
//
// TWO UNITS, TWO SIZES. Phase 1's unit is one 5,000-row page of a THREE-FIELD
// PROJECTION; phase 2's is one 500-row page of FULL DOCUMENTS drained through a
// CONCURRENCY-wide (default 8) window of whole-document upserts. The reserve is
// sized to the LARGER, phase 2's: 90 seconds.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loops.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const AGE_DAYS = 7;
const CONFIRMED_SOURCES = new Set([
  "cardhedge", "ebay-user-purchase", "manual-user-entry", "ebay-user-sale", "ebay-browse-ended",
]);
const NARROW_FLOOR = 0.3;
const NARROW_CEIL = 3.0;
const MIN_POOL_FOR_MEDIAN = 5;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[promote-trust-tier]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  // Phase 1: build per-slug medians (confirmed sources only)
  console.log("\nPhase 1: build per-slug medians...");
  const iter1 = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });
  const pool = new Map();
  let scanned = 0;
  let phase1StoppedAtBudget = false;
  while (iter1.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched. A stop here is FATAL to the
    // write phase -- see THE CLOCK above -- not merely a shorter run.
    if (CLOCK.outOfClock()) { phase1StoppedAtBudget = true; break; }
    const { resources } = await iter1.fetchNext();
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
  const medians = new Map();
  for (const [slug, prices] of pool) {
    if (prices.length < MIN_POOL_FOR_MEDIAN) continue;
    medians.set(slug, median(prices));
  }
  console.log(`  confirmed rows scanned: ${scanned}`);
  console.log(`  pools with medians:     ${medians.size}`);

  // -- THE REFUSAL -----------------------------------------------------------
  //
  // A median over part of a pool is a DIFFERENT median. Promoting against one
  // stamps `confirmed` on rows the full pool would have rejected -- and phase
  // 2's own query excludes already-confirmed rows, so nothing ever revisits
  // them. That is not a shorter run, it is a permanently wrong trusted pool.
  //
  // Exit 5 is a VERDICT, not a crash (#1955's outcome (d)). The marker is
  // printed FIRST, because the relaunch's marker arm runs BEFORE its outcome
  // check -- so this re-dispatches and the next run re-scans from the top.
  if (phase1StoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the median scan is UNFINISHED; the relaunch continues from here`);
    console.error("  REFUSING THE WRITE PHASE: the per-slug medians were computed from a PARTIAL"
      + " scan, and a partial median is a DIFFERENT median rather than a smaller one. Promoting"
      + " against it would stamp verifyStatus='confirmed' on rows the full pool would have"
      + " rejected -- and phase 2's query skips confirmed rows, so no later pass would ever"
      + " revisit them. Nothing was written.");
    if (MODE === "apply") {
      reportWrites({
        job: "promote-sold-comps-trust-tier",
        intended: 0, written: 0, skipped: 0, failed: 0,
      });
    }
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  // Phase 2: iterate all rows, decide promotion
  console.log("\nPhase 2: promote qualifying rows to verifyStatus='confirmed'...");
  const iter2 = sc.items.query({
    query: `SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')
              AND (NOT IS_DEFINED(c.verifyStatus) OR c.verifyStatus != 'confirmed')`
  }, { maxItemCount: 500 });

  const cutoffDate = new Date(Date.now() - AGE_DAYS * 86_400_000).toISOString();
  let examined = 0, promoted = 0, tooYoung = 0, flagged = 0, badSource = 0, noPool = 0, priceOff = 0, errors = 0;
  // `written` did not exist: only failures were counted, so a run reported
  // `promoted: N` and said nothing about how many of those N landed.
  let written = 0;
  const inFlight = [];
  let phase2StoppedAtBudget = false;

  while (iter2.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after its 500
    // whole-document upserts have been issued. A stop HERE is safe: the
    // medians are complete, so every promotion already written was decided
    // against the same numbers the next run will recompute.
    if (CLOCK.outOfClock()) { phase2StoppedAtBudget = true; break; }
    const { resources } = await iter2.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      // Filter 1: age
      const at = row.soldAt || row.observedAt;
      if (!at || at > cutoffDate) { tooYoung++; continue; }
      // Filter 2: source
      if (!CONFIRMED_SOURCES.has(row.source)) { badSource++; continue; }
      // Filter 3: no contamination flags
      if (row.__priceOutlier === true || row.__cardsightUnverified === true
        || row.__userFlagQuarantine === true || row.__badActorSeller === true) { flagged++; continue; }
      // Filter 4: price within pool band
      const m = medians.get(row.hobbyiqCardId);
      if (m === undefined) { noPool++; continue; }
      const p = Number(row.price);
      if (!Number.isFinite(p) || p <= 0) { priceOff++; continue; }
      if (p < m * NARROW_FLOOR || p > m * NARROW_CEIL) { priceOff++; continue; }

      // Promote
      promoted++;
      if (MODE === "apply") {
        row.verifyStatus = "confirmed";
        row.verifyStatusAt = new Date().toISOString();
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).then(() => { written++; }).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) {
      console.log(`  examined=${examined}  promoted=${promoted}  flagged=${flagged}  noPool=${noPool}  tooYoung=${tooYoung}`);
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  examined:  ${examined}`);
  console.log(`  promoted:  ${promoted}`);
  console.log(`  filtered by:`);
  console.log(`    too young (< ${AGE_DAYS}d):  ${tooYoung}`);
  console.log(`    non-confirmed source:  ${badSource}`);
  console.log(`    has contamination flag:${flagged}`);
  console.log(`    no pool median:         ${noPool}`);
  console.log(`    price out of narrow band:${priceOff}`);
  console.log(`  errors:    ${errors}`);

  // RECONCILE OVER WHAT PASSED THE FILTERS. Every row this run planned to
  // promote is one that cleared all four gates, so the identity holds whether
  // phase 2 finished or the budget stopped it.
  if (MODE === "apply") {
    console.log(`  reconciled: intended ${promoted} = written ${written} + failed ${errors}`);
    if (written + errors !== promoted) {
      console.error("  !! RECONCILE MISMATCH -- a planned promotion was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "promote-sold-comps-trust-tier",
      intended: promoted, written, skipped: 0, failed: errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (phase2StoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass wrote: phase 2's scan excludes"
      + " rows already at verifyStatus='confirmed', and the next run recomputes the SAME medians"
      + " from the same complete scan, so the remainder is decided against identical numbers.");
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
