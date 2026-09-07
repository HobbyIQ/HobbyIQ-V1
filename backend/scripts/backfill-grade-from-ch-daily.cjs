#!/usr/bin/env node
// CF-BACKFILL-GRADE-FROM-CH-DAILY (Drew, 2026-07-30). Vendor data is
// authoritative for grade — sellers on eBay populate the item-specifics
// grader/grade fields, CH's ingest captures them structurally into
// ch_daily_sales. Title text is a fallback: it can be ambiguous ("PSA
// graded" without a number) or missing.
//
// This backfill patches sold_comps rows where gradeCompany/gradeValue
// are null by joining to ch_daily_sales on:
//   1. cardId (same partition on ch_daily_sales via card_id)
//   2. sale-day match (soldAt YYYY-MM-DD == sale_date YYYY-MM-DD)
//   3. price match (priceCents ± $1 rounding tolerance)
//
// When a unique CH row matches with a non-Raw grader + parseable grade,
// we patch the sold_comps doc with the vendor-canonical values.
//
// Only-improve guardrail: never overwrite an existing gradeCompany/
// gradeValue; only fill nulls. Never demote a graded row to null.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=8       — parallel patches (kept low because
//                                   composite backfill is competing)
//   BACKFILL_LIMIT=100000        — max null-grade rows scanned per pass
//   BACKFILL_SOURCE=cardhedge    — filter by source ("cardhedge" default;
//                                   pass "any" for cross-source join)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane stamps gradeCompany and
// gradeValue onto sold_comps rows -- it decides which GRADE POOL a sale prices
// in -- and declared no budget at all. Before this it could only ever end by
// being KILLED at the 150-minute ceiling: no marker, no reconcile, no
// finishLane line, and #1913's KILLED branch then withholding the re-dispatch.
//
// THREE PHASES, AND THE MIDDLE ONE IS THE EXPENSIVE ONE. The scan is a bounded
// TOP @n projection; the JOIN then issues ONE partition query per distinct
// cardId against ch_daily_sales (cached, so cost scales with distinct cards
// rather than rows); the patch train is one two-field patch per match. The
// join is where an unbudgeted run spent its 150 minutes, so it carries a
// pre-check per ROW rather than only at a phase boundary.
//
// THE RESERVE IS SIZED TO THE LARGEST UNIT, which is one uncached cardId's
// ch_daily_sales partition query under retry-with-backoff: fetchWithRetry
// sleeps up to 2s * 6 attempts = 12s on a throttled partition, and a card can
// carry several 500-row pages. 60 seconds covers that with room; a single
// patch, or a cached join hit, costs milliseconds.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE. Each row's grade comes from a CH
// row matched on the ROW IN HAND's own (cardId, sale day, price +/- $1), and
// the ambiguity guard is evaluated within that one card's candidates. No group,
// no vote, no ratio, no reference to any other sold_comps row. A stop costs
// coverage, never correctness -- and the only-improve rule in the header holds
// regardless, since the query selects only null-grade rows.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its patch train.
// Worst case 110 + 1 + 1 + 1 = 113m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "8");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "100000");
const SOURCE_FILTER = process.env.BACKFILL_SOURCE || "cardhedge";

