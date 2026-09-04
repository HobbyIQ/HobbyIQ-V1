#!/usr/bin/env node
/**
 * rematch-canary-check.cjs -- the gate between a clean census and an apply.
 *
 * CF-THE-CANARY-IS-A-HAND-VERIFIED-POOL (GREAT REMATCH, Drew 2026-09-01).
 * The GREAT REMATCH may auto-apply its IMPROVE class, and an auto-apply needs
 * something outside itself that says the pool got better and not merely
 * different. The canaries are the holdings whose pools Drew verified by hand:
 * their FMV inputs are known-good, so a shard that moves one of them away from
 * its verified market has done damage, whatever its own banner says.
 *
 * This script does NOT price. It measures the INPUTS that decide the price,
 * because those are what a re-key can move and they can be measured without
 * the estimator's 180-day windows, calibration tables or dist/ build:
 *
 *   rows          how many sales the pool holds -- the union of the slug's own
 *                 partition (c.cardId) and the rows that merely CARRY it
 *                 (c.hobbyiqCardId). Measured 2026-09-01, the split is real:
 *                 Shaq has 2 rows under the partition and 55 carrying the
 *                 slug; Judge Gold Label has 5 under the partition and 0
 *                 carrying it. A check that read one field would see a healthy
 *                 pool vanish and call it unchanged.
 *   anchor        the leading-edge price: the median of the newest 3 sales.
 *                 FMV is the projected next sale from the pool's trend, never
 *                 a median of the pool -- but the ANCHOR the projection starts
 *                 from is a recency-weighted level, and a re-key that changes
 *                 which sales are newest moves it. That is the thing to watch.
 *   newest        the newest sale's date and price, so a pool that lost its
 *                 leading edge is visible even when the count barely moves.
 *   protected     how many rows in the pool are provenance-protected. This
 *                 must NEVER fall: a protected row that left the pool means a
 *                 write touched something no fleet may touch.
 *
 * WHAT COUNTS AS A REGRESSION -- and exits nonzero
 *
 *   1. the pool LOST rows. A rematch moves sales between pools; a verified
 *      pool losing sales is the split-pool defect the rematch exists to end,
 *      arriving from the other direction. (Rows GAINED are fine and expected:
 *      that is a mis-filed sale coming home.)
 *   2. the pool went EMPTY. Three canaries have 1-row pools; there is no
 *      "small regression" available to them.
 *   3. a PROTECTED row left the pool. Report-only forever means exactly this.
 *   4. the anchor moved more than ANCHOR_TOLERANCE_PCT (default 10%) away
 *      from its verified level. A pool whose leading edge jumps has had its
 *      composition changed, and a hand-verified pool should not change.
 *
 * A canary that GAINS rows and holds its anchor PASSES, and the banner says so
 * -- the point is to catch damage, not to freeze the pool.
 *
 * WHERE THIS SITS IN THE SEQUENCE (the apply dispatcher runs it, not the
 * fleet script -- a script cannot certify itself):
 *
 *   1. dispatch rematch-sold-comps MODE=census for the shard          READ ONLY
 *   2. audit 500 rows of that shard's IMPROVE bucket from the census
 *      JSON. Not clean -> STOP, the shard goes to Drew.
 *   3. rematch-canary-check.cjs MODE=before   -> writes the baseline
 *   4. dispatch rematch-sold-comps MODE=apply-improve apply=true for
 *      THAT SHARD ONLY
 *   5. rematch-canary-check.cjs MODE=after    -> compares to the baseline,
 *      exits 5 on any regression
 *   6. exit 5 -> the shard is a regression: STOP the fleet, hand Drew the
 *      diff. Do not proceed to the next shard.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      MODE=before | after | check   (default check: measure and print only)
 *      BASELINE=/tmp/rematch-canary-baseline.json
 *      CANARIES=backend/data/rematch-canaries.json
 *      ANCHOR_TOLERANCE_PCT=10
 *      SCOPE=base-eviction | improve | both   (the apply class scope; under an
 *            eviction scope a PARALLEL canary is expected to lose base rows,
 *            and the loss must be accounted for by the eviction marker)
 * READ ONLY against Cosmos in every mode -- it never writes to the pool.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const MODE = String(process.env.MODE || "check").trim();
const BASELINE = String(process.env.BASELINE || "/tmp/rematch-canary-baseline.json");
const CANARIES = String(process.env.CANARIES || path.join(__dirname, "..", "data", "rematch-canaries.json"));
const TOL = Number(process.env.ANCHOR_TOLERANCE_PCT || 10);

const f = (n) => Number(n ?? 0).toLocaleString();
const money = (n) => (n === null || n === undefined ? "-" : `$${Number(n).toFixed(2)}`);
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

/** Median of a numeric list. Used ONLY for the leading-edge anchor of the
 *  newest 3 sales -- never as an FMV. FMV is the projected next sale. */
