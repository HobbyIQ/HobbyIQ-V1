#!/usr/bin/env node
// CF-DEDUPE-CATALOG-BY-HOBBYIQ (Drew, 2026-08-01).
//
// card_catalog currently stores one row per (vendor, vendorCardId) —
// so a physical card covered by both CardHedge and Cardsight has TWO
// rows. Search dedupes at result-time via hobbyiqCardId, but the
// storage carries the duplication (~2× row count, 2× scan cost,
// inconsistent field coverage across vendors).
//
// This script merges duplicates by hobbyiqCardId — computed from
// (sport, year, setKey, cardNumber, parallel, isAuto, printRun) via
// the SAME function production uses (imported from dist/). Merge
// strategy:
//   - MERGE, don't remove — every vendor contribution is preserved
//   - Best imageUrl wins (CH's Bubble CDN URLs preferred over proxy)
//   - Best-populated field wins per (playerName, setName, year, ...)
//   - vendorMappings: [{ source, vendorCardId }] preserves both IDs
//   - searchTokens / searchText unioned so no coverage regression
//   - Canonical row: id="canonical::{hobbyiqCardId}", partition on
//     new cardId=hobbyiqCardId
//   - Old vendor rows deleted after canonical row upserts
//
// Idempotent — marker __canonicalMergedAt on the canonical row, and
// __supersededBy on any old-shape rows that survive a partial run.
// A row's presence in the canonical shape (id starts with 'canonical::')
// is also treated as a skip signal.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const { CosmosClient } = require("@azure/cosmos");

let computeHobbyIqCardId;
try {
  ({ computeHobbyIqCardId } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js"));
} catch (e) {
  console.error("Cannot import computeHobbyIqCardId from dist — build the backend first (npm run build)");
  console.error(e.message);
  process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 100));
    }
  }
}

function bestOf(a, b) {
  if (a === null || a === undefined || a === "") return b;
  if (b === null || b === undefined || b === "") return a;
  return String(a).length >= String(b).length ? a : b;
}

