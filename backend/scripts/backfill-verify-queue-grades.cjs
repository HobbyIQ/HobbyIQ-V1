#!/usr/bin/env node
// CF-BACKFILL-VERIFY-QUEUE-GRADES (Drew, 2026-07-29). Backfill for
// PR #928 (grade extraction) + PR #937 (PSA MINT modifier). Existing
// verify_queue entries carry input.gradeCompany/gradeValue that were
// populated at enqueue time — often BEFORE the grade parser fixes
// shipped. As a result, the triage UI still shows Grade=Raw even though
// the title clearly has "PSA MINT 9" or "PSA 8.5+".
//
// Fix: scan pending verify_queue rows where input.gradeCompany is null
// OR the current parseGradeLabel yields a different result, and patch
// input.gradeCompany + input.gradeValue.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   BACKFILL_APPLY=true       — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16   — parallel patches

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseGradeLabel } = require(path.join(backend, "dist/services/portfolioiq/gradeParser.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane patches the GRADE on
// pending verify_queue rows -- the value a human sees and confirms in triage --
// and declared no budget at all. Its scan is an UNBOUNDED cross-partition walk
// of every pending row with a title, accumulated in memory before a single
// patch is planned, with no LIMIT of any kind to bound it. Before this it could
// only ever end by being KILLED at the 150-minute ceiling: no marker, no
// reconcile, no finishLane line, and #1913's KILLED branch then withholding the
// re-dispatch.
//
// >>> A PARTIAL SCAN HERE IS SHORTER, NOT WRONG, so this lane does not refuse.
//
// Nothing is derived across rows. Each patch is parseGradeLabel() over that
// row's own title, and the already-correct guard compares the parse to that
// row's own stored company and value. A scan that stops early plans fewer
// patches; the next run finds the rest, still pending, still mis-graded.
//
// TWO LOOPS, TWO UNITS, ONE RESERVE SIZED TO THE LARGER.
//   The SCAN unit is one 5,000-row page of a five-field projection.
//   The APPLY unit is one CONCURRENCY-wide (default 16) batch of two-op
//   patches, checked per batch rather than per row.
// 60 seconds covers either.
//
// VERIFY_MS is nominal: this lane reads nothing after its loops.
// Worst case 110 + 1 + 1 + 1 + 1 = 114m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// CF-RECONCILE-ON-A-REAL-SUCCESS-COUNTER. `ok` here counted a worker callback
// that did not THROW, which is not the same thing as a write that landed --
// and it is the number the summary used to print as "applied". The callback is
// now the one that increments, on the line after its own patch resolves.
// `stop` lets the clock end the drain between batches without unwinding the
// workers.
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
  return { ok, err };
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const q = client.database("hobbyiq").container("verify_queue");

  console.log(`[backfill-verify-queue-grades] scanning pending rows...`);
  console.log(`  apply: ${APPLY} (set BACKFILL_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  // Fetch all pending rows with a title
  const query = `
    SELECT c.id, c.reason, c.input.title, c.input.gradeCompany, c.input.gradeValue
    FROM c
    WHERE c.status = 'pending' AND IS_DEFINED(c.input.title)
  `;
  const it = q.items.query({ query }, { maxItemCount: 5000 });
  const candidates = [];
  let scanStoppedAtBudget = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it. A stop
    // here is SAFE, not fatal: every patch is decided from one row's own title.
    // See THE CLOCK above.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} pending rows with titles\n`);
  if (scanStoppedAtBudget) {
    console.log(`  !! the scan STOPPED at the budget -- this is a PARTIAL candidate set, not every pending row.`);
  }

  const patches = [];
  let alreadyCorrect = 0, noGradeInTitle = 0;

  for (const r of candidates) {
    const title = String(r.title || "");
    if (!title) continue;
    const parsed = parseGradeLabel(title);
    if (!parsed) { noGradeInTitle++; continue; }

    const currentCompany = r.gradeCompany ?? null;
    const currentValue = r.gradeValue ?? null;
    if (currentCompany === parsed.gradeCompany && Number(currentValue) === Number(parsed.gradeValue)) {
      alreadyCorrect++;
      continue;
    }
    patches.push({
      id: r.id,
      partitionKey: r.reason,   // verify_queue partitioned by reason
      title,
      newCompany: parsed.gradeCompany,
      newValue: parsed.gradeValue,
      oldCompany: currentCompany,
      oldValue: currentValue,
    });
  }

  console.log(`No grade in title:         ${noGradeInTitle}`);
  console.log(`Already correct:           ${alreadyCorrect}`);
  console.log(`Ready to backfill:         ${patches.length}\n`);

  if (patches.length === 0) {
    if (scanStoppedAtBudget) emitMarker(0);
    return { client, budget: CLOCK };
  }

  console.log("Sample 20 (old → new):");
  patches.slice(0, 20).forEach(p => {
    const old = p.oldCompany ? `${p.oldCompany} ${p.oldValue}` : "null";
    console.log(`  ${old} → ${p.newCompany} ${p.newValue}   [${p.title.slice(0, 60)}]`);
  });

  if (!APPLY) {
    console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
    if (scanStoppedAtBudget) emitMarker(0);
    return { client, budget: CLOCK };
  }

  console.log(`\nApplying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  // A REAL success counter: incremented after the patch resolves, not by a
  // callback that merely returned.
  let written = 0;
  let applyStoppedAtBudget = false;
  const result = await runInParallel(patches, async (p) => {
    await q.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/input/gradeCompany", value: p.newCompany },
      { op: "set", path: "/input/gradeValue", value: p.newValue },
    ]);
    written++;
    if (written % 500 === 0) {
      const rate = (written / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${written}/${patches.length} (${rate}/s)`);
    }
  }, CONCURRENCY, () => {
    // THE PRE-CHECK for the apply loop, taken by each worker BEFORE it claims
    // its next patch. Safe: a patched row now parses equal to its stored grade,
    // so the already-correct guard skips it on the next run.
    if (!applyStoppedAtBudget && CLOCK.outOfClock()) applyStoppedAtBudget = true;
    return applyStoppedAtBudget;
  });
  const notReached = Math.max(0, patches.length - written - result.err);
  console.log(`\n  applied ${written} / errors ${result.err} / not reached ${notReached} in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // RECONCILE OVER THE PLAN. This lane builds its plan first, so it KNOWS its
  // denominator and reconciles the four-term way: every planned patch either
  // landed, failed, or was never reached because the clock stopped the drain.
  console.log(`  reconciled: intended ${patches.length} = written ${written} + failed ${result.err} + not reached ${notReached}`);
  if (written + result.err + notReached !== patches.length) {
    console.error("  !! RECONCILE MISMATCH -- a planned patch was neither written, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "backfill-verify-queue-grades",
    intended: patches.length, written, skipped: notReached, failed: result.err,
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
  console.log(`  the continuation never re-reads what this pass wrote: a patched row's stored`
    + ` grade now equals what parseGradeLabel returns for its title, so the already-correct`
    + ` guard skips it. ${notReached} planned patch(es) were left for the next run.`);
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
