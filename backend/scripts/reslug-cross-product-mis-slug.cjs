#!/usr/bin/env node
// CF-RESLUG-CROSS-PRODUCT-MIS-SLUG (Drew, 2026-07-30). Ladder audit
// surfaced rows where the slug says Bowman/Bowman-Chrome but the title
// clearly identifies as Panini / Topps Finest / etc. Root cause: three
// backfill scripts had `setKey: ... || "bowman"` as a silent fallback
// that landed cross-product rows in the Bowman namespace. Source bugs
// fixed in the same PR; this script cleans up the existing bad rows.
//
// Approach:
//   1. Scan rows where the slug's setKey slot is bowman* (any Bowman
//      variant) AND the title contains a clear non-Bowman product signal.
//   2. Derive the true setKey via matchKnownProductLine(title).
//   3. Only-improve guardrail: patch only when the derived setKey is a
//      DIFFERENT known product line (never demote a valid Bowman row to
//      unknown fallback slugify).
//   4. Rewrite hobbyiqCardId with the corrected setKey.
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
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "200000");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane REWRITES hobbyiqCardId on
// sold_comps rows -- it moves sales between comp pools, which is the input to
// every FMV -- and declared no budget at all. Its scan is a cross-partition
// CONTAINS() walk over up to BACKFILL_LIMIT (default 200,000) rows and its
// apply is a patch per row, so before this it could only ever end by being
// KILLED at the 150-minute ceiling: no marker, no reconcile, no finishLane
// line, and #1913 KILLED branch then withholding the re-dispatch.
//
// >>> A PARTIAL SCAN HERE IS SHORTER, NOT WRONG, AND THAT IS WHY THIS LANE
// >>> DOES NOT REFUSE ITS WRITE PHASE.
//
// The distinction is the one #1951 and #1970 drew for the statistic lanes.
// Those compute a per-slug median or percentile from the whole scan, so a
// partial scan yields a DIFFERENT number and every write decided against it is
// permanently wrong. Nothing here is derived across rows: each patch is
// decided from that row own title via matchKnownProductLine(), and the
// only-improve guard (derived must be a KNOWN non-bowman product line, and
// different from the existing one) reads the same way over one row as over
// 200,000. So a scan that stops early simply plans fewer patches, and the next
// run finds the rows it did not reach -- still mis-slugged, still matching the
// same query.
//
// TWO LOOPS, TWO UNITS, ONE RESERVE SIZED TO THE LARGER.
//   The SCAN unit is one 5,000-row page of an 11-field projection.
//   The APPLY unit is one CONCURRENCY-wide (default 16) batch of single-row
//   patches, checked per batch rather than per row so the pre-check cost is
//   not paid 200,000 times.
// 60 seconds covers either comfortably.
//
// VERIFY_MS is nominal: this lane reads nothing after its loops.
// Worst case 110 + 1 + 1 + 1 + 1 = 114m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// CF-RECONCILE-ON-A-REAL-SUCCESS-COUNTER. `ok` here counted a worker callback
// that did not THROW, which is not the same thing as a write that landed --
// and it is the number the summary used to print as "patched". The callback is
// now the one that increments, on the line after its own patch resolves, so
// `written` cannot outrun the container. `stop` lets the clock end the drain
// between batches without unwinding the workers.
async function runInParallel(items, worker, concurrency = CONCURRENCY, stop = () => false) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      if (stop()) return;
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err, reached: i };
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[reslug-cross-product-mis-slug]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // Query rows where slug's setKey position (slot 3, between :year: and
  // :cardNumber:) is bowman-family AND title contains a distinct
  // non-Bowman signal. The setKey slot is bracketed by two ":" — we
  // check the exact strings that would appear in a mis-slugged row.
  //
  // Slug format: hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallel}:{autoFlag}
  // We look for ":bowman:", ":bowman-chrome:", etc. in the slug string.
  //
  // Cross-product signal in title: "panini", "topps finest", "topps
  // chrome", "prizm", "select", "playoff", "score", "donruss", "optic",
  // "contenders", "immaculate", "flawless", "national treasures".
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE IS_STRING(c.hobbyiqCardId)
      AND IS_STRING(c.title)
      AND (
        CONTAINS(c.hobbyiqCardId, ":bowman:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-chrome:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-paper:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-draft:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-chrome-draft:")
      )
      AND (
        CONTAINS(LOWER(c.title), "panini") OR
        CONTAINS(LOWER(c.title), "prizm") OR
        CONTAINS(LOWER(c.title), "select") OR
        CONTAINS(LOWER(c.title), "playoff") OR
        CONTAINS(LOWER(c.title), "donruss") OR
        CONTAINS(LOWER(c.title), "optic") OR
        CONTAINS(LOWER(c.title), "contenders") OR
        CONTAINS(LOWER(c.title), "immaculate") OR
        CONTAINS(LOWER(c.title), "flawless") OR
        CONTAINS(LOWER(c.title), "national treasures") OR
        CONTAINS(LOWER(c.title), "mosaic") OR
        CONTAINS(LOWER(c.title), "obsidian") OR
        CONTAINS(LOWER(c.title), "chronicles") OR
        CONTAINS(LOWER(c.title), "topps finest") OR
        CONTAINS(LOWER(c.title), "topps chrome") OR
        CONTAINS(LOWER(c.title), "topps heritage") OR
        CONTAINS(LOWER(c.title), "stadium club") OR
        CONTAINS(LOWER(c.title), "upper deck") OR
        CONTAINS(LOWER(c.title), "fleer")
      )
  `;

  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 },
  );
  const rows = [];
  let scanStoppedAtBudget = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it. A stop
    // here is SAFE, not fatal: every patch is decided from one row own title,
    // so a shorter scan plans fewer patches and the next run finds the rest
    // still matching the same query. See THE CLOCK above.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} candidate rows found.        \n`);
  if (scanStoppedAtBudget) {
    console.log(`  !! the scan STOPPED at the budget -- this is a PARTIAL candidate set, not the whole one.`);
  }

  const patches = [];
  const setKeyDist = {};
  const bowmanBucketDist = {};
  let noSetKeyImprovement = 0, computeFailed = 0, tieAcceptedBowman = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    const existingSetKey = String(r.hobbyiqCardId || "").split(":")[3] || "";

    // Skip mis-formatted slugs.
    if (!existingSetKey) { noSetKeyImprovement++; continue; }
    if (!existingSetKey.startsWith("bowman")) { noSetKeyImprovement++; continue; }

    // Title-derived TRUE setKey.
    const derivedSetKey = matchKnownProductLine(title);
    if (!derivedSetKey) { noSetKeyImprovement++; continue; }

    // Only patch when derived is DIFFERENT and NOT a bowman-family (we're
    // fixing cross-product mis-slugs, not renaming within Bowman).
    if (derivedSetKey === existingSetKey) { noSetKeyImprovement++; continue; }
    if (derivedSetKey.startsWith("bowman")) { tieAcceptedBowman++; continue; }

    // Recompute the slug with the corrected setKey.
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear) || 0,
        setKey: derivedSetKey,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noSetKeyImprovement++; continue; }

    setKeyDist[derivedSetKey] = (setKeyDist[derivedSetKey] ?? 0) + 1;
    bowmanBucketDist[existingSetKey] = (bowmanBucketDist[existingSetKey] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      oldSetKey: existingSetKey,
      newSetKey: derivedSetKey,
      title: title.slice(0, 100),
    });
  }

  console.log(`  no setKey improvement:  ${noSetKeyImprovement}`);
  console.log(`  tie-accepted (bowman → bowman variant, skipped):  ${tieAcceptedBowman}`);
  console.log(`  compute failed:  ${computeFailed}`);
  console.log(`  Ready to patch:  ${patches.length}\n`);
  console.log(`  Corrected setKey distribution (top 20):`);
  Object.entries(setKeyDist).sort((a,b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(5)}  ${k}`));
  console.log(`\n  Original mis-slugged bucket distribution:`);
  Object.entries(bowmanBucketDist).sort((a,b) => b[1] - a[1])
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(5)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5 patches:`);
    patches.slice(0, 5).forEach(p => {
      console.log(`    ${p.oldSetKey} → ${p.newSetKey}`);
      console.log(`      old: ${p.oldSlug}`);
      console.log(`      new: ${p.newSlug}`);
      console.log(`      title: ${p.title}\n`);
    });
  }

  if (!APPLY || patches.length === 0) {
    console.log(`\n  Dry-run / no work. Re-dispatch with BACKFILL_APPLY=true to apply.`);
    if (scanStoppedAtBudget) emitMarker(0);
    return { client, budget: CLOCK };
  }

  console.log(`\n  Applying ${patches.length} patches (concurrency ${CONCURRENCY})...`);
  const t0 = Date.now();
  // A REAL success counter: incremented after the patch resolves, not by a
  // callback that merely returned.
  let written = 0;
  let applyStoppedAtBudget = false;
  const { err, reached } = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    written++;
    if (written % 500 === 0) process.stdout.write(`\r    ${written}/${patches.length} patched`);
  }, CONCURRENCY, () => {
    // THE PRE-CHECK for the apply loop, taken by each worker BEFORE it claims
    // its next patch. A stop here is safe for the same reason the scan stop is:
    // a patched row no longer matches the query, so the next run picks up
    // exactly the ones this pass did not reach.
    if (!applyStoppedAtBudget && CLOCK.outOfClock()) applyStoppedAtBudget = true;
    return applyStoppedAtBudget;
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const notReached = Math.max(0, patches.length - written - err);
  console.log(`\r    ${written}/${patches.length} patched (${secs}s)  err=${err}  not reached=${notReached}`);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  patched:  ${written}`);
  console.log(`  errors:   ${err}`);
  console.log(`  not reached (budget): ${notReached}`);

  // RECONCILE OVER THE PLAN. This lane builds its plan first, so it KNOWS its
  // denominator and reconciles the four-term way: every planned patch either
  // landed, failed, or was never reached because the clock stopped the drain.
  // Both a full run and a partial one balance (a slice is not a sibling
  // counter).
  console.log(`  reconciled: intended ${patches.length} = written ${written} + failed ${err} + not reached ${notReached}`);
  if (written + err + notReached !== patches.length) {
    console.error("  !! RECONCILE MISMATCH -- a planned patch was neither written, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "reslug-cross-product-mis-slug",
    intended: patches.length, written, skipped: notReached, failed: err,
  });

  if (scanStoppedAtBudget || applyStoppedAtBudget) emitMarker(notReached);
  return { client, budget: CLOCK };
}

// -- THE MARKER THE RELAUNCH GREPS -----------------------------------------
//
// CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
// variables. Printed from BOTH stop paths -- a scan stop with nothing applied
// still means work remains, and a dry-run scan stop means the survey itself
// was partial.
function emitMarker(notReached) {
  console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
    + `this sweep is UNFINISHED; the relaunch continues from here`);
  console.log(`  the continuation never re-reads what this pass wrote: a patched row carries its`
    + ` corrected setKey, so the only-improve guard finds derived === existing and skips it.`
    + ` ${notReached} planned patch(es) were left for the next run.`);
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
