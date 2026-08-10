#!/usr/bin/env node
/**
 * CF-PREFIX-MAPPER (Drew, 2026-08-10). Third-pass mapper. For still-
 * unmapped sold_comps, use the card-number PREFIX to identify the
 * correct product setKey.
 *
 * Example: sold_comp has setName="2025 Topps" cardNumber="US-42"
 *   → US prefix = Topps Update Series → correct setKey="topps-update"
 *   → look up catalog with derived setKey.
 *
 * Prefix table below encodes the well-known Topps/Bowman/Panini
 * card-number conventions.
 */

const { CosmosClient } = require("@azure/cosmos");

// Card-number-prefix → canonical setKey mapping.
// Keys should match card_number.split('-')[0] uppercased.
const PREFIX_TO_SETKEY = {
  // Bowman family
  "BCP":    "bowman-chrome",           // Chrome Prospects
  "BCPA":   "bowman-chrome",           // Chrome Prospect Autographs (older)
  "CPA":    "bowman-chrome",           // Chrome Prospect Autographs (current)
  "CPRA":   "bowman-chrome",           // Chrome Prospect Refractor Autos
  "BDC":    "bowman-draft",            // Bowman Draft Chrome
  "BDCP":   "bowman-draft",            // Bowman Draft Chrome Prospects
  "CDA":    "bowman-draft",            // Chrome Draft Autographs
  "BSPA":   "bowman-sterling",         // Bowman Sterling Prospect Autos
  "BPA":    "bowman",                  // Bowman Paper Autos
  "BPPR":   "bowman",                  // Bowman Prospect Paper Refractor
  "PA":     "bowman",                  // Prospect Auto (paper)
  "BSA":    "bowman-sterling",         // Sterling Auto
  "BSRA":   "bowman-sterling",         // Sterling Rookie Auto

  // Topps family
  "US":     "topps-update",            // Update Series
  "T":      "topps",                   // Sometimes "T-1" for Topps checklist
  "USR":    "topps-update",            // Update Rookie
  "TF":     "topps-finest",            // Finest
  "FR":     "topps-finest",            // Finest Refractor
  "CTC":    "topps-cosmic-chrome",     // Cosmic Chrome
  "TPU":    "topps-pristine",          // Pristine

  // Panini
  "PS":     "panini-prizm",            // Panini Prizm Rookie Signatures
  "PC":     "panini-prizm",            // Prizm Cracked Ice
  "NT":     "panini-national-treasures",
  "IC":     "panini-immaculate",
};

