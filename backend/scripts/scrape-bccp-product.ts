#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-BCCP-SCRAPE (Drew, 2026-08-04).
 *
 * Fetches a single baseballcardpedia product page via the MediaWiki API
 * and extracts structured data — parallels, inserts, autographs, and
 * their card-number prefixes. Output: JSON to stdout or a file.
 *
 * Design: MediaWiki wikitext is section-delimited by `=`, `==`, `===`
 * headers. Parallels/Inserts/Autographs sit under their own `==` sections
 * and each variant is a `===` subsection or a `*`-bullet line. Print runs
 * appear as "(serial-numbered to N copies)" or "N/N" tokens.
 *
 * Usage:
 *   npx tsx backend/scripts/scrape-bccp-product.ts \
 *     --page 2024_Bowman_Chrome [--out path/to/out.json]
 *
 * Politeness: 0.5 sec delay after each fetch (single-page script → one
 * fetch, but the orchestrator that loops products enforces this too).
 */

import { writeFileSync } from "fs";
import { setTimeout as sleep } from "timers/promises";

interface Args {
  page?: string;
  out?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--page") { args.page = val; i++; }
    else if (flag === "--out") { args.out = val; i++; }
  }
  return args;
}

const UA = "HobbyIQ-Catalog-Scraper/0.1 (contact:dvabulas@outlook.com)";
const API = "https://baseballcardpedia.com/api.php";

