#!/usr/bin/env node
// CF-BACKFILL-STAGE3-PRICE-SANITY (Drew, 2026-08-01).
//
// Stage 3 of the pool-cleanup pipeline. Stages 1+2 canonicalized slugs;
// Stage 3 catches the OTHER contamination class — rows whose slug is
// correct but the row is the WRONG PHYSICAL CARD (e.g., a base auto sale
// mis-tagged by Cardsight's fuzzy matcher as Blue Refractor and dropped
// into the /150 Blue Refractor pool at $6 when the real market is $1,500).
//
// Only WRITES a new boolean field __priceOutlier=true on flagged rows.
// Never touches slug, parallel, price, or any existing field. Blast
// radius is one nullable boolean — trivially reversible.
//
// Algorithm per row:
//   1. Group rows by hobbyiqCardId
//   2. Compute median from CONFIRMED-SOLD sources only:
//      (cardhedge, ebay-user-purchase, manual-user-entry, ebay-user-sale,
//       ebay-browse-ended)
//   3. Only apply gate if confirmed-sold pool has >= MIN_POOL_SIZE rows
//   4. For each row in the group:
//      if price < median * FLOOR_MULT OR price > median * CEILING_MULT
//         → mark __priceOutlier=true
//
// Configurable bands (env):
//   FLOOR_MULT   default 0.2  (rows priced <20% of median are suspicious)
//   CEILING_MULT default 5.0  (rows priced >5x median are suspicious)
//   MIN_POOL_SIZE default 5   (skip pools too thin to trust median)
//   MIN_MEDIAN    default 20  (skip trivial-price pools where band %
//                              would produce false positives at the noise
//                              floor — $1 sale in a $2 pool isn't outlier)
//
//   BACKFILL_MODE / BACKFILL_APPLY   dry (default) | apply / true|false
//   BACKFILL_CONCURRENCY   default 8

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane pulls rows OUT OF PRICING
// by stamping __priceOutlier=true, and declared no budget at all. Both of its
// phases walk the whole container -- phase 1 reads every priced hiq: row to
// build per-slug medians, phase 2 reads every one of them again as a full
// document -- so before this it could only ever end by being KILLED at the
// 150-minute ceiling: no marker, no reconcile, no finishLane line, and #1913's
// KILLED branch then withholding the re-dispatch.
//
// >>> THE WRITE PHASE REFUSES AFTER A SCAN-PHASE STOP. <<<
//
// This is #1947's retire-flattened-attestations lesson and #1951's three
// sharper instances, and this lane is the same shape as all four. Phase 1 does
// not gather ROWS, it computes a STATISTIC: median(prices) per slug, gated on
// MIN_POOL_SIZE and MIN_MEDIAN. A median over PART of a pool is not a smaller
// median -- it is a DIFFERENT one, and every phase-2 decision is
// `price < median * FLOOR_MULT || price > median * CEILING_MULT`. Stop phase 1
// half way through the container and the $6 sale that the full pool's $1,500
// median flags as an outlier sits against a median computed from whichever
// rows happened to be scanned first, and the run either flags a legitimate
// sale or clears a contaminating one. Both are WELL-FORMED WRONG ROWS that no
// later pass can tell from correct ones.
//
// MIN_POOL_SIZE does not save it: a partial pool can clear the row floor and
// still misstate the median, exactly as #1951 found for
// auto-quarantine-contaminated-pools' MIN_SAMPLES.
//
// So a phase-1 stop exits 5 having written NOTHING, and still prints the
// marker -- the relaunch's marker arm runs BEFORE its outcome check, so a
// refusal re-dispatches and the next run re-scans from the top.
//
// TWO UNITS, TWO SIZES. Phase 1's unit is one 5,000-row page of a
// THREE-FIELD PROJECTION; phase 2's is one 500-row page of FULL DOCUMENTS
// drained through a CONCURRENCY-wide (default 8) window of whole-document
// upserts. The reserve is sized to the LARGER, phase 2's: 90 seconds.
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
const FLOOR_MULT = Number(process.env.FLOOR_MULT || 0.2);
const CEILING_MULT = Number(process.env.CEILING_MULT || 5.0);
const MIN_POOL_SIZE = Math.max(1, Number(process.env.MIN_POOL_SIZE || 5));
const MIN_MEDIAN = Number(process.env.MIN_MEDIAN || 20);

