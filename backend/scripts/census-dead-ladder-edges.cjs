#!/usr/bin/env node
/**
 * CENSUS: THE 13 DEAD LADDER EDGES, READ ONLY. (#1918 debt register)
 *
 * #1918's mirror pin found 13 keys that sit in the ladder (productSetKeys +
 * SPECIALIZATION_PARENTS) but that `inferSetKeyFromTitle` can never mint, so
 * SPECIALIZATION-STATED can never promote a sale onto them. This measures the
 * evidence each one would need before a parser rule may be written:
 *
 *   1. catalog rows AT the key, BY SOURCE -- checklist-backed vs vendor vs
 *      sales-derived. A key with no checklist-backed rows has no authority to
 *      mint against (the checklist is the authority), so a parser rule would
 *      file sales onto an address that does not exist.
 *   2. sold_comps rows already ON the key (hobbyiqCardId prefix) -- what
 *      ingest-time keys have already landed there.
 *   3. sold_comps titles on the FAMILY key that STATE the specialization word
 *      -- the population a rule would move, and the number that decides
 *      whether the edge is worth a rule at all.
 *
 * WHAT IT WRITES: nothing. No --apply exists.
 *
 * Usage (read-only; connection string piped in, never written to disk):
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 \
 *     --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *   node backend/scripts/census-dead-ladder-edges.cjs [--cap=3000] [--json=path]
 */
const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith("--" + n + "=")); return h ? h.slice(n.length + 3) : d; };
const CAP = Number(arg("cap", "3000")) || 3000;
const JSON_OUT = arg("json", "");
const f = (n) => Number(n).toLocaleString("en-US");

/**
 * The register, each with the FAMILY its titles land on today and the word a
 * rule would have to read. `word` is the census probe only -- whether it is
 * SAFE to read is what this census decides.
 */
const EDGES = [
  { key: "fleer-tiffany",               family: "fleer",        word: /\btiffany\b/i },
  { key: "fleer-glossy",                family: "fleer",        word: /\bglossy\b/i },
  { key: "fleer-update-tiffany",        family: "fleer-update", word: /\btiffany\b/i },
  { key: "fleer-update-glossy",         family: "fleer-update", word: /\bglossy\b/i },
  { key: "fleer-tradition-tiffany",     family: "fleer",        word: /\btradition\b[\s\S]*\btiffany\b|\btiffany\b[\s\S]*\btradition\b/i },
  { key: "sp",                          family: "unknown",      word: /\bsp\b/i },
  { key: "sp-championship",             family: "unknown",      word: /\bsp\s+championship\b/i },
  { key: "upper-deck-minors",           family: "upper-deck",   word: /\bminors?\b|\bminor\s+league\b/i },
  { key: "upper-deck-black-diamond",    family: "upper-deck",   word: /\bblack\s+diamond\b/i },
  { key: "score-rookie-and-traded",     family: "score",        word: /\brookie\s*(?:&|and|\/)\s*traded\b/i },
  { key: "pacific-prism",               family: "pacific",      word: /\bprisms?\b/i },
  { key: "pacific-crown-collection",    family: "pacific",      word: /\bcrown\s+collection\b/i },
  { key: "pacific-gold-crown-die-cuts", family: "pacific",      word: /\bgold\s+crown\b|\bcrown\s+die\s*-?\s*cuts?\b/i },
];

