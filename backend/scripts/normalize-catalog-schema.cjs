#!/usr/bin/env node
// CF-NORMALIZE-CATALOG-SCHEMA (Drew, 2026-08-01).
//
// card_catalog rows arrived from two vendor pipelines with divergent
// field names:
//   - CH-source rows: cardNumber, playerName, setName
//   - CS-source rows: number,     player,     set / setName
//
// Downstream consumers had to defensively check both shapes. This
// backfill unifies every row to carry BOTH variants — a cheap denorm
// that means every reader can use whichever name it prefers without
// null-coalescing across shapes.
//
// Idempotent — marker __schemaNormalizedAt prevents re-touching. If
// both shape variants already agree, no write happens.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   RUN_MINUTES                the work loop's budget (default 110)
//   RESERVE_MS / VERIFY_MS     unit reserve / verify cap (see THE CLOCK)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane REWRITES card_catalog rows
// (it unifies the cardNumber/number, playerName/player and setName/set field
// pairs) and had a LOCAL time cap rather than a budget: BACKFILL_MAX_MINUTES,
// default 25, checked at the top of the page loop with no unit reserve, and
// signalling continuation through RELAUNCH_NEEDED rather than the marker every
// other budgeted lane prints. A killed step prints no line at all, `RN` parses
// empty, and the runner's RELAUNCH_NEEDED step falls to a `::warning::` that
// does NOT fail the job -- so a killed run went GREEN with the work half done.
// That is #1906's defect in a second protocol.
//
// THE UNIT IS ONE PAGE of up to 500 catalog rows (maxItemCount: 500) -- fetched
// whole, then drained through a CONCURRENCY-wide window of whole-document
// upserts, and the loop cannot stop inside one. Note the scan is `SELECT *`, so
// every row is a full document and every write replaces it whole. 90 seconds
// comfortably exceeds that drain against a container that throttles, and it is
// checked BEFORE the page is fetched so the page whose 500 upserts would
// overrun is never STARTED.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE here, which is why this lane may
// stop mid-sweep where dedupe-catalog-by-hobbyiq and
// fix-catalog-parallel-as-player (this same change) must refuse: every decision
// is made from the ROW IN HAND -- whichever of a field pair has a value wins --
// with no reference to any other row. A row never reached is simply not
// normalized yet, and the marker query excludes the ones that are.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[normalize-catalog-schema]  apply=${APPLY}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  const query = "SELECT * FROM c WHERE NOT IS_DEFINED(c.__schemaNormalizedAt) " +
                "AND (IS_DEFINED(c.number) OR IS_DEFINED(c.cardNumber) OR IS_DEFINED(c.player) OR IS_DEFINED(c.playerName))";
  const iter = cc.items.query({ query }, { maxItemCount: 500 });

  const stats = { scanned: 0, updated: 0, unchanged: 0, errors: 0 };
  const inFlight = [];
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count: the loop DISCOVERS rows page by page (feedback: a slice is not a
  // sibling counter).
  let stoppedAtBudget = false;

  async function processRow(row) {
    const nowIso = new Date().toISOString();
    const before = {
      cardNumber: row.cardNumber, number: row.number,
      playerName: row.playerName, player: row.player,
      setName: row.setName, set: row.set,
    };
    // Unify: whichever variant has a value wins; write both.
    const num = row.cardNumber ?? row.number ?? null;
    const player = row.playerName ?? row.player ?? null;
    const setStr = row.setName ?? row.set ?? null;

    const needsUpdate =
      before.cardNumber !== num || before.number !== num ||
      before.playerName !== player || before.player !== player ||
      before.setName !== setStr || before.set !== setStr;

    if (!needsUpdate && APPLY) {
      // Still stamp the marker so we don't re-scan next run
      row.__schemaNormalizedAt = nowIso;
      try { await withRetry(() => cc.items.upsert(row)); stats.unchanged++; } catch { stats.errors++; }
      return;
    }
    if (!needsUpdate) { stats.unchanged++; return; }

    if (!APPLY) { stats.updated++; return; }
    row.cardNumber = num;
    row.number = num;
    row.playerName = player;
    row.player = player;
    row.setName = setStr;
    row.set = setStr;
    row.__schemaNormalizedAt = nowIso;
    try { await withRetry(() => cc.items.upsert(row)); stats.updated++; } catch { stats.errors++; }
  }

  while (iter.hasMoreResults()) {
    // THE PRE-CHECK: above the unit's work, and BEFORE the page is fetched
    // rather than after its 500 whole-document upserts have been issued.
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
      if (stats.scanned % 5000 === 0) {
        console.log(`  scanned=${stats.scanned}  updated=${stats.updated}  unchanged=${stats.unchanged}  errors=${stats.errors}`);
      }
      // The inner break only leaves the row walk; the outer `while` re-checks
      // the same clock at the top, so the budget is honoured PER RUN rather than
      // per page (#1947's retire-impossible-grade-rows lesson).
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:    ${stats.scanned}`);
  console.log(`  updated:    ${stats.updated}  (schema unified)`);
  console.log(`  unchanged:  ${stats.unchanged}  (already consistent)`);
  console.log(`  errors:     ${stats.errors}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);

  // RECONCILE OVER WHAT WAS SEEN. Every scanned row is decided: it is either
  // rewritten (`updated`), stamped-but-unchanged (`unchanged`), or it failed. So
  // the identity holds whether the loop finished or the budget stopped it -- a
  // budget stop shrinks BOTH sides rather than opening a gap that reads as loss.
  if (APPLY) {
    console.log(`  reconciled: intended ${stats.scanned} = written ${stats.updated}`
      + ` + unchanged ${stats.unchanged} + failed ${stats.errors}`);
    if (stats.updated + stats.unchanged + stats.errors !== stats.scanned) {
      console.error("  !! RECONCILE MISMATCH -- a scanned row was neither updated, unchanged nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "normalize-catalog-schema",
      intended: stats.scanned, written: stats.updated,
      skipped: stats.unchanged, failed: stats.errors,
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
    console.log("  the continuation never re-reads what this pass wrote: every handled row is"
      + " stamped __schemaNormalizedAt -- the unchanged ones deliberately too -- and the scan"
      + " query excludes it by name.");
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
