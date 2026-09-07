#!/usr/bin/env node
// CF-BACKFILL-COMPOSITE-V3 (Drew, 2026-07-31). Additive-only enrichment
// on top of v1 composite. Reads existing rows with composite.colorFamily
// defined + cardYear present, computes era + ladderVerdict + ladderTier +
// paniniColorEquivalent, writes them onto composite.
//
// Safe to run alongside the v1 backfill self-relaunch loop — v1
// writes composite.{edition,insertSet,colorFamily,finishModifier,isRefractor,
// confidence}; v3 only adds fields. Idempotent: reruns on already-
// enriched rows detect via composite.era != null and skip.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — write (default false / dry-run)
//   BACKFILL_CONCURRENCY=32      — parallel patch workers
//   BACKFILL_LIMIT               — optional row cap for testing

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { enrichCompositeV3 } = require(path.join(backend, "dist/services/portfolioiq/enrichCompositeV3.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane PATCHES composite on
// sold_comps rows and declared no budget at all. BACKFILL_LIMIT is documented
// as "optional row cap for testing" and defaults to NULL -- i.e. the standing
// configuration is an unbounded walk of every row whose composite.era is
// missing -- so before this the lane could only ever end by being KILLED at the
// ceiling: no marker, no reconcile, no finishLane line, and #1913's KILLED
// branch then withholding the re-dispatch.
//
// THE UNIT IS ONE BATCH of CONCURRENCY (default 32) rows, because the loop
// cannot stop inside one: flushBatch() issues all 32 patches with Promise.all
// and returns only when the slowest resolves. 90 seconds comfortably exceeds
// one such wave against a container that throttles, and it is checked BEFORE
// the batch is flushed.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: enrichCompositeV3 reads the ROW
// IN HAND -- its cardYear, its slug's product line, its own colorFamily and
// serialRun -- with no reference to any other row, so a row never reached is
// simply not enriched yet.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || "32"));
const LIMIT = process.env.BACKFILL_LIMIT ? Number(process.env.BACKFILL_LIMIT) : null;

function productLineFromSlug(slug) {
  const parts = String(slug || "").split(":");
  return parts[3] || null;
}

async function main() {
  // Already NAMED, so finishLane() can dispose it (#1809): an undisposed SDK
  // holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-composite-v3]`);
  console.log(`  apply:       ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit:       ${LIMIT ?? "unbounded"}`);
  console.log(`  ${CLOCK.describe()}`);

  const query = `
    SELECT c.id, c.cardId, c.cardYear, c.hobbyiqCardId, c.composite
    FROM c
    WHERE IS_DEFINED(c.composite) AND c.composite != null
      AND NOT IS_DEFINED(c.composite.era)
  `;
  const it = sc.items.query(query, { maxItemCount: 2000 });

  let scanned = 0;
  let planned = 0;
  let wrote = 0;
  let failed = 0;
  let skipped = 0;
  // Rows a DRY RUN would have written. Kept separate from `wrote` so the two
  // are never confused again (see the comment at the increment below).
  let planned_dryRun = 0;
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count: the loop DISCOVERS rows page by page (feedback: a slice is not a
  // sibling counter).
  let stoppedAtBudget = false;

  const batch = [];
  const flushBatch = async () => {
    if (batch.length === 0) return;
    await Promise.all(
      batch.map(async (row) => {
        try {
          const v3 = enrichCompositeV3({
            cardYear: row.cardYear,
            productLine: productLineFromSlug(row.hobbyiqCardId),
            colorFamily: row.composite?.colorFamily,
            serialRun: row.composite?.serialRun ?? null,
          });
          const merged = { ...(row.composite || {}), ...v3 };
          if (APPLY) {
            await sc.item(row.id, row.cardId).patch([
              { op: "set", path: "/composite", value: merged },
            ]);
            // `wrote++` USED TO SIT OUTSIDE THIS BRANCH, so a DRY RUN reported
            // `wrote: N` for N rows it had not written -- the summary's own
            // "*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***" line printed
            // directly beneath a non-zero write count. Counting a write where
            // no write happened is the one thing a reconciliation cannot
            // survive, so the increment now follows the patch it is counting.
            wrote++;
          } else {
            planned_dryRun++;
          }
        } catch (e) {
          failed++;
        }
      }),
    );
    batch.length = 0;
  };

  while (it.hasMoreResults()) {
    // THE PRE-CHECK: above the unit's work, and BEFORE the page is fetched
    // rather than after its batches have been flushed.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      if (LIMIT && scanned > LIMIT) break;
      // Cheap idempotence — composite.era already set means we've been
      // here on a prior run. Skip.
      if (r.composite && r.composite.era != null) { skipped++; continue; }
      planned++;
      batch.push(r);
      if (batch.length >= CONCURRENCY) {
        // THE PRE-CHECK before the UNIT, which here is the batch: flushBatch()
        // cannot be stopped once entered, so the wave whose 32 patches would
        // overrun is never started. The rows already buffered are left for the
        // relaunch rather than flushed past expiry.
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
        await flushBatch();
      }
      if (scanned % 10000 === 0) {
        console.log(`  scanned ${scanned}, planned ${planned}, wrote ${wrote}`);
      }
    }
    if (LIMIT && scanned > LIMIT) break;
    // The inner breaks only leave the row walk; without this the next page
    // would be fetched and the budget honoured per page rather than per run
    // (#1947's retire-impossible-grade-rows lesson).
    if (stoppedAtBudget) break;
  }
  // The final partial batch is flushed even on a budget stop: it is at most
  // CONCURRENCY rows, it is already decided, and the reserve is sized to
  // exactly one such wave.
  await flushBatch();

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  scanned:  ${scanned}`);
  console.log(`  skipped:  ${skipped}  (already v3-enriched)`);
  console.log(`  planned:  ${planned}`);
  console.log(`  wrote:    ${wrote}`);
  console.log(`  failed:   ${failed}`);
  if (!APPLY) {
    console.log(`  would write: ${planned_dryRun}`);
    console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
  }

  // RECONCILE OVER WHAT WAS SEEN. `planned` counts only rows this run decided to
  // enrich, so the identity holds whether the loop finished or the budget
  // stopped it -- a budget stop shrinks BOTH sides rather than opening a gap
  // that reads as loss.
  if (APPLY) {
    console.log(`  reconciled: intended ${planned} = written ${wrote} + failed ${failed}`);
    if (wrote + failed !== planned) {
      console.error("  !! RECONCILE MISMATCH -- a planned enrichment was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "backfill-composite-v3",
      intended: planned, written: wrote, skipped, failed,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the enrichment is IDEMPOTENT: the scan selects only rows whose composite.era is"
      + " absent, and the loop skips any row that already has one, so the continuation never"
      + " re-writes what this pass landed.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
