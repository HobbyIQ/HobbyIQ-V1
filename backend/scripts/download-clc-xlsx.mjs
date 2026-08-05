#!/usr/bin/env node
// CF-CATALOG-CLC-XLSX (Drew, 2026-08-05).
//
// For every CLC product JSON on disk, re-fetch its HTML page, extract
// the xlsx download URL, and grab the .xlsx to c:/tmp/clc-xlsx/{year}/.
// Enables player-name enrichment: xlsx has "1 Aaron Judge - NYY, 2 ..."
// data we can use to backfill playerName on catalog rows.
//
// Politeness: 1500ms between REQUEST PAIRS (fetch HTML + fetch xlsx).
// Skips products that already have an xlsx on disk.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const UA = "HobbyIQ-Catalog-Scraper/0.1 (contact:dvabulas@outlook.com)";
const JSON_ROOT = "c:/tmp/clc";
const XLSX_ROOT = "c:/tmp/clc-xlsx";
const POLITE_DELAY_MS = 1500;

function slugFromUrl(url) {
  const m = url.match(/checklistcenter\.com\/([^/]+)\//);
  return m ? m[1] : "unknown";
}

async function main() {
  mkdirSync(XLSX_ROOT, { recursive: true });
  const yearDirs = readdirSync(JSON_ROOT).filter((n) => /^\d{4}$/.test(n)).sort();
  const jobs = [];
  for (const y of yearDirs) {
    const files = readdirSync(join(JSON_ROOT, y)).filter((n) => n.endsWith(".json"));
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(join(JSON_ROOT, y, f), "utf8"));
        if (!j.url || !j.sourceSlug) continue;
        jobs.push({ year: y, slug: j.sourceSlug, url: j.url });
      } catch { /* skip broken JSON */ }
    }
  }
  console.log(`▸ ${jobs.length} CLC products to check for xlsx`);

  let ok = 0, noXlsx = 0, skipped = 0, fail = 0;
  const startedAt = Date.now();
  for (let i = 0; i < jobs.length; i++) {
    const { year, slug, url } = jobs[i];
    const outDir = join(XLSX_ROOT, year);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${slug}.xlsx`);
    if (existsSync(outPath)) { skipped++; continue; }
    try {
      const htmlRes = await fetch(url, { headers: { "User-Agent": UA } });
      if (!htmlRes.ok) { fail++; continue; }
      const html = await htmlRes.text();
      const m = html.match(/https:\/\/www\.checklistcenter\.com\/wp-content\/uploads\/[^"'<>]+\.xlsx/);
      if (!m) { noXlsx++; continue; }
      const xlsxUrl = m[0];
      const xlsxRes = await fetch(xlsxUrl, { headers: { "User-Agent": UA } });
      if (!xlsxRes.ok) { fail++; continue; }
      const buf = Buffer.from(await xlsxRes.arrayBuffer());
      writeFileSync(outPath, buf);
      ok++;
    } catch (err) {
      fail++;
      if (fail < 5) console.log(`  ! ${slug}: ${err.message}`);
    }
    if ((i + 1) % 20 === 0 || i === jobs.length - 1) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  ${i + 1}/${jobs.length}  ok=${ok} noXlsx=${noXlsx} skipped=${skipped} fail=${fail}  ${elapsed}s`);
    }
    await sleep(POLITE_DELAY_MS);
  }
  console.log(`\n▸ DONE — ok=${ok} noXlsx=${noXlsx} skipped=${skipped} fail=${fail}, total ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
