#!/usr/bin/env node
// CF-CATALOG-TCDB-SETS (Drew, 2026-08-05).
//
// TCDB scraper — SETS ONLY (no per-card pagination). For each year,
// fetches the year index page (/ViewAll.cfm/sp/Baseball/year/YYYY)
// and extracts every set entry. Each set link gives us:
//   - sid (numeric TCDB internal)
//   - slug (year + product name)
//   - year, brand (parsed from slug)
//
// Purpose: capture set-level product coverage TCDB has that BCCP/CLC
// don't — primarily international (Japanese BBM/Epoch/NPB, team-
// exclusives) and rare/regional. Does NOT go into per-card detail —
// that would require paginated scraping (~75 hours for full baseball).
// Set-level identity is enough for the catalog to KNOW the product
// exists so when it eventually trades, we have a home for it.
//
// Rate: ~1 sec per year page → ~120s for full baseball history (1866-2026).
//
// Output: c:/tmp/tcdb-sets/{year}/sets.json
//         { year, sets: [{ sid, slug, productName }] }

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const UA = "HobbyIQ-Catalog-Scraper/0.1 (contact:dvabulas@outlook.com)";
const OUT_ROOT = "c:/tmp/tcdb-sets";
const YEAR_URL = (y) => `https://www.tcdb.com/ViewAll.cfm/sp/Baseball/year/${y}`;
const POLITE_DELAY_MS = 1200;

function parseSetsFromHtml(html) {
  // Every set link is /ViewSet.cfm/sid/{id}/{slug}
  const re = /href="\/ViewSet\.cfm\/sid\/(\d+)\/([^"?#]+)"/g;
  const out = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const sid = m[1];
    const slug = m[2];
    // Skip prev/next-year navigation links — same-year only
    if (out.has(sid)) continue;
    out.set(sid, { sid, slug });
  }
  return [...out.values()];
}

async function scrapeYear(year, outDir) {
  const outPath = join(outDir, "sets.json");
  if (existsSync(outPath)) return { skipped: true };
  const res = await fetch(YEAR_URL(year), { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const setsRaw = parseSetsFromHtml(html);
  // Filter to sets whose slug starts with this year (skip cross-year nav)
  const sets = setsRaw
    .filter((s) => s.slug.startsWith(String(year)))
    .map((s) => ({
      sid: s.sid,
      slug: s.slug,
      productName: s.slug.replace(/^\d{4}-/, "").replace(/-/g, " "),
    }));
  writeFileSync(outPath, JSON.stringify({ year, sets, fetchedAt: new Date().toISOString() }, null, 2));
  return { sets: sets.length };
}

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  const startYear = Number(process.argv[2] ?? "1866");
  const endYear = Number(process.argv[3] ?? "2026");
  const years = [];
  for (let y = endYear; y >= startYear; y--) years.push(y);
  console.log(`▸ TCDB sets scrape ${endYear}..${startYear}`);
  let ok = 0, fail = 0, skipped = 0, totalSets = 0;
  const startedAt = Date.now();
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    const outDir = join(OUT_ROOT, String(y));
    mkdirSync(outDir, { recursive: true });
    try {
      const r = await scrapeYear(y, outDir);
      if (r.skipped) { skipped++; continue; }
      ok++;
      totalSets += r.sets;
      if ((i + 1) % 10 === 0 || i === years.length - 1) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  y=${y}  sets=${r.sets}  running total=${totalSets}  ${elapsed}s`);
      }
    } catch (err) {
      fail++;
      if (fail < 5) console.log(`  ! y=${y}: ${err.message}`);
    }
    await sleep(POLITE_DELAY_MS);
  }
  console.log(`\n▸ DONE — years fetched=${ok}, skipped=${skipped}, failed=${fail}, ${totalSets.toLocaleString()} sets total`);
}

main().catch((e) => { console.error(e); process.exit(1); });
