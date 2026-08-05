#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-BCCP-SCRAPE (Drew, 2026-08-04).
 *
 * For a given year, fetches the baseballcardpedia year-index page,
 * enumerates every candidate baseball product listed as a link, and
 * scrapes each product page's parallels/inserts/autos/gimmicks by
 * re-using the product-page parser.
 *
 * Skips pages whose title explicitly indicates a non-baseball sport
 * (NFL/NBA/NHL/MLS/WNBA/Football/Basketball/Hockey/Soccer/Racing/
 * NASCAR/PGA/UFC/MMA/Boxing/Wrestling), plus one-off promo/season
 * ticket-holder subpages that are not real products.
 *
 * Politeness: 800ms delay between product-page fetches.
 *
 * Output: /tmp/bccp/{year}/products.json (index) plus
 *         /tmp/bccp/{year}/{slugified-name}.json per product.
 *
 * Usage:
 *   npx tsx backend/scripts/scrape-bccp-year.ts --year 2024 [--outdir /tmp/bccp]
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";

interface Args {
  year?: number;
  outdir?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  // c:/tmp/bccp is a real Windows path — survives suspend/reboot unlike
  // /tmp which Git Bash / Cygwin can wipe on system events.
  const args: Args = { outdir: "c:/tmp/bccp" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--year") { args.year = Number(val); i++; }
    else if (flag === "--outdir") { args.outdir = val; i++; }
  }
  return args;
}

const UA = "HobbyIQ-Catalog-Scraper/0.1 (contact:dvabulas@outlook.com)";
const API = "https://baseballcardpedia.com/api.php";
const NON_BASEBALL = /\b(NFL|NBA|NHL|MLS|WNBA|Football|Basketball|Hockey|Soccer|Racing|NASCAR|PGA|Golf|UFC|MMA|Boxing|Wrestling|Tennis|Cricket|Rugby|F1|Formula[- ]1|Pokemon|Marvel|Star[- ]?Wars|Disney|Magic:? the Gathering|MTG)\b/i;
const SKIP_TITLES = /\b(Season Ticket Holders?|Signing Day|Autograph Day|Wrapper Redemption|Employee|Manager)\b/i;

async function fetchWikitext(page: string): Promise<string | null> {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext&redirects=1`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const j = (await res.json()) as { parse?: { wikitext?: { "*": string } }; error?: unknown };
  return j.parse?.wikitext?.["*"] ?? null;
}

async function fetchYearProductLinks(year: number): Promise<string[]> {
  const url = `${API}?action=parse&page=${year}&format=json&prop=links`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Year page ${year} HTTP ${res.status}`);
  const j = (await res.json()) as { parse?: { links?: Array<{ "*": string; ns?: number }> } };
  const links = j.parse?.links ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (l.ns !== undefined && l.ns !== 0) continue;
    const title = String(l["*"]);
    if (!title.startsWith(String(year))) continue;
    if (NON_BASEBALL.test(title)) continue;
    if (SKIP_TITLES.test(title)) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  out.sort();
  return out;
}

// --- product-page parser (kept in sync with scrape-bccp-product.ts) ---

interface Section { title: string; level: number; body: string; children: Section[]; }

function parseSections(wikitext: string): Section[] {
  const lines = wikitext.split("\n");
  const roots: Section[] = [];
  const stack: Section[] = [];
  let currentBody: string[] = [];
  const attach = (sec: Section): void => {
    while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) stack.pop();
    if (stack.length === 0) roots.push(sec); else stack[stack.length - 1].children.push(sec);
    stack.push(sec);
  };
  const flushBody = (): void => {
    if (stack.length > 0 && currentBody.length > 0) stack[stack.length - 1].body += currentBody.join("\n");
    currentBody = [];
  };
  for (const line of lines) {
    const m = /^(=+)\s*(.+?)\s*=+\s*$/.exec(line);
    if (m) { flushBody(); attach({ title: m[2], level: m[1].length, body: "", children: [] }); }
    else currentBody.push(line);
  }
  flushBody();
  return roots;
}

function findSectionByTitle(sections: Section[], title: string): Section | null {
  for (const s of sections) {
    if (s.title.toLowerCase() === title.toLowerCase()) return s;
    const child = findSectionByTitle(s.children, title);
    if (child) return child;
  }
  return null;
}

function extractBulletVariants(body: string): Array<{ name: string; printRun: number | null }> {
  const out: Array<{ name: string; printRun: number | null }> = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("*")) continue;
    const bullet = line.replace(/^\*+\s*/, "").trim();
    if (!bullet) continue;
    let printRun: number | null = null;
    let name = bullet;
    let m: RegExpMatchArray | null;
    m = bullet.match(/\((?:s[eiral]{4}l-numbered|numbered)\s+to\s+(\d[\d,]*)\s+copies?\)/i);
    if (m) { printRun = Number(m[1].replace(/,/g, "")); name = bullet.replace(m[0], "").trim(); }
    if (printRun === null) {
      m = bullet.match(/\/(\d[\d,]*)\b/);
      if (m) printRun = Number(m[1].replace(/,/g, ""));
    }
    if (printRun === null && /\b1\s*[-\/]?\s*of\s*[-\/]?\s*1\b/i.test(bullet)) printRun = 1;
    if (printRun === null && /\bone[- ]of[- ]one\b/i.test(bullet)) printRun = 1;
    if (printRun === null) {
      const wordMap: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      const wm = bullet.match(/\(s[eiral]{4}l-numbered\s+to\s+(one|two|three|four|five|six|seven|eight|nine|ten)\)/i);
      if (wm) printRun = wordMap[wm[1].toLowerCase()];
    }
    name = name.replace(/\[\[([^\|\]]+\|)?([^\]]+)\]\]/g, "$2").trim();
    name = name.replace(/[.:,\s]+$/, "");
    out.push({ name, printRun });
  }
  return out;
}

