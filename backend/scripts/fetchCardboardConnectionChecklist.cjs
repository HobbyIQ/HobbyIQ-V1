#!/usr/bin/env node
// CF-CARDBOARD-CONNECTION-SOURCE (Drew, 2026-08-13, pointing at
// cardboardconnection.com/2003-topps-baseball-cards and /2006-topps-baseball-cards
// and /2006-bowman-draft-picks-prospects-baseball).
//
// SECOND checklist source, for everything Beckett's S3 does not carry.
//
// Beckett is our only acquisition path and its uploads appear to start around
// 2014: 2023 Topps resolves as Series 1 / Series 2, but 2003, 2006 and 2013
// return nothing for ANY brand or naming variant we can spell. That is not a
// filename bug — the files are not there. Every pre-2014 seed in the queue
// (hundreds of them) hits the same wall, so vintage coverage is impossible
// without another source.
//
// Cardboard Connection publishes full card-by-card checklists as inline HTML:
//
//   Base Set Checklist
//   1 Alex Rodriguez
//   2 Dan Wilson
//   ...
//   Autographs Set Checklist
//   BDP1 Matt Kemp
//
// Emits the SAME CSV shape as convertBeckettChecklistXlsx
// (category,cardNumber,parallel,isAuto,printRun,player) so
// ingest-scraped-checklist.cjs consumes it unchanged and a fix in the ingest
// path benefits both sources.
//
//   node scripts/fetchCardboardConnectionChecklist.cjs \
//     --url https://www.cardboardconnection.com/2003-topps-baseball-cards \
//     --year 2003 --set-key topps --set-name "2003 Topps" --sport baseball \
//     --out data/checklists/scraped/2003-topps-baseball.csv
//
// Or let it build candidate URLs from the product:
//   node scripts/fetchCardboardConnectionChecklist.cjs --year 2006 --brand "Bowman Draft" --sport baseball --out ...

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const URL_IN = val("--url", "");
const YEAR = Number(val("--year", "0"));
const BRAND = val("--brand", "");
const SPORT = val("--sport", "baseball");
const OUT = val("--out", "");
const SET_KEY = val("--set-key", "");
const SET_NAME = val("--set-name", "");
const QUIET = args.includes("--quiet");

if (!OUT) { console.error("--out is required"); process.exit(2); }
if (!URL_IN && (!YEAR || !BRAND)) { console.error("need --url, or --year and --brand"); process.exit(2); }

const log = (...a) => { if (!QUIET) console.log(...a); };

