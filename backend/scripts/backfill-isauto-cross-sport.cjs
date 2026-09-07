#!/usr/bin/env node
// CF-BACKFILL-ISAUTO-CROSS-SPORT (Drew, 2026-07-30). Cross-sport
// isAuto backfill using the unified inferIsAuto detector:
//
//   - Basketball (Panini era 2009-2024): setName-keyword based
//     ("Signatures", "Autographs", "Ink", "Penmanship", "Rookie
//     Ticket", "Sensational Signatures", etc.)
//   - Football (Panini era 2016-2025): setName-keyword + a few
//     prefixed inserts (WT for Winning Ticket)
//   - Any sport where setName matches the AUTO_SETNAME_RE keyword
//     regex
//
// Baseball is handled by backfill-isauto-from-cardnumber.cjs (already
// ran; 37,462 rows fixed). This script is the counterpart for the
// other sports.
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=100000       — max rows scanned
//   BACKFILL_SPORT=basketball   — restrict to one sport (default: all
//                                 non-baseball sports)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { inferIsAuto } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane flips isAuto and REWRITES
// hobbyiqCardId -- autoFlag is slot 6, so every patch MOVES a sale from the raw
// pool into the auto pool -- across THREE sports, and declared no budget at
// all. Before this it could only ever end by being KILLED at the 150-minute
// ceiling: no marker, no reconcile, no finishLane line, and #1913's KILLED
// branch then withholding the re-dispatch.
//
// THE CLOCK IS PER RUN, NOT PER SPORT, and that is the sizing decision worth
// stating. The lane's outer loop is `for (const sp of sports)`, and each sport
// runs its own scan and its own patch train. A budget checked only at the top
// of that outer loop admits ONE WHOLE SPORT past expiry -- basketball alone is
// a 100,000-row scan plus its patches -- which is precisely the "one more unit"
// defect at the largest granularity this file offers. So CLOCK is a module
// singleton, started once, and every pre-check below reads the SAME clock:
// the sport loop, the page walk inside a sport, and the patch worker inside a
// sport. A stop in the middle of basketball ends the run; football and hockey
// are reported as NOT REACHED rather than silently skipped.
//
// UNITS AND THE RESERVE. The smallest thing that cannot be interrupted is one
// 5,000-row page of a PROJECTION (twelve scalar fields, no documents) or one
// two-field patch. The reserve is sized to the page: 60 seconds covers it
// against a throttling container with room to spare.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE: inferIsAuto reads the ROW IN
// HAND's own sport, cardNumber and setName, and the new slug re-uses the row's
// own setKey slot -- no group, no vote, no ratio. A stop costs coverage, never
// correctness.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loops.
// Worst case 110 + 1 + 1 + 1 = 113m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "100000");
const SPORT_FILTER = (process.env.BACKFILL_SPORT || "").toLowerCase();

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

