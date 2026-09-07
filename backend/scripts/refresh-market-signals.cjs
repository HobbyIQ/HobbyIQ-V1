#!/usr/bin/env node
// CF-REFRESH-MARKET-SIGNALS (Drew, 2026-07-30). Nightly compute that
// writes momentum signals per (dimension, key) to the market_signals
// container. Runs at 5:30 AM ET via daily-market-signals.yml — after
// the 5:00 AM CH ingest completes so the freshest sales are in the
// pool.
//
// Dimensions computed (all use last 30d vs prior 30d):
//   colorFamily     — BLUE / GOLD / SPECKLE / etc.
//   edition         — SAPPHIRE / MEGA_BOX / etc.
//   finishModifier  — WAVE / SHIMMER / VINYL / etc.
//   insertSet       — scouts-top-100 / home-run-challenge / etc.
//   sport           — baseball / basketball / football / hockey
//   productLine     — bowman-chrome / topps-heritage / etc.
//   isAuto          — true / false
//   autoStyle       — on-card / sticker
//   gradeTier       — PSA 10, BGS 9.5, raw, etc.
//
// Env:
//   COSMOS_CONNECTION_STRING       — required
//   MARKET_SIGNALS_APPLY=true       — actually write (default true; set
//                                      "false" for dry-run diagnostics)
//   MARKET_SIGNALS_WINDOW_DAYS=30   — rolling window
//   MARKET_SIGNALS_MIN_VOLUME=20    — min combined sample size to emit
//                                      a signal (avoids noisy micro-groups)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { upsertMomentumSignal } = require(path.join(backend, "dist/services/portfolioiq/marketMomentum.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// CF-RUNNER-FLAG-HYGIENE (D18, 2026-08-29). Default-on meant `apply=false`
// under the runner still wrote — the runner exports BACKFILL_APPLY, not
// MARKET_SIGNALS_APPLY. Precedence: an explicit MARKET_SIGNALS_APPLY (the cron
// workflows set "true"); else the runner's BACKFILL_APPLY when it is present;
// else the old default, on.
const APPLY = process.env.MARKET_SIGNALS_APPLY !== undefined
  ? process.env.MARKET_SIGNALS_APPLY !== "false"
  : process.env.BACKFILL_APPLY !== undefined
    ? process.env.BACKFILL_APPLY === "true"
    : true;
