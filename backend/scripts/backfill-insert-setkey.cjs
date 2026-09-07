#!/usr/bin/env node
// CF-BACKFILL-INSERT-SETKEY (Drew, 2026-07-30). Move insert cards
// out of the base-product FMV pool by rewriting setKey to a compound
// form. Example:
//   OLD: hiq:baseball:2024:bowman:btp-10:refractor:no-auto
//   NEW: hiq:baseball:2024:bowman-scouts-top-100:btp-10:refractor:no-auto
//
// Detection via detectInsertSet(cardNumber) which returns the insert
// slug when the cardNumber prefix matches Drew's curated baseball
// insert vocabulary (BTP/BSP/DPP/MR/TT/54F/HRC/SMLB/CC/HA/FS/USC/NAP/
// TAN/BF/NF/GOAT + anniversary regex).
//
// Surgical rewrite: split old slug on ":", replace setKey slot (3)
// only, join back. Preserves cardNumber/parallel/isAuto/printRun.
// Bypasses normalizeSetKey which would otherwise collapse the compound
// back to the base product.
//
// Guardrails:
//   - Skip when detectInsertSet returns null
//   - Skip when new setKey already contains the insert slug (idempotent)
//   - Only touch baseball rows (that's Drew's vocab scope)
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=200000       — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { detectInsertSet } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane REWRITES hobbyiqCardId on
// sold_comps rows -- it MOVES a sale from one comp pool to another -- and
// declared no budget at all. Before this it could only ever end by being
// KILLED at the 150-minute ceiling: no marker, no reconcile, no finishLane
// line, and #1913's KILLED branch then withholding the re-dispatch. A sweep
// killed mid-patch leaves a product's insert cards SPLIT across two pools,
// which is the split-pool-wrong-FMV failure this rewrite exists to end
// (feedback_one_card_one_row_one_pool).
//
// TWO UNITS, TWO SIZES. The scan's unit is one 5,000-row page of a PROJECTION
// (four scalar fields, no documents); the write's unit is ONE patch of a single
// slug field. The reserve is sized to the LARGER: 60 seconds covers a 5,000-row
// projection page against a throttling container with room to spare, and any
// single patch many times over.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE. The new setKey is
// detectInsertSet(row.cardNumber) appended to the row's OWN existing setKey
// slot -- every input is the ROW IN HAND, with no reference to any other row,
// no group, no vote and no ratio. A stop costs coverage, never correctness,
// which is what separates this lane from the four on this wave that REFUSE
// their write phase after a scan stop.
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
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-insert-setkey]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // Enumerate every insert prefix. STARTSWITH-based Cosmos filter;
  // JS-side detectInsertSet is the strict test.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.cardNumber
    FROM c
    WHERE c.sport = "baseball"
      AND IS_STRING(c.cardNumber)
      AND LENGTH(c.cardNumber) > 3
      AND (
        STARTSWITH(c.cardNumber, "BTP-", true) OR
        STARTSWITH(c.cardNumber, "BSP-", true) OR
        STARTSWITH(c.cardNumber, "DPP-", true) OR
        STARTSWITH(c.cardNumber, "MR-", true) OR
        STARTSWITH(c.cardNumber, "TT-", true) OR
        STARTSWITH(c.cardNumber, "54F-", true) OR
        STARTSWITH(c.cardNumber, "HRC-", true) OR
        STARTSWITH(c.cardNumber, "SMLB-", true) OR
        STARTSWITH(c.cardNumber, "CC-", true) OR
        STARTSWITH(c.cardNumber, "HA-", true) OR
        STARTSWITH(c.cardNumber, "FS-", true) OR
        STARTSWITH(c.cardNumber, "USC-", true) OR
        STARTSWITH(c.cardNumber, "NAP-", true) OR
        STARTSWITH(c.cardNumber, "TAN-", true) OR
        STARTSWITH(c.cardNumber, "BF-", true) OR
        STARTSWITH(c.cardNumber, "NF-", true) OR
        STARTSWITH(c.cardNumber, "GOAT-", true)
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
  console.log(`\r  ${rows.length} baseball rows with insert-prefix cardNumber.        \n`);

  const patches = [];
  const dist = {};
  let noInsert = 0, alreadyCompound = 0, invalidSlug = 0;

  for (const r of rows) {
    const insertSlug = detectInsertSet(r.cardNumber);
    if (!insertSlug) { noInsert++; continue; }

    const parts = String(r.hobbyiqCardId ?? "").split(":");
    // Expected canonical slug shape: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N]
    if (parts.length < 7) { invalidSlug++; continue; }
    const oldSetKey = parts[3];
    if (!oldSetKey) { invalidSlug++; continue; }
    // Idempotent: if setKey already ends with the insert slug, skip.
    if (oldSetKey.endsWith(`-${insertSlug}`)) { alreadyCompound++; continue; }
    // Also skip if setKey already contains the insert slug fragment
    // (defensive against reorderings).
    if (oldSetKey.includes(insertSlug)) { alreadyCompound++; continue; }

    // Compose new setKey: `${old}-${insertSlug}`
    const newSetKey = `${oldSetKey}-${insertSlug}`;
    const newParts = parts.slice();
    newParts[3] = newSetKey;
    const newSlug = newParts.join(":");

    dist[newSetKey] = (dist[newSetKey] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug, cardNumber: r.cardNumber });
  }

  console.log(`  no insert:       ${noInsert}`);
  console.log(`  already compound:${alreadyCompound}`);
  console.log(`  invalid slug:    ${invalidSlug}`);
  console.log(`  Ready to patch:  ${patches.length}\n`);
  console.log(`  New setKey distribution (top 25):`);
  Object.entries(dist)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 25)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(6)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 8:`);
    patches.slice(0, 8).forEach(p =>
      console.log(`    ${p.cardNumber.padEnd(10)}  ${p.oldSlug}\n                → ${p.newSlug}`)
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
  // See THE CLOCK above for why a partial scan is safe to write from here
  // (each row's new setKey comes from its own cardNumber and its own slug).
  // What is NOT safe is STARTING the patch train past expiry: that is the
  // "one more unit" defect at phase granularity, so entry is gated.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the scan consumed it; ${patches.length} patches were NOT STARTED and the relaunch`
      + ` continues from here`);
    console.log("  nothing was written. The rewrite is idempotent -- a row whose setKey already"
      + " carries the insert slug is skipped as `already compound` -- so the next pass re-derives"
      + " this same plan and spends its clock writing it.");
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
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${done} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // RECONCILE OVER THE KNOWN PLAN. `patches` was built before the first write,
  // so the population is known and `not reached` is a real number rather than
  // an invention (#1947: the two reconciliation shapes are not interchangeable).
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
    job: "backfill-insert-setkey",
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
    console.log("  the rewrite is IDEMPOTENT: a row whose setKey slot already ends with the insert"
      + " slug is skipped as `already compound`, so the continuation never re-writes what this"
      + " pass already landed.");
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