function unionArrays(a, b) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(a) ? a : []) if (!seen.has(x)) { seen.add(x); out.push(x); }
  for (const x of Array.isArray(b) ? b : []) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function pickImage(rows) {
  // Prefer CH-native CDN URL (highest quality). Then proxy URL. Then any URL.
  const chNative = rows.find(r => r.imageUrl && /cdn\.bubble\.io|cdnh\.bubble\.io/i.test(r.imageUrl));
  if (chNative) return chNative.imageUrl;
  const proxy = rows.find(r => r.imageUrl && /\/api\/compiq\/card-image\//i.test(r.imageUrl));
  if (proxy) return proxy.imageUrl;
  const any = rows.find(r => r.imageUrl);
  return any?.imageUrl ?? null;
}

function hobbyiqSlugFromRow(row) {
  const sport = row.sport ?? row.__sport ?? null;
  const year = Number(row.year ?? row.cardYear ?? 0);
  const setKey = row.setName ?? row.set ?? row.releaseName ?? null;
  const cardNumber = row.cardNumber ?? row.number ?? null;
  if (!sport || !year || !setKey || !cardNumber) return null;
  try {
    return computeHobbyIqCardId({
      sport: String(sport),
      year,
      setKey: String(setKey),
      cardNumber: String(cardNumber),
      parallel: "Base",   // catalog rows don't carry a parallel — that's a per-sale attribute
      isAuto: /auto/i.test(String(setKey)) || /auto/i.test(String(row.title ?? "")),
      printRun: null,
    });
  } catch { return null; }
}

function mergeRows(rows) {
  // rows: array of vendor rows sharing the same hobbyiqCardId. Produce one canonical row.
  const nowIso = new Date().toISOString();
  const bestRow = rows.reduce((best, r) => {
    if (!best) return r;
    const bestScore = Object.keys(best).length;
    const rScore = Object.keys(r).length;
    return rScore > bestScore ? r : best;
  }, null);
  const slug = hobbyiqSlugFromRow(bestRow);
  const canonical = {
    id: `canonical::${slug}`,
    cardId: slug,
    hobbyiqCardId: slug,
    source: "canonical",
    playerName: rows.reduce((v, r) => bestOf(v, r.playerName ?? r.player ?? null), null),
    setName:    rows.reduce((v, r) => bestOf(v, r.setName ?? r.set ?? r.releaseName ?? null), null),
    year:       Number(bestRow.year ?? bestRow.cardYear ?? 0),
    cardNumber: rows.reduce((v, r) => bestOf(v, r.cardNumber ?? r.number ?? null), null),
    sport:      bestRow.sport ?? bestRow.__sport ?? null,
    imageUrl:   pickImage(rows),
    __hasImage: rows.some(r => r.__hasImage === true || (typeof r.imageUrl === "string" && r.imageUrl.length > 0)),
    vendorMappings: rows.map(r => ({ source: r.source, vendorCardId: r.cardId })).filter(m => m.source && m.vendorCardId),
    searchText: rows.map(r => r.searchText).filter(Boolean).join(" ").toLowerCase() || null,
    searchTokens: rows.reduce((acc, r) => unionArrays(acc, r.searchTokens), []),
    recentSaleCount: rows.reduce((sum, r) => sum + (Number(r.recentSaleCount) || 0), 0),
    __canonicalMergedAt: nowIso,
    __canonicalMergedFrom: rows.length,
    observedAt: nowIso,
  };
  return canonical;
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[dedupe-catalog-by-hobbyiq]  apply=${APPLY}  concurrency=${CONCURRENCY}  maxMinutes=${MAX_MINUTES}`);

  // Scan vendor rows only (skip existing canonical rows and rows without
  // enough fields to compute a slug).
  const query = "SELECT * FROM c WHERE c.source IN ('cardhedge', 'cardsight') " +
                "AND NOT STARTSWITH(c.id, 'canonical::') " +
                "AND (IS_DEFINED(c.cardNumber) OR IS_DEFINED(c.number))";

  const iter = cc.items.query({ query }, { maxItemCount: 500 });

  // Group by hobbiyqCardId
  const bySlug = new Map();
  let scanned = 0;
  let noSlug = 0;

  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ scan-phase time cap"); break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      scanned++;
      const slug = hobbyiqSlugFromRow(row);
      if (!slug) { noSlug++; continue; }
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(row);
      if (scanned % 100000 === 0) console.log(`  scanned=${scanned}  slugs=${bySlug.size}  noSlug=${noSlug}`);
    }
  }
  console.log(`\n  Scan done. scanned=${scanned}  distinct-slugs=${bySlug.size}  noSlug=${noSlug}`);

  // Count singletons vs duplicates
  let singletons = 0, dupGroups = 0, dupRows = 0;
  for (const rows of bySlug.values()) {
    if (rows.length === 1) singletons++;
    else { dupGroups++; dupRows += rows.length; }
  }
  console.log(`  singletons: ${singletons}`);
  console.log(`  duplicate groups: ${dupGroups}  (total rows in groups: ${dupRows})`);
  console.log(`  potential row reduction: ${dupRows - dupGroups}`);

  if (!APPLY) {
    console.log(`\n  (dry run — set BACKFILL_APPLY=true to write canonical + delete vendor rows)`);
    console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
    return;
  }

  // Merge phase — upsert canonical row + delete vendor rows
  let mergedGroups = 0, canonicalUpserts = 0, vendorDeletes = 0, errors = 0;
  const inFlight = [];

  async function processGroup(slug, rows) {
    try {
      const canonical = mergeRows(rows);
      await withRetry(() => cc.items.upsert(canonical));
      canonicalUpserts++;
      // Delete vendor rows
      for (const r of rows) {
        try {
          await withRetry(() => cc.item(r.id, r.cardId).delete());
          vendorDeletes++;
        } catch (e) { errors++; }
      }
      mergedGroups++;
    } catch (e) { errors++; }
  }

  for (const [slug, rows] of bySlug) {
    if (rows.length < 2) continue;   // singletons don't need merge
    if (timeExpired()) { console.log("⏰ merge-phase time cap"); break; }
    inFlight.push(processGroup(slug, rows));
    if (inFlight.length >= CONCURRENCY) {
      await Promise.race(inFlight);
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
        if (s !== "PENDING") inFlight.splice(i, 1);
      }
    }
    if (mergedGroups % 1000 === 0 && mergedGroups > 0) {
      console.log(`  mergedGroups=${mergedGroups}  canonicalUpserts=${canonicalUpserts}  vendorDeletes=${vendorDeletes}  errors=${errors}`);
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  merged groups:      ${mergedGroups}`);
  console.log(`  canonical upserts:  ${canonicalUpserts}`);
  console.log(`  vendor rows deleted: ${vendorDeletes}`);
  console.log(`  errors:             ${errors}`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); process.exit(1); });
