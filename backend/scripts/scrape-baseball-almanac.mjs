#!/usr/bin/env node
// CF-CATALOG-BALMANAC (Drew, 2026-08-05).
//
// Baseball-Almanac scraper — three-level walk:
//   1. Index page → list of manufacturers
//   2. Per-manufacturer page → list of sets (year + set slug)
//   3. Per-set page → checklist (cardNumber + playerName + subset)
//
// No WAF, polite delay only. Writes to c:/tmp/ba/{mfrSlug}/{setSlug}.json.
// Consumed by match-catalog-to-alt-sources.ts for identity match against
// null card_catalog rows (bccpMatchedAs undefined).
//
// Env / args:
//   MANUFACTURER=Score  → only scrape one manufacturer
//   MAX_MFR=N          → cap for smoke test

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const UA = "HobbyIQ-Catalog/0.1 (contact:dvabulas@outlook.com)";
const BASE = "https://www.baseball-almanac.com/baseball_cards";
const OUT_ROOT = "c:/tmp/ba";
const POLITE_DELAY_MS = 800;
const ONLY_MFR = process.env.MANUFACTURER || "";
const MAX_MFR = process.env.MAX_MFR ? Number(process.env.MAX_MFR) : 0;

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchIndex() {
  const html = await fetchText(`${BASE}/baseball_cards.php`);
  const links = [...html.matchAll(/href=["'](baseball_card_sets\.php\?m=[^"']+)["']/g)];
  const out = new Map();
  for (const m of links) {
    const url = m[1];
    const mfr = decodeURIComponent(url.match(/m=(.+)$/)[1]);
    if (!out.has(mfr)) out.set(mfr, `${BASE}/${url}`);
  }
  return [...out.entries()].map(([mfr, url]) => ({ mfr, url }));
}

async function fetchSetsForMfr(mfrUrl) {
  const html = await fetchText(mfrUrl);
  // Set links look like: <a href="baseball_cards_oneset.php?s=1990sco01">1990 Score</a>
  const re = /href=["'](baseball_cards_oneset\.php\?s=([^"']+))["'][^>]*>([\s\S]*?)<\/a>/g;
  const sets = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const slug = m[2];
    // Clean label: strip <sup>(nnn Cards)</sup> markup + any HTML.
    const label = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").replace(/\(\s*\d+\s+Cards?\s*\)/i, "").trim();
    // Extract year from slug prefix (first 4 chars are year).
    const yearMatch = slug.match(/^(\d{4})/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    sets.push({ slug, year, label, url: `${BASE}/${url}` });
  }
  return sets;
}

function parseChecklist(html) {
  // Checklists render as an HTML table. Rows look like:
  //   <tr><td>001</td><td><a href="...">Player Name</a></td>...</tr>
  // Some sets have subset chunks with a heading row. Extract every row
  // that has a numeric-ish first cell and a player-name second cell.
  const cards = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const rowHtml = m[1];
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
    );
    if (cells.length < 2) continue;
    const cardNumber = cells[0];
    const player = cells[1];
    if (!cardNumber || !player) continue;
    // Very loose acceptance: cardNumber can be alphanumeric with punctuation
    // (T206 uses "N/A" for many; modern uses "BDC28"; vintage "42").
    // Reject rows that are clearly headers ("Card"/"Player" etc.)
    if (/^card$/i.test(cardNumber) || /^player$/i.test(player)) continue;
    // Header row leaks: cardNumber = "#" or "No.", player = "Card Description" etc.
    if (cardNumber === "#" || /^no\.?$/i.test(cardNumber)) continue;
    if (/^(card\s+description|description|name|subject|player)$/i.test(player)) continue;
    if (cardNumber.length > 12) continue;
    cards.push({ cardNumber, playerName: player });
  }
  return cards;
}

async function scrapeSet(mfrSlug, setInfo) {
  const outDir = join(OUT_ROOT, mfrSlug);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${setInfo.slug}.json`);
  if (existsSync(outPath)) return { skipped: true };
  const html = await fetchText(setInfo.url);
  const cards = parseChecklist(html);
  writeFileSync(
    outPath,
    JSON.stringify(
      { slug: setInfo.slug, year: setInfo.year, label: setInfo.label, mfr: mfrSlug, cards, fetchedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  return { cards: cards.length };
}

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log("▸ Baseball-Almanac scrape starting");
  const mfrs = await fetchIndex();
  const filtered = ONLY_MFR ? mfrs.filter((m) => m.mfr.toLowerCase() === ONLY_MFR.toLowerCase()) : mfrs;
  const capped = MAX_MFR ? filtered.slice(0, MAX_MFR) : filtered;
  console.log(`  ${capped.length} manufacturers to walk (of ${mfrs.length} total)`);

  let totalSets = 0;
  let totalCards = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (const { mfr, url } of capped) {
    const mfrSlug = slugify(mfr);
    let sets = [];
    try {
      sets = await fetchSetsForMfr(url);
    } catch (e) {
      failed++;
      console.log(`  ! mfr=${mfr}: ${e.message}`);
      await sleep(POLITE_DELAY_MS);
      continue;
    }
    console.log(`  → ${mfr}: ${sets.length} sets`);
    for (const s of sets) {
      try {
        const r = await scrapeSet(mfrSlug, s);
        if (r.skipped) { skipped++; continue; }
        totalSets++;
        totalCards += r.cards;
      } catch (e) {
        failed++;
        if (failed < 20) console.log(`    ! ${s.slug}: ${e.message}`);
      }
      await sleep(POLITE_DELAY_MS);
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  · ${mfr} done. running total: sets=${totalSets} cards=${totalCards} elapsed=${elapsed}s`);
  }
  console.log(`\n▸ DONE — sets fetched=${totalSets}, skipped=${skipped}, failed=${failed}, ${totalCards.toLocaleString()} cards total`);
}

main().catch((e) => { console.error(e); process.exit(1); });