async function fetchWikitext(page: string): Promise<string> {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${page}`);
  const j = (await res.json()) as { parse?: { wikitext?: { "*": string } } };
  const wt = j.parse?.wikitext?.["*"];
  if (!wt) throw new Error(`No wikitext for ${page}`);
  return wt;
}

interface Section {
  title: string;
  level: number;   // 1 = `=Title=`, 2 = `==Title==`, 3 = `===Title===`
  body: string;
  children: Section[];
}

/** Turn a flat wikitext string into a nested-section tree. */
function parseSections(wikitext: string): Section[] {
  const lines = wikitext.split("\n");
  const roots: Section[] = [];
  const stack: Section[] = [];
  let currentBody: string[] = [];

  const attach = (sec: Section): void => {
    // Pop stack until we find a parent level < sec.level.
    while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) stack.pop();
    if (stack.length === 0) roots.push(sec);
    else stack[stack.length - 1].children.push(sec);
    stack.push(sec);
  };

  const flushBody = (): void => {
    if (stack.length > 0 && currentBody.length > 0) {
      stack[stack.length - 1].body += currentBody.join("\n");
    }
    currentBody = [];
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const m = /^(=+)\s*(.+?)\s*=+\s*$/.exec(line);
    if (m) {
      flushBody();
      const level = m[1].length;
      attach({ title: m[2], level, body: "", children: [] });
    } else {
      currentBody.push(line);
    }
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

/** Extract bulleted-list variants from a section's body. Each `*` line is
 *  one variant. We try to pull a print run out of "(serial-numbered to N
 *  copies)" or trailing " /N" tokens. Also handles the misspelling
 *  "seiral-numbered" seen in the sample. */
function extractBulletVariants(body: string): Array<{ name: string; printRun: number | null; raw: string }> {
  const out: Array<{ name: string; printRun: number | null; raw: string }> = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("*")) continue;
    const bullet = line.replace(/^\*+\s*/, "").trim();
    if (!bullet) continue;
    // Print-run patterns.
    let printRun: number | null = null;
    let name = bullet;
    let m: RegExpMatchArray | null;
    // Permissive to spelling variants: "serial-numbered", "seiral-numbered"
    // (r/i transposed — seen in the wild), "seiial-numbered" (typo).
    m = bullet.match(/\((?:s[eiral]{4}l-numbered|numbered)\s+to\s+(\d[\d,]*)\s+copies?\)/i);
    if (m) { printRun = Number(m[1].replace(/,/g, "")); name = bullet.replace(m[0], "").trim(); }
    if (printRun === null) {
      m = bullet.match(/\/(\d[\d,]*)\b/);
      if (m) { printRun = Number(m[1].replace(/,/g, "")); }
    }
    if (printRun === null && /\b1\s*[-\/]?\s*of\s*[-\/]?\s*1\b/i.test(bullet)) printRun = 1;
    if (printRun === null && /\bone[- ]of[- ]one\b/i.test(bullet)) printRun = 1;
    if (printRun === null) {
      // Written-word small numbers ("serial-numbered to five copies").
      const wordMap: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      const wm = bullet.match(/\(s[eiral]{4}l-numbered\s+to\s+(one|two|three|four|five|six|seven|eight|nine|ten)\)/i);
      if (wm) printRun = wordMap[wm[1].toLowerCase()];
    }
    // Strip wiki-link brackets [[...]] → text.
    name = name.replace(/\[\[([^\|\]]+\|)?([^\]]+)\]\]/g, "$2").trim();
    // Strip trailing punctuation.
    name = name.replace(/[.:,\s]+$/, "");
    out.push({ name, printRun, raw: bullet });
  }
  return out;
}

/** Extract card-number prefixes from a section body — most subset
 *  sections open with "cards numbered CPA-1 through CPA-100" or similar,
 *  or the wiki table rows begin with the prefix. Grab the first token
 *  matching /[A-Z0-9]+-[A-Z0-9]+/ per section. */
function extractCardPrefix(body: string): string | null {
  const m = body.match(/\b([A-Z0-9]{2,6})-[A-Z0-9]+\b/);
  return m ? m[1] : null;
}

interface Extracted {
  page: string;
  parallels: Array<{ section: string; name: string; printRun: number | null }>;
  inserts: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  autos: Array<{ name: string; cardPrefix: string | null; parallelCount: number }>;
  gameUsed: Array<{ name: string; cardPrefix: string | null }>;
  gimmicks: Array<{ name: string; cardPrefix: string | null }>;
  fetchedAt: string;
}

function extract(page: string, wikitext: string): Extracted {
  const sections = parseSections(wikitext);
  const out: Extracted = {
    page,
    parallels: [],
    inserts: [],
    autos: [],
    gameUsed: [],
    gimmicks: [],
    fetchedAt: new Date().toISOString(),
  };

  const parallelsRoot = findSectionByTitle(sections, "Parallels");
  if (parallelsRoot) {
    // Each child section (e.g. "Base Set Refractors", "Prospect Refractors")
    // contains bullet lines with parallel variants.
    for (const sub of parallelsRoot.children) {
      const variants = extractBulletVariants(sub.body);
      for (const v of variants) {
        out.parallels.push({ section: sub.title, name: v.name, printRun: v.printRun });
      }
    }
    // Some wiki pages put bullets directly under Parallels with no
    // sub-section (rare). Grab any top-level bullets too.
    const directVariants = extractBulletVariants(parallelsRoot.body);
    for (const v of directVariants) {
      out.parallels.push({ section: "(root)", name: v.name, printRun: v.printRun });
    }
  }

  // CF-BCCP-SUBSECTION-PARALLELS (2026-08-05). Insert / auto / game-used
  // subsections often carry their own parallel bullets — enumerate them
  // into out.parallels tagged with the subset name so the match script
  // can find them; still count them under inserts[].parallelCount for
  // the product-structure UI.
  const insertsRoot = findSectionByTitle(sections, "Inserts");
  if (insertsRoot) {
    for (const sub of insertsRoot.children) {
      const variants = extractBulletVariants(sub.body);
      out.inserts.push({
        name: sub.title,
        cardPrefix: extractCardPrefix(sub.body),
        parallelCount: variants.length,
      });
      for (const v of variants) out.parallels.push({ section: sub.title, name: v.name, printRun: v.printRun });
    }
  }

  const autosRoot = findSectionByTitle(sections, "Autographs");
  if (autosRoot) {
    for (const sub of autosRoot.children) {
      const variants = extractBulletVariants(sub.body);
      out.autos.push({
        name: sub.title,
        cardPrefix: extractCardPrefix(sub.body),
        parallelCount: variants.length,
      });
      for (const v of variants) out.parallels.push({ section: sub.title, name: v.name, printRun: v.printRun });
    }
  }

  const guRoot = findSectionByTitle(sections, "Autographed Game-Used") ?? findSectionByTitle(sections, "Game-Used");
  if (guRoot) {
    for (const sub of guRoot.children) {
      const variants = extractBulletVariants(sub.body);
      out.gameUsed.push({ name: sub.title, cardPrefix: extractCardPrefix(sub.body) });
      for (const v of variants) out.parallels.push({ section: sub.title, name: v.name, printRun: v.printRun });
    }
  }

  const checklistRoot = findSectionByTitle(sections, "Checklist");
  if (checklistRoot) {
    for (const sub of checklistRoot.children) {
      // Sub-sections like "Gimmicks", "Etched in Glass Gimmicks" are
      // gimmick subsets. "Base Set" and "Prospects" are handled as
      // base checklist chunks (recorded via cardPrefix on inserts loop).
      if (/gimmick/i.test(sub.title)) {
        out.gimmicks.push({ name: sub.title, cardPrefix: extractCardPrefix(sub.body) });
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.page) {
    console.error("Usage: scrape-bccp-product.ts --page <PageName> [--out file.json]");
    process.exit(2);
  }
  const wt = await fetchWikitext(args.page);
  const data = extract(args.page, wt);
  const json = JSON.stringify(data, null, 2);
  if (args.out) {
    writeFileSync(args.out, json);
    console.error(`Wrote ${args.out}`);
  } else {
    console.log(json);
  }
  // Polite pause (kept small since this is a single-page script — the
  // orchestrator loop enforces the real per-page rate limit).
  await sleep(200);
}

main().catch((e) => { console.error(e); process.exit(1); });