async function fetchWithRetry(iterator, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await iterator.fetchNext(); }
    catch (err) {
      const msg = String(err?.message || "");
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`\r  [429 backoff ${wait}ms attempt ${attempt+1}]  `);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

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
  const db = client.database("hobbyiq");
  const sc = db.container("sold_comps");
  const ch = db.container("ch_daily_sales");

  console.log(`[backfill-grade-from-ch-daily]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  source filter: ${SOURCE_FILTER}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // Query null-grade sold_comps rows where we might find a CH-daily match.
  // Filter to source="cardhedge" (default) since those rows have cardId ==
  // ch chCardId, which is our join key. Pass BACKFILL_SOURCE=any to include
  // eBay + cardsight sources (join by (title, day, price) heuristic).
  const sourceClause = SOURCE_FILTER === "any"
    ? ""
    : "AND c.source = @source ";
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.title, c.price, c.soldAt,
      c.gradeCompany, c.gradeValue, c.source
    FROM c
    WHERE (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null)
      AND (NOT IS_DEFINED(c.gradeValue) OR c.gradeValue = null)
      AND IS_STRING(c.cardId)
      ${sourceClause}
      AND c.price > 0
  `;
  const params = [{ name: "@n", value: LIMIT }];
  if (SOURCE_FILTER !== "any") params.push({ name: "@source", value: SOURCE_FILTER });

  const it = sc.items.query({ query, parameters: params }, { maxItemCount: 2000 });
  const rows = [];
  let scanStoppedAtBudget = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is buffered.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const page = await fetchWithRetry(it);
    if (page && Array.isArray(page.resources)) rows.push(...page.resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
    if (rows.length >= LIMIT) break;
  }
  console.log(`\r  ${rows.length} null-grade rows scanned.        \n`);

  const patches = [];
  const graderDist = {};
  const gradeDist = {};
  let noChMatch = 0, ambiguousMatch = 0, chRaw = 0, chUnparsed = 0;

  // Look up CH-daily rows per unique cardId (partition query) → cache and
  // reuse for all sold_comps rows sharing that cardId. Bounds RUs.
  const cardIdCache = new Map();
  async function getCHSalesForCard(cardId) {
    if (cardIdCache.has(cardId)) return cardIdCache.get(cardId);
    const chIt = ch.items.query(
      {
        query: `SELECT c.price_history_id, c.sale_date, c.price, c.grade, c.grader FROM c WHERE c.card_id = @cid`,
        parameters: [{ name: "@cid", value: cardId }],
      },
      { partitionKey: cardId, maxItemCount: 500 },
    );
    const results = [];
    while (chIt.hasMoreResults()) {
      const p = await fetchWithRetry(chIt);
      if (p && Array.isArray(p.resources)) results.push(...p.resources);
    }
    cardIdCache.set(cardId, results);
    return results;
  }

  console.log(`  Cross-referencing ch_daily_sales (RU budget: retry-backed)...\n`);
  let processed = 0;
  // Rows the join never looked at, because the budget ran out mid-phase. A real
  // number: `rows` is fixed before the loop starts, so this is measured rather
  // than a sibling counter.
  let joinNotReached = 0;
  let joinStoppedAtBudget = false;
  for (const r of rows) {
    // THE PRE-CHECK, per ROW. The unit here is one uncached cardId's
    // ch_daily_sales partition query under retry-with-backoff, which is where
    // an unbudgeted run spent its 150 minutes -- so the clock is read before
    // each one rather than only at the phase boundary.
    if (CLOCK.outOfClock()) { joinStoppedAtBudget = true; joinNotReached++; continue; }
    processed++;
    if (processed % 250 === 0) process.stdout.write(`\r  processed ${processed}/${rows.length}`);

    let chSales;
    try { chSales = await getCHSalesForCard(r.cardId); }
    catch { noChMatch++; continue; }
    if (!chSales || chSales.length === 0) { noChMatch++; continue; }

    // Match on (soldAt day, price ± $1). soldAt is ISO string.
    const soldDay = String(r.soldAt || "").slice(0, 10);
    const priceCents = Math.round(Number(r.price) * 100);
    if (!soldDay || !priceCents) { noChMatch++; continue; }

    const candidates = chSales.filter(ch => {
      const chDay = String(ch.sale_date || "").slice(0, 10);
      if (chDay !== soldDay) return false;
      const chPriceCents = Math.round(Number(ch.price) * 100);
      return Math.abs(chPriceCents - priceCents) <= 100; // ±$1
    });

    if (candidates.length === 0) { noChMatch++; continue; }
    if (candidates.length > 1) {
      // Ambiguous — multiple CH rows same day+price. If they all agree on
      // grader/grade, use it; otherwise skip.
      const graderSet = new Set(candidates.map(x => `${x.grader}::${x.grade}`));
      if (graderSet.size > 1) { ambiguousMatch++; continue; }
    }
    const chMatch = candidates[0];

    const grader = String(chMatch.grader || "").trim().toUpperCase();
    const gradeStr = String(chMatch.grade || "").trim();
    if (!grader || grader === "RAW" || grader === "UNGRADED") { chRaw++; continue; }
    const gradeValue = parseFloat(gradeStr);
    if (!Number.isFinite(gradeValue) || gradeValue <= 0) { chUnparsed++; continue; }

    graderDist[grader] = (graderDist[grader] ?? 0) + 1;
    gradeDist[`${grader}_${gradeValue}`] = (gradeDist[`${grader}_${gradeValue}`] ?? 0) + 1;

    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      gradeCompany: grader,
      gradeValue,
      title: String(r.title || "").slice(0, 80),
    });
  }
  console.log(`\r  processed ${processed}/${rows.length}                              \n`);
  if (joinNotReached > 0) {
    console.log(`  the join was CUT SHORT by the budget: ${joinNotReached} scanned rows were never`
      + ` cross-referenced. They are neither matched nor unmatched -- they are UNREAD.`);
  }

  console.log(`════════════════ MATCH DISTRIBUTION ════════════════`);
  console.log(`  no CH-daily row for cardId:              ${noChMatch.toLocaleString()}`);
  console.log(`  ambiguous CH match (different graders):  ${ambiguousMatch.toLocaleString()}`);
  console.log(`  CH row was Raw / ungraded:               ${chRaw.toLocaleString()}`);
  console.log(`  CH row grade unparseable:                ${chUnparsed.toLocaleString()}`);
  console.log(`  ready to patch:                          ${patches.length.toLocaleString()}`);

  console.log(`\n════════════════ GRADER DISTRIBUTION (patches) ════════════════`);
  Object.entries(graderDist).sort((a,b) => b[1] - a[1]).forEach(([g, cnt]) => {
    console.log(`  ${String(cnt).padStart(7)}  ${g}`);
  });

  console.log(`\n════════════════ TOP GRADE DISTRIBUTION (patches) ════════════════`);
  Object.entries(gradeDist).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([g, cnt]) => {
    console.log(`  ${String(cnt).padStart(7)}  ${g}`);
  });

  if (patches.length > 0) {
    console.log(`\n  Sample 5 patches:`);
    patches.slice(0, 5).forEach(p => {
      console.log(`    ${p.gradeCompany} ${p.gradeValue}  ${p.title}`);
    });
  }

  if (scanStoppedAtBudget) {
    console.log(`  the scan was CUT SHORT by the budget: ${rows.length} rows were read, which is`
      + ` NOT the whole population.`);
  }

  if (!APPLY || patches.length === 0) {
    console.log(`\n  Dry-run / no work. Re-dispatch with BACKFILL_APPLY=true to apply.`);
    if (scanStoppedAtBudget || joinStoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `this pass is UNFINISHED; the relaunch continues from here`);
    }
    return { client, budget: CLOCK };
  }

  // -- THE WRITE PHASE IS GATED ON THE CLOCK, NOT REFUSED ------------------
  //
  // A partial scan or a partial join is safe to write from (each row's grade
  // comes from its own cardId + day + price match); STARTING the patch train
  // past expiry is not.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the scan and join consumed it; ${patches.length} patches were NOT STARTED and the`
      + ` relaunch continues from here`);
    console.log("  nothing was written. The scan selects only null-grade rows, so the next pass"
      + " re-derives a plan over what is left.");
    return { client, budget: CLOCK };
  }

  console.log(`\n  Applying ${patches.length} patches (concurrency ${CONCURRENCY})...`);
  const t0 = Date.now();
  let done = 0;
  let writeStoppedAtBudget = false;
  let writeNotReached = 0;
  const { ok, err } = await runInParallel(patches, async (p) => {
    // THE PRE-CHECK, inside the worker so it governs the RUN and not one wave.
    if (CLOCK.outOfClock()) { writeStoppedAtBudget = true; writeNotReached++; return; }
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/gradeCompany", value: p.gradeCompany },
      { op: "set", path: "/gradeValue", value: p.gradeValue },
    ]);
    if (++done % 500 === 0) process.stdout.write(`\r    ${done}/${patches.length} patched`);
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\r    ${done}/${patches.length} patched (${secs}s)  err=${err}`);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  // `ok` is NOT the written count: runInParallel counts a worker callback that
  // did not throw, which includes the budget-stopped early return above.
  // `done` is incremented only after the patch itself resolves. The summary
  // said `patched: ${ok}` and was therefore wrong the moment a worker could
  // return without writing.
  console.log(`  patched:  ${done}`);
  console.log(`  errors:   ${err}`);

  // RECONCILE OVER THE KNOWN PLAN. `patches` is fixed before the first write,
  // so the population is known and `not reached` is a real number.
  console.log(`  reconciled: intended ${patches.length} = written ${done}`
    + ` + failed ${err} + not reached ${writeNotReached}`);
  if (done + err + writeNotReached !== patches.length) {
    console.error("  !! RECONCILE MISMATCH -- a planned patch was neither written, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "backfill-grade-from-ch-daily",
    intended: patches.length, written: done, skipped: writeNotReached, failed: err,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (writeStoppedAtBudget || joinStoppedAtBudget || scanStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this pass is UNFINISHED; the relaunch continues from here`);
    console.log("  the patch is IDEMPOTENT: the scan selects only rows whose gradeCompany and"
      + " gradeValue are both absent or null, and a patched row has both, so the continuation"
      + " never re-reads what this pass wrote.");
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
