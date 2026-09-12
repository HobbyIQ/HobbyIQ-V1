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

// ── THE SCAN OUTGREW A 12-MINUTE BUDGET (2026-09-12) ────────────────────────
//
// Run 34688789170 read 5,071,211 of the 60-day window's rows in the full
// 12-minute budget and never reached the end of the scan -- the FIRST time
// that happened; the three prior days (5.27M-5.30M rows) finished the scan
// with 0-1 minutes to spare and left the emit loop to eat what was left
// (34590057476: 1,311 signals emitted, 09-10: 0, 09-09: 328 -- see the run
// history). The pool grows every day and sold_comps runs at a shared 10k
// RU/s with a 32-slot census fleet overnight (CLAUDE.md), so the scan's own
// wall-clock cost is both GROWING and NOISY -- and until now a stop mid-scan
// meant literally nothing was kept: fetchRecentSales() built its row array
// entirely in memory with no persisted position, so tomorrow's run re-reads
// the identical prefix from byte zero and can only ever lose the race by a
// wider margin as the pool keeps growing.
//
// Two independent fixes, same shape as #2068 (anomaly-force-scan.cjs):
//
//   1. A 429 (or any retryable Cosmos throttle) on a page fetch gets a short
//      bounded in-process backoff instead of taking down the loop -- reusing
//      #2068's exact isRetryableCosmosError/backoff-delay pattern rather than
//      re-deriving it, since the failure shape (shared 10k RU, transient
//      throttle) is identical.
//
//   2. The scan now persists a Cosmos QueryIterator continuation token in
//      crawl_state after every page, keyed to the EXACT @since parameter this
//      run used. A resumed run passes that token back into the SAME query
//      text and parameters -- the one shape the SDK's continuation token
//      contract guarantees still means something -- so a budget stop (or a
//      429 that outlives the backoff) picks the physical scan back up at the
//      next page rather than restarting the 5M+-row prefix from scratch. NO
//      composite index or ORDER BY is added: the composite-index runbook
//      (backend/docs/runbooks/sold-comps-composite-indexes.md) is explicitly
//      "proposed, NOT applied", and an indexing-policy change on a live
//      Cosmos container is a live-prod-config HALT per CLAUDE.md, not
//      something a scan-resumability fix should smuggle in. The continuation
//      token resumes the SAME physically-ordered scan Cosmos was already
//      doing; it does not change what order rows arrive in, so the existing
//      "no ORDER BY, so a partial fetch is a partition-ordered slice, not a
//      sample" refusal below is UNCHANGED and still fires on any run whose
//      scan does not finish -- resuming across runs is what lets a scan
//      EVENTUALLY finish rather than what excuses publishing a partial one.
//
// A cursor older than CURSOR_MAX_AGE_MS is discarded: the window has moved on
// far enough that it no longer means the same dispatch (yesterday's cron, not
// a same-day relaunch), and resuming means re-issuing the query with the
// CURSOR's OWN @since -- a continuation token is only meaningful against the
// exact parameters that produced it -- so an unbounded age would let an
// arbitrarily stale window keep being resumed forever. Same reasoning as
// anomaly-force-scan's scanDate-mismatch discard, one level down, but keyed
// on elapsed time rather than a calendar-day boundary because this lane's
// window boundary is a moving `now`, not a fixed day.
//
// THE ARITHMETIC, HONESTLY. Run 34688789170 measured 7,697 rows/s over
// 5,071,211 rows in 658.8s. At that rate a 5.3M-row window (today's size,
// growing) needs ~11.5 minutes of SCAN ALONE -- before the emit loop's own
// ~90s (colorFamily..gradeTier, from the days the scan left room to run it)
// -- against daily-market-signals.yml's 12-minute RUN_MINUTES. 11.5 + 1.5 =
// 13 minutes needed vs 12 budgeted: this job DOES NOT FIT ANY MORE, and it is
// getting worse every day as sold_comps grows. Nothing in this fix "solves"
// that by making the scan faster -- 10k RU/s shared with a 32-slot census
// fleet is a Drew-fixed ceiling (CLAUDE.md), not a tuning knob this script
// owns. What this fix buys instead is that the SAME 11.5-13 minutes of work
// no longer has to be re-paid from zero every single day: a run that reads
// ~85-95% of the window and stops leaves that fraction banked, so the next
// dispatch (tomorrow's cron, or a same-day relaunch on backfill-runner /
// overnight-auto-chain, which already whitelist this script for relaunch)
// finishes the remaining 5-15% in under a minute and reaches the emit loop
// with most of its budget still intact. The job self-heals across 1-2 runs
// instead of losing the same race by a wider margin every day.
//
// THE CUT, IF ONE IS EVER NEEDED. If the pool keeps growing and even a
// resumed run stops finishing within 2 dispatches, the honest lever is
// WINDOW_DAYS: scan cost is roughly linear in the 2xWINDOW_DAYS range this
// query reads (measured: 60 days -> 5.3M rows -> 11.5 min), so a 20-day
// window (40-day scan range) would cut the scan to roughly 2/3 -- about 7.7
// minutes, comfortably inside 12 with room for emit -- at the cost of a
// noisier, less-smoothed momentum signal. That is a product tradeoff for
// Drew to make explicitly, not a default this script should reach for on its
// own; the resumable cursor above is what keeps the job alive in the
// meantime without raising RUN_MINUTES past the workflow's own ceiling.
const RATE_LIMIT_RETRY_DELAYS_MS = String(process.env.MARKET_SIGNALS_429_BACKOFF_MS || "500,1500,4000")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);