function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error("too many redirects"));
    const req = https.get(url, {
      headers: {
        // Plain node default UA gets 403 from some CDNs.
        "User-Agent": "Mozilla/5.0 (compatible; HobbyIQ-checklist/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return resolve(get(next, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", "#8217": "'", "#8211": "-", "#8212": "-" };

/** HTML → newline-separated text. Block tags and <br> become line breaks so the
 *  checklist's visual line structure survives. */
function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|td)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&([a-z]+|#\d+);/gi, (m, e) => (ENTITIES[e.toLowerCase()] ?? m))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Mirrors convertBeckettChecklistXlsx.categoryFor so both sources classify
 *  identically — otherwise the same product ingested from two sources would
 *  produce two different category namespaces. */
function categoryFor(section) {
  const s = slug(section) || "unsectioned";
  if (/variation/i.test(section)) return `insert-${s}`;
  if (/^base set$/i.test(section.trim()) || /^base$/i.test(section.trim())) return "base";
  if (/autograph/i.test(section)) return `auto-${s}`;
  return `insert-${s}`;
}

/** "Base Set Checklist", "Prime Cuts Autograph Relics Set Checklist" */
const SECTION_RE = /^(.+?)\s+Set\s+Checklist\s*$/i;
/** "1 Alex Rodriguez", "BDP1 Matt Kemp", "DP95 Some Guy", "10a Foo Bar" */
const ROW_RE = /^([A-Z]{0,5}-?\d+[A-Za-z]?)\s+(.{2,80})$/;

/**
 * Cardboard Connection uses two heading styles. Some pages label sections
 * bare ("Base", "All-Stars"); others repeat the whole product on every one:
 *
 *   "2006 Bowman Draft Picks and Prospects Baseball Set Checklist"
 *   "2006 Bowman Draft Picks and Prospects Baseball Draft Picks Set Checklist"
 *
 * Left alone, the second style is actively wrong: the BASE set's label is the
 * product name, so categoryFor never matches /^base$/ and every base card was
 * filed as `insert-2006-bowman-draft-picks-prospects-baseball`. Card numbers
 * would resolve, but the base set would not be the base set.
 *
 * Strip the shared prefix rather than pattern-matching the product name, so it
 * works for any page: the longest word-wise common prefix across all section
 * labels IS the product title when there is one, and is empty when labels are
 * already bare. A section whose label is entirely prefix is the base set.
 */
function stripCommonPrefix(sections) {
  if (sections.length < 2) return new Map(sections.map((s) => [s, s]));
  const split = sections.map((s) => s.split(/\s+/));
  let n = 0;
  while (n < Math.min(...split.map((w) => w.length))) {
    const w = split[0][n];
    if (!split.every((words) => words[n].toLowerCase() === w.toLowerCase())) break;
    n++;
  }
  // Never strip everything from every label — that would erase all distinction.
  if (n === 0 || split.every((w) => w.length === n)) return new Map(sections.map((s) => [s, s]));
  return new Map(sections.map((s, i) => {
    const rest = split[i].slice(n).join(" ").trim();
    return [s, rest || "Base"];
  }));
}

/**
 * CF-BARE-CHECKLIST-HEADING (Drew, 2026-08-16: "see if we have them if not get
 * them").
 *
 * Vintage pages do not label their sections "<Product> Set Checklist" — they
 * carry a single bare "Checklist" heading. SECTION_RE never matched, `section`
 * stayed null, and the loop below dropped every row. 1987 Donruss reported
 * "parsed 0 rows" while serving 752 perfectly good ones, and the product sat on
 * the gap report at 0.65 coverage with its checklist one HTTP request away.
 */
const BARE_SECTION_RE = /^(checklist|base set|base)\s*:?\s*$/i;

/**
 * The star-rating widget renders as "5 Stars - Incredible Product", which is
 * exactly the shape of a card row and lands on numbers 1-5 — the most valuable
 * numbers in any set. Left in, 1987 Donruss #1 would carry both "Wally Joyner"
 * and "Star - Avoid this product like the plague".
 *
 * This is the whole junk yield of the looser heading rule, measured: 700 parsed
 * rows, 665 distinct numbers, 5 of them widget. Everything else duplicating is
 * the page printing its checklist twice (annotated "1 Wally Joyner - Diamond
 * Kings" and plain "1 Wally Joyner"), which dedup on ingest folds together.
 */
const RATING_WIDGET_RE = /^Stars?\s+-\s+/i;

function parse(lines) {
  const out = [];
  let section = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) { section = m[1].trim(); continue; }
    if (BARE_SECTION_RE.test(line)) { section = "Base"; continue; }
    if (!section) continue;
    const r = ROW_RE.exec(line);
    if (!r) continue;
    // A four-digit "card number" is the site's year navigation ("2026
    // Baseball"), never a card. Real numbers do not reach 1900. The existing
    // prose filters test the PLAYER for a year, so these walked straight
    // through the moment the heading rule stopped gating them.
    if (/^(19|20)\d{2}$/.test(r[1])) continue;
    const player = r[2].trim();
    if (RATING_WIDGET_RE.test(player)) continue;
    // Navigation and prose fragments start lowercase ("cards. Shop for sets on
    // eBay.", "days"). A player name or subset label never does.
    if (!/^[A-Z0-9]/.test(player)) continue;
    // Reject prose/navigation lines without rejecting real names.
    //
    // The first cut dropped anything ending in punctuation, which silently ate
    // every "Ken Griffey Jr." and "Cal Ripken Sr." — 2003 Topps parsed 712 base
    // cards against a known 720 (721 numbers, #7 retired for Mantle). Card
    // counts are the only cheap check we have on a scraper, so a filter that
    // quietly loses 8 real cards is worse than a few junk rows.
    //
    // Instead: bound the word count (names are short, prose is not) and reject
    // an embedded 4-digit year, which is what product/nav lines carry.
    if (/\d{4}/.test(player)) continue;
    // Multi-player cards are legitimately long — League Leaders run
    // "Pedro Martinez / Derek Lowe / Barry Zito LL" (8 words) when the page
    // spaces its slashes, while "A/B/C LL" is 4. A cap of 7 silently dropped
    // 341, 346 and 347 from 2003 Topps. 12 clears real multi-player cards and
    // still rejects prose.
    if (player.split(/\s+/).length > 12) continue;
    out.push({
      cardNumber: r[1],
      parallel: "Base",
      printRun: "",     // never guessed — same rule as the Beckett converter
      player,
      section,
    });
  }

  // Classify only once every section label is known, so the shared product
  // prefix can be removed first.
  const labels = stripCommonPrefix([...new Set(out.map((r) => r.section))]);
  for (const r of out) {
    r.section = labels.get(r.section) ?? r.section;
    r.category = categoryFor(r.section);
    r.isAuto = r.category.startsWith("auto-") ? "true" : "false";
  }
  return out;
}

function candidateUrls() {
  if (URL_IN) return [URL_IN];
  const b = slug(BRAND);
  const s = slug(SPORT);
  // Observed CC url shapes.
  return [
    `https://www.cardboardconnection.com/${YEAR}-${b}-${s}-cards`,
    `https://www.cardboardconnection.com/${YEAR}-${b}-${s}`,
  ];
}

(async () => {
  let html = null, used = null;
  for (const u of candidateUrls()) {
    try {
      log(`fetching ${u}`);
      html = await get(u);
      used = u;
      break;
    } catch (e) {
      log(`  ${e.message}`);
    }
  }
  if (!html) { console.error("no Cardboard Connection page resolved"); process.exit(1); }

  const rows = parse(htmlToLines(html));
  if (rows.length === 0) { console.error("parsed 0 rows — page format may have changed"); process.exit(1); }

  // Same duplicate guard as the Beckett converter: identical
  // category+number+player twice would upsert over itself and hide a parse bug.
  const seen = new Set();
  const kept = rows.filter((r) => {
    const k = `${r.category}|${r.cardNumber}|${r.player}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const bySection = {};
  for (const r of kept) bySection[r.section] = (bySection[r.section] ?? 0) + 1;

  const q = (s) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
  for (const r of kept) {
    csv.push([r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun, q(r.player)].join(","));
  }
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), csv.join("\n") + "\n");

  fs.writeFileSync(path.resolve(OUT).replace(/\.csv$/, ".manifest.json"), JSON.stringify({
    source: "cardboard-connection",
    sourceUrl: used,
    year: YEAR || null,
    setKey: SET_KEY || null,
    setName: SET_NAME || null,
    sport: SPORT,
    rows: kept.length,
    deduped: rows.length - kept.length,
    sections: bySection,
    fetchedAt: new Date().toISOString(),
  }, null, 2));

  log(`rows=${kept.length}  (deduped ${rows.length - kept.length})  sections=${Object.keys(bySection).length}`);
  for (const [s, n] of Object.entries(bySection).slice(0, 12)) log(`   ${String(n).padStart(5)}  ${s}`);
  log(`wrote ${OUT}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