const CONFIRMED_SOURCES = new Set([
  "cardhedge",
  "ebay-user-purchase",
  "manual-user-entry",
  "ebay-user-sale",
  "ebay-browse-ended",
]);

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429 || /Too many requests|Request rate/i.test(String(e?.message || ""));
      if (!is429) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-stage3-price-sanity]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log(`  FLOOR_MULT=${FLOOR_MULT}  CEILING_MULT=${CEILING_MULT}  MIN_POOL_SIZE=${MIN_POOL_SIZE}  MIN_MEDIAN=$${MIN_MEDIAN}`);

  console.log("\nPhase 1: build per-slug medians from confirmed-sold rows...");
  const iter1 = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });

  const poolPrices = new Map(); // slug → confirmed prices only
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
      if (!poolPrices.has(r.hobbyiqCardId)) poolPrices.set(r.hobbyiqCardId, []);
      poolPrices.get(r.hobbyiqCardId).push(p);
    }
    if (scanned % 500000 === 0) console.log(`  scanned=${scanned}  pools=${poolPrices.size}`);
  }

  // Compute medians
  const medianBySlug = new Map();
  let poolsSizedOk = 0, poolsSkipped = 0;
  for (const [slug, prices] of poolPrices) {
    if (prices.length < MIN_POOL_SIZE) { poolsSkipped++; continue; }
    const m = median(prices);
    if (m < MIN_MEDIAN) { poolsSkipped++; continue; }
    medianBySlug.set(slug, m);
    poolsSizedOk++;
  }
  console.log(`  confirmed-source scanned=${scanned}`);
  console.log(`  pools with >= ${MIN_POOL_SIZE} confirmed rows and median >= $${MIN_MEDIAN}: ${poolsSizedOk}`);
  console.log(`  pools skipped (too thin or trivial-price): ${poolsSkipped}`);

  // -- THE REFUSAL -----------------------------------------------------------
  //
  // A median over part of a pool is a DIFFERENT median, not a smaller one, and
  // every phase-2 flag is a band around it. Writing from one produces
  // well-formed WRONG rows -- legitimate sales pulled out of pricing,
  // contaminating ones left in -- which no later pass can distinguish from
  // correct ones. So the write phase does not run at all.
  //
  // Exit 5 is a VERDICT, not a crash: the lane reached its own exit and
  // declared why (#1955's outcome (d)). The marker is printed FIRST, because
  // the relaunch's marker arm runs BEFORE its outcome check -- so this
  // re-dispatches, and the next run re-scans from the top with a full clock.
  if (phase1StoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the median scan is UNFINISHED; the relaunch continues from here`);
    console.error("  REFUSING THE WRITE PHASE: the per-slug medians were computed from a PARTIAL"
      + " scan, and a partial median is a DIFFERENT median rather than a smaller one. Flagging"
      + " against it would pull legitimate sales out of pricing and leave contaminating ones in,"
      + " as well-formed rows no later pass can tell from correct ones. Nothing was written.");
    if (MODE === "apply") {
      reportWrites({
        job: "backfill-stage3-price-sanity",
        intended: 0, written: 0, skipped: 0, failed: 0,
      });
    }
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  console.log("\nPhase 2: scan all rows, flag outliers against pool median...");
  const iter2 = sc.items.query({
    query: `SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 500 });

  let examined = 0, flagged = 0, alreadyFlagged = 0, noPool = 0, inBand = 0, errors = 0;
  const flaggedBySource = {};
  const flaggedBands = { belowFloor: 0, aboveCeiling: 0 };
  const sampleFlags = [];
  const inFlight = [];
  // `written` did not exist: only failures were counted, so a run reported
  // `newly flagged: N` and said nothing about how many of those N landed.
  let written = 0;
  let phase2StoppedAtBudget = false;

  while (iter2.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after its 500
    // whole-document upserts have been issued. A stop HERE is safe: the
    // medians are complete, so every flag already written was decided against
    // the same numbers the next run will recompute.
    if (CLOCK.outOfClock()) { phase2StoppedAtBudget = true; break; }
    const { resources } = await iter2.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const m = medianBySlug.get(row.hobbyiqCardId);
      if (m === undefined) { noPool++; continue; }
      const p = Number(row.price);
      if (!Number.isFinite(p) || p <= 0) continue;

      const belowFloor = p < m * FLOOR_MULT;
      const aboveCeiling = p > m * CEILING_MULT;
      if (!belowFloor && !aboveCeiling) { inBand++; continue; }

      if (row.__priceOutlier === true) { alreadyFlagged++; continue; }

      flagged++;
      flaggedBySource[row.source] = (flaggedBySource[row.source] || 0) + 1;
      if (belowFloor) flaggedBands.belowFloor++;
      if (aboveCeiling) flaggedBands.aboveCeiling++;

      if (sampleFlags.length < 12) {
        sampleFlags.push(`  $${p.toFixed(2)}  poolMedian=$${m.toFixed(0)}  ratio=${(p/m).toFixed(2)}x  [${row.source}]  ${(row.title||'').slice(0,80)}`);
      }

      if (MODE === "apply") {
        row.__priceOutlier = true;
        row.__priceOutlierAt = new Date().toISOString();
        row.__priceOutlierPoolMedian = m;
        row.__priceOutlierBand = belowFloor ? "below-floor" : "above-ceiling";
        inFlight.push(
          withRetry(() => sc.items.upsert(row))
            .then(() => { written++; })
            .catch(() => { errors++; })
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
    if (examined % 100000 === 0) console.log(`  examined=${examined}  flagged=${flagged}  noPool=${noPool}  inBand=${inBand}`);
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  examined:         ${examined}`);
  console.log(`  no pool (skip):   ${noPool}`);
  console.log(`  in band:          ${inBand}`);
  console.log(`  already flagged:  ${alreadyFlagged}`);
  console.log(`  newly flagged:    ${flagged}  (${flaggedBands.belowFloor} below floor, ${flaggedBands.aboveCeiling} above ceiling)`);
  console.log(`  errors:           ${errors}`);
  console.log(`\n  Flagged by source:`);
  Object.entries(flaggedBySource).sort((a,b) => b[1] - a[1]).forEach(([s, n]) => {
    console.log(`    ${String(n).padStart(7)}  ${s}`);
  });
  console.log(`\nSample flagged rows:`);
  sampleFlags.forEach(s => console.log(s));

  // RECONCILE OVER WHAT WAS FLAGGED. Every row this run planned to stamp is one
  // it decided was out of band, so the identity holds whether phase 2 finished
  // or the budget stopped it.
  if (MODE === "apply") {
    console.log(`  reconciled: intended ${flagged} = written ${written} + failed ${errors}`);
    if (written + errors !== flagged) {
      console.error("  !! RECONCILE MISMATCH -- a planned flag was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "backfill-stage3-price-sanity",
      intended: flagged, written, skipped: 0, failed: errors,
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
    console.log("  a row already carrying __priceOutlier=true is counted as `already flagged` and"
      + " never re-written, and the next run recomputes the SAME medians from the same complete"
      + " scan, so the continuation decides the remainder against identical numbers.");
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
