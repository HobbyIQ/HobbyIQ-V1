#!/usr/bin/env node
// CF-BACKFILL-SEARCHTOKENS-ALL-SPORTS (Drew, 2026-08-02).
//
// The existing backfill-search-fields.cjs only touches c.source='cardsight'
// AND defaults to baseball. Result: basketball/football/hockey/soccer
// have ZERO searchTokens indexed, so canonicalCardSearch returns 0 hits
// for those sports even for common names (Luka, Herbert), causing web
// search to fall through to CardHedge's /card-search endpoint = 30s+
// hang.
//
// This script rebuilds searchTokens for EVERY row lacking them,
// regardless of source or sport. Pure Cosmos read/write, no vendor
// API calls.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 10)
//   SPORT_FILTER               optional single sport (basketball, football, etc.)

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 10));
const SPORT_FILTER = process.env.SPORT_FILTER || null;

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

// Mirror of buildSearchIndex from backend/src/services/portfolioiq/searchIndexing.service.ts
function buildSearchText(row) {
  const parts = [];
  const player = row.playerName ?? row.player;
  const releaseName = row.releaseName;
  const setName = row.setName ?? row.set;
  const number = row.cardNumber ?? row.number;
  const title = row.title;
  const variant = row.variant;
  if (player) parts.push(String(player));
  if (releaseName) parts.push(String(releaseName));
  if (setName && setName !== releaseName) parts.push(String(setName));
  if (title && title !== releaseName && title !== setName) parts.push(String(title));
  if (number) parts.push(String(number));
  if (row.year !== undefined && row.year !== null && row.year !== "") parts.push(String(row.year));
  if (variant) parts.push(String(variant));
  if (Array.isArray(row.parallels)) {
    for (const p of row.parallels) if (p && p.name) parts.push(String(p.name));
  }
  if (Array.isArray(row.attributes)) {
    for (const a of row.attributes) if (a) parts.push(String(a));
  }
  return parts.join(" ").toLowerCase();
}

function buildSearchTokens(searchText) {
  if (!searchText) return [];
  const seen = new Set();
  const out = [];
  const raw = String(searchText).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const r of raw) {
    if (r.length >= 2 && !seen.has(r)) { seen.add(r); out.push(r); }
    if (r.includes("-")) {
      for (const f of r.split("-")) {
        if (f.length >= 2 && !seen.has(f)) { seen.add(f); out.push(f); }
      }
    }
  }
  return out;
}

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[backfill-searchtokens-all-sports] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES} sport=${SPORT_FILTER ?? "all"}`);

  const sportClause = SPORT_FILTER ? " AND c.sport = @sport" : "";
  const params = SPORT_FILTER ? [{ name: "@sport", value: SPORT_FILTER }] : [];
  const query = "SELECT * FROM c WHERE (NOT IS_DEFINED(c.searchTokens) OR ARRAY_LENGTH(c.searchTokens) = 0)" +
                sportClause;

  const iter = cc.items.query({ query, parameters: params }, { maxItemCount: 200 });
  const stats = { scanned: 0, indexed: 0, empty: 0, errors: 0, bySport: {} };
  const inFlight = [];

  async function processRow(row) {
    try {
      const searchText = buildSearchText(row);
      const searchTokens = buildSearchTokens(searchText);
      if (!searchTokens.length) { stats.empty++; return; }
      const sport = row.sport || "unknown";
      stats.bySport[sport] = (stats.bySport[sport] || 0) + 1;
      stats.indexed++;
      if (APPLY) {
        row.searchText = searchText;
        row.searchTokens = searchTokens;
        row.__searchIndexedAt = new Date().toISOString();
        await withRetry(() => cc.items.upsert(row));
      }
    } catch { stats.errors++; }
  }

  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ time cap"); break; }
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
      if (stats.scanned % 2000 === 0) {
        console.log(`  scanned=${stats.scanned} indexed=${stats.indexed} empty=${stats.empty} err=${stats.errors}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:  ${stats.scanned}`);
  console.log(`  indexed:  ${stats.indexed}`);
  console.log(`  empty:    ${stats.empty}  (no text to tokenize)`);
  console.log(`  errors:   ${stats.errors}`);
  console.log(`  by sport:`);
  for (const [s, n] of Object.entries(stats.bySport).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(15)}${String(n).padStart(10)}`);
  }
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); });
