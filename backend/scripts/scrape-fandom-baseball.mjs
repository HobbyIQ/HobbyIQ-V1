#!/usr/bin/env node
// CF-CATALOG-FANDOM (Drew, 2026-08-05).
//
// Fandom Baseball Cards Wiki (baseballcards.fandom.com) — MediaWiki API,
// no auth, no WAF. Walks the "Set" category to enumerate every set
// article, fetches each via `action=parse&format=json`, extracts card
// checklist tables from the wikitext, and writes to
// c:/tmp/fandom/{setSlug}.json in the same shape our BA scraper uses.
//
// Consumed by match-catalog-to-alt-sources.ts alongside the BA output.
//
// Env: MAX_PAGES (default unlimited)

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const UA = "HobbyIQ-Catalog/0.1 (contact:dvabulas@outlook.com)";
const API = "https://baseballcards.fandom.com/api.php";
const OUT_ROOT = "c:/tmp/fandom";
const POLITE_DELAY_MS = 400;
const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : 0;

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function enumerateCategoryPages(category) {
  const pages = [];
  let cont;
  do {
    const url = `${API}?action=query&list=categorymembers&cmtitle=${encodeURIComponent("Category:" + category)}&cmlimit=500&format=json${cont ? `&cmcontinue=${encodeURIComponent(cont)}` : ""}`;
    const data = await fetchJson(url);
    for (const p of data.query?.categorymembers ?? []) {
      if (p.ns === 0) pages.push(p.title);
    }
    cont = data.continue?.cmcontinue;
    await sleep(POLITE_DELAY_MS);
  } while (cont);
  return pages;
}

function parseChecklistFromWikitext(wikitext) {
  const cards = [];
  const seen = new Set();
  // Fandom articles use "* N PlayerName [suffix]" bullet-list format for
  // set checklists (e.g. `* 1 Bob Elliott RC`, `* 18 Warren Spahn RC`).
  // Also handles alphanumeric prefixes ("BDC28 Carson Benge") and
  // subset ranges (BB1, T206-N/A). Skip bullet lines that don't look
  // like a card entry.
  for (const rawLine of wikitext.split(/\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("*")) continue;
    // Strip leading "* " (or "**") and trailing HTML/comments.
    const body = line.replace(/^\*+\s*/, "").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!body) continue;
    // Match: [cardNumber] [space] [rest]
    // cardNumber = alphanumeric with optional dash/slash, 1-12 chars.
    const m = body.match(/^([A-Za-z0-9][\w\-\/\.]{0,11})\s+(.+)$/);
    if (!m) continue;
    const cardNumber = m[1];
    // Strip wikilinks + emphasis + trailing suffixes (RC, SP, CL, HOF).
    let player = m[2]
      .replace(/\[\[([^\|\]]+\|)?([^\]]+)\]\]/g, "$2")
      .replace(/'''?/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // Drop trailing "RC", "SP", "RC/SP", "HOF", "CL" (rookie / short
    // print / checklist markers). Keep them on their own row so we
    // preserve player identity.
    player = player.replace(/\s+(RC|SP|CL|HOF|RC\/SP|SP\/RC|SP\/CL|RB|MV|AS)$/i, "").trim();
    if (!cardNumber || !player) continue;
    if (player.length < 2) continue;
    if (/^(name|player|subject|no|number|#|card)\.?$/i.test(player)) continue;
    const key = `${cardNumber}::${player}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({ cardNumber, playerName: player });
  }
  return cards;
}

async function fetchPageWikitext(title) {
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
  const data = await fetchJson(url);
  return data.parse?.wikitext?.["*"] ?? "";
}

function extractYearFromTitle(title) {
  const m = title.match(/^(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log("▸ Fandom Baseball-Cards Wiki scrape starting");
  // Best category: "Baseball_card_sets" (may vary — fall back if empty).
  let titles = [];
  for (const cat of ["Baseball Card Sets", "Baseball Card Boxes", "Baseball Card Singles"]) {
    titles = await enumerateCategoryPages(cat);
    if (titles.length > 0) {
      console.log(`  category=${cat} → ${titles.length} pages`);
      break;
    }
  }
  if (titles.length === 0) {
    console.log("  ! no titles found in any category — check category name");
    return;
  }
  const capped = MAX_PAGES ? titles.slice(0, MAX_PAGES) : titles;
  let ok = 0, empty = 0, failed = 0;
  const startedAt = Date.now();
  for (let i = 0; i < capped.length; i++) {
    const title = capped[i];
    const setSlug = slugify(title);
    const outPath = join(OUT_ROOT, `${setSlug}.json`);
    if (existsSync(outPath)) continue;
    try {
      const wt = await fetchPageWikitext(title);
      const cards = parseChecklistFromWikitext(wt);
      if (cards.length === 0) { empty++; continue; }
      const year = extractYearFromTitle(title);
      writeFileSync(
        outPath,
        JSON.stringify({ slug: setSlug, year, label: title, mfr: "fandom", cards, fetchedAt: new Date().toISOString() }, null, 2),
      );
      ok++;
      if ((i + 1) % 20 === 0) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  ${i + 1}/${capped.length}  ok=${ok} empty=${empty} failed=${failed}  ${elapsed}s`);
      }
    } catch (e) {
      failed++;
      if (failed < 10) console.log(`  ! ${title}: ${e.message}`);
    }
    await sleep(POLITE_DELAY_MS);
  }
  console.log(`\n▸ DONE — pages ok=${ok} empty=${empty} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
