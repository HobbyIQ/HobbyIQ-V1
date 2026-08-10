#!/usr/bin/env node
/**
 * CF-SOLD-COMPS-MAP (Drew, 2026-08-10). For every sold_comp, verify
 * it maps to a canonical catalog row (via hobbyiqCardId lookup). For
 * unmapped comps, aggregate by (year, setName) to build a gap list
 * of checklists we need to ingest.
 *
 * Doctrine: sold_comps carry (playerName, cardYear, setName,
 * cardNumber, parallel) — sometimes with hobbyiqCardId already
 * computed. Catalog holds the canonical rows. Their intersection is
 * "priced coverage." Gap = sold_comp with no catalog match.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING=... node backend/scripts/mapSoldCompsToCatalog.cjs \
 *     [--report-only]
 *
 * --report-only: don't write any tags to sold_comps, just print the gap analysis.
 */

const { CosmosClient } = require("@azure/cosmos");

const REPORT_ONLY = process.argv.includes("--report-only") || !process.argv.includes("--apply");

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  const sc = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  console.log(`[mapper] MODE=${REPORT_ONLY ? "REPORT-ONLY" : "APPLY"}`);
  console.log(`[mapper] Loading catalog v2 slug set...`);
  // Load all canonical hobbyiqCardId values into memory
  const catalogSlugs = new Set();
  const it = cat.items.query({ query: "SELECT c.hobbyiqCardId FROM c WHERE c.catalogVersion = 2 AND IS_DEFINED(c.hobbyiqCardId)" }, { maxItemCount: 5000 }).getAsyncIterator();
  let loaded = 0;
  for await (const page of it) {
    for (const r of page.resources ?? []) {
      if (r.hobbyiqCardId) catalogSlugs.add(r.hobbyiqCardId);
    }
    loaded += page.resources?.length ?? 0;
    if (loaded % 100000 === 0) process.stdout.write(`\r  loaded ${loaded.toLocaleString()} catalog slugs`);
  }
  console.log(`\n[mapper] Catalog slugs loaded: ${catalogSlugs.size.toLocaleString()}`);

  console.log(`\n[mapper] Scanning sold_comps + checking coverage...`);
  const totalByYearSet = new Map();
  const unmappedByYearSet = new Map();
  let scanned = 0, mapped = 0, unmapped = 0, unmappedNoSlug = 0;
  const scIt = sc.items.query({ query: "SELECT c.cardYear, c.setName, c.hobbyiqCardId FROM c WHERE c.price > 0" }, { maxItemCount: 5000 }).getAsyncIterator();
  for await (const page of scIt) {
    for (const r of page.resources ?? []) {
      scanned++;
      const key = `${r.cardYear ?? "?"}::${String(r.setName ?? "?").toLowerCase().trim()}`;
      totalByYearSet.set(key, (totalByYearSet.get(key) ?? 0) + 1);
      if (r.hobbyiqCardId && catalogSlugs.has(r.hobbyiqCardId)) {
        mapped++;
      } else {
        unmapped++;
        if (!r.hobbyiqCardId) unmappedNoSlug++;
        unmappedByYearSet.set(key, (unmappedByYearSet.get(key) ?? 0) + 1);
      }
    }
    if (scanned % 100000 === 0) {
      process.stdout.write(`\r  scanned ${scanned.toLocaleString()} · mapped ${mapped.toLocaleString()} (${(mapped*100/scanned).toFixed(1)}%)`);
    }
  }
  console.log(`\n`);

  console.log(`╔═══ MAPPING RESULT ═══`);
  console.log(`║ sold_comps scanned:      ${scanned.toLocaleString()}`);
  console.log(`║ mapped to catalog v2:    ${mapped.toLocaleString()}  (${(mapped*100/scanned).toFixed(1)}%)`);
  console.log(`║ UNMAPPED:                ${unmapped.toLocaleString()}  (${(unmapped*100/scanned).toFixed(1)}%)`);
  console.log(`║   of which no slug:      ${unmappedNoSlug.toLocaleString()}  (missing hobbyiqCardId)`);
  console.log(`╚═══`);

  // Top gaps by unmapped-sale count
  console.log(`\n═══ TOP 40 UNMAPPED (year, setName) COMBOS BY VOLUME ═══`);
  console.log(`  These are the checklists to find next.`);
  console.log(`  YEAR SETNAME                              UNMAPPED  TOTAL   GAP%`);
  const gaps = [...unmappedByYearSet.entries()]
    .map(([key, unm]) => ({ key, unm, total: totalByYearSet.get(key) || unm }))
    .filter((g) => g.unm > 100)
    .sort((a, b) => b.unm - a.unm)
    .slice(0, 40);
  for (const g of gaps) {
    const [yr, sn] = g.key.split("::");
    const pct = (g.unm * 100 / g.total).toFixed(0);
    console.log(`  ${String(yr).padEnd(5)} ${sn.slice(0, 42).padEnd(42)} ${String(g.unm).padStart(8)} ${String(g.total).padStart(8)}  ${pct}%`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
