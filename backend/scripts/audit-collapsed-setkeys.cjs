#!/usr/bin/env node
/**
 * CF-COLLAPSED-SETKEY-AUDIT (Drew, 2026-08-17: "lets run through All the sales
 * index to see what else collapsed that shouldn't").
 *
 * READ-ONLY. Finds sales whose setKey is LESS specific than the product their
 * own vendor setName names — i.e. distinct products sharing one comp pool.
 *
 * METHOD. For every setName in sold_comps: resolve it through the CURRENT
 * vocabulary, strip the year and sport (the slug already carries both), and
 * compare the remaining product words against the key's own words. A word the
 * vendor wrote that the key does not contain is a product distinction the slug
 * threw away.
 *
 * Runs against the live vocabulary on purpose, so a product that has just been
 * given a rule drops out of the report on the next run. That makes this the
 * progress meter for the collapse worklist, not a one-off snapshot.
 *
 * WHAT IT CANNOT DECIDE. Some collapses are deliberate — Bowman Chrome
 * Prospects folds into bowman-chrome because buyers do not distinguish the
 * subset (CF-CHROME-SUBSET-COLLAPSE), and Bowman Draft Chrome keeps the draft
 * identity (CF-MATCH-THE-CATALOG). This script compares words, not intent, so
 * it flags those too. Read the report; do not sweep it.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-collapsed-setkeys.cjs [--keys=40] [--products=6]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const TOP_KEYS = Number(arg("keys", "40"));
const TOP_PRODUCTS = Number(arg("products", "6"));

const SPORTS = /\b(baseball|basketball|football|hockey|soccer|golf|racing|boxing|wrestling|mma|tennis|pokemon|multi-?sport)\b/gi;
/** Words that appear in vendor set names but never distinguish a product. */
const NOISE = new Set([
  "series", "cards", "card", "edition", "set", "sets", "box", "boxes", "hobby",
  "retail", "factory", "sealed", "pack", "packs", "the", "and", "of", "inc",
  "tm", "collection", "update", "updates", "vintage", "modern", "sport",
  "sports", "trading", "league", "national", "official", "complete", "team",
  "teams", "player", "players", "rookie", "rookies", "star", "stars", "insert",
  "inserts", "parallel", "parallels", "auto", "autograph", "autographs", "rc",
]);

function productOf(setName) {
  let s = String(setName || "").trim();
  s = s.replace(/^((19|20)\d{2}(-\d{2})?\s+)+/g, "");   // leading year(s)
  s = s.replace(SPORTS, "").replace(/\s+/g, " ").trim();  // sport word
  return s;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  process.stderr.write("grouping sold_comps by setName ...\n");
  const { resources: groups } = await sold.items.query(
    "SELECT c.setName AS k, COUNT(1) AS n FROM c WHERE IS_DEFINED(c.setName) GROUP BY c.setName",
    { maxItemCount: -1 },
  ).fetchAll();

  const byKey = new Map();
  let scanned = 0, flagged = 0;

  for (const r of groups) {
    const setName = String(r.k ?? "");
    if (!setName || /^unknown$/i.test(setName)) continue;
    scanned += r.n;
    const key = normalizeSetKey(setName);
    if (!key || key === "unknown") continue;

    const prod = productOf(setName);
    if (!prod) continue;
    const pTokens = prod.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
    const kTokens = new Set(key.split("-"));
    const extra = pTokens.filter((t) => !kTokens.has(t) && !NOISE.has(t) && t.length > 1 && !/^\d+$/.test(t));
    if (extra.length === 0) continue;

    flagged += r.n;
    if (!byKey.has(key)) byKey.set(key, { total: 0, products: new Map() });
    const e = byKey.get(key);
    e.total += r.n;
    e.products.set(prod, (e.products.get(prod) || 0) + r.n);
  }

  const ranked = [...byKey.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log(`setNames: ${groups.length}   sales with a setName: ${scanned.toLocaleString()}`);
  console.log(`ON A KEY THEIR OWN setName CONTRADICTS: ${flagged.toLocaleString()} (${(flagged / scanned * 100).toFixed(1)}%)`);
  console.log(`distinct keys affected: ${ranked.length}\n`);
  console.log("key".padEnd(28) + "collapsed".padStart(9) + "   products hiding inside it");
  console.log("-".repeat(110));
  for (const [key, e] of ranked.slice(0, TOP_KEYS)) {
    const top = [...e.products.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_PRODUCTS)
      .map(([p, n]) => `${p} ${n.toLocaleString()}`).join(" · ");
    console.log(`${key.padEnd(28)}${String(e.total).padStart(9)}   ${top.slice(0, 150)}`);
  }
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