function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * The FMV inputs of one canary pool. Pure given the rows, so a test can drive
 * it without Cosmos.
 */
function poolInputs(rows) {
  const sorted = rows.slice().sort((a, b) => Date.parse(String(b.soldAt ?? 0)) - Date.parse(String(a.soldAt ?? 0)));
  const newest = sorted[0] ?? null;
  const anchor = median(sorted.slice(0, 3).map((r) => Number(r.price)));
  const protectedRows = rows.filter((r) => K.provenanceTier(r).tier === K.PROTECTED);
  return {
    rows: rows.length,
    byPartition: rows.filter((r) => r.__viaPartition).length,
    byField: rows.filter((r) => !r.__viaPartition).length,
    anchor,
    newestAt: newest?.soldAt ?? null,
    newestPrice: newest === null ? null : Number(newest.price),
    protectedRows: protectedRows.length,
    protectedIds: protectedRows.map((r) => `${r.id}@${r.cardId}`).sort(),
  };
}

/**
 * Compare one canary's before/after inputs. Returns { ok, regressions[],
 * notes[] } -- `regressions` non-empty is a shard failure.
 */
function compareCanary(canary, before, after, tolPct = TOL) {
  const regressions = [], notes = [];
  // A PARALLEL-POOL CANARY IS SUPPOSED TO LOSE BASE ROWS (2026-09-04).
  //
  // "rows went down" was written for the IMPROVE class, where a verified pool
  // has no reason to shrink. Under scope=base-eviction the whole POINT is that
  // base-titled sales mis-filed on a parallel slug leave for the base pool, so
  // on a parallel canary a loss is the intended effect and the old rule fails
  // the shard for doing its job. On a BASE canary (slug parallel is base) no
  // eviction can ever remove a row, so there the rule still holds exactly.
  //
  // What must be asserted instead is that every row that left is ACCOUNTED
  // FOR: it carries the eviction marker, it is base-titled, and it landed on
  // the base identity. The checker cannot see the destination rows, so it
  // asserts what it can -- that the departures are attributable to this
  // apply -- and `unexplainedLoss` (rows that vanished with no eviction
  // marker) stays a regression in every scope. An anchor move is a NOTE under
  // eviction scope rather than a failure, because removing mis-filed sales is
  // expected to move the leading edge.
  // SCOPE is the variable the backfill runner already passes to the fleet
  // script as its APPLY CLASS SCOPE, so the gate and the apply read the SAME
  // value and cannot disagree about which class ran. APPLY_SCOPE is accepted
  // as an alias for a hand-run check.
  const evictionScope = String(process.env.SCOPE || process.env.APPLY_SCOPE || "").toLowerCase().includes("eviction");
  const canaryIsParallel = !/:(base|no-parallel)?:(auto|no-auto)$/.test(String(canary.slug || "")) &&
    !/:base:(auto|no-auto)$/.test(String(canary.slug || ""));
  const lossIsExpected = evictionScope && canaryIsParallel;
  const lost = before.rows - after.rows;
  if (after.rows < before.rows) {
    const explained = Number(after.evictedAway ?? 0);
    if (lossIsExpected && explained >= lost) notes.push(`pool lost ${lost} row(s) to base eviction, all ${explained} accounted for by the eviction marker -- the intended effect`);
    else if (lossIsExpected) regressions.push(`pool LOST ${lost} row(s): ${before.rows} -> ${after.rows}, but only ${explained} carry the eviction marker -- ${lost - explained} unexplained`);
    else regressions.push(`pool LOST ${lost} row(s): ${before.rows} -> ${after.rows}`);
  }
  else if (after.rows > before.rows) notes.push(`pool gained ${after.rows - before.rows} row(s) -- a mis-filed sale coming home`);
  if (after.rows === 0) regressions.push("pool is EMPTY");
  if (after.protectedRows < before.protectedRows) {
    const gone = before.protectedIds.filter((x) => !after.protectedIds.includes(x));
    regressions.push(`a PROTECTED row left the pool (${before.protectedRows} -> ${after.protectedRows})${gone.length ? `: ${gone.join(", ")}` : ""}`);
  }
  if (before.anchor !== null && after.anchor !== null && before.anchor > 0) {
    const movePct = Math.abs((after.anchor - before.anchor) / before.anchor) * 100;
    if (movePct > tolPct && lossIsExpected) notes.push(`anchor moved ${movePct.toFixed(1)}%: ${money(before.anchor)} -> ${money(after.anchor)} -- expected under base eviction, the leading edge is recomputed once mis-filed sales leave`);
    else if (movePct > tolPct) regressions.push(`anchor moved ${movePct.toFixed(1)}% (tolerance ${tolPct}%): ${money(before.anchor)} -> ${money(after.anchor)}`);
    else if (movePct > 0) notes.push(`anchor moved ${movePct.toFixed(1)}% within tolerance`);
  } else if (before.anchor !== null && after.anchor === null) {
    regressions.push(`anchor is gone: ${money(before.anchor)} -> none`);
  }
  return { name: canary.name, slug: canary.slug, ok: regressions.length === 0, regressions, notes };
}

