#!/usr/bin/env node
/**
 * Re-measure the SPORT-SEGMENT split population (tranche 2 planning).
 * READ ONLY. Reuses the #1924 _ts-window bisection and the shared classifier
 * so this measurement and the census decide identically.
 *
 * Writes the full sport-split row set to disk for offline classification.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const S = require(path.join(__dirname, "lib", "split-identity.cjs"));

const OUT = process.env.OUT || "C:/tmp/hiq-split-tranche/work/out";
const SHARDS = Number(process.env.SHARDS || 64);
const ROWS_PER_CHUNK = Number(process.env.ROWS_PER_CHUNK || 200000);
const GUARD_TS = Number(process.env.GUARD_TS || 0);
const f = (n) => Number(n ?? 0).toLocaleString();

const retry = async (fn, tries = 10) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|timeout/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

const sportOf = (slug) => String(slug || "").split(":")[1] || "";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const pool = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 40, maxWaitTimeInSeconds: 180 } },
  }).database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const q = async (query, parameters = []) =>
    (await retry(() => pool.items.query({ query, parameters }, { maxItemCount: 1000 }).fetchAll())).resources;
  const countIn = async (lo, hi) =>
    Number((await q("SELECT VALUE COUNT(1) FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      [{ name: "@lo", value: lo }, { name: "@hi", value: hi }]))[0] ?? 0);

  const minTs = Number((await q("SELECT VALUE MIN(c._ts) FROM c"))[0] ?? 0);
  const maxTs = Number((await q("SELECT VALUE MAX(c._ts) FROM c"))[0] ?? 0);
  if (!minTs || !maxTs) { console.error("FATAL: no _ts bounds"); process.exit(3); }
  const grand = await countIn(minTs, maxTs + 1);
  console.log(`corpus ${f(grand)} rows  _ts ${minTs}..${maxTs}  (${new Date(minTs*1000).toISOString().slice(0,10)} .. ${new Date(maxTs*1000).toISOString().slice(0,10)})`);

  const chunks = [];
  const plan = async (lo, hi, depth = 0) => {
    const n = await countIn(lo, hi);
    if (n === 0) return;
    if (n <= ROWS_PER_CHUNK || hi - lo <= 1 || depth > 24) { chunks.push({ lo, hi, n }); return; }
    const mid = lo + Math.floor((hi - lo) / 2);
    await plan(lo, mid, depth + 1); await plan(mid, hi, depth + 1);
  };
  await plan(minTs, maxTs + 1);
  chunks.sort((a, b) => a.lo - b.lo);
  console.log(`plan ${f(chunks.length)} chunks (${SHARDS}-shard axis available)`);
  fs.writeFileSync(path.join(OUT, "plan.json"), JSON.stringify({ minTs, maxTs, grand, chunks }, null, 2));

  // STREAM, DO NOT BUFFER. The first run of this measurement accumulated every
  // split row in an array and was OOM-killed at 5,001,437 rows of 16,904,909 --
  // silently, with exit 1 and no stderr, which is exactly what a V8 heap abort
  // looks like. The rows go to a JSONL file as they are found so the walk's
  // memory is flat regardless of how large the population turns out to be.
  const rowsPath = path.join(OUT, "sport-split-rows.jsonl");
  const rowsOut = fs.createWriteStream(rowsPath, { flags: "w" });
  const write = (obj) => {
    if (!rowsOut.write(JSON.stringify(obj) + "\n")) {
      return new Promise((r) => rowsOut.once("drain", r));
    }
    return null;
  };
  let scanned = 0, splits = 0, sportSplits = 0, parkedAlready = 0, newSinceGuard = 0;
  const bySportPair = new Map(), bySource = new Map(), byClass = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const chunk of chunks) {
    const iter = pool.items.query({
      query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c.title, c.price, c.soldAt, c.identityUnverified, c.flaggedWrong, c._ts FROM c WHERE c._ts >= @lo AND c._ts < @hi",
      parameters: [{ name: "@lo", value: chunk.lo }, { name: "@hi", value: chunk.hi }],
    }, { maxItemCount: 2000 });
    while (iter.hasMoreResults()) {
      const { resources } = await retry(() => iter.fetchNext());
      for (const row of resources || []) {
        scanned++;
        const c = S.classifyIdentity(row);
        if (!c.split) continue;
        splits++;
        bump(byClass, c.klass);
        if (c.klass !== S.HIQ_SPLIT) continue;
        if (!c.segments.includes("sport")) continue;
        sportSplits++;
        const pair = `${sportOf(c.cardId)} -> ${sportOf(c.hobbyiqCardId)}`;
        bump(bySportPair, pair);
        bump(bySource, String(row.source ?? "(none)"));
        if (row.identityUnverified === true) { parkedAlready++; }
        // `_ts` IS LAST-MODIFIED, NOT CREATED. A repair that PATCHES a stored
        // row bumps its `_ts` to the moment of the patch, so a naive
        // "written since the guard deployed" count reads every row an earlier
        // lane touched as a fresh emission. The 2026-09-07 park wrote 7,996
        // rows minutes after the #1929 deploy and every one of them landed in
        // this bucket on the first run. A row that is ALREADY PARKED cannot be
        // a new emission -- the guard's job is to stop unparked split rows
        // being written -- so parked rows are excluded and the residue is
        // attributed by id before any claim is made about the guard.
        if (GUARD_TS && Number(row._ts) >= GUARD_TS && row.identityUnverified !== true) newSinceGuard++;
        const back = write({
          id: row.id, cardId: c.cardId, hobbyiqCardId: c.hobbyiqCardId,
          source: row.source ?? null, title: row.title ?? null,
          price: row.price ?? null, soldAt: row.soldAt ?? null,
          identityUnverified: row.identityUnverified === true,
          flaggedWrong: row.flaggedWrong === true,
          segments: c.segments, ts: Number(row._ts) || 0,
        });
        if (back) await back;
      }
      if (scanned % 500000 < 2000) process.stderr.write(`\r  scanned=${f(scanned)} splits=${f(splits)} sport=${f(sportSplits)}   `);
    }
  }
  process.stderr.write("\n");

  await new Promise((r) => rowsOut.end(r));
  const summary = {
    at: new Date().toISOString(), readOnly: true, corpusRows: grand, scanned,
    flaggedSplits: splits, byClass: Object.fromEntries(byClass),
    sportSegmentSplits: sportSplits, alreadyParked: parkedAlready,
    remainingAfterParked: sportSplits - parkedAlready,
    guardTs: GUARD_TS, newSplitRowsSinceGuard: newSinceGuard,
    bySportPair: Object.fromEntries([...bySportPair].sort((a,b)=>b[1]-a[1])),
    bySource: Object.fromEntries([...bySource].sort((a,b)=>b[1]-a[1])),
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n" + "=".repeat(70));
  console.log(`SPORT-SEGMENT SPLIT RE-MEASUREMENT   scanned ${f(scanned)} of ${f(grand)}`);
  console.log("=".repeat(70));
  console.log(`  flagged splits (all)     ${f(splits)}`);
  for (const [k,v] of byClass) console.log(`    ${k.padEnd(16)} ${f(v)}`);
  console.log(`  SPORT-segment splits     ${f(sportSplits)}`);
  console.log(`  already parked           ${f(parkedAlready)}`);
  console.log(`  REMAINING                ${f(sportSplits - parkedAlready)}`);
  console.log(`  new since guard (_ts>=${GUARD_TS})  ${f(newSinceGuard)}`);
  console.log("\nBY SPORT PAIR (cardId -> hobbyiqCardId)");
  for (const [k,v] of [...bySportPair].sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(34)} ${f(v).padStart(9)}`);
  console.log("\nBY SOURCE");
  for (const [k,v] of [...bySource].sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(26)} ${f(v).padStart(9)}`);
  console.log(`\nwrote ${rowsPath} (${f(sportSplits)} rows) — READ ONLY, nothing written to Cosmos`);
}
main().then(()=>process.exit(0)).catch((e)=>{ console.error("FATAL:", e?.stack||e?.message); process.exit(3); });
