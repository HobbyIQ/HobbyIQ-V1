#!/usr/bin/env node
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ DISARMED 2026-08-20. DO NOT RUN WITH BACKFILL_APPLY=true.                │
// └──────────────────────────────────────────────────────────────────────────┘
//
// CF-DISARM-PARALLEL-ENRICHMENT. This script re-derives the WHOLE slug through
// computeHobbyIqCardId, not just the parallel segment its name advertises. Its
// dry run on 2026-08-19 was caught pushing
//
//     hiq:baseball:2026:bowman:cpa-eha:...   ->   ...:bowman-chrome:cpa-eha:...
//
// which would have re-split the CPA- pool that had just been merged hours
// earlier — the very split that priced a gold CPA-MG auto at $6.90 against $187
// paid. A full re-derive is only as good as the vendor title, and vendor titles
// routinely omit a setKey or parallel the existing slug already had right.
//
// It also earns almost nothing now. Re-running it over 20,000 candidate rows
// improved 6, because the 2026-07-30 pass already harvested what the parser can
// see. The remaining "base with a colour in the title" rows are not recoverable
// from text: the parallel is absent at the SOURCE (identical generic titles
// across a $1.25-$725 spread), which is why the colour work moved to the image
// path.
//
// Left in the tree rather than deleted because the dry-run output is useful
// evidence and the measurement above should not have to be redone. If parallel
// enrichment is wanted again, it must patch ONLY the parallel segment and carry
// every other segment across untouched — the shape reslug-setkey-segment uses.
//
// The guard below refuses to write. Removing it is a decision, not an accident.
if (process.env.BACKFILL_APPLY === "true" && process.env.I_HAVE_READ_CF_DISARM !== "yes") {
  console.error([
    "",
    "REFUSING TO RUN: backfill-parallel-enrichment is disarmed.",
    "",
    "It re-derives the ENTIRE slug, not just the parallel, and was caught in dry",
    "run pushing bowman:cpa-eha back to bowman-chrome:cpa-eha — re-splitting a",
    "pool merged hours earlier. It also improved only 6 rows in 20,000.",
    "",
    "If you truly intend this, read the header, then set:",
    "  I_HAVE_READ_CF_DISARM=yes",
    "",
  ].join("\n"));
  // CF-A-KILLED-RUN-IS-NOT-A-FINISHED-RUN (#1906/#1913/#1955). This refusal is
  // ABOVE every require -- it is the first thing the file does -- so there is
  // no CLOCK and no finishLane() to route through yet, and calling one would
  // mean loading the SDK to reject a dispatch. But the relaunch step reads the
  // log, not the source: a step that exits 1 having printed NEITHER the budget
  // marker NOR a finishLane line is classified KILLED, and the operator is sent
  // to investigate a crash that is actually this file refusing on purpose. So
  // the guard writes the SAME operator proof finishLane writes, with the same
  // synchronous writeSync (a buffered write on a wedged pipe is exactly what
  // could not be relied on to arrive), and the step lands on the VERDICT arm
  // where it belongs.
  require("node:fs").writeSync(1, "finishLane: exiting code 1\n");
  process.exit(1);
}
//
// CF-BACKFILL-PARALLEL-ENRICHMENT (Drew, 2026-07-30). 56,510 rows have
// parallel="Base" but title mentions a color word ("gold", "red",
// "orange", "purple", "pink"). Re-run extractParallel via
// parseListingIdentity and patch when it returns non-"Base".
//
// Rewrites both /parallel AND /hobbyiqCardId (parallel is slot 5).
// Only-improve guardrail: new parallel must be MORE specific than old
// (never demote a colored refractor to Base).
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=100000       — max rows scanned per pass

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
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane is DISARMED for APPLY (see
// the header), so its reachable mode is the dry run -- and a dry run is still a
// step that can be killed at the 150-minute ceiling. Its scan is every
// Base/Refractor row whose title contains any of twenty-two colour words, which
// is a very large fraction of the container: before this, the dry run's own
// evidence -- the distribution and the samples the header calls "useful
// evidence" -- was printed only if the scan happened to finish, and lost
// entirely if it did not. A budget is what makes the report survivable.
//
// It is budgeted rather than de-listed because de-listing is not available:
// the lane is on the runner's dropdown, and a lane anybody can dispatch has to
// be able to stop (feedback: a whole-source retire needs its name).
//
// TWO UNITS, TWO SIZES. The scan's unit is one 5,000-row page of a PROJECTION
// (eleven scalar fields, no documents); the write's unit -- reachable only past
// the disarm guard -- is ONE patch of two fields. 60 seconds covers the larger
// against a throttling container.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: parseListingIdentity reads the
// ROW IN HAND's own title -- no group, no vote, no ratio. (That the FULL
// re-derive it then performs is wrong for a different reason is what the disarm
// guard above is for; the budget does not change that verdict either way.)
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1 + 1 + 1 = 113m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "100000");

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

  console.log(`[backfill-parallel-enrichment]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // parallel is base + title mentions a color word (broad Cosmos-side
  // filter; parseListingIdentity is the strict per-row extractor).
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE (c.parallel = "Base" OR c.parallel = "base" OR c.parallel = "Refractor")
      AND IS_STRING(c.title)
      AND (
        CONTAINS(LOWER(c.title),"gold") OR
        CONTAINS(LOWER(c.title),"red ") OR CONTAINS(LOWER(c.title),"red/") OR
        CONTAINS(LOWER(c.title),"orange") OR
        CONTAINS(LOWER(c.title),"purple") OR
        CONTAINS(LOWER(c.title),"pink") OR
        CONTAINS(LOWER(c.title),"blue ") OR CONTAINS(LOWER(c.title),"blue/") OR
        CONTAINS(LOWER(c.title),"green") OR
        CONTAINS(LOWER(c.title),"aqua") OR
        CONTAINS(LOWER(c.title),"yellow") OR
        CONTAINS(LOWER(c.title),"black") OR
        CONTAINS(LOWER(c.title),"sapphire") OR
        CONTAINS(LOWER(c.title),"shimmer") OR
        CONTAINS(LOWER(c.title),"lava") OR
        CONTAINS(LOWER(c.title),"wave") OR
        CONTAINS(LOWER(c.title),"speckle") OR
        CONTAINS(LOWER(c.title),"mojo") OR
        CONTAINS(LOWER(c.title),"mega") OR
        CONTAINS(LOWER(c.title),"xfractor") OR
        CONTAINS(LOWER(c.title),"x-fractor") OR
        CONTAINS(LOWER(c.title),"superfractor") OR
        CONTAINS(LOWER(c.title),"prizm")
      )
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
  console.log(`\r  ${rows.length} base/refractor rows with color-word in title.        \n`);

  const patches = [];
  const dist = {};
  let noImprovement = 0, computeFailed = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    const parsed = parseListingIdentity(title);
    const newParallel = parsed.parallel;
    const oldParallel = String(r.parallel || "").toLowerCase();

    // Skip if extractor returned Base or same as current.
    if (!newParallel || newParallel.toLowerCase() === "base") { noImprovement++; continue; }
    if (newParallel.toLowerCase() === oldParallel) { noImprovement++; continue; }
    // Only-improve: new must be strictly more specific.
    // Reject if new is bare "Refractor" but old was already "Refractor".
    if (oldParallel === "refractor" && newParallel.toLowerCase() === "refractor") { noImprovement++; continue; }

    // CF-CROSS-PRODUCT-MIS-SLUG-FIX (Drew, 2026-07-30). Never default to
    // "bowman" — that silent fallback was landing Panini/Topps rows in
    // the Bowman namespace. Precedence: title-derived (source of truth)
    // > existing slug's setKey > skip.
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
        parallel: newParallel,
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noImprovement++; continue; }

    dist[newParallel] = (dist[newParallel] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId, newSlug,
      newParallel,
    });
  }

  console.log(`  no improvement:  ${noImprovement}`);
  console.log(`  compute failed:  ${computeFailed}`);
  console.log(`  Ready to patch:  ${patches.length}\n`);
  console.log(`  New parallel distribution (top 20):`);
  Object.entries(dist)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([p, c]) => console.log(`    ${String(c).padStart(5)}  ${p}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p =>
      console.log(`    ${p.newParallel}\n      ${p.oldSlug}\n      → ${p.newSlug}`)
    );
  }

  if (scanStoppedAtBudget) {
    console.log(`  the scan was CUT SHORT by the budget: ${rows.length} rows were read, which is`
      + ` NOT the whole population. The distribution above covers only those.`);
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
    console.log("  nothing was written.");
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
      { op: "set", path: "/parallel", value: p.newParallel },
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
    job: "backfill-parallel-enrichment",
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
