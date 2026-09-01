#!/usr/bin/env node
/**
 * CF-BECKETT-VARIATION-GUIDES (Drew, 2026-08-31: "we can go through all of
 * this for the variations. it has many pages").
 *
 * Beckett's variations-and-SP category is the systematic source for image
 * variations: one guide per product, each carrying the checklist AND the
 * photo descriptor that names every card ("Variation - carrying bag" /
 * "Base - batting"), plus the CMP code that confirms it on the card back.
 *
 * That descriptor is the thing nothing else has. Titles never carry Beckett's
 * wording for 8 of the 15 cards in 2018 Bowman Chrome, so the market cannot
 * supply these names on its own and TCDB does not publish them either.
 *
 * Discovery only — writes a manifest, fetches no checklist. The per-product
 * converter reads the manifest.
 *
 * Usage:
 *   node backend/scripts/discoverBeckettVariationGuides.cjs \
 *     [--sport=baseball] [--pages=8] [--out=/tmp/beckett-variation-guides.json]
 */

const fs = require("fs");
const { execFileSync } = require("child_process");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const PAGES = Number(arg("pages", "8"));
const OUT = arg("out", "C:/Users/dvabu/AppData/Local/Temp/beckett-variation-guides.json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
// Beckett answers node's https client with 403 on these pages while serving
// curl at 200 — the same TLS fingerprinting scrape-tcdb documents. Shell out.
const get = (url) => {
  try {
    return execFileSync("curl", ["-sL", "--max-time", "45", "-A", UA,
      "-H", "Accept: text/html,application/xhtml+xml", "-H", "Accept-Language: en-US,en;q=0.9", url],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch { return ""; }
};

const CATEGORY = `https://www.beckett.com/news/category/${SPORT}/variations-and-sp-info-${SPORT}/`;

function main() {
  const seen = new Map();
  for (let p = 1; p <= PAGES; p++) {
    const url = p === 1 ? CATEGORY : `${CATEGORY}page/${p}/`;
    const html = get(url);
    if (!html || html.length < 5000) { console.log(`  page ${p}: empty/blocked — stopping`); break; }
    let added = 0;
    // Article links in this category are the guides themselves.
    for (const m of html.matchAll(/href="(https:\/\/www\.beckett\.com\/news\/([a-z0-9-]+)\/)"/g)) {
      const [, href, slug] = m;
      // A guide names a product and says variation / SP / short print.
      if (!/(variation|short-print|sp-)/.test(slug)) continue;
      if (/category|page/.test(href)) continue;
      const year = (slug.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
      if (!seen.has(href)) { seen.set(href, { url: href, slug, year: year ? Number(year) : null }); added++; }
    }
    console.log(`  page ${p}: +${added} guides (total ${seen.size})`);
    if (!added && p > 1) break;
  }

  const guides = [...seen.values()].sort((a, b) => (b.year || 0) - (a.year || 0) || a.slug.localeCompare(b.slug));
  fs.writeFileSync(OUT, JSON.stringify({ sport: SPORT, discoveredAt: new Date().toISOString(), count: guides.length, guides }, null, 2));
  console.log(`\n[discover] ${guides.length} variation guides -> ${OUT}`);
  const byYear = new Map();
  for (const g of guides) byYear.set(g.year, (byYear.get(g.year) || 0) + 1);
  console.log("by year:");
  for (const [y, n] of [...byYear.entries()].sort((a, b) => (b[0] || 0) - (a[0] || 0))) console.log(`  ${y ?? "?"}: ${n}`);
}
main();