// Reconciled (D18): intended = signals handed to upsertMomentumSignal, written =
// calls that resolved. A call that throws aborts the run (exit 1), not green.
const writes = { intended: 0, written: 0 };
const WINDOW_DAYS = Number(process.env.MARKET_SIGNALS_WINDOW_DAYS || "30");
const MIN_VOLUME = Number(process.env.MARKET_SIGNALS_MIN_VOLUME || "20");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane writes the momentum signals
// nine dimensions of the product read, and it declared no budget at all. Its
// scan is an unbounded cross-partition walk of every sold_comps sale in a 60-day
// window (2 x WINDOW_DAYS) that carries a composite, accumulated ENTIRELY IN
// MEMORY before a single signal is emitted. On the runner it could only ever end
// by being KILLED at the 150-minute ceiling: no marker, no reconcile, no
// finishLane line, and #1913 KILLED branch then withholding the re-dispatch.
//
// >>> THE WRITE PHASE REFUSES AFTER A SCAN-PHASE STOP. <<<
//
// Same shape and same reason as #1970 four statistic lanes. Every number this
// lane emits is a STATISTIC OVER THE WHOLE FETCH: emitDimension() takes the
// median of the current window prices and the median of the prior window
// prices per key, and reports priceMomentum as their ratio and volumeMomentum
// as the ratio of their COUNTS. A median over part of a pool is a DIFFERENT
// median, not a smaller one -- and a COUNT over part of a window is not merely
// smaller, it is a ratio computed against a denominator that was never real.
//
// AND THE PARTIAL SCAN IS BIASED, NOT MERELY SHORT, WHICH MAKES THIS WORSE
// THAN THE MEDIAN CASE. The query carries no ORDER BY, so a stop mid-walk
// keeps whichever physical partitions were served first. Those pages are not a
// random sample of the window: they are a sport-and-card skewed slice, and the
// current/prior split is then taken from THAT. A dimension whose keys happen to
// live in the unread partitions reports volumeMomentum as if its sales had
// vanished -- a -100% "collapse" published as market intelligence.
//
// MIN_VOLUME does not save it. A partial pool can clear a 20-sale floor and
// still misstate both medians and both counts.
//
// AND THE WRITE IS DESTRUCTIVE ON RE-RUN: upsertMomentumSignal keys on
// (dimension, key, windowDays) and OVERWRITES, so a wrong signal does not sit
// beside the right one to be noticed -- it replaces it.
//
// So a scan-phase stop exits 5 having written NOTHING, and still prints the
// marker -- the relaunch marker arm runs BEFORE its outcome check, so a refusal
// re-dispatches and the next run re-scans from the top with a full clock.
//
// TWO UNITS, TWO SIZES. The scan unit is one 5,000-row page of a nine-field
// projection; the emit unit is one dimension key, an in-memory median plus one
// upsert. The reserve is sized to the LARGER, the scan page: 60 seconds.
//
// VERIFY_MS is nominal: this lane reads nothing after its loops.
// Worst case 110 + 1 + 1 + 1 + 1 = 114m under the 150m ceiling.
//
// THE CRONS PASS THEIR OWN RUN_MINUTES. daily-market-signals.yml runs this
// under `timeout-minutes: 30` and overnight-auto-chain.yml under a 180-minute
// job it SHARES with two other scripts, so a 110-minute default would be a
// budget above one ceiling and a monopoly under the other. budget() reads
// RUN_MINUTES from the env, and both workflows set it.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function fetchRecentSales(sc, sinceIso) {
  const query = `
    SELECT c.soldAt, c.price, c.sport, c.isAuto, c.autoStyle, c.hobbyiqCardId,
           c.gradeCompany, c.gradeValue, c.composite
    FROM c
    WHERE c.soldAt >= @since AND c.price > 0
      AND IS_DEFINED(c.composite) AND c.composite != null
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@since", value: sinceIso }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  let stoppedAtBudget = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched. A stop here is FATAL to the
    // write phase -- see THE CLOCK above -- not merely a shorter run.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    if (rows.length % 25000 < 5000) process.stdout.write(`\r  fetching ${rows.length}`);
  }
  console.log(`\r  ${rows.length} sales with composite since ${sinceIso}                     `);
  return { rows, stoppedAtBudget };
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function groupBy(rows, keyFn) {
  const groups = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null || k === "") continue;
    if (!groups[k]) groups[k] = [];
    groups[k].push(Number(r.price));
  }
  return groups;
}

// -- THE EMIT PHASE'S OWN PRE-CHECK, AND WHY IT REPORTS RATHER THAN REFUSES --
//
// The scan refuses because a partial scan makes every number WRONG. A partial
// EMIT is a different failure: the numbers written are correct -- they were
// computed from the complete window -- but the published SET is incomplete, so
// a key not reached keeps yesterday's signal beside today's. That is stale, not
// false, and it is strictly better than the alternative on offer: there is no
// transaction here, upsertMomentumSignal writes one key at a time, and by the
// time this loop starts the whole 60-day scan has already been paid for.
// Refusing at that point would throw away the expensive part of the run to
// avoid a staleness the next dispatch fixes.
//
// So the emit loop STOPS AND SAYS SO rather than refusing, and the run carries
// the marker so a relaunch re-scans and finishes the set. `emitStopped` is
// module scope because it is set inside this helper and read by main().
let emitStopped = false;

async function emitDimension(name, currGroups, priorGroups, computedAt) {
  const allKeys = new Set([...Object.keys(currGroups), ...Object.keys(priorGroups)]);
  let emitted = 0;
  let notReached = 0;
  for (const key of allKeys) {
    // THE PRE-CHECK, per KEY -- the unit here is one median plus one upsert,
    // not one dimension. Checking per dimension would admit a whole dimension's
    // worth of keys past expiry, which is the loop-top defect #1799 fixed one
    // level up.
    if (emitStopped || CLOCK.outOfClock()) {
      emitStopped = true;
      notReached++;
      continue;
    }
    const curr = currGroups[key] ?? [];
    const prior = priorGroups[key] ?? [];
    const combined = curr.length + prior.length;
    if (combined < MIN_VOLUME) continue;
    const currMed = median(curr);
    const priorMed = median(prior);
    const volumeMomentum = prior.length > 0 ? (curr.length / prior.length - 1) : null;
    const priceMomentum = (currMed != null && priorMed != null && priorMed > 0)
      ? (currMed / priorMed - 1) : null;
    const metrics = {
      currVolume: curr.length,
      priorVolume: prior.length,
      volumeMomentum,
      currMedian: currMed,
      priorMedian: priorMed,
      priceMomentum,
      sampleSize: combined,
    };
    if (APPLY) {
      writes.intended++;
      await upsertMomentumSignal({
        dimension: name,
        key: String(key),
        windowDays: WINDOW_DAYS,
        computedAt,
        metrics,
      });
      writes.written++;
    }
    emitted++;
  }
  console.log(`  ${name}: ${emitted} signals emitted`
    + (notReached > 0 ? `   !! ${notReached} key(s) NOT REACHED (budget)` : ""));
  return emitted;
}

async function main() {
  // NAMED and RETURNED, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[refresh-market-signals]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  window: ${WINDOW_DAYS} days`);
  console.log(`  min volume: ${MIN_VOLUME}`);
  console.log(`  ${CLOCK.describe()}\n`);

  const now = Date.now();
  const computedAt = new Date(now).toISOString();
  const currStart = now - WINDOW_DAYS * 86400000;
  const priorStart = now - 2 * WINDOW_DAYS * 86400000;
  const { rows, stoppedAtBudget: scanStoppedAtBudget } = await fetchRecentSales(sc, new Date(priorStart).toISOString());

  // -- THE REFUSAL -----------------------------------------------------------
  //
  // Every signal below is a ratio of medians and a ratio of COUNTS taken over
  // this fetch. A partial fetch does not make them smaller, it makes them
  // WRONG -- and biased, because the query has no ORDER BY, so the rows that
  // arrived are whichever partitions were served first rather than a sample of
  // the window. A dimension key whose sales live in the unread partitions would
  // be published as a -100% volume collapse, over the top of the correct signal
  // upsertMomentumSignal replaces.
  //
  // Exit 5 is a VERDICT, not a crash (#1955 outcome (d)). The marker is printed
  // FIRST, because the relaunch marker arm runs BEFORE its outcome check -- so
  // this re-dispatches and the next run re-scans from the top.
  if (scanStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the sales scan is UNFINISHED; the relaunch continues from here`);
    console.error("  REFUSING TO EMIT SIGNALS: every metric below -- priceMomentum, volumeMomentum,"
      + " both medians, both volumes -- is a STATISTIC over the whole window, and this fetch read"
      + " only part of it. The query carries no ORDER BY, so what arrived is a partition-ordered"
      + " slice rather than a sample: a key whose sales sit in the unread partitions would publish"
      + " as a -100% volume collapse. MARKET_SIGNALS_MIN_VOLUME does not save it -- a partial pool"
      + " can clear a 20-sale floor and still misstate every number. And upsertMomentumSignal"
      + " OVERWRITES on (dimension, key, windowDays), so a wrong signal would replace the right"
      + " one rather than sit beside it. Nothing was written.");
    if (APPLY) reportWrites({ job: "refresh-market-signals", intended: 0, written: 0, skipped: 0, failed: 0 });
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  const curr = rows.filter(r => new Date(r.soldAt).getTime() >= currStart);
  const prior = rows.filter(r => new Date(r.soldAt).getTime() < currStart);
  console.log(`\n  Current ${WINDOW_DAYS}d: ${curr.length} sales`);
  console.log(`  Prior ${WINDOW_DAYS}d:   ${prior.length} sales\n`);

  const productFromSlug = (r) => {
    const parts = String(r.hobbyiqCardId || "").split(":");
    return parts[3] ?? null;
  };
  const gradeKey = (r) => r.gradeCompany && r.gradeValue != null ? `${r.gradeCompany}_${r.gradeValue}` : "raw";

  let total = 0;
  total += await emitDimension("colorFamily",
    groupBy(curr, r => r.composite?.colorFamily),
    groupBy(prior, r => r.composite?.colorFamily),
    computedAt);
  total += await emitDimension("edition",
    groupBy(curr, r => r.composite?.edition),
    groupBy(prior, r => r.composite?.edition),
    computedAt);
  total += await emitDimension("finishModifier",
    groupBy(curr, r => r.composite?.finishModifier),
    groupBy(prior, r => r.composite?.finishModifier),
    computedAt);
  total += await emitDimension("insertSet",
    groupBy(curr, r => r.composite?.insertSet),
    groupBy(prior, r => r.composite?.insertSet),
    computedAt);
  total += await emitDimension("sport",
    groupBy(curr, r => (r.sport || "unknown").toLowerCase()),
    groupBy(prior, r => (r.sport || "unknown").toLowerCase()),
    computedAt);
  total += await emitDimension("productLine",
    groupBy(curr, productFromSlug),
    groupBy(prior, productFromSlug),
    computedAt);
  total += await emitDimension("isAuto",
    groupBy(curr, r => r.isAuto === true ? "true" : "false"),
    groupBy(prior, r => r.isAuto === true ? "true" : "false"),
    computedAt);
  total += await emitDimension("autoStyle",
    groupBy(curr, r => r.autoStyle),
    groupBy(prior, r => r.autoStyle),
    computedAt);
  total += await emitDimension("gradeTier",
    groupBy(curr, gradeKey),
    groupBy(prior, gradeKey),
    computedAt);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  Signals emitted: ${total}`);
  console.log(`  computedAt:      ${computedAt}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set MARKET_SIGNALS_APPLY=true to write. ***`);

  // RECONCILE OVER THE SIGNALS HANDED TO THE STORE. `intended` counts each
  // upsertMomentumSignal call made and `written` each one that RESOLVED; a
  // throw aborts the run rather than being counted, so the equation balances
  // on every run that reaches this line. There is no partial-run arm to carry:
  // this lane either scans the whole window and emits, or refuses above.
  if (APPLY) {
    const failed = writes.intended - writes.written;
    console.log(`  reconciled: intended ${writes.intended} = written ${writes.written} + failed ${failed}`);
    if (failed !== 0) {
      console.error("  !! RECONCILE MISMATCH -- a signal was handed to the store and never confirmed");
      process.exitCode = 4;
    }
    reportWrites({ job: "refresh-market-signals", ...writes });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables. Reached only when the SCAN completed and the EMIT ran out of
  // clock -- the scan-stop path refuses and returns above, before any write.
  if (emitStopped) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the signal set is INCOMPLETE; the relaunch continues from here`);
    console.log("  every signal written above is CORRECT: it was computed from the complete"
      + " 60-day window this run scanned. What is missing is coverage -- a key not reached still"
      + " carries its previous computedAt, so it reads as STALE rather than wrong. The next run"
      + " re-scans the window and overwrites the whole set on (dimension, key, windowDays).");
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
