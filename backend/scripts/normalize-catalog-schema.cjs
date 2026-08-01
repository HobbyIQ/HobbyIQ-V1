#!/usr/bin/env node
// CF-NORMALIZE-CATALOG-SCHEMA (Drew, 2026-08-01).
//
// card_catalog rows arrived from two vendor pipelines with divergent
// field names:
//   - CH-source rows: cardNumber, playerName, setName
//   - CS-source rows: number,     player,     set / setName
//
// Downstream consumers had to defensively check both shapes. This
// backfill unifies every row to carry BOTH variants — a cheap denorm
// that means every reader can use whichever name it prefers without
// null-coalescing across shapes.
//
// Idempotent — marker __schemaNormalizedAt prevents re-touching. If
// both shape variants already agree, no write happens.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[normalize-catalog-schema]  apply=${APPLY}  concurrency=${CONCURRENCY}  maxMinutes=${MAX_MINUTES}`);

  const query = "SELECT * FROM c WHERE NOT IS_DEFINED(c.__schemaNormalizedAt) " +
                "AND (IS_DEFINED(c.number) OR IS_DEFINED(c.cardNumber) OR IS_DEFINED(c.player) OR IS_DEFINED(c.playerName))";
  const iter = cc.items.query({ query }, { maxItemCount: 500 });

  const stats = { scanned: 0, updated: 0, unchanged: 0, errors: 0 };
  const inFlight = [];

  async function processRow(row) {
    const nowIso = new Date().toISOString();
    const before = {
      cardNumber: row.cardNumber, number: row.number,
      playerName: row.playerName, player: row.player,
      setName: row.setName, set: row.set,
    };
    // Unify: whichever variant has a value wins; write both.
    const num = row.cardNumber ?? row.number ?? null;
    const player = row.playerName ?? row.player ?? null;
    const setStr = row.setName ?? row.set ?? null;

    const needsUpdate =
      before.cardNumber !== num || before.number !== num ||
      before.playerName !== player || before.player !== player ||
      before.setName !== setStr || before.set !== setStr;

    if (!needsUpdate && APPLY) {
      // Still stamp the marker so we don't re-scan next run
      row.__schemaNormalizedAt = nowIso;
      try { await withRetry(() => cc.items.upsert(row)); stats.unchanged++; } catch { stats.errors++; }
      return;
    }
    if (!needsUpdate) { stats.unchanged++; return; }

    if (!APPLY) { stats.updated++; return; }
    row.cardNumber = num;
    row.number = num;
    row.playerName = player;
    row.player = player;
    row.setName = setStr;
    row.set = setStr;
    row.__schemaNormalizedAt = nowIso;
    try { await withRetry(() => cc.items.upsert(row)); stats.updated++; } catch { stats.errors++; }
  }

  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ time cap reached"); break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      stats.scanned++;
      inFlight.push(processRow(row).catch(() => { stats.errors++; }));
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
      if (stats.scanned % 5000 === 0) {
        console.log(`  scanned=${stats.scanned}  updated=${stats.updated}  unchanged=${stats.unchanged}  errors=${stats.errors}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:    ${stats.scanned}`);
  console.log(`  updated:    ${stats.updated}  (schema unified)`);
  console.log(`  unchanged:  ${stats.unchanged}  (already consistent)`);
  console.log(`  errors:     ${stats.errors}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  if (timeExpired()) console.log(`RELAUNCH_NEEDED=true`);
  else console.log(`RELAUNCH_NEEDED=false`);
}

main().catch(e => { console.error(e); process.exit(1); });
