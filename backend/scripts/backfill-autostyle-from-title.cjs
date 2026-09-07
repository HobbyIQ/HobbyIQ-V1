#!/usr/bin/env node
// CF-BACKFILL-AUTOSTYLE-FROM-TITLE (Drew, 2026-07-30). 236,913 rows
// have isAuto=true but autoStyle=null. Parser's extractAutoStyle
// detects "on card"/"on-card"/"hard signed" (→ on-card) or "sticker"/
// "sticker auto" (→ sticker) from title text. Backfill applies this
// to historic rows where the field is null.
//
// On-card vs sticker matters: 15-30% FMV differential on premium autos
// (Bowman Chrome Prospect Autos, Topps Chrome Rookie Autos are
// on-card; older Panini autos are often sticker).
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=300000       — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane PATCHES sold_comps rows
// (autoStyle, which the docblock above prices at a 15-30% FMV differential on
// premium autos) and declared no budget at all. BACKFILL_LIMIT caps how many
// rows it SCANS -- 300,000 by default -- but a row cap is not a clock: 300,000
// patches at a throttled moment take however long they take, so before this the
// lane could only ever end by being KILLED at the ceiling with no marker, no
// reconcile and no finishLane line.
//
// THIS LANE IS SCAN-THEN-WRITE, and both phases are on the clock.
//
//   THE SCAN gathers the whole population into memory first (`rows.push(...)`
//   over every page) before a single patch is issued. Its unit is one page of
//   up to 5,000 rows.
//
//   THE WRITE unit is ONE PATCH -- a point write on (id, cardId) -- dispatched
//   through a CONCURRENCY-wide (default 16) worker pool. 90 seconds
//   comfortably exceeds one patch plus the pool's drain, and it is checked
//   BEFORE the patch is handed to a worker.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE here, which is why the write
// phase PROCEEDS on one where dedupe-catalog-by-hobbyiq and
// fix-catalog-parallel-as-player (this same change) must REFUSE: every decision
// is made from the ROW IN HAND -- parseListingIdentity reads that row's own
// title and nothing else -- so a row the scan never reached is simply not in
// this pass's plan. It is not a missing input to some other row's answer. The
// scan's own stop is still reported, so the operator never reads a short
// population as the whole one.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "300000");

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-autostyle-from-title]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // isAuto=true + autoStyle null + has title
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.title, c.rawTitle
    FROM c
    WHERE c.isAuto = true
      AND (NOT IS_DEFINED(c.autoStyle) OR c.autoStyle = null)
      AND IS_STRING(c.title)
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  let scanStoppedAtBudget = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is buffered.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} isAuto=true + autoStyle=null rows fetched.        \n`);

  const patches = [];
  const dist = { "on-card": 0, "sticker": 0 };
  let noHint = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    const parsed = parseListingIdentity(title);
    if (parsed.autoStyle == null) { noHint++; continue; }
    dist[parsed.autoStyle] = (dist[parsed.autoStyle] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, autoStyle: parsed.autoStyle });
  }

  console.log(`  no autoStyle hint in title: ${noHint}`);
  console.log(`  Ready to patch:              ${patches.length}`);
  console.log(`    on-card: ${dist["on-card"]}`);
  console.log(`    sticker: ${dist["sticker"]}\n`);

  if (patches.length > 0) {
    console.log(`  Sample 5:`);
    patches.slice(0,5).forEach(p =>
      console.log(`    ${p.autoStyle.padEnd(8)} ${p.id.slice(0,8)}`)
    );
  }

  if (scanStoppedAtBudget) {
    console.log(`  the scan was CUT SHORT by the budget: ${rows.length} rows were read, which is`
      + ` NOT the whole population. The plan below covers only those.`);
  }

  if (!APPLY || patches.length === 0) {
    if (!APPLY) console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
    if (scanStoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `the scan is UNFINISHED; the relaunch continues from here`);
    }
    return { client, budget: CLOCK };
  }

  // -- THE WRITE PHASE IS GATED ON THE CLOCK, NOT REFUSED ------------------
  //
  // See THE CLOCK above for why a partial scan is safe to write from here (each
  // row's answer comes from its own title). What is NOT safe is STARTING the
  // patch train past expiry: that is #1947's "one more unit" defect at phase
  // granularity, so entry is gated.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the scan consumed it; ${patches.length} patches were NOT STARTED and the relaunch`
      + ` continues from here`);
    console.log("  nothing was written. The scan query selects only rows whose autoStyle is absent"
      + " or null, so the next pass re-derives this same plan and spends its clock writing it.");
    return { client, budget: CLOCK };
  }

  console.log(`\n  Applying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  let writeStoppedAtBudget = false;
  let notReached = 0;
  const result = await runInParallel(patches, async (p) => {
    // THE PRE-CHECK, inside the worker so it governs the RUN and not one wave:
    // a worker that finds the clock gone stops taking work instead of draining
    // the whole remaining plan past expiry.
    if (CLOCK.outOfClock()) { writeStoppedAtBudget = true; notReached++; return; }
    // autoStyle doesn't affect slug — patch field only.
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/autoStyle", value: p.autoStyle },
    ]);
    done++;
    if (done % 1000 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${done} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // RECONCILE OVER THE KNOWN PLAN. `patches` was built before the first write,
  // so the population is known and `not reached` is a real number rather than an
  // invention (#1947: the two reconciliation shapes are not interchangeable).
  //
  // NOTE `result.ok` is NOT the written count: runInParallel counts a worker
  // callback that did not throw, which includes the budget-stopped early return
  // above. `done` is incremented only after the patch itself resolves.
  console.log(`  reconciled: intended ${patches.length} = written ${done}`
    + ` + failed ${result.err} + not reached ${notReached}`);
  if (done + result.err + notReached !== patches.length) {
    console.error("  !! RECONCILE MISMATCH -- a planned patch was neither written, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "backfill-autostyle-from-title",
    intended: patches.length, written: done, skipped: notReached, failed: result.err,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (writeStoppedAtBudget || scanStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the patch is IDEMPOTENT: the scan selects only rows whose autoStyle is absent or"
      + " null, and a patched row has neither, so the continuation never re-writes what this pass"
      + " already landed.");
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