async function processSport(sc, sport) {
  console.log(`\n══ ${sport} ══`);
  // Fetch isAuto=false rows for this sport where either setName or
  // cardNumber might carry an auto signal. Broad Cosmos filter; the
  // JS-side inferIsAuto is the strict test.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE c.isAuto = false
      AND c.sport = @sport
      AND (
        IS_STRING(c.setName)
        OR IS_STRING(c.cardNumber)
      )
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }, { name: "@sport", value: sport }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  let scanStoppedAtBudget = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is
    // buffered. It reads the RUN's clock, not a per-sport one.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} isAuto=false ${sport} rows fetched.        `);

  const patches = [];
  const setNameHits = {};
  let noSignal = 0, computeFailed = 0, noSlugChange = 0;

  for (const r of rows) {
    const isAutoInferred = inferIsAuto({
      sport,
      cardNumber: r.cardNumber ?? null,
      setName: r.setName ?? null,
      titleHasAutoText: false, // don't double-count title; we already have isAuto=false
    });
    if (!isAutoInferred) { noSignal++; continue; }

    // Recompute slug with isAuto=true.
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport,
        year: Number(r.cardYear),
        setKey: (r.hobbyiqCardId || "").split(":")[3] || sport,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noSlugChange++; continue; }

    // Track WHY it matched (for eyeballing).
    const key = r.setName ? String(r.setName).slice(0, 40) : `#${r.cardNumber}`;
    setNameHits[key] = (setNameHits[key] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug });
  }

  console.log(`  no signal:      ${noSignal}`);
  console.log(`  compute failed: ${computeFailed}`);
  console.log(`  no slug change: ${noSlugChange}`);
  console.log(`  Ready to patch: ${patches.length}\n`);
  console.log(`  Top match sources (top 20):`);
  Object.entries(setNameHits)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([k,c]) => console.log(`    ${String(c).padStart(5)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0, 5).forEach(p => console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`));
  }

  if (scanStoppedAtBudget) {
    console.log(`  the ${sport} scan was CUT SHORT by the budget: ${rows.length} rows were read,`
      + ` which is NOT the whole population. The plan above covers only those.`);
  }

  if (!APPLY || patches.length === 0) {
    return {
      sport, ready: patches.length, applied: 0, errors: 0, notReached: 0,
      stopped: scanStoppedAtBudget,
    };
  }

  // -- THE WRITE PHASE IS GATED ON THE CLOCK, NOT REFUSED ------------------
  //
  // A partial scan is safe to write from (each row's answer comes from its own
  // fields); STARTING this sport's patch train past expiry is not.
  if (CLOCK.outOfClock()) {
    console.log(`  the budget is gone: ${patches.length} ${sport} patches were NOT STARTED.`);
    return {
      sport, ready: patches.length, applied: 0, errors: 0,
      notReached: patches.length, stopped: true,
    };
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
      { op: "set", path: "/isAuto", value: true },
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  // `result.ok` is NOT the written count: runInParallel counts a worker
  // callback that did not throw, which includes the budget-stopped early
  // return above. `done` is incremented only after the patch resolves.
  console.log(`\n  applied ${done} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return {
    sport, ready: patches.length, applied: done, errors: result.err,
    notReached, stopped: writeStoppedAtBudget || scanStoppedAtBudget,
  };
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-isauto-cross-sport]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  scan-limit-per-sport: ${LIMIT}`);
  console.log(`  sport filter: ${SPORT_FILTER || "all non-baseball"}`);

  const sports = SPORT_FILTER
    ? [SPORT_FILTER]
    : ["basketball", "football", "hockey"];
  const summary = [];
  // Sports NOT STARTED at all, distinct from a sport whose own phases stopped:
  // an unentered sport contributes NOTHING to the reconcile, and inventing a
  // "not reached" count for it would be a sibling counter rather than a
  // measurement (feedback: a slice is not a sibling counter).
  const sportsNotStarted = [];
  let stoppedAtBudget = false;
  for (const sp of sports) {
    // THE PRE-CHECK AT THE OUTER LOOP TOO. Without it a run that has spent its
    // clock on basketball still ENTERS football and runs a 100,000-row scan
    // plus its patch train past expiry -- one whole sport of overrun, which is
    // this file's largest unit.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; sportsNotStarted.push(sp); continue; }
    const r = await processSport(sc, sp);
    summary.push(r);
    if (r.stopped) stoppedAtBudget = true;
  }

  console.log(`\n════════════════ GRAND SUMMARY ════════════════`);
  summary.forEach(s => console.log(`  ${s.sport.padEnd(12)} ready=${String(s.ready).padStart(6)} applied=${String(s.applied).padStart(6)} errors=${s.errors} notReached=${s.notReached}`));
  if (sportsNotStarted.length) {
    console.log(`  NOT STARTED (budget): ${sportsNotStarted.join(", ")}`);
  }
  if (!APPLY) console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);

  // RECONCILE OVER THE PLANS ACTUALLY BUILT. `ready` is each entered sport's
  // known plan, so the identity holds per sport and therefore in total. A sport
  // never entered is named above and contributes nothing to either side --
  // there is no honest count of what its scan would have found.
  if (APPLY) {
    const intended = summary.reduce((a, s) => a + s.ready, 0);
    const written = summary.reduce((a, s) => a + s.applied, 0);
    const failed = summary.reduce((a, s) => a + s.errors, 0);
    const notReached = summary.reduce((a, s) => a + s.notReached, 0);
    console.log(`  reconciled: intended ${intended} = written ${written}`
      + ` + failed ${failed} + not reached ${notReached}`);
    if (written + failed + notReached !== intended) {
      console.error("  !! RECONCILE MISMATCH -- a planned patch was neither written, failed nor left unreached");
      process.exitCode = 4;
    }
    reportWrites({
      job: "backfill-isauto-cross-sport",
      intended, written, skipped: notReached, failed,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the patch is IDEMPOTENT and the relaunch re-walks the sport list from the top:"
      + " each sport's scan selects only isAuto=false rows, and a patched row is isAuto=true, so a"
      + " finished sport re-scans cheaply to an empty plan and the clock lands on what is left.");
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
