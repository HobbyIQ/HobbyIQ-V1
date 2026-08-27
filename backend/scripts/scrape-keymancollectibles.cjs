#!/usr/bin/env node
/**
 * CF-KEYMAN-IS-THE-VINTAGE-SOURCE (Drew, 2026-08-26).
 *
 * Every automated checklist source we have is modern-only:
 *
 *   cardboardconnection   DNS-dead since 2026-08-17 (was the broad first stop)
 *   hobbymonitor          live, modern only
 *   checklistinsider      live, modern only -- measured: baseball 2023-2026
 *   checklistcentral      live, 2024-2025 only, several sets "Coming Soon"
 *   beckett               live, XLSX -- the only vintage path, one set at a time
 *
 * keymancollectibles indexes roughly 200 year/set combinations spanning
 * 1921-2029: Bowman 1948-1955, Topps 1951-2026, Fleer 1959-2007, Donruss
 * 1981-2005, Upper Deck 1989-2019. That is the range where we currently have
 * no automated coverage at all.
 *
 * TWO PAGES PER SET. The set page is a summary -- 1952 Topps shows 5 key cards
 * and a card count -- and links to a printer-friendly page carrying the actual
 * 407 rows. Scraping the set page alone yields 5 cards and looks like a thin
 * checklist rather than the wrong page, so the checklist link is followed and
 * a set that never reaches one is reported, not silently emitted small.
 *
 * ROW FORMAT is `<cardNumber> <player> [flags]`:
 *
 *     1 Andy Pafko
 *     2 Pete Runnels RC
 *     20 Billy Loes RC SP
 *
 * Flags are the site's own glossary -- RC rookie, SP short print, DP double
 * print, ERR error, FTC first Topps card. They are stripped from the player
 * name and RC is kept as a rookie flag; leaving "RC" in the name would slug
 * "pete-runnels-rc" and never match a sale.
 *
 * OUTPUT IS THE ONE CANONICAL FORMAT, three files per set, matching what
 * backend/data/checklists/scraped/ already uses:
 *
 *   <productKey>.csv            category,cardNumber,parallel,isAuto,printRun,player
 *   <productKey>.manifest.json  sport, year, setName, setKey, rowCount, sectionsReport
 *
 * The parallel column is BLANK, never "Base". This source publishes base
 * checklists and says nothing about parallels; blank means "nobody told us",
 * and asserting "Base" would claim knowledge we do not have.
 *
 * STAGING ONLY. Nothing is written to Cosmos. Read a sample before ingesting.
 *
 * Usage:
 *   node backend/scripts/scrape-keymancollectibles.cjs \
 *     [--limit=N] [--delayMs=1500] [--outDir=C:/tmp/keyman]
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const ORIGIN = "https://www.keymancollectibles.com";
const INDEX = `${ORIGIN}/baseballcardchecklist.htm`;
const LIMIT = Number(arg("limit", "0")) || Infinity;
const DELAY_MS = Number(arg("delayMs", "1500"));
const OUT_DIR = arg("outDir", "C:/tmp/keyman");

const f = (n) => Number(n).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function get(url, tries = 3) {
  for (let a = 0; ; a++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "HobbyIQ-checklist-ingest/1.0" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (a >= tries) throw e;
      await sleep(1500 * (a + 1));
    }
  }
}

/**
 * The checklists are TABLES, and the number and player sit in SEPARATE cells:
 *
 *     <td>1</td><td>Andy Pafko</td><td>41</td><td>Bob Wellman</td>
 *
 * Stripping tags to lines therefore yields "1", "Andy Pafko", "41" on separate
 * lines and every row fails to parse -- which reads as "their page is empty"
 * rather than "we read it wrong". Pull the cells out IN ORDER and pair them.
 */
function cells(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const out = [];
  for (const m of body.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
    const text = m[1]
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#39;|&rsquo;|&apos;/gi, "'")
      .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
      .replace(/&eacute;/gi, "e")
      .replace(/\s+/g, " ")
      .trim();
    out.push(text);
  }
  return out;
}

/** Site glossary. Stripped from the player name; RC is kept as a flag. */
const FLAG = /\b(RC|SP|DP|ERR|COR|FTC|UER|VAR|HOR|IA|MVP|AS|LL|WS|CL|TC)\b/g;

/** A card number: numeric, optionally with a letter suffix (311a). */
const IS_NUM = (s) => /^\d{1,4}[A-Za-z]?$/.test(s);

/** Walk the cells pairing (number, player). */
function rowsFromCells(list) {
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    if (!IS_NUM(list[i])) continue;
    // The number and the name are NOT adjacent. Each row is laid out as
    //   <td>1</td><td><input type=checkbox></td><td>Andy Pafko</td><td></td>
    // so the cells arrive as ["1", "", "Andy Pafko", "", "41", ...] with a
    // tick-box column and a spacer between them. Demanding the very next cell
    // matches nothing and reports the page as empty -- which reads as "the
    // source has no checklist" rather than "we read the table wrong".
    let j = i + 1;
    while (j < list.length && list[j] === "") j++;
    if (j >= list.length) break;
    const raw = list[j];
    if (!raw || raw.length < 2 || raw.length > 80) continue;
    if (IS_NUM(raw)) continue;
    if (!/[A-Za-z]/.test(raw)) continue;
    const isRookie = /\bRC\b/.test(raw);
    const player = raw.replace(FLAG, "").replace(/\s+/g, " ").replace(/[,\-–—]\s*$/, "").trim();
    if (!player || player.length < 2 || !/[A-Za-z]{2}/.test(player)) continue;
    out.push({ cardNumber: list[i], player, isRookie });
    i = j;
  }
  return out;
}

