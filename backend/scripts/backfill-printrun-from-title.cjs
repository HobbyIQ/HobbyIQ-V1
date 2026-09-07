#!/usr/bin/env node
// CF-BACKFILL-PRINTRUN-FROM-TITLE (Drew, 2026-07-30). Extract printRun
// from vendor titles for rows where the field is null but the title
// contains a clear "/N" or "M/N" pattern. Rewrites both the printRun
// field AND the slug (num-N suffix goes in the trailing slug slot).
//
// Uses parseListingIdentity so extraction stays consistent with the
// live parser (X/Y serial → denominator; /N standalone with 1<=N<=5000
// sanity bound to avoid grabbing years like "/2024").
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16      — parallel patches
//   BACKFILL_LIMIT=200000        — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, matchKnownProductLine } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane writes printRun AND
// REWRITES hobbyiqCardId -- the num-N suffix is a slug slot, so every patch
// MOVES a sale into the numbered pool -- and declared no budget at all. Its
// scan is every printRun-null row whose title contains a "/", which is a large
// fraction of the container, so before this it could only ever end by being
// KILLED at the 150-minute ceiling: no marker, no reconcile, no finishLane
// line, and #1913's KILLED branch then withholding the re-dispatch, leaving a
// card's serial-numbered sales split across two pools.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: parseListingIdentity reads the
// ROW IN HAND's own title, and the setKey falls back to the row's own slug --
// no group, no vote, no ratio, no reference to any other row. A stop costs
// coverage, never correctness.

// TWO UNITS, TWO SIZES. The scan's unit is one 5,000-row page of a PROJECTION
// (eleven scalar fields, no documents); the write's unit is ONE patch of two
// fields. 60 seconds covers the larger against a throttling container.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1 + 1 + 1 = 113m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "200000");

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
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-printrun-from-title]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // Fetch printRun-missing rows whose title contains a "/" (necessary
  // for a print run to exist in text). Broad; JS-side extractor is
  // the strict filter.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE (NOT IS_DEFINED(c.printRun) OR c.printRun = null)
      AND IS_STRING(c.title)
      AND CONTAINS(c.title, "/")
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
  console.log(`\r  ${rows.length} printRun-null rows with "/" in title.        \n`);

  const patches = [];
  const printRunDist = {};
  let noPrintRunInTitle = 0, computeFailed = 0, noSlugChange = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    let parsed;
    try {
      parsed = parseListingIdentity(title);
    } catch { noPrintRunInTitle++; continue; }
    if (parsed.printRun == null) { noPrintRunInTitle++; continue; }

    // CF-CROSS-PRODUCT-MIS-SLUG-FIX (Drew, 2026-07-30). Never default to
    // "bowman" — that silent fallback was landing Panini/Topps rows in
    // the Bowman namespace. Precedence: title-derived > existing slug > skip.
    const setKey = matchKnownProductLine(title)
      || (r.hobbyiqCardId || "").split(":")[3]
      || null;
    if (!setKey) { computeFailed++; continue; }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear),
        setKey,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: r.isAuto === true,
        printRun: parsed.printRun,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noSlugChange++; continue; }

    printRunDist[parsed.printRun] = (printRunDist[parsed.printRun] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId, newSlug,
      newPrintRun: parsed.printRun,
    });
  }

  console.log(`  no printRun in title: ${noPrintRunInTitle}`);
  console.log(`  compute failed:       ${computeFailed}`);
  console.log(`  no slug change:       ${noSlugChange}`);
  console.log(`  Ready to patch:       ${patches.length}\n`);

  console.log(`  Print-run distribution (top 20):`);
  Object.entries(printRunDist)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([n, ct]) => console.log(`    /${String(n).padEnd(5)} ${ct}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p =>
      console.log(`    /${p.newPrintRun}: ${p.oldSlug}\n    →         ${p.newSlug}`)
    );
  }

  if (scanStoppedAtBudget) {
    console.log(`  the scan was CUT SHORT by the budget: ${rows.length} rows were read, which is`
      + ` NOT the whole population. The plan above covers only those.`);
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
  // A partial scan is safe to write from (each row's answer comes from its own
  // title); STARTING the patch train past expiry is not.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the scan consumed it; ${patches.length} patches were NOT STARTED and the relaunch`
      + ` continues from here`);
    console.log("  nothing was written. The scan selects only rows whose printRun is absent or"
      + " null, and a patched row has a number, so the next pass re-derives a plan over what"
      + " is left.");
    return { client, budget: CLOCK };
  }

  console.log(`\n  Applying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  let writeStoppedAtBudget = false;
  let notReached = 0;
  const result = await runInParallel(patches, async (p) => {
    // THE PRE-CHECK, inside the worker so it governs the RUN and not one wave.
    if (CLOCK.outOfClock()) { writeStoppedAtBudget = true; notReached++; return; }
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/printRun", value: p.newPrintRun },
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${done} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // RECONCILE OVER THE KNOWN PLAN. `patches` was built before the first write.
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
    job: "backfill-printrun-from-title",
    intended: patches.length, written: done, skipped: notReached, failed: result.err,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (writeStoppedAtBudget || scanStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the patch is IDEMPOTENT: the scan selects only rows whose printRun is absent or"
      + " null, and a patched row carries a number, so the continuation never re-writes what this"
      + " pass already landed.");
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
