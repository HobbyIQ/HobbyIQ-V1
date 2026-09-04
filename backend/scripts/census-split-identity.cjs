#!/usr/bin/env node
/**
 * census-split-identity.cjs -- the SPLIT-IDENTITY census over the WHOLE pool.
 *
 * CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS (Drew, 2026-09-02: "we need to go back and
 * check ALL this way"). #1649 found split rows in 8 touched slugs. #1650
 * proved most of that population was the designed CardHedge partition and 72
 * were real damage. This walks all 16,428,857 rows and classifies every one
 * whose two identity fields disagree. READ ONLY -- it never writes.
 *
 * The rule itself lives in scripts/lib/split-identity.cjs so the census, the
 * rematch classifier and the invariant auditor decide identically and the
 * tests pin the code that runs. This file is paging, sharding and the banner.
 *
 * WHY A _ts WALK AND NOT A PREDICATE
 *
 * The natural query is `WHERE c.cardId != c.hobbyiqCardId`. It does not work:
 * a field-to-field comparison is not index-served, so Cosmos falls back to a
 * full scan of a 16.4M-row container and the query dies before returning --
 * measured 2026-09-02, the COUNT came back empty rather than slow. Every
 * pattern that DOES work has the same shape: an indexed EQUALITY or RANGE
 * server-side, and the field compare done client-side on the rows that come
 * back. So the corpus is walked in `_ts` range windows -- `_ts` is indexed,
 * every one of the 16,428,857 rows carries one, and a one-day window COUNT
 * costs ~400 RU against the 10k floor.
 *
 * CHUNKS ARE SIZED BY ROW COUNT, NOT BY TIME. `_ts` is last-modified, not sale
 * date, so the corpus is violently skewed toward recent backfills: measured
 * 2026-09-02, the week of 08-01 holds 14,163 rows and the week of 08-29 holds
 * 7,329,221 -- a 517x spread. Fixed-width time chunks would put half the pool
 * in one window and time out on it while the others returned instantly, so a
 * window that overflows is bisected until it fits ROWS_PER_CHUNK.
 *
 * SHARDING. slot/slots split the _ts SPACE, not the row count: slot N takes
 * every chunk whose index mod slots === slot. Because chunks are already
 * row-balanced by the bisection above, equal chunk counts mean roughly equal
 * row counts, and the banner prints the rows each slot actually classified so
 * the balance is measured rather than assumed (CF-A-SHARD-AXIS-MUST-BE-
 * GUARANTEED-AND-MEASURED).
 *
 * RELAUNCH. The walk is READ ONLY, so there is no predicate that shrinks as it
 * works and no cursor to resume from that would still be a census OF THE
 * SHARD. A run that hits its budget prints the marker and the runner
 * re-dispatches; the continuation re-reads its shard from the top, exactly as
 * the rematch census does and for the same reason. CENSUS_FROM_TS lets a
 * relaunch skip chunks the previous run already reported, when a shard is too
 * big for one budget.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   COSMOS_DATABASE           default "hobbyiq"
 *   SLOT / SLOTS              which slice (default 0 / 1 = the whole corpus)
 *   ROWS_PER_CHUNK            target rows per _ts window (default 200000)
 *   RUN_MINUTES               budget marker (default 140, under the step's 150)
 *   LIMIT                     stop after N rows classified (0 = no limit)
 *   TOP_SLUGS                 damaged slugs listed (default 25)
 *   MAX_SAMPLES               sample rows kept per class (default 8)
 *   CENSUS_OUT                directory for the JSON census (default /tmp/split-identity-census)
 *   CENSUS_FROM_TS            resume: skip chunks ending at or below this _ts
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const S = require(path.join(__dirname, "lib", "split-identity.cjs"));

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER || "sold_comps";
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// This census lane is a REAL fan-out -- it is always dispatched across every
// slot (the 2026-09-03 runs walked all 64, twice) and it never writes -- so it
// keeps sharding on the env alone. It uses the SHARED helper so its banner
// states its coverage in the same words as every other lane, and so the rule
// lives in one place rather than in 56 copies.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ alwaysShard: true, label: "census-split-identity" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const ROWS_PER_CHUNK = Number(process.env.ROWS_PER_CHUNK || 200000);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 140);
const LIMIT = Number(process.env.LIMIT || 0);
const TOP_SLUGS = Number(process.env.TOP_SLUGS || 25);
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES || 8);
const CENSUS_OUT = process.env.CENSUS_OUT || "/tmp/split-identity-census";
const FROM_TS = Number(process.env.CENSUS_FROM_TS || 0);

const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const f = (n) => Number(n ?? 0).toLocaleString();
const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(3) + "%" : "-");

// sold_comps sits at its RU floor while the spine fleets run; every read
// retries on 429 instead of taking the whole measurement down.
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

  const pool = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database(DB_NAME).container(CONTAINER);

  const q = async (query, parameters = [], maxItemCount = 1000) =>
    (await retry(() => pool.items.query({ query, parameters }, { maxItemCount }).fetchAll())).resources;
  const countIn = async (lo, hi) =>
    Number((await q("SELECT VALUE COUNT(1) FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      [{ name: "@lo", value: lo }, { name: "@hi", value: hi }]))[0] ?? 0);

  console.log(`census-split-identity  READ ONLY  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m  target ${f(ROWS_PER_CHUNK)} rows/chunk${LIMIT ? `  limit ${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  // ── bounds + row-balanced chunk plan ─────────────────────────────────────
  const minTs = Number((await q("SELECT VALUE MIN(c._ts) FROM c"))[0] ?? 0);
  const maxTs = Number((await q("SELECT VALUE MAX(c._ts) FROM c"))[0] ?? 0);
  if (!minTs || !maxTs) { console.error("FATAL: could not read _ts bounds — refusing to report a census of nothing"); process.exit(3); }
  const grand = await countIn(minTs, maxTs + 1);
  console.log(`corpus  ${f(grand)} rows  _ts ${minTs}..${maxTs}  (${new Date(minTs * 1000).toISOString().slice(0, 10)} .. ${new Date(maxTs * 1000).toISOString().slice(0, 10)})`);

  /**
   * Bisect [lo,hi) until every window holds <= ROWS_PER_CHUNK rows. A window
   * that cannot be split further (lo+1 === hi, one _ts second) is kept whole
   * however large -- a single second's worth of rows is one bulk write's
   * worth, and the alternative is an infinite bisection.
   */
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
  const mine = chunks.filter((_, i) => i % SLOTS === SLOT).filter((c) => c.hi > FROM_TS);
  const myRows = mine.reduce((s, c) => s + c.n, 0);
  console.log(`plan    ${f(chunks.length)} chunks over the corpus; slot ${SLOT} owns ${f(mine.length)} of them = ${f(myRows)} rows (${pct(myRows, grand)} of the corpus)${FROM_TS ? `  [resumed past _ts ${FROM_TS}]` : ""}\n`);

  // ── walk ─────────────────────────────────────────────────────────────────
  const counts = new Map();          // klass -> n
  const vendorCounts = new Map();    // vendor shape -> n
  const segCounts = new Map();       // differing segment -> n
  const sourceSplits = new Map();    // source -> n (split rows only)
  const damagedSlugs = new Map();    // slug -> n (both sides counted)
  const samples = new Map();         // klass -> [line]
  let scanned = 0, splits = 0, lastTs = 0, stopReason = null;

  const bump = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
  const sample = (k, line) => {
    const arr = samples.get(k) ?? [];
    if (arr.length < MAX_SAMPLES) { arr.push(line); samples.set(k, arr); }
  };

  for (const chunk of mine) {
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
    if (LIMIT && scanned >= LIMIT) { stopReason = `stopped at LIMIT=${f(LIMIT)}`; break; }

    // The whole point: an indexed RANGE server-side, the field compare done
    // client-side on what comes back. Never `c.cardId != c.hobbyiqCardId`.
    const iter = pool.items.query({
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c._ts FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      parameters: [{ name: "@lo", value: chunk.lo }, { name: "@hi", value: chunk.hi }],
    }, { maxItemCount: 2000 });

    while (iter.hasMoreResults()) {
      if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
      if (LIMIT && scanned >= LIMIT) { stopReason = `stopped at LIMIT=${f(LIMIT)}`; break; }
      const { resources } = await retry(() => iter.fetchNext());
      for (const row of resources || []) {
        scanned++;
        lastTs = Math.max(lastTs, Number(row._ts) || 0);
        const c = S.classifyIdentity(row);
        bump(counts, c.klass);
        if (c.klass === S.VENDOR_DESIGN) { bump(vendorCounts, c.vendorShape); continue; }
        if (!c.split) continue;
        splits++;
        bump(sourceSplits, String(row.source ?? "(none)"));
        for (const seg of c.segments) bump(segCounts, seg);
        // BOTH sides are counted as damaged: the row pollutes the pool it is
        // partitioned under AND the pool its slug names, and a repair has to
        // know both addresses.
        if (c.cardId) bump(damagedSlugs, c.cardId);
        if (c.hobbyiqCardId && c.hobbyiqCardId !== c.cardId) bump(damagedSlugs, c.hobbyiqCardId);
        sample(c.klass, `${String(row.source ?? "?").padEnd(20)} ${row.id}  ${S.renderSplit(c)}`);
      }
      if (scanned % 500000 < 2000) process.stderr.write(`\r  scanned=${f(scanned)} splits=${f(splits)}   `);
    }
    if (stopReason) break;
  }
  process.stderr.write("\n");

  // ── banner ───────────────────────────────────────────────────────────────
  const get = (k) => counts.get(k) ?? 0;
  const CLASSES = [S.COHERENT, S.VENDOR_DESIGN, S.HIQ_SPLIT, S.UNKNOWN_VENDOR, S.MALFORMED];
  console.log(`\n${"=".repeat(78)}`);
  console.log(`SPLIT-IDENTITY CENSUS   slot ${SLOT}/${SLOTS}   rows classified ${f(scanned)}${stopReason ? `   (${stopReason})` : ""}`);
  console.log(`${"=".repeat(78)}\n`);
  console.log("BY CLASS");
  for (const k of CLASSES) {
    const n = get(k);
    const tag = k === S.VENDOR_DESIGN ? "  <- designed vendor partition, NOT damage (#1650)"
      : k === S.HIQ_SPLIT ? "  <- THE DAMAGE CLASS: both sides hiq:, different cards"
        : k === S.UNKNOWN_VENDOR ? "  <- foreign cardId of an unmeasured shape; tell Drew"
          : "";
    console.log(`  ${k.padEnd(16)} ${f(n).padStart(12)}  ${pct(n, scanned).padStart(9)}${tag}`);
  }
  console.log(`  ${"-".repeat(16)} ${"-".repeat(12)}`);
  console.log(`  ${"flagged".padEnd(16)} ${f(splits).padStart(12)}  ${pct(splits, scanned).padStart(9)}  (HIQ-SPLIT + UNKNOWN-VENDOR + MALFORMED)`);

  // RECONCILED: every row landed in exactly one class, and the flagged count
  // is exactly the classes that set split=true. A census whose parts do not
  // add up is not evidence, so this is asserted rather than trusted.
  const classSum = CLASSES.reduce((s, k) => s + get(k), 0);
  const flagSum = get(S.HIQ_SPLIT) + get(S.UNKNOWN_VENDOR) + get(S.MALFORMED);
  const reconciled = classSum === scanned && flagSum === splits;
  console.log(`\nRECONCILED  classes sum to ${f(classSum)} of ${f(scanned)} scanned; flagged ${f(splits)} vs class sum ${f(flagSum)}  -> ${reconciled ? "OK" : "MISMATCH"}`);
  if (!reconciled) console.log("  ::warning:: the census does not reconcile — the class counts and the scan disagree");

  if (vendorCounts.size) {
    console.log("\nVENDOR-DESIGN SHAPES (exempt, counted)");
    for (const [k, n] of [...vendorCounts].sort((a, b) => b[1] - a[1])) {
      const shape = S.VENDOR_SHAPES.find((s) => s.name === k);
      console.log(`  ${String(k).padEnd(22)} ${f(n).padStart(12)}   e.g. ${shape ? shape.example : "?"}`);
    }
  }

  if (segCounts.size) {
    console.log("\nHIQ-SPLIT SUB-BUCKETS (which slug segment disagrees; a row can differ on several)");
    for (const [k, n] of [...segCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(22)} ${f(n).padStart(12)}`);
    }
  }

  if (sourceSplits.size) {
    console.log("\nFLAGGED ROWS BY SOURCE");
    for (const [k, n] of [...sourceSplits].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(22)} ${f(n).padStart(12)}`);
    }
  }

  if (damagedSlugs.size) {
    console.log(`\nTOP DAMAGED SLUGS BY ROW COUNT (both addresses of every flagged row; ${f(damagedSlugs.size)} distinct)`);
    for (const [slug, n] of [...damagedSlugs].sort((a, b) => b[1] - a[1]).slice(0, TOP_SLUGS)) {
      console.log(`  ${f(n).padStart(8)}  ${slug}`);
    }
  }

  for (const k of [S.HIQ_SPLIT, S.UNKNOWN_VENDOR, S.MALFORMED]) {
    const arr = samples.get(k);
    if (!arr || !arr.length) continue;
    console.log(`\nSAMPLES — ${k} (capped at ${MAX_SAMPLES})`);
    for (const line of arr) console.log(`  ${line}`);
  }

  // ── the census artifact ──────────────────────────────────────────────────
  const census = {
    job: "census-split-identity", slot: SLOT, slots: SLOTS,
    at: new Date().toISOString(), readOnly: true,
    corpusRows: grand, chunksTotal: chunks.length, chunksMine: mine.length,
    plannedRows: myRows, scanned, splits, reconciled, stopReason,
    lastTs, counts: Object.fromEntries(counts),
    vendorShapes: Object.fromEntries(vendorCounts),
    segments: Object.fromEntries(segCounts),
    bySource: Object.fromEntries(sourceSplits),
    topDamagedSlugs: [...damagedSlugs].sort((a, b) => b[1] - a[1]).slice(0, TOP_SLUGS).map(([slug, n]) => ({ slug, rows: n })),
    samples: Object.fromEntries(samples),
  };
  try {
    const dir = CENSUS_OUT.endsWith(".json") ? path.dirname(CENSUS_OUT) : CENSUS_OUT;
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `split-identity-census-slot-${SLOT}.json`);
    fs.writeFileSync(out, JSON.stringify(census, null, 2));
    console.log(`\ncensus written to ${out}`);
  } catch (e) {
    console.log(`\n::warning::could not write the census artifact: ${e?.message}`);
  }

  // The budget marker the runner greps to decide a relaunch (#1361). Printed
  // in the same words every other lane uses so the runner's one regex catches
  // it, and ONLY when work is actually left.
  if (stopReason && stopReason.includes("budget")) {
    console.log(`\n${stopReason} — the relaunch continues from here (CENSUS_FROM_TS=${lastTs}).`);
  }
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s — READ ONLY, nothing was written to Cosmos.`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