/** Source buckets, by the same reading `count by source` uses everywhere. */
function sourceClass(src) {
  const s = String(src == null ? "" : src).toLowerCase();
  if (!s) return "unknown";
  if (/sales-derived|self|derived-from-sales/.test(s)) return "sales-derived";
  if (/checklist|beckett|tcdb|sportscardchecklist|bcp|scc|clc|insider/.test(s)) return "checklist";
  if (/cardhedge|ch-|ebay|tca|vendor|cardsight/.test(s)) return "vendor";
  return "other:" + s;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log("census-dead-ladder-edges  READ ONLY -- nothing is written");
  console.log("  cap per family scan: " + f(CAP) + " rows\n");

  const out = {};

  // 1. catalog rows at each key, by source
  for (const e of EDGES) {
    const q = { query: "SELECT c.source, c.cardYear FROM c WHERE c.setKey = @sk", parameters: [{ name: "@sk", value: e.key }] };
    const bySource = new Map(); const byYear = new Map(); let n = 0;
    try {
      const it = cat.items.query(q, { maxItemCount: 1000 });
      while (it.hasMoreResults()) {
        const r0 = await it.fetchNext();
        for (const r of r0.resources || []) {
          n++;
          const c = sourceClass(r.source);
          bySource.set(c, (bySource.get(c) || 0) + 1);
          const y = r.cardYear == null ? "null" : r.cardYear;
          byYear.set(y, (byYear.get(y) || 0) + 1);
        }
      }
    } catch (err) { console.log("  (catalog scan failed " + e.key + ": " + String(err.message).slice(0, 90) + ")"); }
    out[e.key] = { catalogRows: n, catalogBySource: Object.fromEntries(bySource), catalogByYear: Object.fromEntries([...byYear].sort()) };
    console.log("catalog " + e.key.padEnd(30) + String(f(n)).padStart(7) + "  " + [...bySource].map((kv) => kv[0] + "=" + f(kv[1])).join(" "));
  }

  // 2. sold_comps rows already on the key
  console.log("");
  for (const e of EDGES) {
    const q = { query: "SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(c.hobbyiqCardId, @p)", parameters: [{ name: "@p", value: ":" + e.key + ":" }] };
    let n = -1;
    try { const r = await pool.items.query(q, { maxItemCount: 1 }).fetchAll(); n = (r.resources && r.resources[0]) || 0; }
    catch (err) { console.log("  (count failed for " + e.key + ": " + String(err.message).slice(0, 80) + ")"); }
    out[e.key].poolRowsOnKey = n;
    console.log("pool-on-key " + e.key.padEnd(30) + String(f(n)).padStart(8));
  }

  // 3. family titles that STATE the specialization word
  console.log("");
  const familyCache = new Map();
  for (const e of EDGES) {
    if (e.family === "unknown") { out[e.key].familyScan = { note: "family is `unknown` -- no family pool to scan" }; continue; }
    if (!familyCache.has(e.family)) {
      const q = { query: "SELECT TOP " + CAP + " c.title, c.cardYear, c.source FROM c WHERE CONTAINS(c.hobbyiqCardId, @p)", parameters: [{ name: "@p", value: ":" + e.family + ":" }] };
      const rows = [];
      try { const r = await pool.items.query(q, { maxItemCount: 1000 }).fetchAll(); rows.push(...(r.resources || [])); }
      catch (err) { console.log("  (family scan failed " + e.family + ": " + String(err.message).slice(0, 90) + ")"); }
      familyCache.set(e.family, rows);
    }
    const rows = familyCache.get(e.family);
    const hits = rows.filter((r) => e.word.test(String(r.title == null ? "" : r.title)));
    const yrs = new Map();
    for (const h of hits) { const y = h.cardYear == null ? "null" : h.cardYear; yrs.set(y, (yrs.get(y) || 0) + 1); }
    out[e.key].familyScan = {
      family: e.family, sampled: rows.length, stating: hits.length,
      pct: rows.length ? Number((100 * hits.length / rows.length).toFixed(2)) : 0,
      byYear: Object.fromEntries([...yrs].sort()),
      samples: hits.slice(0, 8).map((h) => String(h.title == null ? "" : h.title).slice(0, 110)),
    };
    console.log("family " + e.key.padEnd(30) + e.family.padEnd(14) + String(f(hits.length)).padStart(6) + "/" + String(f(rows.length)).padStart(6) + " state the word");
  }

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log("\nwrote " + JSON_OUT); }
}
main().catch((e) => { console.error(e); process.exit(1); });
