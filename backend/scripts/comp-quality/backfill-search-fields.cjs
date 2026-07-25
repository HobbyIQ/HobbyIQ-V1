#!/usr/bin/env node
// CF-SEARCH-ENRICH (Drew, 2026-07-24; searchTokens 2026-07-25).
// Backfills three fields on card_catalog to make search fast + smart:
//
//   1. searchText: lowercase concat of (player, releaseName, cardNumber,
//      parallels[].name). Kept for the fuzzy fallback path.
//   2. searchTokens: string[] of unique alpha-num tokens from searchText.
//      canonicalCardSearch uses ARRAY_CONTAINS(c.searchTokens, @t) which
//      IS index-accelerated — drops cold cross-partition scan from
//      3-10s (post-autoscale) to <1s. CONTAINS on a scalar string is not
//      index-accelerated for substring; ARRAY_CONTAINS on an indexed
//      string array IS. This is the "do it right" fix (Drew 2026-07-25).
//   3. recentSaleCount: number of sold_comps rows in the last 90 days
//      whose (cardYear, UPPER(cardNumber)) match this catalog card.
//      Used as a popularity boost in search ranking.
//
// All three computed in ONE pass. searchText/searchTokens are per-row
// (cheap). recentSaleCount requires a pre-aggregated (year|number) map
// built from a single sold_comps scan up front.
//
// Env:
//   SEARCH_ENRICH_APPLY=true — persist. Default: dry-run.
//   SEARCH_ENRICH_CONCURRENCY=12
//
// Usage:
//   node backend/scripts/comp-quality/backfill-search-fields.cjs --sport baseball

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const APPLY = process.env.SEARCH_ENRICH_APPLY === "true";
const CONCURRENCY = Number(process.env.SEARCH_ENRICH_CONCURRENCY || "12");

function buildSearchText(row) {
  const parts = [];
  if (row.player) parts.push(String(row.player));
  if (row.releaseName) parts.push(String(row.releaseName));
  if (row.setName && row.setName !== row.releaseName) parts.push(String(row.setName));
  if (row.number) parts.push(String(row.number));
  if (row.year) parts.push(String(row.year));
  if (Array.isArray(row.parallels)) {
    for (const p of row.parallels) if (p?.name) parts.push(String(p.name));
  }
  if (Array.isArray(row.attributes)) {
    for (const a of row.attributes) if (a) parts.push(String(a));
  }
  return parts.join(" ").toLowerCase();
}

