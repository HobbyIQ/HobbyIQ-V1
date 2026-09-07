#!/usr/bin/env node
/**
 * NEGATIVE-PROOF PASS, READ ONLY.
 *
 * The detail pass showed each candidate word's positive population. A rule may
 * only be written if the word ALSO cannot be claimed by a title that means
 * something else. This measures exactly that, per candidate:
 *
 *   - "Prisms" outside Pacific   -- Panini Prizm is a different spelling, but
 *     "Marquee Prisms" and Sportflics/other prism inserts are real. Counts
 *     titles stating prism that name a RIVAL brand.
 *   - "Black Diamond" outside Upper Deck.
 *   - "Minor League" outside Upper Deck.
 *   - "Rookie & Traded" outside Score (Topps Traded, Fleer Update are rivals).
 *   - "Glossy"/"Tiffany" outside Fleer (Topps Tiffany is the canonical rival).
 *
 * WRITES NOTHING.
 */
const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith("--" + n + "=")); return h ? h.slice(n.length + 3) : d; };
const CAP = Number(arg("cap", "4000")) || 4000;
const JSON_OUT = arg("json", "");
const f = (n) => Number(n).toLocaleString("en-US");

const PROBES = [
  { name: "prism-outside-pacific",       contains: "PRISM",           own: /\bpacific\b/i },
  { name: "blackdiamond-outside-ud",     contains: "BLACK DIAMOND",   own: /\bupper\s*deck\b/i },
  { name: "minorleague-outside-ud",      contains: "MINOR LEAGUE",    own: /\bupper\s*deck\b/i },
  { name: "crowncollection-outside-pac", contains: "CROWN COLLECTION", own: /\bpacific\b/i },
  { name: "goldcrown-outside-pacific",   contains: "GOLD CROWN",      own: /\bpacific\b/i },
  { name: "glossy-outside-fleer",        contains: "GLOSSY",          own: /\bfleer\b/i },
  { name: "rookietraded-outside-score",  contains: "ROOKIE & TRADED", own: /\bscore\b/i },
];

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const out = {};
  console.log("census-dead-edge-negatives  READ ONLY -- nothing is written\n");

  for (const p of PROBES) {
    const q = { query: "SELECT TOP " + CAP + " c.title, c.cardYear, c.hobbyiqCardId FROM c WHERE CONTAINS(UPPER(c.title ?? ''), @w)", parameters: [{ name: "@w", value: p.contains }] };
    let rs = [];
    try { rs = (await pool.items.query(q, { maxItemCount: 1000 }).fetchAll()).resources || []; }
    catch (err) { console.log("  (" + p.name + " failed: " + String(err.message).slice(0, 80) + ")"); continue; }
    const outside = rs.filter((r) => !p.own.test(String(r.title == null ? "" : r.title)));
    const keys = new Map();
    for (const r of outside) { const k = String(r.hobbyiqCardId || "").split(":")[3] || "?"; keys.set(k, (keys.get(k) || 0) + 1); }
    out[p.name] = {
      sampled: rs.length, outsideOwnBrand: outside.length,
      pct: rs.length ? Number((100 * outside.length / rs.length).toFixed(2)) : 0,
      topStoredKeys: Object.fromEntries([...keys].sort((a, b) => b[1] - a[1]).slice(0, 10)),
      samples: outside.slice(0, 10).map((r) => String(r.cardYear) + " | " + String(r.title).slice(0, 105)),
    };
    console.log(p.name.padEnd(32) + String(f(outside.length)).padStart(6) + "/" + String(f(rs.length)).padStart(6) + " outside own brand (" + out[p.name].pct + "%)");
    console.log("    top rival keys: " + [...keys].sort((a, b) => b[1] - a[1]).slice(0, 6).map((kv) => kv[0] + "=" + kv[1]).join(" "));
  }

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log("\nwrote " + JSON_OUT); }
}
main().catch((e) => { console.error(e); process.exit(1); });