function derivePrefix(cardNumber) {
  const m = /^([A-Z]{1,6})-/.exec(String(cardNumber || "").toUpperCase().trim());
  return m ? m[1] : null;
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
  const sc = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  console.log(`[prefix-mapper] Loading catalog index by (year, setKey, cardNumber, playerName)...`);
  const catExactIndex = new Set();
  const catPlayerNumIndex = new Set();  // (year, setKey, cardNumberLower, playerNameLower) → true
  const catNumIndex = new Set();        // (year, setKey, cardNumberLower) → true
  const catSlugSet = new Set();
  const it = cat.items.query({
    query: "SELECT c.year, c.setKey, c.cardNumber, c.playerName, c.hobbyiqCardId FROM c WHERE c.catalogVersion = 2"
  }, { maxItemCount: 5000 }).getAsyncIterator();
  let loaded = 0;
  for await (const page of it) {
    for (const r of page.resources ?? []) {
      if (r.hobbyiqCardId) catSlugSet.add(r.hobbyiqCardId);
      if (r.year && r.setKey && r.cardNumber) {
        const cnLower = String(r.cardNumber).toLowerCase().trim();
        catNumIndex.add(`${r.year}::${r.setKey}::${cnLower}`);
        if (r.playerName) {
          catPlayerNumIndex.add(`${r.year}::${r.setKey}::${cnLower}::${String(r.playerName).toLowerCase().trim()}`);
        }
      }
    }
    loaded += page.resources?.length ?? 0;
    if (loaded % 500000 === 0) process.stdout.write(`\r  loaded ${loaded.toLocaleString()}`);
  }
  console.log(`\n[prefix-mapper] catalog indices built: ${catSlugSet.size.toLocaleString()} slugs, ${catNumIndex.size.toLocaleString()} num-index, ${catPlayerNumIndex.size.toLocaleString()} player-num-index`);

  console.log(`\n[prefix-mapper] Scanning sold_comps...`);
  let scanned = 0, exact = 0, prefixMatch = 0, unmapped = 0;
  const prefixHits = new Map();
  const trueGaps = new Map();
  const scIt = sc.items.query({
    query: "SELECT c.cardYear, c.setName, c.cardNumber, c.playerName, c.hobbyiqCardId FROM c WHERE c.price > 0"
  }, { maxItemCount: 5000 }).getAsyncIterator();
  for await (const page of scIt) {
    for (const r of page.resources ?? []) {
      scanned++;
      // Exact slug match first
      if (r.hobbyiqCardId && catSlugSet.has(r.hobbyiqCardId)) { exact++; continue; }
      // Prefix-based match
      const prefix = derivePrefix(r.cardNumber);
      const derivedSetKey = prefix ? PREFIX_TO_SETKEY[prefix] : null;
      if (derivedSetKey && r.cardYear && r.cardNumber) {
        const cnLower = String(r.cardNumber).toLowerCase().trim();
        const playerLower = r.playerName ? String(r.playerName).toLowerCase().trim() : null;
        // Try full identity first, then num-only
        const fullKey = playerLower ? `${r.cardYear}::${derivedSetKey}::${cnLower}::${playerLower}` : null;
        const numKey = `${r.cardYear}::${derivedSetKey}::${cnLower}`;
        if ((fullKey && catPlayerNumIndex.has(fullKey)) || catNumIndex.has(numKey)) {
          prefixMatch++;
          prefixHits.set(prefix, (prefixHits.get(prefix) ?? 0) + 1);
          continue;
        }
      }
      unmapped++;
      const gapKey = `${r.cardYear ?? "?"}::${String(r.setName ?? "?").toLowerCase().trim()}`;
      trueGaps.set(gapKey, (trueGaps.get(gapKey) ?? 0) + 1);
    }
    if (scanned % 200000 === 0) {
      process.stdout.write(`\r  scanned ${scanned.toLocaleString()} · exact ${exact.toLocaleString()} · prefix ${prefixMatch.toLocaleString()} · unmapped ${unmapped.toLocaleString()}`);
    }
  }
  console.log(`\n`);

  console.log(`╔═══ COVERAGE ═══`);
  console.log(`║ sold_comps scanned:  ${scanned.toLocaleString()}`);
  console.log(`║ EXACT slug match:    ${exact.toLocaleString()}  (${(exact*100/scanned).toFixed(1)}%)`);
  console.log(`║ PREFIX-derived setKey:${prefixMatch.toLocaleString()}  (${(prefixMatch*100/scanned).toFixed(1)}%)`);
  console.log(`║ TRULY UNMAPPED:      ${unmapped.toLocaleString()}  (${(unmapped*100/scanned).toFixed(1)}%)`);
  console.log(`║ Total coverage:      ${((exact+prefixMatch)*100/scanned).toFixed(1)}%`);
  console.log(`╚═══`);

  console.log(`\n═══ PREFIX MATCHES BY CODE ═══`);
  const prefixSorted = [...prefixHits.entries()].sort((a,b) => b[1] - a[1]);
  for (const [p, n] of prefixSorted.slice(0, 20)) {
    console.log(`  ${p.padEnd(8)} → ${PREFIX_TO_SETKEY[p].padEnd(30)} ${n.toLocaleString()}`);
  }

  console.log(`\n═══ TOP 25 TRUE GAPS ═══`);
  const gaps = [...trueGaps.entries()]
    .map(([k, n]) => ({ k, n }))
    .filter((g) => g.n > 200)
    .sort((a, b) => b.n - a.n)
    .slice(0, 25);
  for (const g of gaps) {
    const [yr, sn] = g.k.split("::");
    console.log(`  ${String(yr).padEnd(5)} ${sn.slice(0, 45).padEnd(45)} ${String(g.n).padStart(8)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
