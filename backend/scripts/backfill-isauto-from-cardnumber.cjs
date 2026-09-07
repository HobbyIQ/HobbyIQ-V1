#!/usr/bin/env node
// CF-BACKFILL-ISAUTO-FROM-CARDNUMBER (Drew, 2026-07-30). Fix
// historic sold_comps rows where the parser stored isAuto=false but
// the cardNumber prefix is on the confident-auto list
// (isCardNumberAutoSubset). These rows have wrong FMV placement
// because raw pool includes autos; correcting isAuto=true splits
// them into the right pool AND rewrites the slug (autoFlag is in
// slot 6 of hobbyiqCardId).
//
// Also re-slugs so /hobbyiqCardId reflects the new isAuto flag.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   BACKFILL_APPLY=true       — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16   — parallel patches
//   BACKFILL_LIMIT=100000     — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { isCardNumberAutoSubset } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane flips isAuto and REWRITES
// hobbyiqCardId -- autoFlag is slot 6, so every patch MOVES a sale from the raw
// pool into the auto pool -- and declared no budget at all. Before this it
// could only ever end by being KILLED at the 150-minute ceiling: no marker, no
// reconcile, no finishLane line, and #1913's KILLED branch then withholding the
// re-dispatch, leaving one product's autos split across two pools.
//
// THE SCAN HAD NO UNIT AT ALL, WHICH IS THE DEFECT WORTH NAMING. It was a
// single `.fetchAll()` -- the SDK drains every page internally and hands back
// one array -- so there was no point in the source at which a clock COULD be
// checked, only a call that returns when it returns. A budget bolted onto that
// shape would have been decorative. The scan is now the ordinary
// hasMoreResults/fetchNext page walk its three sibling lanes use, which is what
// makes the pre-check below possible rather than merely present.
//
// TWO UNITS, TWO SIZES. The scan's unit is one 5,000-row page of a PROJECTION
// (eight scalar fields, no documents); the write's unit is ONE patch of two
// fields. 60 seconds covers the larger against a throttling container.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: isCardNumberAutoSubset reads the
// ROW IN HAND's own cardNumber and the new slug re-uses the row's own setKey
// slot -- no group, no vote, no ratio, no reference to any other row. A stop
// costs coverage, never correctness.
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

  console.log(`[backfill-isauto-from-cardnumber]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  scan-limit: ${LIMIT}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // Cosmos SQL: STARTSWITH is per-prefix; enumerate every auto prefix
  // from Drew's curated baseball list (2026-07-30). The JS-side
  // isCardNumberAutoSubset re-verifies each row, so any prefix that
  // ambiguously matches (e.g. "PA-*" is also a common Panini pattern)
  // will still be routed through the strict letter-boundary regex
  // check before we touch the row.
  //
  // Note: Cosmos SQL has ~256 arg limit; enumerating ~55 prefixes as
  // STARTSWITH ORs stays well under. Two-char prefixes (BA/PA/RA/etc.)
  // will over-match at the Cosmos level (e.g. "BA-14" AND "BASEBALL"),
  // but the LENGTH > 3 filter + JS-side regex rejects false positives.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun
    FROM c
    WHERE c.isAuto = false
      AND c.sport = "baseball"
      AND IS_STRING(c.cardNumber)
      AND LENGTH(c.cardNumber) > 3
      AND (
        STARTSWITH(c.cardNumber, "CPATWH", true) OR
        STARTSWITH(c.cardNumber, "CPALD", true) OR
        STARTSWITH(c.cardNumber, "APDCA", true) OR
        STARTSWITH(c.cardNumber, "54FAV", true) OR
        STARTSWITH(c.cardNumber, "FFDA", true) OR
        STARTSWITH(c.cardNumber, "CUSA", true) OR
        STARTSWITH(c.cardNumber, "SCCA", true) OR
        STARTSWITH(c.cardNumber, "CCAR", true) OR
        STARTSWITH(c.cardNumber, "RODA", true) OR
        STARTSWITH(c.cardNumber, "ROTA", true) OR
        STARTSWITH(c.cardNumber, "TTAR", true) OR
        STARTSWITH(c.cardNumber, "DPPA", true) OR
        STARTSWITH(c.cardNumber, "BSPA", true) OR
        STARTSWITH(c.cardNumber, "BCPA", true) OR
        STARTSWITH(c.cardNumber, "BCRA", true) OR
        STARTSWITH(c.cardNumber, "TCRA", true) OR
        STARTSWITH(c.cardNumber, "B96A", true) OR
        STARTSWITH(c.cardNumber, "BGA-", true) OR
        STARTSWITH(c.cardNumber, "MRA-", true) OR
        STARTSWITH(c.cardNumber, "UAC-", true) OR
        STARTSWITH(c.cardNumber, "BSA-", true) OR
        STARTSWITH(c.cardNumber, "FSA-", true) OR
        STARTSWITH(c.cardNumber, "CPA-", true) OR
        STARTSWITH(c.cardNumber, "CDA-", true) OR
        STARTSWITH(c.cardNumber, "CRA-", true) OR
        STARTSWITH(c.cardNumber, "BPA-", true) OR
        STARTSWITH(c.cardNumber, "CBA-", true) OR
        STARTSWITH(c.cardNumber, "CCA-", true) OR
        STARTSWITH(c.cardNumber, "USA-", true) OR
        STARTSWITH(c.cardNumber, "DAS-", true) OR
        STARTSWITH(c.cardNumber, "NTS-", true) OR
        STARTSWITH(c.cardNumber, "SSM-", true) OR
        STARTSWITH(c.cardNumber, "DCA-", true) OR
        STARTSWITH(c.cardNumber, "CAA-", true) OR
        STARTSWITH(c.cardNumber, "GQA-", true) OR
        STARTSWITH(c.cardNumber, "AGA-", true) OR
        STARTSWITH(c.cardNumber, "ROA-", true) OR
        STARTSWITH(c.cardNumber, "FAR-", true) OR
        STARTSWITH(c.cardNumber, "FFA-", true) OR
        STARTSWITH(c.cardNumber, "BOA-", true) OR
        STARTSWITH(c.cardNumber, "T1A-", true) OR
        STARTSWITH(c.cardNumber, "SCA-", true) OR
        STARTSWITH(c.cardNumber, "PPA-", true) OR
        STARTSWITH(c.cardNumber, "ODA-", true) OR
        STARTSWITH(c.cardNumber, "IAP-", true) OR
        STARTSWITH(c.cardNumber, "UAR-", true) OR
        STARTSWITH(c.cardNumber, "BA-", true) OR
        STARTSWITH(c.cardNumber, "PA-", true) OR
        STARTSWITH(c.cardNumber, "RA-", true) OR
        STARTSWITH(c.cardNumber, "FA-", true) OR
        STARTSWITH(c.cardNumber, "TA-", true) OR
        STARTSWITH(c.cardNumber, "AA-", true) OR
        STARTSWITH(c.cardNumber, "AP-", true)
      )
  `;
  // PAGED, NOT fetchAll(). See THE CLOCK above: fetchAll drains every page
  // inside the SDK and returns one array, which leaves no seam for a clock
  // check. The page walk is what makes the pre-check real.
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
  console.log(`\r  Fetched ${rows.length} isAuto=false rows with candidate cardNumber prefixes.        \n`);

  const patches = [];
  const prefixDist = {};
  let skipped = 0;

  for (const r of rows) {
    // Belt-and-braces: JS-side confirm the cardNumber really matches the rule.
    if (!isCardNumberAutoSubset(r.cardNumber)) { skipped++; continue; }
    // CF-CROSS-PRODUCT-MIS-SLUG-FIX (Drew, 2026-07-30). Never default to
    // "bowman" — preserve existing slug's setKey, skip if the row has no
    // slug at all (fresh-write path shouldn't be reached from this script).
    const setKey = (r.hobbyiqCardId || "").split(":")[3] || null;
    if (!setKey) { skipped++; continue; }

    // Recompute slug with isAuto=true.
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear),
        setKey,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: true,
        printRun: r.printRun ?? null,
      });
    } catch { skipped++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { skipped++; continue; }

    const px = String(r.cardNumber).toUpperCase().replace(/^#/, "").split("-")[0];
    prefixDist[px] = (prefixDist[px] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug });
  }

  console.log(`  Ready to patch: ${patches.length}`);
  console.log(`  Skipped (rule mismatch or no slug change): ${skipped}\n`);
  console.log(`  Prefix distribution:`);
  Object.entries(prefixDist)
    .sort((a,b) => b[1]-a[1])
    .forEach(([p,c]) => console.log(`    ${p.padEnd(10)} ${c}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p => console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`));
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
  // cardNumber); STARTING the patch train past expiry is not.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the scan consumed it; ${patches.length} patches were NOT STARTED and the relaunch`
      + ` continues from here`);
    console.log("  nothing was written. The scan selects only isAuto=false rows, and a patched row"
      + " is isAuto=true, so the next pass re-derives a plan over what is left.");
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
      { op: "set", path: "/isAuto", value: true },
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
    job: "backfill-isauto-from-cardnumber",
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
    console.log("  the patch is IDEMPOTENT: the scan selects only isAuto=false rows, and a patched"
      + " row is isAuto=true, so the continuation never re-writes what this pass already landed.");
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