// Tokenize searchText into unique alphanumeric tokens for ARRAY_CONTAINS
// lookups. Mirrors canonicalCardSearch's tokenize() (kept simple + sync).
// Also includes card-number fragments (e.g. "cpa-eha" → also "cpa" + "eha")
// so users typing either half of a hyphenated card number hit the row.
function buildSearchTokens(searchText) {
  if (!searchText) return [];
  const seen = new Set();
  const out = [];
  // Split on whitespace + non-alphanum, keeping hyphenated tokens whole
  // AND their halves so both "cpa-eha" and "cpa" match.
  const rawTokens = String(searchText).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const raw of rawTokens) {
    // Emit the full token (may contain hyphen, e.g. "cpa-eha", "o-pee-chee")
    if (raw.length >= 2 && !seen.has(raw)) { seen.add(raw); out.push(raw); }
    // Also emit hyphen-split fragments so partial-cardNumber queries hit
    if (raw.includes("-")) {
      for (const frag of raw.split("-")) {
        if (frag.length >= 2 && !seen.has(frag)) { seen.add(frag); out.push(frag); }
      }
    }
  }
  return out;
}

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0;
  let ok = 0, err = 0;
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
  const sport = arg("sport", "baseball");
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = client.database("hobbyiq").container("card_catalog");
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[search-enrich] scope: sport=${sport}  apply=${APPLY}`);

  // Pass 1: build recent-sale-count map from sold_comps (last 90 days)
  const cutoffIso = new Date(Date.now() - 90 * 86_400_000).toISOString();
  console.log(`  building recent-sale-count map (>= ${cutoffIso})...`);
  const rscQuery = `SELECT c.cardYear, c.cardNumber FROM c WHERE c.sport = @sp AND c.soldAt >= @from AND IS_DEFINED(c.cardNumber) AND c.cardNumber != null AND c.cardNumber != ''`;
  const rscIt = sc.items.query({ query: rscQuery, parameters: [{ name: "@sp", value: sport }, { name: "@from", value: cutoffIso }] }, { maxItemCount: 5000 });
  const recentCountByYearNumber = new Map();
  let scannedSales = 0;
  while (rscIt.hasMoreResults()) {
    const { resources } = await rscIt.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      if (!r.cardYear || !r.cardNumber) continue;
      const key = `${r.cardYear}|${String(r.cardNumber).toUpperCase()}`;
      recentCountByYearNumber.set(key, (recentCountByYearNumber.get(key) || 0) + 1);
    }
    scannedSales += (resources || []).length;
    process.stdout.write(`\r  sales scanned=${scannedSales} distinct=${recentCountByYearNumber.size}`);
  }
  console.log(`\n  ${recentCountByYearNumber.size} distinct (year|number) keys with recent sales`);

  // Pass 2: scan card_catalog, compute searchText + searchTokens + lookup recentSaleCount
  console.log(`  scanning card_catalog...`);
  const ccQuery = `SELECT c.id, c.cardId, c.player, c.releaseName, c.setName, c.number, c.year, c.parallels, c.attributes, c.searchText, c.searchTokens, c.recentSaleCount FROM c WHERE c.source = 'cardsight' AND c.sport = @sp`;
  const ccIt = cc.items.query({ query: ccQuery, parameters: [{ name: "@sp", value: sport }] }, { maxItemCount: 5000 });
  const patches = [];
  let scanned = 0, unchanged = 0;
  while (ccIt.hasMoreResults()) {
    const { resources } = await ccIt.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      scanned++;
      const searchText = buildSearchText(r);
      const searchTokens = buildSearchTokens(searchText);
      const key = `${r.year}|${String(r.number || "").toUpperCase()}`;
      const recentSaleCount = recentCountByYearNumber.get(key) || 0;
      // Skip only when all three match — searchTokens compared by
      // stringified sort so array-order differences don't force rewrites.
      const existingTokensKey = Array.isArray(r.searchTokens) ? [...r.searchTokens].sort().join("|") : "";
      const newTokensKey = [...searchTokens].sort().join("|");
      if (r.searchText === searchText && existingTokensKey === newTokensKey && (r.recentSaleCount ?? 0) === recentSaleCount) {
        unchanged++;
        continue;
      }
      patches.push({
        id: r.id,
        partitionKey: r.cardId,
        searchText,
        searchTokens,
        recentSaleCount,
      });
    }
    process.stdout.write(`\r  catalog scanned=${scanned} unchanged=${unchanged} patches=${patches.length}`);
  }
  console.log(`\nSummary:`);
  console.log(`  scanned:      ${scanned}`);
  console.log(`  unchanged:    ${unchanged}`);
  console.log(`  to patch:     ${patches.length}`);

  if (!APPLY || patches.length === 0) {
    if (!APPLY && patches.length > 0) console.log(`\n*** DRY-RUN. Set SEARCH_ENRICH_APPLY=true to persist. ***`);
    return;
  }

  console.log(`\nPatching ${patches.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await cc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/searchText", value: p.searchText },
      { op: "set", path: "/searchTokens", value: p.searchTokens },
      { op: "set", path: "/recentSaleCount", value: p.recentSaleCount },
    ]);
    done++;
    if (done % 500 === 0) process.stdout.write(`\r  patched ${done}/${patches.length}`);
  });
  console.log(`\n  patched ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
