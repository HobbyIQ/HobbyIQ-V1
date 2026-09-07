#!/usr/bin/env node
/**
 * census-duplicate-sale-ids.cjs -- ONE SALE, ONE DOCUMENT: the whole-pool
 * census of sale ids resident in MORE THAN ONE partition.
 *
 * #1924/#1936 found split-identity ROWS -- one document whose two identity
 * fields disagree. This is the other shape, and it is strictly worse: the SAME
 * `id` exists as TWO DOCUMENTS under two different `cardId` partition keys, so
 * the sale is a row in each of two pools. The reasoning lives in
 * scripts/lib/duplicate-sale-ids.cjs; this file is paging, sharding, the
 * catalog check and the banner.
 *
 * WHY A _ts WALK AND NOT A GROUP BY
 *
 * `SELECT c.id, COUNT(1) FROM c GROUP BY c.id` over 16.9M rows is a
 * cross-partition aggregate over an unbounded group set: it does not return.
 * The shape that works everywhere else works here -- an indexed RANGE
 * server-side, the grouping done client-side on what comes back -- so the
 * corpus is walked in `_ts` windows bisected until each holds at most
 * ROWS_PER_CHUNK rows, exactly as census-split-identity.cjs does it, and for
 * the same reason. A bare cross-partition COUNT is never issued; the corpus
 * count is bounded by the indexed `_ts` range.
 *
 * SHARDING IS BY ID HASH, NOT BY _ts -- see `shardOfId` in the library for why
 * the split-identity walk's `_ts` shard axis would report zero here.
 *
 * MEMORY. A slot holds only its own 1/SLOTS slice of ids. At SLOTS=64 that is
 * ~265k ids, one short object each, and the full per-copy detail only for the
 * ids that actually repeat.
 *
 * READ ONLY -- it never writes.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   COSMOS_DATABASE           default "hobbyiq"
 *   SLOT / SLOTS              which id-hash slice
 *   SLOT_SPAN                 how many CONSECUTIVE slots this process covers in
 *                             ONE pass (default 1). Every slot must walk the
 *                             whole `_ts` space -- see shardOfId -- so N slots
 *                             run as N full scans unless they share a pass.
 *                             SLOT_SPAN folds them into one walk: the scan is
 *                             paid once and the memory scales with the span.
 *   ROWS_PER_CHUNK            target rows per _ts window (default 200000)
 *   RUN_MINUTES               budget marker (default 120)
 *   LIMIT                     stop after N rows scanned (0 = no limit)
 *   PROBE_ONLY                measure rows/s and RU, then exit (no walk)
 *   MAX_SAMPLES               sample duplicate ids printed (default 12)
 *   CENSUS_OUT                directory for the JSON census
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const D = require(path.join(__dirname, "lib", "duplicate-sale-ids.cjs"));

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps";
const SHARD_SCOPE = runnerShardScope({ alwaysShard: true, label: "census-duplicate-sale-ids" });
const { SLOT, SLOTS } = SHARD_SCOPE;
// CF-A-SHARD-AXIS-MUST-BE-GUARANTEED-AND-MEASURED, cost side. Because every
// slot must read the WHOLE corpus (a duplicate's copies sit in different `_ts`
// windows), a 64-way fan-out is 64 full scans of 16.9M rows. SLOT_SPAN lets one
// process own a CONTIGUOUS RANGE of slots and pay for the scan once; the id map
// then holds span/SLOTS of the corpus, which is the real constraint.
const SLOT_SPAN = Math.max(1, Number(process.env.SLOT_SPAN || 1));
const ROWS_PER_CHUNK = Number(process.env.ROWS_PER_CHUNK || 200000);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top — a budget check that runs
 *  after a unit admits one more unit of unbounded size past expiry. This
 *  lane's unit is one `_ts` chunk page (<= 2,000 rows), so the reserve is
 *  sized to the largest chunk a bisection can leave whole. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const PROBE_ONLY = String(process.env.PROBE_ONLY || "") === "true";
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES || 12);
const CENSUS_OUT = process.env.CENSUS_OUT || "/tmp/duplicate-sale-ids-census";

const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const f = (n) => Number(n ?? 0).toLocaleString();
const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(4) + "%" : "-");

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|timeout/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!Number.isFinite(SLOT) || !Number.isFinite(SLOTS) || SLOTS < 1 || SLOT < 0 || SLOT >= SLOTS) {
    console.error(`FATAL: SLOT must be 0..${SLOTS - 1}; got SLOT=${SLOT} SLOTS=${SLOTS}`);
    process.exit(2);
  }

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database(DB_NAME);
  const pool = db.container(CONTAINER);
  const catalog = db.container("card_catalog");

  const q = async (query, parameters = [], maxItemCount = 1000) =>
    (await retry(() => pool.items.query({ query, parameters }, { maxItemCount }).fetchAll())).resources;
  const countIn = async (lo, hi) =>
    Number((await q("SELECT VALUE COUNT(1) FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      [{ name: "@lo", value: lo }, { name: "@hi", value: hi }]))[0] ?? 0);

  const SLOT_HI = Math.min(SLOT + SLOT_SPAN, SLOTS);
  const mineSlot = (id) => { const sh = D.shardOfId(id, SLOTS); return sh >= SLOT && sh < SLOT_HI; };

  console.log(`census-duplicate-sale-ids  READ ONLY  slots ${SLOT}..${SLOT_HI - 1} of ${SLOTS}  budget ${RUN_MINUTES}m  target ${f(ROWS_PER_CHUNK)} rows/chunk${LIMIT ? `  limit ${f(LIMIT)}` : ""}`);
  console.log(`  shard axis: hashId(id) mod ${SLOTS} — every copy of an id lands in ONE slot`);
  console.log(`  this pass covers ${SLOT_HI - SLOT} of ${SLOTS} slots = ${((100 * (SLOT_HI - SLOT)) / SLOTS).toFixed(1)}% of the ids, in ONE walk of the corpus`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const minTs = Number((await q("SELECT VALUE MIN(c._ts) FROM c"))[0] ?? 0);
  const maxTs = Number((await q("SELECT VALUE MAX(c._ts) FROM c"))[0] ?? 0);
  if (!minTs || !maxTs) { console.error("FATAL: could not read _ts bounds — refusing to report a census of nothing"); process.exit(3); }
  const grand = await countIn(minTs, maxTs + 1);
  console.log(`corpus  ${f(grand)} rows  _ts ${minTs}..${maxTs}  (${new Date(minTs * 1000).toISOString().slice(0, 10)} .. ${new Date(maxTs * 1000).toISOString().slice(0, 10)})`);

  // ── throughput probe BEFORE the walk ─────────────────────────────────────
  // CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH (#1667): rows/s and RU
  // per 1,000 rows, measured, before any fan-out is sized on a guess.
  {
    const t0 = Date.now();
    const probeIter = pool.items.query({
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c._ts FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      parameters: [{ name: "@lo", value: maxTs - 3600 }, { name: "@hi", value: maxTs + 1 }],
    }, { maxItemCount: 2000 });
    let n = 0, ru = 0, pages = 0;
    while (probeIter.hasMoreResults() && n < 20000) {
      const r = await retry(() => probeIter.fetchNext());
      const got = (r.resources || []).length;
      n += got; ru += Number(r.requestCharge || 0); pages++;
      if (!got) break;
    }
    const secs = (Date.now() - t0) / 1000;
    console.log(`probe   ${f(n)} rows in ${secs.toFixed(1)}s = ${f(Math.round(n / Math.max(secs, 0.001)))} rows/s, ${(1000 * ru / Math.max(n, 1)).toFixed(1)} RU per 1,000 rows (${pages} pages)`);
    if (PROBE_ONLY) { console.log("PROBE_ONLY — exiting before the walk."); return 0; }
  }

  const chunks = [];
  const plan = async (lo, hi, depth = 0) => {
    const n = await countIn(lo, hi);
    if (n === 0) return;
    if (n <= ROWS_PER_CHUNK || hi - lo <= 1 || depth > 24) { chunks.push({ lo, hi, n }); return; }
    const mid = lo + Math.floor((hi - lo) / 2);
    await plan(lo, mid, depth + 1);
    await plan(mid, hi, depth + 1);
  };
  await plan(minTs, maxTs + 1);
  chunks.sort((a, b) => a.lo - b.lo);
  console.log(`plan    ${f(chunks.length)} chunks over the corpus — this slot walks ALL of them and keeps only the ids in its hash slice\n`);

  // ── walk: every chunk, keeping only this slot's id slice ─────────────────
  const seen = new Map();
  let scanned = 0, mineRows = 0, stopReason = null;

  for (const chunk of chunks) {
    if (budgetLeft() < RESERVE_MS) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
    if (LIMIT && scanned >= LIMIT) { stopReason = `stopped at LIMIT=${f(LIMIT)}`; break; }
    const iter = pool.items.query({
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c._ts FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      parameters: [{ name: "@lo", value: chunk.lo }, { name: "@hi", value: chunk.hi }],
    }, { maxItemCount: 2000 });

    while (iter.hasMoreResults()) {
      if (budgetLeft() < RESERVE_MS) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
      if (LIMIT && scanned >= LIMIT) { stopReason = `stopped at LIMIT=${f(LIMIT)}`; break; }
      const { resources } = await retry(() => iter.fetchNext());
      for (const row of resources || []) {
        scanned++;
        const id = String(row.id ?? "");
        if (!id || !mineSlot(id)) continue;
        mineRows++;
        D.observe(seen, id, row);
      }
      if (scanned % 500000 < 2000) process.stderr.write(`\r  scanned=${f(scanned)} mine=${f(mineRows)} ids=${f(seen.size)}   `);
    }
    if (stopReason) break;
  }
  process.stderr.write("\n");

  const dups = [];
  for (const [id, v] of seen) if (v && v.copies) dups.push({ id, copies: v.copies });
  const report = D.summarize(dups);

  // ── the catalog check that decides canonicity ────────────────────────────
  // Batched `IN` reads, read-only, over the DISTINCT addresses only — the same
  // shape #1924 used to prove the pokemon destinations did not exist.
  const addresses = [...new Set(dups.flatMap((d) => d.copies.map((c) => c.cardId)).filter((s) => s.startsWith("hiq:")))];
  const present = new Set();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const rows = await retry(() => catalog.items.query({
      query: `SELECT VALUE c.id FROM c WHERE c.id IN (${batch.map((_, j) => `@p${j}`).join(",")})`,
      parameters: batch.map((v, j) => ({ name: `@p${j}`, value: v })),
    }, { maxItemCount: 200 }).fetchAll());
    for (const r of rows.resources || []) present.add(String(r));
  }
  console.log(`catalog  ${f(present.size)} of ${f(addresses.length)} distinct duplicate addresses resolve to a card_catalog row`);

  const verdicts = {};
  const decided = dups.map((d) => {
    const dec = D.decideCanonical(d.copies, present);
    verdicts[dec.verdict] = (verdicts[dec.verdict] ?? 0) + 1;
    return { id: d.id, ...dec };
  });

  console.log(`\n${"=".repeat(78)}`);
  console.log(`DUPLICATE SALE IDS   slots ${SLOT}..${SLOT_HI - 1} of ${SLOTS}   rows scanned ${f(scanned)}${stopReason ? `   (${stopReason})` : ""}`);
  console.log(`${"=".repeat(78)}\n`);
  console.log(`  rows in this pass's id slice   ${f(mineRows)}`);
  console.log(`  distinct ids held              ${f(seen.size)}`);
  console.log(`  ids in >1 partition            ${f(report.dupIds)}   ${pct(report.dupIds, seen.size)} of this pass's ids`);
  console.log(`  ids in >2 partitions           ${f(report.dupIds3plus)}`);
  console.log(`  duplicate DOCUMENTS            ${f(report.dupDocs)}   <- what the pools actually double-count`);
  console.log(`  excess documents               ${f(report.excessDocs)}   <- one sale, one document: this many are extra`);

  // RECONCILED: dupDocs is exactly dupIds plus the excess, and every duplicate
  // id landed in exactly one verdict. A census whose parts do not add up is
  // not evidence, so this is asserted rather than trusted.
  const verdictSum = Object.values(verdicts).reduce((s, n) => s + n, 0);
  const reconciled = report.dupDocs === report.dupIds + report.excessDocs && verdictSum === report.dupIds;
  console.log(`\nRECONCILED  documents ${f(report.dupDocs)} = ids ${f(report.dupIds)} + excess ${f(report.excessDocs)}; verdicts sum to ${f(verdictSum)}  -> ${reconciled ? "OK" : "MISMATCH"}`);
  if (!reconciled) console.log("  ::warning:: the census does not reconcile");

  const table = (title, m) => {
    if (!m || !Object.keys(m).length) return;
    console.log(`\n${title}`);
    for (const [k, n] of Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      console.log(`  ${String(k).padEnd(46)} ${f(n).padStart(10)}`);
    }
  };
  table("BY SOURCE (duplicate ids; a mixed-source id is counted under each)", report.bySource);
  table("BY SPORT PAIR of the two partitions (older -> newer)", report.bySportPair);
  table("BY _ts DAY of the NEWER copy (is an emitter still writing a second copy?)", report.byNewerDay);
  table("CANONICAL VERDICTS", verdicts);

  console.log(`\nDOES THE NEWER COPY CARRY A DIFFERENT hobbyiqCardId?`);
  console.log(`  newer hiq DIFFERS from older   ${f(report.newerHiqDiffers)}`);
  console.log(`  newer hiq SAME as older        ${f(report.newerHiqSame)}`);
  console.log(`  newer copy is address-coherent ${f(report.newerCoherent)}`);
  console.log(`  older copy is address-coherent ${f(report.olderCoherent)}`);
  console.log(`\nSTILL LIVE?  newest duplicate copy written ${report.newestIso ?? "(none)"} — ${f(report.writtenLast7d)} ids have a copy written in the last 7 days`);

  if (dups.length) {
    console.log(`\nSAMPLES (capped at ${MAX_SAMPLES})`);
    for (const line of D.sampleLines(dups, MAX_SAMPLES)) console.log(`  ${line}`);
  }

  // The same writer as the checkpoint, so the artifact has ONE shape and the
  // only difference between a killed run and a finished one is whether the
  // catalog verdicts are filled in.
  const finalOut = writeCensus({
    catalogResolved: !catalogTruncated,
    catalogAddresses: addresses.length, catalogPresent: present.size,
    verdicts, reconciled,
    decided: decided.map((d) => ({ id: d.id, verdict: d.verdict, reason: d.reason, canonical: d.canonical?.cardId ?? null, extras: d.extras.map((e) => e.cardId) })),
  });
  if (finalOut) console.log(`\ncensus written to ${finalOut}`);

  if (stopReason && stopReason.includes("budget")) {
    console.log(`\n${stopReason} — the relaunch re-reads this shard from the top.`);
  }
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s — READ ONLY, nothing was written to Cosmos.`);
  return 0;
}

main()
  .then((c) => finishLane(typeof c === "number" ? c : 0, (c && typeof c === "object") ? c : {}))
  .catch(async (e) => { console.error("FATAL:", e?.stack || e?.message); await finishLane(3); });
