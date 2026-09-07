#!/usr/bin/env node
// CF-A-DELETED-HOLDING-KEEPS-NO-TRAIL (H-9, 2026-09-03).
//
// `priceHistoryByHolding` is keyed by holding id. Nothing ever removed an entry
// when the holding was deleted, so every delete since the map existed leaked
// its whole trail into the user doc permanently. The writer-side fix is
// `reapPriceTrail()` in portfolioStore.service.ts, called at all five
// `delete doc.holdings[...]` sites. This script is the other half: the
// one-time sweep for the trails that are ALREADY orphaned.
//
// Measured on prod 2026-09-03 (read-only):
//   250 orphaned trails corpus-wide, 16,246 of 24,055 stored points (67.5%)
//   user-199fcbc9  1,963,908 / 2,097,152 bytes (93.7%)  238 of 281 trails orphaned
//
// The 2 MB Cosmos document ceiling is a hard failure, not a slowdown: at the
// ceiling EVERY reprice and EVERY holding edit for that user fails. The
// per-class history caps from #1627 bound a live holding's trail and bound
// nothing at all once the holding is gone.
//
// Report-first, like every runner lane:
//   BACKFILL_APPLY unset/false  ->  count and name the orphans, write nothing
//   BACKFILL_APPLY=true         ->  delete the orphaned trails, reconciled
//
// Reconciliation (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW): `intended` is the number
// of orphaned TRAILS found by the scan, and it must equal written + skipped +
// failed. Verified by read: after each write the doc is re-read and its
// remaining orphan count asserted to be zero, so a silent partial write is
// counted as failed rather than reported green.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   COSMOS_DATABASE            optional (default "hobbyiq")
//   BACKFILL_APPLY=true        the runner's write switch
//   REPRICE_USER_ID            optional -- scope the sweep to ONE user.
//                              Reuses the existing runner env rather than
//                              claiming a new dispatch input (it is at 24 of
//                              25). Empty = every user, which is the intended
//                              corpus-wide repair.

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const ONLY_USER = String(process.env.REPRICE_USER_ID || "").trim() || null;
const DB = process.env.COSMOS_DATABASE || "hobbyiq";
const CEILING = 2 * 1024 * 1024; // Cosmos hard document ceiling, bytes.

