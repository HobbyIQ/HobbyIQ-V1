#!/usr/bin/env node
// CF-BACKFILL-BOWMAN-MEGA-BOX-RESLUG (Drew, 2026-08-01).
//
// Retroactively re-slugs sold_comps rows where setName mentions
// "Mega Box" but the slug's set segment is generic `bowman`.
// After 2026-08-01 normalizeSetKey fix, new ingest lands at
// bowman-mega-box — this brings existing rows in line.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_CONCURRENCY       default 12

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane REWRITES sold_comps slugs
// -- it moves a sale from the generic `bowman` pool onto `bowman-chrome` -- and
// declared no budget at all. Its scan is an unbounded
// `CONTAINS(UPPER(c.setName), 'MEGA BOX')` over the whole pool, so before this
// it could only ever end by being KILLED at the ceiling: no marker, no
// reconcile, no finishLane line, and #1913's KILLED branch then withholding the
// re-dispatch with an unknown number of sales relocated and the rest at their
// old address. A split pool is a wrong FMV
// (feedback_one_card_one_row_one_pool), so a half-done reslug is worse than an
// undone one.
//
// THE UNIT IS ONE PAGE of up to 500 sold_comps rows (maxItemCount: 500) --
// fetched whole, then drained through a CONCURRENCY-wide (default 12) window of
// whole-document upserts, and the loop cannot stop inside one. Note the scan is
// `SELECT *`, so each row is a full document and each write replaces it whole.
// 90 seconds comfortably exceeds that drain against a container that throttles,
// and it is checked BEFORE the page is fetched.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: every decision reads the ROW IN
// HAND -- its own setName and its own slug segment -- with no reference to any
// other row, so a row never reached is simply not moved yet.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));

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
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-bowman-mega-box-reslug]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE IS_DEFINED(c.setName) AND CONTAINS(UPPER(c.setName), 'MEGA BOX')`
  }, { maxItemCount: 500 });

  let examined = 0, wouldChange = 0, errors = 0;
  // `written` did not exist: only failures were counted, so a run reported
  // `wouldChange: N` and said nothing about how many of those N landed.
  let written = 0;
  const transitions = {};
  const inFlight = [];
  const at = new Date().toISOString();
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count: the loop DISCOVERS rows page by page (feedback: a slice is not a
  // sibling counter).
  let stoppedAtBudget = false;

  while (iter.hasMoreResults()) {
    // THE PRE-CHECK: above the unit's work, and BEFORE the page is fetched
    // rather than after its 500 whole-document upserts have been issued.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const slug = row.hobbyiqCardId;
      if (typeof slug !== "string" || !slug.startsWith("hiq:")) continue;
      const parts = slug.split(":");
      if (parts.length < 6) continue;
      if (parts[3] === "bowman-chrome") continue; // already at correct destination
      // Only reslug rows currently at generic bowman OR (legacy) bowman-mega-box
      if (parts[3] !== "bowman" && parts[3] !== "bowman-mega-box") continue;
      const oldSet = parts[3];
      parts[3] = "bowman-chrome";
      const newSlug = parts.join(":");
      const key = `${oldSet} → bowman-chrome`;
      transitions[key] = (transitions[key] || 0) + 1;
      wouldChange++;
      if (MODE === "apply") {
        row.hobbyiqCardId = newSlug;
        row.__megaBoxReslugAt = at;
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
    if (examined % 50000 === 0) console.log(`  examined=${examined}  wouldChange=${wouldChange}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  examined=${examined}  wouldChange=${wouldChange}  errors=${errors}`);
  Object.entries(transitions).forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));

  // RECONCILE OVER WHAT WAS SEEN. `wouldChange` counts only rows this run
  // decided to move, so the identity holds whether the loop finished or the
  // budget stopped it -- a budget stop shrinks BOTH sides rather than opening a
  // gap that reads as loss.
  if (MODE === "apply") {
    console.log(`  reconciled: intended ${wouldChange} = written ${written} + failed ${errors}`);
    if (written + errors !== wouldChange) {
      console.error("  !! RECONCILE MISMATCH -- a planned reslug was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "backfill-bowman-mega-box-reslug",
      intended: wouldChange, written, skipped: 0, failed: errors,
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
    console.log("  the reslug is IDEMPOTENT: a moved row already has `bowman-chrome` in its slug's"
      + " set segment, which the loop's own guard reads as `already at correct destination` and"
      + " skips, so the continuation re-walks cheaply and moves only what is left.");
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