function extractCardPrefix(body: string): string | null {
  const m = body.match(/\b([A-Z0-9]{2,6})-[A-Z0-9]+\b/);
  return m ? m[1] : null;
}

interface Extracted {
  page: string;
  year: number;
  parallels: Array<{ section: string; name: string; printRun: number | null }>;
  inserts: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  autos: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  gameUsed: Array<{ name: string; cardPrefix: string | null }>;
  gimmicks: Array<{ name: string; cardPrefix: string | null }>;
  fetchedAt: string;
}

function extract(page: string, year: number, wikitext: string): Extracted {
  const sections = parseSections(wikitext);
  const out: Extracted = { page, year, parallels: [], inserts: [], autos: [], gameUsed: [], gimmicks: [], fetchedAt: new Date().toISOString() };
  const parallelsRoot = findSectionByTitle(sections, "Parallels");
  if (parallelsRoot) {
    for (const sub of parallelsRoot.children) for (const v of extractBulletVariants(sub.body)) out.parallels.push({ section: sub.title, ...v });
    for (const v of extractBulletVariants(parallelsRoot.body)) out.parallels.push({ section: "(root)", ...v });
  }
  // CF-BCCP-SUBSECTION-PARALLELS (2026-08-05). Insert / auto / game-used
  // subsections often carry their own parallel bullets ("Ascensions Blue
  // Refractor /150"). Previously only counted as parallelCount. Now
  // enumerate them and PUSH into out.parallels tagged with the subset
  // name so the match script can find them.
  const insertsRoot = findSectionByTitle(sections, "Inserts");
  if (insertsRoot) for (const sub of insertsRoot.children) {
    const variants = extractBulletVariants(sub.body);
    out.inserts.push({ name: sub.title, cardPrefix: extractCardPrefix(sub.body), parallelCount: variants.length });
    for (const v of variants) out.parallels.push({ section: sub.title, ...v });
  }
  const autosRoot = findSectionByTitle(sections, "Autographs");
  if (autosRoot) for (const sub of autosRoot.children) {
    const variants = extractBulletVariants(sub.body);
    out.autos.push({ name: sub.title, cardPrefix: extractCardPrefix(sub.body), parallelCount: variants.length });
    for (const v of variants) out.parallels.push({ section: sub.title, ...v });
  }
  const guRoot = findSectionByTitle(sections, "Autographed Game-Used") ?? findSectionByTitle(sections, "Game-Used");
  if (guRoot) for (const sub of guRoot.children) {
    const variants = extractBulletVariants(sub.body);
    out.gameUsed.push({ name: sub.title, cardPrefix: extractCardPrefix(sub.body) });
    for (const v of variants) out.parallels.push({ section: sub.title, ...v });
  }
  const checklistRoot = findSectionByTitle(sections, "Checklist");
  if (checklistRoot) for (const sub of checklistRoot.children) if (/gimmick/i.test(sub.title)) out.gimmicks.push({ name: sub.title, cardPrefix: extractCardPrefix(sub.body) });
  return out;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year || !Number.isFinite(args.year)) {
    console.error("Usage: scrape-bccp-year.ts --year YYYY [--outdir /tmp/bccp]");
    process.exit(2);
  }
  const year = args.year;
  const outDir = join(args.outdir ?? "/tmp/bccp", String(year));
  mkdirSync(outDir, { recursive: true });

  console.log(`▸ Fetching product index for ${year}...`);
  const products = await fetchYearProductLinks(year);
  console.log(`  ${products.length} candidate baseball products`);
  writeFileSync(join(outDir, "products.json"), JSON.stringify(products, null, 2));

  let ok = 0, fail = 0, empty = 0;
  const startedAt = Date.now();
  for (let i = 0; i < products.length; i++) {
    const page = products[i];
    const slug = slugify(page);
    try {
      const wt = await fetchWikitext(page);
      if (!wt) { fail++; console.log(`  ! ${page} — no wikitext`); }
      else {
        const data = extract(page, year, wt);
        writeFileSync(join(outDir, `${slug}.json`), JSON.stringify(data, null, 2));
        const nEmpty = (data.parallels.length + data.inserts.length + data.autos.length + data.gameUsed.length + data.gimmicks.length) === 0;
        if (nEmpty) { empty++; console.log(`  · ${page} — empty (no product sections)`); }
        else { ok++; }
      }
    } catch (err) {
      fail++;
      console.log(`  ! ${page} — ${(err as Error).message}`);
    }
    // Politeness pause between product fetches.
    await sleep(800);
    if ((i + 1) % 5 === 0 || i === products.length - 1) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  progress ${i + 1}/${products.length}  ok=${ok} empty=${empty} fail=${fail}  ${elapsed}s`);
    }
  }
  console.log(`\n▸ ${year} done — ok=${ok} empty=${empty} fail=${fail}, total ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
