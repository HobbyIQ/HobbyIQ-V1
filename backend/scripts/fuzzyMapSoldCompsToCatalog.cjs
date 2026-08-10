#!/usr/bin/env node
/**
 * CF-FUZZY-MAPPER (Drew, 2026-08-10). Second-pass mapper for
 * sold_comps that don't have an exact hobbyiqCardId match in catalog.
 * Tries fuzzy identity match on (cardYear, cardNumber, playerName).
 *
 * A sold_comp with year=2026 setName="2026 Topps Baseball" playerName=
 * "Shohei Ohtani" cardNumber="1" should map to catalog row
 * hiq:baseball:2026:topps:1:base:no-auto EVEN IF the sold_comp's own
 * hobbyiqCardId is missing or differently normalized.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/fuzzyMapSoldCompsToCatalog.cjs
 */

const { CosmosClient } = require("@azure/cosmos");

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  const sc = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  console.log(`[fuzzy] Loading catalog identity index (year::cardNumber::playerName → count)...`);
  // Build a lookup: for each (year, cardNumberLower, playerNameLower), does any catalog row exist?
  const catIndex = new Set();
  const catSlugSet = new Set();
  const it = cat.items.query({
    query: "SELECT c.year, c.cardNumber, c.playerName, c.hobbyiqCardId FROM c WHERE c.catalogVersion = 2 AND IS_DEFINED(c.year) AND IS_DEFINED(c.cardNumber) AND IS_DEFINED(c.playerName)"
  }, { maxItemCount: 5000 }).getAsyncIterator();
  let loaded = 0;
  for await (const page of it) {
    for (const r of page.resources ?? []) {
      if (r.hobbyiqCardId) catSlugSet.add(r.hobbyiqCardId);
      if (r.year && r.cardNumber && r.playerName) {
        const key = `${r.year}::${String(r.cardNumber).toLowerCase().trim()}::${String(r.playerName).toLowerCase().trim()}`;
        catIndex.add(key);
      }
    }
    loaded += page.resources?.length ?? 0;
    if (loaded % 200000 === 0) process.stdout.write(`\r  loaded ${loaded.toLocaleString()}`);
  }
  console.log(`\n[fuzzy] Catalog index size: ${catIndex.size.toLocaleString()} identity tuples, ${catSlugSet.size.toLocaleString()} slugs`);

  console.log(`\n[fuzzy] Scanning sold_comps for coverage...`);
  let scanned = 0, exact = 0, fuzzy = 0, unmapped = 0;
  const trueGaps = new Map();  // (year, setName) with 0 catalog coverage even fuzzy
  const scIt = sc.items.query({
    query: "SELECT c.cardYear, c.setName, c.cardNumber, c.playerName, c.hobbyiqCardId FROM c WHERE c.price > 0"
  }, { maxItemCount: 5000 }).getAsyncIterator();
  for await (const page of scIt) {
    for (const r of page.resources ?? []) {
      scanned++;
      // Exact match first
      if (r.hobbyiqCardId && catSlugSet.has(r.hobbyiqCardId)) { exact++; continue; }
      // Fuzzy match: (year, cardNumber, playerName)
      if (r.cardYear && r.cardNumber && r.playerName) {
        const key = `${r.cardYear}::${String(r.cardNumber).toLowerCase().trim()}::${String(r.playerName).toLowerCase().trim()}`;
        if (catIndex.has(key)) { fuzzy++; continue; }
      }
      unmapped++;
      const gapKey = `${r.cardYear ?? "?"}::${String(r.setName ?? "?").toLowerCase().trim()}`;
      trueGaps.set(gapKey, (trueGaps.get(gapKey) ?? 0) + 1);
    }
    if (scanned % 200000 === 0) {
      process.stdout.write(`\r  scanned ${scanned.toLocaleString()} · exact ${exact.toLocaleString()} · fuzzy ${fuzzy.toLocaleString()} · unmapped ${unmapped.toLocaleString()}`);
    }
  }
  console.log(`\n`);

  console.log(`╔═══ COVERAGE ═══`);
  console.log(`║ sold_comps scanned:  ${scanned.toLocaleString()}`);
  console.log(`║ EXACT slug match:    ${exact.toLocaleString()}  (${(exact*100/scanned).toFixed(1)}%)`);
  console.log(`║ FUZZY id-tuple match:${fuzzy.toLocaleString()}  (${(fuzzy*100/scanned).toFixed(1)}%)`);
  console.log(`║ TRULY UNMAPPED:      ${unmapped.toLocaleString()}  (${(unmapped*100/scanned).toFixed(1)}%)`);
  console.log(`║ Total coverage:      ${((exact+fuzzy)*100/scanned).toFixed(1)}%`);
  console.log(`╚═══`);

  console.log(`\n═══ TOP 30 TRUE GAPS (year, setName) ═══`);
  console.log(`  Checklists to find and ingest.`);
  console.log(`  YEAR SETNAME                              UNMAPPED`);
  const gaps = [...trueGaps.entries()]
    .map(([k, n]) => ({ k, n }))
    .filter((g) => g.n > 200)
    .sort((a, b) => b.n - a.n)
    .slice(0, 30);
  for (const g of gaps) {
    const [yr, sn] = g.k.split("::");
    console.log(`  ${String(yr).padEnd(5)} ${sn.slice(0, 42).padEnd(42)} ${String(g.n).padStart(8)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
