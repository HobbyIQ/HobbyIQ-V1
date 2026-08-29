#!/usr/bin/env node
/**
 * scrape-checklistcenter-products.cjs -- acquire checklistcenter pages, staging only.
 *
 * CF-CHECKLISTCENTER-INTO-THE-GUARDED-PIPE (checklist D3). The old
 * checklistcenter ingesters raw-upserted into card_catalog (~1.0M + ~209k rows)
 * with a ladder parser that split on commas -- player names became rungs -- and
 * must not be rerun. The converter that replaces them reads cached page
 * artifacts; this script produces those artifacts and nothing else. It never
 * touches Cosmos.
 *
 * Work list: backend/data/checklistcenter-products.json (547 product pages,
 * extracted from the ladders-only cache of scrape-clc-checklist.mjs). Per
 * product: fetch the page HTML into <outDir>/html/<year>/<slug>.html; if the
 * page links a wp-content/uploads/*.xlsx workbook, fetch it into
 * <outDir>/xlsx/<year>/<slug>.xlsx. Skip what is already cached. 800 ms between
 * requests -- it is somebody else's site.
 *
 * Args: --outDir=<dir> (default C:/tmp/clc-pages)  --delayMs=800  --limit=N
 *       --years=2020-2026 (inclusive filter)  --force (re-fetch)
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => { const hit = process.argv.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.slice(n.length + 3) : d; };
const OUT_DIR = arg("outDir", "C:/tmp/clc-pages");
const DELAY_MS = Number(arg("delayMs", "800"));
const LIMIT = Number(arg("limit", "0"));
const YEARS = String(arg("years", ""));
const FORCE = process.argv.includes("--force");
const LIST = path.join(__dirname, "..", "data", "checklistcenter-products.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (n) => Number(n).toLocaleString();

async function get(url, binary = false, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) { console.log(`   HTTP ${res.status} ${url.slice(0, 90)}`); return null; }
    return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  } catch (e) {
    if (attempt < 3) { await sleep(3000 * (attempt + 1)); return get(url, binary, attempt + 1); }
    console.log(`   fetch failed ${url.slice(0, 80)}: ${String(e.message).slice(0, 40)}`);
    return null;
  }
}

async function main() {
  const list = JSON.parse(fs.readFileSync(LIST, "utf8"));
  let products = list.products;
  if (YEARS) { const [a, b] = YEARS.split("-").map(Number); products = products.filter((p) => p.year >= a && p.year <= (b || a)); }
  if (LIMIT) products = products.slice(0, LIMIT);
  console.log(`[clc-pages] ${f(products.length)} products  out: ${OUT_DIR}\n`);
  let html = 0, xlsx = 0, noXlsx = 0, cached = 0, failed = 0;
  for (const p of products) {
    const year = String(p.year || "unknown"), slug = p.sourceSlug;
    const hDir = path.join(OUT_DIR, "html", year), xDir = path.join(OUT_DIR, "xlsx", year);
    fs.mkdirSync(hDir, { recursive: true }); fs.mkdirSync(xDir, { recursive: true });
    const hPath = path.join(hDir, `${slug}.html`), xPath = path.join(xDir, `${slug}.xlsx`);
    if (!FORCE && fs.existsSync(hPath)) { cached++; continue; }
    const page = await get(p.url);
    await sleep(DELAY_MS);
    if (!page) { failed++; continue; }
    fs.writeFileSync(hPath, page);
    html++;
    const xm = page.match(/href="([^"]+wp-content\/uploads\/[^"]+\.xlsx)"/i);
    if (xm) {
      const buf = await get(xm[1].replace(/&amp;/g, "&"), true);
      await sleep(DELAY_MS);
      if (buf) { fs.writeFileSync(xPath, buf); xlsx++; } else noXlsx++;
    } else noXlsx++;
    if ((html + cached) % 25 === 0) console.log(`  ${f(html + cached)}/${f(products.length)}  html=${f(html)} xlsx=${f(xlsx)} cached=${f(cached)} failed=${f(failed)}`);
  }
  console.log(`\n[clc-pages] done  html fetched=${f(html)}  xlsx fetched=${f(xlsx)}  pages without xlsx=${f(noXlsx)}  already cached=${f(cached)}  failed=${f(failed)}`);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