const n = (x) => x.toLocaleString("en-US");
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) : "0.0");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane writes to `portfolio` --
// user documents -- and had no clock at all: over every user with holdings it
// could only end by being KILLED at the runner's 150-minute ceiling, printing
// no marker, no reconcile and no finishLane line, at which point #1913's
// KILLED branch withholds the re-dispatch and the reap stops half done.
//
// THE UNIT IS ONE USER DOCUMENT, and it is the most expensive unit shape in
// this repo: a WHOLE-DOCUMENT `replace` followed by a verifying `read`, on a
// document this lane's own banner tracks against the 2 MB Cosmos ceiling. A
// document at the ceiling is ~2 MB written and ~2 MB read back, and a
// throttled container can stretch that pair well past a minute. 90 seconds is
// that worst case with room, checked BEFORE the document rather than after it.
//
// Every count is accumulated in the loop and the post-loop report reads
// nothing, so VERIFY_MS is nominal and only sizes the pin's worst case
// (110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling).
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  // NAMED, not chained away, so finishLane() can dispose it: an undisposed SDK
  // holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database(DB).container("portfolio");

  console.log("=".repeat(74));
  console.log("reap-orphan-price-trails");
  console.log(`  mode:   ${APPLY ? "APPLY (writes)" : "REPORT-ONLY (no writes)"}`);
  console.log(`  scope:  ${ONLY_USER ? `ONE user (${ONLY_USER})` : "EVERY user with holdings"}`);
  console.log(`  clock:  ${CLOCK.describe()}`);
  console.log("=".repeat(74));
  console.log();

  const query = ONLY_USER
    ? { query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings) AND c.userId = @u", parameters: [{ name: "@u", value: ONLY_USER }] }
    : { query: "SELECT * FROM c WHERE IS_DEFINED(c.holdings)" };
  const { resources: docs } = await container.items.query(query).fetchAll();

  // -- Scan ---------------------------------------------------------------
  const plan = [];
  let intendedTrails = 0, intendedPoints = 0, corpusTrails = 0, corpusPoints = 0;
  for (const doc of docs) {
    const holdings = doc.holdings || {};
    const trails = doc.priceHistoryByHolding || {};
    const orphanIds = [];
    let orphanPoints = 0, totalPoints = 0;
    for (const [id, pts] of Object.entries(trails)) {
      const count = Array.isArray(pts) ? pts.length : 0;
      totalPoints += count;
      corpusPoints += count;
      corpusTrails += 1;
      // An orphan is a trail whose holding is no longer in the map. That is
      // the whole test: the holdings map IS the set of live holdings.
      if (!(id in holdings)) { orphanIds.push(id); orphanPoints += count; }
    }
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    if (orphanIds.length > 0) {
      intendedTrails += orphanIds.length;
      intendedPoints += orphanPoints;
    }
    plan.push({
      doc, userId: doc.userId, bytes,
      pctOfCeiling: Number(((bytes / CEILING) * 100).toFixed(1)),
      holdings: Object.keys(holdings).length,
      trails: Object.keys(trails).length,
      orphanIds, orphanPoints, totalPoints,
    });
  }

  plan.sort((a, b) => b.orphanPoints - a.orphanPoints || b.bytes - a.bytes);

  console.log(`Scanned ${n(docs.length)} user docs -- ${n(corpusTrails)} trails, ${n(corpusPoints)} points total.`);
  console.log(`ORPHANED: ${n(intendedTrails)} trails carrying ${n(intendedPoints)} points (${pct(intendedPoints, corpusPoints)}% of all stored points).`);
  console.log();
  console.log("Per user (largest orphan payload first; docs over 50% of ceiling always listed):");
  console.log("  userId                                            bytes  %ceil   hold  trails  orphan     pts");
  for (const p of plan) {
    if (p.orphanIds.length === 0 && p.pctOfCeiling < 50) continue;
    console.log(
      `  ${String(p.userId).padEnd(44)} ${String(n(p.bytes)).padStart(9)} ${String(p.pctOfCeiling).padStart(5)}% `
      + `${String(p.holdings).padStart(6)} ${String(p.trails).padStart(7)} ${String(p.orphanIds.length).padStart(7)} ${String(n(p.orphanPoints)).padStart(7)}`,
    );
  }
  console.log();

  if (!APPLY) {
    const affected = plan.filter((p) => p.orphanIds.length > 0).length;
    console.log(`REPORT-ONLY -- ${n(intendedTrails)} orphaned trails (${n(intendedPoints)} points) would be reaped across ${n(affected)} users.`);
    console.log("Nothing was written. Re-dispatch with apply=true to reap.");
    return { client, budget: CLOCK };
  }

  // -- Apply --------------------------------------------------------------
  let written = 0, skipped = 0, failed = 0, pointsReaped = 0;
  // Trails the budget never reached. NOT failures and NOT skips: nothing was
  // written and nothing was decided about them, so they are their own line in
  // the reconcile and the relaunch is what settles them.
  let notReached = 0;
  let stoppedAtBudget = false;
  const work = plan.filter((p) => p.orphanIds.length > 0);
  for (let i = 0; i < work.length; i++) {
    const p = work[i];
    // THE PRE-CHECK: before the document, never after it. `outOfClock()` is
    // true when less than the reserve remains, so the user doc that would
    // overrun is never STARTED. A check after the write admits one more
    // whole-document replace past expiry -- the loop-top defect #1799 named.
    if (CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      for (let j = i; j < work.length; j++) notReached += work[j].orphanIds.length;
      break;
    }
    try {
      for (const id of p.orphanIds) delete p.doc.priceHistoryByHolding[id];
      await container.item(p.doc.id, p.userId).replace(p.doc);

      // Verify by read (CF-VERIFY-THE-WRITE-NOT-THE-RUN): re-read the doc and
      // count what remains. A write that silently did not land, or landed
      // partially, is counted as FAILED, never as written.
      const { resource: after } = await container.item(p.doc.id, p.userId).read();
      const liveHoldings = after.holdings || {};
      const remaining = Object.keys(after.priceHistoryByHolding || {})
        .filter((id) => !(id in liveHoldings));
      if (remaining.length > 0) {
        failed += p.orphanIds.length;
        console.error(`  FAILED  ${p.userId}: ${remaining.length} orphans still present after the write landed`);
        continue;
      }
      const afterBytes = Buffer.byteLength(JSON.stringify(after));
      written += p.orphanIds.length;
      pointsReaped += p.orphanPoints;
      console.log(
        `  reaped  ${p.userId}  ${p.orphanIds.length} trails / ${n(p.orphanPoints)} points  `
        + `${n(p.bytes)} -> ${n(afterBytes)} bytes (${((afterBytes / CEILING) * 100).toFixed(1)}% of ceiling)`,
      );
    } catch (err) {
      failed += p.orphanIds.length;
      console.error(`  FAILED  ${p.userId}: ${err?.message ?? String(err)}`);
    }
  }

  console.log();
  console.log(`Reaped ${n(written)} trails / ${n(pointsReaped)} points.`);
  console.log(`Not reached (budget): ${n(notReached)} trails -- the relaunch settles these.`);
  // A PARTIAL RUN STILL RECONCILES. The identity holds over what the loop
  // CONSIDERED, not over the scan, or a budget stop reads as lost trails.
  console.log(`  reconciled: intended ${n(intendedTrails)} = written ${n(written)} + skipped ${n(skipped)} `
    + `+ failed ${n(failed)} + not reached ${n(notReached)}`);
  if (written + skipped + failed + notReached !== intendedTrails) {
    console.error("  !! RECONCILE MISMATCH -- a trail was neither written, skipped, failed nor deferred");
    process.exitCode = 4;
  }
  // intended = every orphaned trail the scan found; each one is written,
  // skipped or failed. skipped stays 0: this lane holds nothing back, so a
  // non-zero skip would mean a trail vanished between the scan and the write.
  reportWrites({
    job: "reap-orphan-price-trails",
    intended: intendedTrails,
    written,
    skipped: skipped + notReached,
    failed,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps stdout for
  // `stopped at the .*budget`, so the phrase is a SOURCE LITERAL rather than
  // assembled from variables: a marker built by concatenation is one a
  // refactor can silently reword, and a reworded marker ends the fan-out after
  // one slice with the run green.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${n(notReached)} trails not reached; the relaunch continues from here`);
    console.log("  the reap is IDEMPOTENT: a trail already deleted is no longer an orphan on"
      + " the next scan, so the continuation re-derives cheaply and writes only what is left.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a
// failure path that exits and a success path that hopes is the asymmetry that
// cost four reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => { console.error(e); await finishLane(1, { budget: CLOCK }); });