async function measure(pool, slug) {
  const all = async (q, p) => { const it = pool.items.query({ query: q, parameters: p }, { maxItemCount: 1000 }); const o = []; while (it.hasMoreResults()) { const { resources } = await retry(() => it.fetchNext()); o.push(...(resources ?? [])); } return o; };
  // The union, deliberately: a pool split across the partition and the field is
  // exactly the state the rematch is fixing, and a check that read one field
  // would call a vanished pool unchanged.
  const byPartition = await all("SELECT * FROM c WHERE c.cardId = @s", [{ name: "@s", value: slug }]);
  const byField = await all("SELECT * FROM c WHERE c.hobbyiqCardId = @s AND c.cardId != @s", [{ name: "@s", value: slug }]);
  for (const r of byPartition) r.__viaPartition = true;
  // THE UNION IS DE-DUPLICATED BY id (2026-09-04 incident).
  //
  // A sale can appear twice in this union -- the same id under two cardIds
  // (a cross-source CH/CS pair), or a row whose cardId and hobbiqCardId both
  // point here. Counting the raw concatenation makes the pool look larger
  // than it is, and then the NIGHTLY DEDUP job (04:45 UTC, cross_source=true)
  // collapsing that pair reads as "the pool LOST a row" to a check whose
  // baseline was taken before it ran. That is exactly what failed the wave of
  // 2026-09-04: four canaries reported losses of 1-3 rows, and every one of
  // them was a duplicate id being retired by a concurrent job -- zero rows had
  // left any canary pool to a base eviction.
  //
  // A pool is a set of SALES, so the count that gates a fleet must be a count
  // of distinct sales.
  // Rows that LEFT this slug by a base eviction, counted from the marker the
  // apply writes onto the relocated row (rekeyedFrom[0].cardId is the pool it
  // came from). This is what makes a loss EXPLAINABLE instead of merely
  // observed: an eviction that moved a sale to its base pool is attributable,
  // and anything else that removed a row is not.
  const evicted = await all(
    "SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.baseEvictionEvidence) AND ARRAY_LENGTH(c.rekeyedFrom) > 0 AND c.rekeyedFrom[0].cardId = @s",
    [{ name: "@s", value: slug }]
  );
  const byId = new Map();
  for (const r of [...byPartition, ...byField]) if (!byId.has(r.id)) byId.set(r.id, r);
  return { ...poolInputs([...byId.values()]), evictedAway: Number(evicted[0] ?? 0) };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!["before", "after", "check"].includes(MODE)) { console.error(`FATAL: MODE must be before | after | check; got ${JSON.stringify(MODE)}`); process.exit(2); }
  const doc = JSON.parse(fs.readFileSync(CANARIES, "utf8"));
  const canaries = doc.canaries ?? [];
  if (!canaries.length) { console.error(`FATAL: ${CANARIES} lists no canaries.`); process.exit(2); }

  // THE SHARD BEING APPLIED MUST HAVE A CANARY (audit gate, 2026-09-03).
  //
  // The gate is per-shard by construction -- before, apply ONE shard, after --
  // so a shard with no canary in it passes by construction: the pools measured
  // are pools that shard's apply cannot touch. 25 of 32 shards were in that
  // state, slot 29 among them, and slot 29 was the 30/30-wrong one.
  //
  // SLOT is read from the same env the runner passes to the fleet script, so
  // the before/after pair and the apply are certainly talking about the same
  // shard. A refusal here is a refusal to certify, which is the correct
  // failure: better no verdict than a green one that measured nothing.
  const SLOT = process.env.SLOT === undefined || process.env.SLOT === "" ? null : Number(process.env.SLOT);
  if (SLOT !== null && Number.isFinite(SLOT)) {
    const inShard = canaries.filter((c) => Number(c.shardSlot) === SLOT);
    if (!inShard.length) {
      console.error(`FATAL: SLOT=${SLOT} has NO canary in ${CANARIES}. A shard with no canary passes this gate by construction --`);
      console.error(`       the pools it measures are pools that shard's apply cannot move. That is not a pass, it is an absence of measurement.`);
      console.error(`       Run backend/scripts/derive-rematch-canaries.cjs to give every shard a canary before applying this one.`);
      process.exit(2);
    }
    console.log(`  slot ${SLOT}: ${inShard.length} canary/canaries live in THIS shard -- ${inShard.map((c) => c.slug).join(", ")}`);
  }

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");

  console.log(`rematch-canary-check  MODE=${MODE}  ${canaries.length} canaries  anchor tolerance ${TOL}%  READ ONLY`);
  console.log(`  the anchor is the leading edge (median of the newest 3), never the pool's FMV -- FMV is the projected next sale.`);

  const now = {};
  for (const c of canaries) {
    now[c.slug] = await measure(pool, c.slug);
    const m = now[c.slug];
    console.log(`\n  ${c.name}`);
    console.log(`    ${c.slug}`);
    console.log(`    rows ${f(m.rows)} (partition ${f(m.byPartition)} + field ${f(m.byField)})   expected floor ${f(c.poolRows)}   protected ${f(m.protectedRows)}`);
    console.log(`    anchor ${money(m.anchor)}   newest ${money(m.newestPrice)} @ ${m.newestAt ?? "-"}   direction ${c.verifiedMarketDirection}`);
    if (m.rows < Number(c.poolRows ?? 0)) console.log(`    !! below the captured floor of ${f(c.poolRows)} -- the pool has lost rows since 2026-09-01`);
  }

  if (MODE === "before") {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({ capturedAt: new Date().toISOString(), tolerancePct: TOL, inputs: now }, null, 1));
    console.log(`\nbaseline written -> ${BASELINE}`);
    console.log(`Now dispatch rematch-sold-comps MODE=apply-improve for the SHARD, then re-run this with MODE=after.`);
    return;
  }
  if (MODE === "check") { console.log(`\ncheck only -- no baseline compared. Run MODE=before, apply the shard, then MODE=after.`); return; }

  if (!fs.existsSync(BASELINE)) { console.error(`FATAL: MODE=after but no baseline at ${BASELINE}. The gate cannot pass a shard it has no before for.`); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const results = [];
  for (const c of canaries) {
    const b = base.inputs?.[c.slug];
    if (!b) { results.push({ name: c.name, slug: c.slug, ok: false, regressions: ["no baseline entry for this canary"], notes: [] }); continue; }
    results.push(compareCanary(c, b, now[c.slug], base.tolerancePct ?? TOL));
  }

  console.log(`\nCANARY VERDICT  (baseline ${base.capturedAt})`);
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    for (const x of r.regressions) console.log(`        REGRESSION: ${x}`);
    for (const n of r.notes) console.log(`        ${n}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n!! ${failed.length} of ${results.length} canaries REGRESSED. This shard is damage, not an improvement.`);
    console.error(`   STOP the fleet. Do not apply the next shard. The diff goes to Drew.`);
    process.exit(5);
  }
  console.log(`\nall ${results.length} canaries hold -- the shard may stand, and the next shard may be censused.`);
}

module.exports = { median, poolInputs, compareCanary };

if (require.main === module) main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
