#!/usr/bin/env node
// CF-PURGE-CATALOG-JUNK-CS (Drew, 2026-08-01).
//
// The pre-existing persistVendorCatalog service writes CS API RESPONSE
// observations into card_catalog with sold_comps shape — most have
// null cardNumber, undefined playerName, and no imageUrl. These are
// not usable as catalog entries and pollute coverage math.
//
// This script deletes CS-source rows that lack a cardNumber AND lack
// the __expandedFromCardsight marker (proper enumeration entries).
// Idempotent: only touches rows matching the junk predicate.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   PURGE_APPLY                true|false  (default false = dry run)
//   PURGE_CONCURRENCY          default 8
//   PURGE_LIMIT                default 0 = unlimited

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.PURGE_APPLY === "true" || process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.PURGE_CONCURRENCY || 8));
const LIMIT = Math.max(0, Number(process.env.PURGE_LIMIT || 0));

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[purge-catalog-junk-cs]  apply=${APPLY}  concurrency=${CONCURRENCY}  limit=${LIMIT || "unlimited"}`);

  // Junk predicate: CS-source AND no cardNumber AND no `number` AND not from real enumeration
  const query = "SELECT c.id, c.cardId FROM c WHERE c.source = 'cardsight' " +
                "AND (NOT IS_DEFINED(c.__expandedFromCardsight)) " +
                "AND (NOT IS_DEFINED(c.cardNumber) OR c.cardNumber = null OR c.cardNumber = '') " +
                "AND (NOT IS_DEFINED(c.number) OR c.number = null OR c.number = '')";

  const iter = cc.items.query({ query }, { maxItemCount: 500 });

  let scanned = 0, deleted = 0, errors = 0;
  const inFlight = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      scanned++;
      if (LIMIT && scanned > LIMIT) break;
      if (!APPLY) continue;
      inFlight.push(
        withRetry(() => cc.item(row.id, row.cardId).delete())
          .then(() => { deleted++; })
          .catch(e => { errors++; if (errors < 5) console.error("  err:", e.message); })
      );
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
    }
    if (scanned % 50000 === 0) console.log(`  scanned=${scanned}  deleted=${deleted}  errors=${errors}`);
    if (LIMIT && scanned > LIMIT) break;
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:  ${scanned}`);
  console.log(`  deleted:  ${deleted}`);
  console.log(`  errors:   ${errors}`);
  if (!APPLY) console.log(`\n  (dry run — set PURGE_APPLY=true to delete)`);
}

main().catch(e => { console.error(e); process.exit(1); });