/** Absolute URL for an href seen on `from`. */
function resolve(from, href) {
  try { return new URL(href, from).toString(); } catch { return null; }
}

function hrefs(html, from) {
  const out = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const u = resolve(from, m[1]);
    if (u && u.startsWith(ORIGIN)) out.push(u);
  }
  return out;
}

/** Year + set name from a checklist page's own title, falling back to the URL. */
function identify(html, url) {
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const src = t || url;
  const year = Number((src.match(/\b(19|20)\d{2}\b/) ?? [])[0]);
  let setName = t
    .replace(/\bbaseball\b/gi, " ")
    .replace(/\bcards?\b/gi, " ")
    .replace(/\bchecklists?\b/gi, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[|–—-].*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!setName) setName = path.basename(url, ".htm").replace(/(19|20)\d{2}/, "").replace(/baseballcard(s)?(checklist)?/i, "").trim();
  return { year: Number.isFinite(year) ? year : null, setName: setName || null };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`index: ${INDEX}`);
  const idx = await get(INDEX);
  if (!idx) { console.error("FATAL: index unreachable"); process.exit(1); }

  // Set pages live under /baseballcards/. Checklist pages are the ones we
  // want; the index links summary pages, so collect both shapes and dedupe.
  // .htm only -- the index links card IMAGES out of the same directory, and a
  // jpg url reports as "no checklist link" rather than as a bad filter. Drop
  // the index itself too: relative hrefs resolve back onto it.
  const links = [...new Set(hrefs(idx, INDEX)
    .filter((u) => /\/baseballcards\//i.test(u))
    .filter((u) => /\.html?$/i.test(u))
    .filter((u) => !/baseballcardchecklist\.htm$/i.test(u)))];
  console.log(`  ${f(links.length)} set links found\n`);

  let done = 0, written = 0, rows = 0, noChecklist = 0, empty = 0, failed = 0;
  const report = [];

  for (const setUrl of links) {
    if (done >= LIMIT) break;
    done++;
    try {
      // A page that already IS the checklist needs no second hop.
      let listUrl = /checklist\.htm$/i.test(setUrl) ? setUrl : null;
      let html = await get(setUrl);
      await sleep(DELAY_MS);
      if (!html) { failed++; continue; }

      if (!listUrl) {
        const cand = hrefs(html, setUrl).find((u) => /checklist\.htm$/i.test(u));
        if (!cand) {
          // The summary page shows a handful of key cards. Emitting those
          // would look like a small set rather than a missing checklist.
          noChecklist++;
          report.push({ url: setUrl, issue: "no printer-friendly checklist link" });
          continue;
        }
        listUrl = cand;
        html = await get(listUrl);
        await sleep(DELAY_MS);
        if (!html) { failed++; continue; }
      }

      const parsed = [];
      const seen = new Set();
      for (const r of rowsFromCells(cells(html))) {
        const k = `${r.cardNumber}|${r.player.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        parsed.push(r);
      }
      if (parsed.length < 10) { empty++; report.push({ url: listUrl, issue: `only ${parsed.length} rows parsed` }); continue; }

      const { year, setName } = identify(html, listUrl);
      const productKey = slugify(`${year ?? ""}-${setName ?? path.basename(listUrl, ".htm")}`);
      const setKey = slugify(setName ?? "");

      const q = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
      const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
      // parallel stays BLANK: this source publishes base checklists and says
      // nothing about parallels. Blank is "unknown", never "Base".
      for (const r of parsed) csv.push(["base", q(r.cardNumber), "", "false", "", q(r.player)].join(","));
      fs.writeFileSync(path.join(OUT_DIR, `${productKey}.csv`), csv.join("\n") + "\n");

      fs.writeFileSync(path.join(OUT_DIR, `${productKey}.manifest.json`), JSON.stringify({
        scrapedAt: new Date().toISOString(),
        sourceUrl: listUrl,
        sport: "baseball",
        year,
        setName,
        productKey,
        setKey,
        rowCount: parsed.length,
        rookieCount: parsed.filter((r) => r.isRookie).length,
        sectionsReport: [{ breadcrumb: `Checklist > ${setName ?? "?"}`, category: "base", playerCount: parsed.length, printRun: null }],
      }, null, 1) + "\n");

      written++; rows += parsed.length;
      process.stderr.write(`\r  ${done}/${links.length}  sets=${written} rows=${f(rows)}   `);
    } catch (e) {
      failed++;
      report.push({ url: setUrl, issue: String(e.message ?? e).slice(0, 90) });
    }
  }
  process.stderr.write("\n");

  console.log(`\npages visited            ${f(done)}`);
  console.log(`  checklists written     ${f(written)}`);
  console.log(`  card rows              ${f(rows)}`);
  console.log(`  no checklist link      ${f(noChecklist)}   <- summary page only, needs a look`);
  console.log(`  parsed under 10 rows   ${f(empty)}   <- our parser, not their gap`);
  console.log(`  failed                 ${f(failed)}`);
  console.log(`\n  format: category,cardNumber,parallel,isAuto,printRun,player`);
  console.log(`  staged to ${OUT_DIR} — STAGING ONLY, nothing written to Cosmos`);
  if (report.length) {
    fs.writeFileSync(path.join(OUT_DIR, "_diagnostics.json"), JSON.stringify(report, null, 1) + "\n");
    console.log(`  ${f(report.length)} diagnostics -> ${path.join(OUT_DIR, "_diagnostics.json")}`);
  }
}

module.exports = { cells, rowsFromCells, identify, IS_NUM };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
}