function isRetryableCosmosError(e) {
  if (!e) return false;
  if (e.code === 429 || e.code === "429") return true;
  if (Number(e.code) === 429) return true;
  if (typeof e.retryAfterInMs === "number") return true;
  const msg = String(e.message || e.body || "");
  return /request rate is too large/i.test(msg) || /cosmosdb-error-429/i.test(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetchNext() wrapped with a short, bounded retry for exactly the retryable
 * Cosmos throttle shape -- never a blanket catch-and-continue, so a
 * NON-retryable error (a bad query, an auth failure) still propagates to the
 * outer .catch and fails the run loudly, matching #2068's anomaly-force-scan
 * helper verbatim.
 */
async function fetchNextWithBackoff(iter) {
  let attempt = 0;
  for (;;) {
    try {
      return await iter.fetchNext();
    } catch (e) {
      if (!isRetryableCosmosError(e) || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) throw e;
      const waitMs = Number(e.retryAfterInMs) || RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      console.log(`  Cosmos 429 on this page -- backing off ${waitMs}ms (retry ${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length})`);
      await sleep(waitMs);
      attempt++;
    }
  }
}

// ── THE SCAN CURSOR ──────────────────────────────────────────────────────
//
// One MANIFEST doc plus N CHUNK docs, all id-partitioned like every other
// crawl_state row (anomaly-force-scan.cjs, tca-firehose-ingest.cjs,
// ingest-universe-driver.cjs). CURSOR_ID/chunkId() are SOURCE LITERALS for
// the same reason: a drifted id would resume from nothing and silently
// re-scan from row 0.
//
// WHY CHUNKED, NOT ONE DOC. A Cosmos document caps at 2MB. The nine-field
// projection fetchRecentSales() already SELECTs runs ~300 bytes/row as JSON
// (measured against a populated `composite` object), which puts that ceiling
// at roughly 7,000 rows per document -- and a stopped scan has read MILLIONS
// (5,071,211 rows in the run this fix responds to). One doc holding `rows`
// would throw on its very first upsert past that ceiling, which would turn
// "the scan didn't finish" into "the scan didn't finish AND the attempt to
// remember that threw" -- strictly worse than the unbounded-memory defect
// this file already documents fixing. Chunking at CURSOR_CHUNK_SIZE rows per
// doc keeps every individual write on the safe side of the 2MB ceiling
// regardless of how large the pool grows.
//
// NOTHING IS TRIMMED FROM THE ROW SHAPE. `composite` is kept as a whole
// (colorFamily/edition/finishModifier/insertSet all live under it and
// groupBy() reads it as one object) -- every field fetchRecentSales already
// SELECTs is load-bearing for one of the nine emitted dimensions or for the
// curr/prior split itself, so none of them can be dropped from the persisted
// shape without also dropping it from the emit this cursor exists to make
// possible.
const CONTROL_CONTAINER = process.env.CONTROL_CONTAINER || "crawl_state";
const CURSOR_ID = "refresh-market-signals::scan-cursor";
// 5,000 rows/chunk keeps each chunk doc comfortably under Cosmos' 2MB
// document ceiling even for the widest rows this scan reads (a populated
// `composite` object): ~300 bytes/row measured x 5,000 = ~1.5MB, leaving
// margin for Cosmos' own system properties. This is a RARE-PATH cost -- it
// is only paid on a run that stops mid-scan and the run that resumes it --
// so trading some chunk-doc RU for skipping a full re-scan (which would
// re-spend the RU of reading those same rows again, on top of the wall-clock
// this whole fix exists to stop losing) is the cheaper side of the trade.
const CURSOR_CHUNK_SIZE = Number(process.env.MARKET_SIGNALS_CURSOR_CHUNK_SIZE || 5000);
const chunkId = (n) => `refresh-market-signals::scan-cursor::chunk::${n}`;

/** Runs `fn` over `items` with at most `limit` in flight at once -- bounded
 *  concurrency for the chunk reads/writes so a cursor spanning hundreds of
 *  chunks does not serialize into hundreds of sequential round trips, and
 *  does not fire them all at once against a container already RU-constrained. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
const CURSOR_IO_CONCURRENCY = Number(process.env.MARKET_SIGNALS_CURSOR_IO_CONCURRENCY || 8);

async function readScanCursor(control) {
  let manifest;
  try {
    const { resource } = await control.item(CURSOR_ID, CURSOR_ID).read();
    manifest = resource || null;
  } catch (e) {
    if (e.code === 404) return null;
    throw e;
  }
  if (!manifest) return null;
  const chunkResults = await mapWithConcurrency(
    Array.from({ length: manifest.chunkCount }, (_, i) => i),
    CURSOR_IO_CONCURRENCY,
    async (i) => {
      const { resource } = await control.item(chunkId(i), chunkId(i)).read();
      return Array.isArray(resource?.rows) ? resource.rows : [];
    }
  );
  return { ...manifest, rows: chunkResults.flat() };
}

/** Persist scan progress: the continuation token, the exact @since this
 *  token is valid against, and the rows accumulated so far chunked across
 *  several docs (so a resumed run does not have to re-fetch what it already
 *  read, and no single write risks the 2MB document ceiling). */
async function writeScanCursor(control, { sinceIso, continuationToken, rows }) {
  const chunkCount = Math.max(1, Math.ceil(rows.length / CURSOR_CHUNK_SIZE));
  await mapWithConcurrency(
    Array.from({ length: chunkCount }, (_, i) => i),
    CURSOR_IO_CONCURRENCY,
    (i) => {
      const slice = rows.slice(i * CURSOR_CHUNK_SIZE, (i + 1) * CURSOR_CHUNK_SIZE);
      return control.items.upsert({ id: chunkId(i), docType: "market_signals_scan_cursor_chunk", rows: slice });
    }
  );
  const manifest = {
    id: CURSOR_ID,
    docType: "market_signals_scan_cursor",
    sinceIso,
    continuationToken,
    rowCount: rows.length,
    chunkCount,
    updatedAt: new Date().toISOString(),
  };
  await control.items.upsert(manifest);
  return manifest;
}

async function clearScanCursor(control, priorManifest) {
  const chunkCount = priorManifest?.chunkCount ?? 0;
  await mapWithConcurrency(
    Array.from({ length: chunkCount }, (_, i) => i),
    CURSOR_IO_CONCURRENCY,
    async (i) => {
      try { await control.item(chunkId(i), chunkId(i)).delete(); }
      catch (e) { if (e.code !== 404) throw e; }
    }
  );
  try {
    await control.item(CURSOR_ID, CURSOR_ID).delete();
  } catch (e) {
    if (e.code !== 404) throw e;
  }
}

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
// re-dispatches and the next run RESUMES the scan from the persisted
// continuation token (see THE SCAN CURSOR above) rather than re-reading the
// same multi-million-row prefix with a full clock and no progress to show
// for it.
//
// TWO UNITS, TWO SIZES. The scan unit is one 5,000-row page of a nine-field
// projection; the emit unit is one dimension key, an in-memory median plus one
// upsert. The reserve is sized to the LARGER, the scan page: 60 seconds --
// comfortably above the worst-case in-process 429 backoff for one page
// (500+1500+4000 = 6s) plus the page fetch itself, so a page that needs its
// full backoff still fits inside the reserve rather than being cut off
// mid-retry.
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

const SCAN_QUERY = `
    SELECT c.soldAt, c.price, c.sport, c.isAuto, c.autoStyle, c.hobbyiqCardId,
           c.gradeCompany, c.gradeValue, c.composite
    FROM c
    WHERE c.soldAt >= @since AND c.price > 0
      AND IS_DEFINED(c.composite) AND c.composite != null
  `;

/**
 * @param {object} sc               sold_comps container
 * @param {string} sinceIso         the window's @since parameter
 * @param {object} [resume]         { continuationToken, rows } from a cursor
 *                                   written against this EXACT sinceIso
 */
async function fetchRecentSales(sc, sinceIso, resume) {
  const rows = resume ? resume.rows.slice() : [];
  const startingContinuation = resume ? resume.continuationToken : undefined;
  const t0 = Date.now();
  const startCount = rows.length;
  const it = sc.items.query(
    { query: SCAN_QUERY, parameters: [{ name: "@since", value: sinceIso }] },
    { maxItemCount: 5000, continuationToken: startingContinuation }
  );
  let stoppedAtBudget = false;
  let lastContinuation = startingContinuation ?? null;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched. A stop here is FATAL to the
    // write phase -- see THE CLOCK above -- not merely a shorter run. It is
    // ALSO the point a resumable cursor is written, so a stop here no longer
    // means the next run re-reads this same prefix.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    let resp;
    try {
      resp = await fetchNextWithBackoff(it);
    } catch (e) {
      if (!isRetryableCosmosError(e)) throw e;
      // A 429 that outlived the in-process backoff. Same handling as a
      // clock-exhaustion stop: the cursor below persists lastContinuation
      // (the last page THIS call fully committed to `rows`), never the
      // in-flight page that just threw.
      console.log(`  Cosmos is throttling sold_comps (429) past the retry budget at ${rows.length} rows -- `
        + "stopping the scan here rather than crashing; the relaunch resumes from this page.");
      stoppedAtBudget = true;
      break;
    }
    const { resources } = resp;
    if (Array.isArray(resources)) rows.push(...resources);
    lastContinuation = resp.continuationToken ?? resp.continuation ?? lastContinuation;
    if (rows.length % 25000 < 5000) process.stdout.write(`\r  fetching ${rows.length}`);
  }
  const elapsedS = (Date.now() - t0) / 1000;
  const fetchedThisRun = rows.length - startCount;
  if (elapsedS > 0 && fetchedThisRun > 0) {
    console.warn(`  scan rate: ${(fetchedThisRun / elapsedS).toFixed(0)} rows/s `
      + `(${fetchedThisRun.toLocaleString("en-US")} rows in ${elapsedS.toFixed(1)}s this run)`);
  }
  console.log(`\r  ${rows.length} sales with composite since ${sinceIso}                     `);
  return { rows, stoppedAtBudget, continuationToken: stoppedAtBudget ? lastContinuation : null };
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
  const db = client.database("hobbyiq");
  const sc = db.container("sold_comps");
  const control = db.container(CONTROL_CONTAINER);

  console.log(`[refresh-market-signals]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  window: ${WINDOW_DAYS} days`);
  console.log(`  min volume: ${MIN_VOLUME}`);
  console.log(`  ${CLOCK.describe()}\n`);

  const now = Date.now();
  const computedAt = new Date(now).toISOString();
  const currStart = now - WINDOW_DAYS * 86400000;
  const priorStart = now - 2 * WINDOW_DAYS * 86400000;
  const freshSinceIso = new Date(priorStart).toISOString();

  // -- RESUME THE SCAN FROM A CURSOR, IF ONE IS RECENT ENOUGH TO TRUST -------
  //
  // `now` is computed FRESH every run, so a resumed run's own @since would
  // never byte-match a cursor written minutes or hours earlier even on a
  // same-day relaunch -- and a Cosmos continuation token is only meaningful
  // against the EXACT query parameters that produced it, so resuming means
  // re-issuing the query with the CURSOR's @since, not today's recomputed
  // one. The two are close enough to be the same 60-day window in practice
  // (the window only moves 1ms per 1ms of wall-clock, so a same-day resume
  // shifts it by minutes out of 60 days) -- what matters is bounding how OLD
  // a cursor may be before it is discarded instead of resumed, so a cursor
  // from a genuinely different dispatch (yesterday's cron, a window that has
  // since rolled past MARKET_SIGNALS_WINDOW_DAYS) does not get spliced onto
  // a run that no longer means the same thing.
  //
  // CURSOR_MAX_AGE_MS defaults to 20 hours: shorter than the 24-hour cron
  // cadence (so YESTERDAY's leftover cursor is never mistaken for today's),
  // long enough to cover any same-day relaunch chain (backfill-runner and
  // overnight-auto-chain both dispatch this script within a single job).
  const CURSOR_MAX_AGE_MS = Number(process.env.MARKET_SIGNALS_CURSOR_MAX_AGE_MS || 20 * 60 * 60 * 1000);
  const priorCursor = await readScanCursor(control);
  const cursorAgeMs = priorCursor ? now - new Date(priorCursor.updatedAt).getTime() : Infinity;
  const resuming = !!(priorCursor && priorCursor.continuationToken && cursorAgeMs >= 0 && cursorAgeMs <= CURSOR_MAX_AGE_MS);
  const sinceIso = resuming ? priorCursor.sinceIso : freshSinceIso;
  console.log(resuming
    ? `  RESUMING scan from cursor (${priorCursor.rowCount.toLocaleString("en-US")} rows already read this window, `
      + `cursor age ${Math.round(cursorAgeMs / 60000)}m)`
    : `  starting a fresh scan${priorCursor ? ` (discarding a cursor too old to trust, age ${Math.round(cursorAgeMs / 60000)}m)` : ""}`);

  const { rows, stoppedAtBudget: scanStoppedAtBudget, continuationToken } =
    await fetchRecentSales(sc, sinceIso, resuming ? priorCursor : undefined);

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
  // this re-dispatches and the next run re-scans from here.
  if (scanStoppedAtBudget) {
    // THE SCAN CURSOR. Unlike the old all-or-nothing fetch, a stop here now
    // persists the continuation token AND the rows already read, so the next
    // dispatch (the relaunch, if this workflow gains one, or tomorrow's cron
    // if it stays bare) resumes the physical scan at the next page instead of
    // re-reading this same multi-million-row prefix from byte zero.
    await writeScanCursor(control, { sinceIso, continuationToken, rows });
    console.log(`  scan cursor written: ${rows.length.toLocaleString("en-US")} rows persisted for this window`);
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

  // The scan FINISHED -- clear any cursor from a prior stop so a later run
  // does not mistake a stale continuation token for a valid resume point.
  if (priorCursor) await clearScanCursor(control, priorCursor);

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
