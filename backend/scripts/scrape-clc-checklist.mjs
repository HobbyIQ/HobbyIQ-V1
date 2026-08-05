#!/usr/bin/env node
// CF-CATALOG-CLC-SCRAPE (Drew, 2026-08-05).
//
// Scrape checklistcenter.com baseball checklists as a secondary
// parallel-enumeration source alongside BCCP. Complements BCCP's
// coverage — checklistcenter is smaller (~547 baseball products)
// but has 2026 pages that BCCP doesn't (BCCP topped out at 2025).
//
// Wire contract per product JSON:
//   {
//     url, productName, year, sport, sourceSlug,
//     subsets: [
//       { title, cardCount, parallels: [{ name, printRun }] }
//     ],
//     fetchedAt
//   }
//
// URL pattern: https://www.checklistcenter.com/{year}-{slug}-baseball-card-checklist/
// Sitemap index: https://www.checklistcenter.com/post-sitemap{1..4}.xml
//
// Output: c:/tmp/clc/{year}/{slug}.json
// Politeness: 1000ms between fetches, single-threaded.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const UA = "HobbyIQ-Catalog-Scraper/0.1 (contact:dvabulas@outlook.com)";
const OUT_ROOT = "c:/tmp/clc";
const SITEMAPS = [1, 2, 3, 4].map((n) => `https://www.checklistcenter.com/post-sitemap${n}.xml`);
const POLITE_DELAY_MS = 1000;

// ─── URL discovery ────────────────────────────────────────────

async function fetchAllBaseballUrls() {
  const all = new Set();
  for (const sitemapUrl of SITEMAPS) {
    process.stdout.write(`▸ ${sitemapUrl} ... `);
    const res = await fetch(sitemapUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) { console.log(`skip (HTTP ${res.status})`); continue; }
    const xml = await res.text();
    const urls = (xml.match(/https:\/\/www\.checklistcenter\.com\/[^<]*baseball-card-checklist\//g) ?? []);
    for (const u of urls) all.add(u);
    console.log(`+${urls.length}`);
    await sleep(500);
  }
  return [...all].sort();
}

// ─── HTML → subsets ────────────────────────────────────────────

const WORD_TO_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function decodeEntities(s) {
  return s
    .replace(/&#8211;/g, "-").replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8216;/g, "'").replace(/&#8212;/g, "—")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function stripTags(s) { return s.replace(/<[^>]+>/g, "").trim(); }

function parseParallelString(raw) {
  // "Sky Blue Border #/499; Neon Green Border #/399; SuperFractor 1/1"
  const out = [];
  for (const chunk of raw.split(";")) {
    let text = decodeEntities(chunk).replace(/\s+/g, " ").trim();
    if (!text) continue;
    let printRun = null;
    // "#/N"
    let m = text.match(/#\/(\d[\d,]*)/);
    if (m) { printRun = Number(m[1].replace(/,/g, "")); text = text.replace(m[0], "").trim(); }
    // "1/1" or "1 of 1"
    if (printRun == null && /\b1\s*[-\/]?\s*of\s*[-\/]?\s*1\b|\b1\s*\/\s*1\b/.test(text)) {
      printRun = 1;
      text = text.replace(/\b1\s*[-\/]?\s*of\s*[-\/]?\s*1\b/gi, "").replace(/\b1\s*\/\s*1\b/g, "").trim();
    }
    // "one-of-one"
    if (printRun == null && /\bone[-\s]of[-\s]one\b/i.test(text)) {
      printRun = 1;
      text = text.replace(/\bone[-\s]of[-\s]one\b/gi, "").trim();
    }
    // Trailing (Hobby Exclusive) / (Retail Exclusive) / (Retail Only) — strip but keep as noise
    text = text.replace(/\((?:hobby|retail|mega|walmart|target)[- ]?(?:exclusive|only)?\)/gi, "").trim();
    // Trailing pack odds "(1:1165 Hobby; 1:489 Jumbo)" — chunk-split would break this, but if leftover strip
    text = text.replace(/\(1[:\s]\d+[^)]*\)/gi, "").trim();
    text = text.replace(/[\s,.:]+$/, "").trim();
    if (!text) continue;
    out.push({ name: text, printRun });
  }
  return out;
}

function extractSubsetsFromHtml(html) {
  // Split by h3 boundaries. Each subset chunk contains a title (in h3) and
  // one or more <p> blocks below with the "N Cards" + "Parallels:" data.
  const subsets = [];
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const marks = [];
  let m;
  while ((m = h3Re.exec(html)) !== null) marks.push({ title: decodeEntities(stripTags(m[1])), idx: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx - 100 : html.length;
    const chunk = html.slice(start, end);
    const title = marks[i].title;

    // Card count
    let cardCount = null;
    const cc = chunk.match(/\b(\d+)\s+Cards?\b/i);
    if (cc) cardCount = Number(cc[1]);

    // Parallels line — <strong>Parallels:</strong> ...
    let parallels = [];
    const pm = chunk.match(/<strong>\s*Parallels?\s*:\s*<\/strong>([\s\S]*?)<\/p>/i);
    if (pm) {
      const rawText = stripTags(pm[1]);
      parallels = parseParallelString(rawText);
    }

    // Only push subsets that carry either parallels OR a real card count
    // (skip pure text blocks like "Product Breakdown").
    if (parallels.length > 0 || cardCount != null) {
      subsets.push({ title, cardCount, parallels });
    }
  }
  return subsets;
}

// ─── per-URL scrape ────────────────────────────────────────────

function slugFromUrl(url) {
  const m = url.match(/checklistcenter\.com\/([^/]+)\//);
  return m ? m[1] : url.replace(/[^a-z0-9]/gi, "-");
}
function yearFromSlug(slug) {
  const m = slug.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

async function scrapeUrl(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const slug = slugFromUrl(url);
  const year = yearFromSlug(slug);
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const productName = titleMatch ? decodeEntities(stripTags(titleMatch[1])).replace(/\s*-\s*Baseball Card Checklist\s*$/i, "").trim() : slug;
  const subsets = extractSubsetsFromHtml(html);
  return { url, sourceSlug: slug, productName, year, sport: "baseball", subsets, fetchedAt: new Date().toISOString() };
}

// ─── main ─────────────────────────────────────────────────────

async function main() {
  const urls = await fetchAllBaseballUrls();
  console.log(`\n▸ ${urls.length} baseball checklist URLs to scrape`);
  mkdirSync(OUT_ROOT, { recursive: true });

  let ok = 0, fail = 0, skipped = 0;
  const startedAt = Date.now();
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const slug = slugFromUrl(url);
    const year = yearFromSlug(slug);
    if (!year || year < 1950) { skipped++; continue; }
    const outDir = join(OUT_ROOT, String(year));
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${slug}.json`);
    if (existsSync(outPath)) { skipped++; continue; }
    try {
      const data = await scrapeUrl(url);
      writeFileSync(outPath, JSON.stringify(data, null, 2));
      ok++;
    } catch (err) {
      fail++;
      if (fail < 10) console.log(`  ! ${slug}: ${err.message}`);
    }
    if ((i + 1) % 20 === 0 || i === urls.length - 1) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  ${i + 1}/${urls.length}  ok=${ok} skipped=${skipped} fail=${fail}  ${elapsed}s`);
    }
    await sleep(POLITE_DELAY_MS);
  }
  console.log(`\n▸ DONE — ok=${ok} skipped=${skipped} fail=${fail}, total ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
