// CF-CHECKLIST-SCRAPER-TCDB (Drew, 2026-08-10). Backup checklist source
// when baseballcardpedia lacks a product. TCDB has broader multi-sport
// coverage but blocks bot user-agents by default — uses a
// browser-realistic User-Agent + Accept headers.
//
// TCDB URL pattern:
//   https://www.tcdb.com/Checklist.cfm/sid/{SID}/{slug}
// SID is TCDB's internal product ID. Not derivable from setKey alone —
// the driver needs to search TCDB first (Search.cfm) to resolve
// product name → SID.
//
// This scraper takes a full checklist URL and emits the same CSV format
// scrape-baseballcardpedia.cjs uses.
//
// Env:
//   TCDB_URL    required
//   SET_KEY     optional canonical hint
//   YEAR        optional
//   SPORT       default "baseball"

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// CF-TCDB-INSERT-CATEGORY (Drew, 2026-08-17). An insert set has its OWN
// numbering, so scraping 1995-96 Fleer - Class Encounters as category "base"
// would mint `hiq:basketball:1995:fleer:4:base:no-auto` and overwrite Fleer
// base #4 (Andrew Lang) with Class Encounters #4 — a different card entirely.
// ingest-scraped-checklist maps an `insert-<name>` category onto the parallel
// segment, which is how this codebase already models inserts and finishes.
//
// CF-ENV-READ-INSIDE-MAIN (2026-09-13). TCDB_URL/CATEGORY used to be read at
// module load with a bare `process.exit(2)` on the missing case — the same
// shape as #1985 (crons that died on AUTH_SESSION_SECRET before their own
// code ran). That made this file un-`require`-able for a test: loading it
// without TCDB_URL set killed the test process. Reads move inside main() /
// the functions that need them so the module can be required for its parsing
// surface with no env and no process.exit as a side effect.
function readEnv() {
  const TCDB_URL = process.env.TCDB_URL;
  if (!TCDB_URL) { throw new Error("TCDB_URL required"); }
  return {
    TCDB_URL,
    CATEGORY: process.env.CATEGORY || "base",
    YEAR: process.env.YEAR,
    SET_NAME: process.env.SET_NAME,
    SPORT: process.env.SPORT || "baseball",
    SET_KEY: process.env.SET_KEY || null,
  };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity", // don't ask for gzip; simplifies
  "Cache-Control": "no-cache",
};

// CF-TCDB-CURL-FALLBACK (Drew, 2026-08-17). TCDB answers node's https client
// with 403 on checklist pages while serving the identical URL to curl at 200
// with the full 172KB body — the browser-realistic User-Agent above is not
// enough, because what is being fingerprinted is the TLS handshake, not the
// header set. Rather than reproduce a browser's ClientHello, shell out to curl
// when the native client is refused. Verified 2026-08-17 on
// Checklist.cfm/sid/2346 (1995-96 Fleer): node 403, curl 200.
function fetchViaCurl(url) {
  const { execFileSync } = require("node:child_process");
  return execFileSync("curl", [
    "-sL", "--max-time", "60",
    "-A", UA,
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H", "Accept-Language: en-US,en;q=0.9",
    url,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function fetchHtml(url, depth = 0) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("too many redirects"));
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        return resolve(fetchHtml(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode === 403) {
        // Refused by fingerprint, not by policy — the same URL serves fine to
        // curl. Retry there before giving up on the page.
        try { return resolve(fetchViaCurl(url)); }
        catch { return reject(new Error(`HTTP 403 on ${url} (curl fallback also failed)`)); }
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function slugify(s) {
  return String(s || "").toLowerCase()
    .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function cleanPlayerName(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/\s*\([^)]+\)\s*$/, "").trim();
  s = s.replace(/^\s*-\s*/, "").trim();
  if (s.length < 2 || s.length > 80) return null;
  return s;
}

/**
 * CF-TCDB-CARD-NUMBER (2026-09-13, lifted unchanged from the pre-existing
 * anchor extractor / CF-TCDB-INITIALS-NUMBERS). Card numbers are frequently
 * HYPHENATED, especially on inserts: S-1, R-8, SS-3, and whole sets are
 * numbered by the player's INITIALS with no digit anywhere (BNR-AA..BNR-WB).
 * "#-VG" is a card number in full, where the # is not decoration. A bare word
 * with no digit and no hyphen ("Base", "More") is link text, not a number.
 */
function isCardNumber(text) {
  const num = String(text || "").replace(/^#(?=[A-Za-z0-9])/, "").trim();
  if (!/^#?[A-Za-z0-9]{0,8}(?:-[A-Za-z0-9]{1,8})?$/.test(num)) return false;
  if (!/[A-Za-z0-9]/.test(num)) return false;
  if (!/\d/.test(num) && !num.includes("-")) return false;
  return true;
}
function normalizeCardNumber(text) {
  return String(text || "").replace(/^#(?=[A-Za-z0-9])/, "").trim();
}

// CF-TCDB-ATTRIBUTE-TOKENS (2026-09-13). Found building the 2014 Panini
// Prizm FIFA World Cup file (PR #2105): TCDB's Combo Signatures rung states
// the row's autograph/print-run truth as trailing tokens on the NAME cell —
// "Bobby Charlton / Steven Gerrard AU, SN10" — not as separate columns.
// scrape-bcp-ladders already treats blank as unknown and never mints an auto
// unsigned (isAuto boundary is cardNumber-or-explicit-token, never inferred
// text per feedback_isauto_boundary_is_cardnumber_not_text); AU is exactly
// such an explicit token, stated per-rung, and SN<N> is that rung's serial
// print run, scoped to the cards it actually appears on — never carried over
// to a rung that didn't state it.
const ATTR_TOKEN_RE = /\s*[,/]?\s*\b(AU|SN(\d+))\b\s*/gi;

/**
 * Strip trailing AU / SNnnn tokens off a raw name-cell string and return the
 * cleaned name plus what was found. Tokens may appear in either order and
 * separated by a comma ("AU, SN10") — TCDB's own separator on this rung.
 */
function parseNameAttributes(raw) {
  let isAuto = false;
  let printRun = "";
  const cleaned = String(raw || "").replace(ATTR_TOKEN_RE, (_m, token, snDigits) => {
    if (/^AU$/i.test(token)) { isAuto = true; return " "; }
    if (snDigits) { printRun = snDigits; return " "; }
    return " ";
  }).replace(/\s+/g, " ").trim();
  return { name: cleaned, isAuto, printRun };
}

/**
 * Split a name cell into one or more player names. Multi-player cards
 * (Combo Signatures: "Bobby Charlton / Steven Gerrard") are real plain text
 * with no Person.cfm anchor at all — the "/" is TCDB's own separator, not a
 * hyphenated single name (player names never contain "/").
 */
function splitPlayers(name) {
  return String(name || "")
    .split("/")
    .map((s) => cleanPlayerName(s))
    .filter(Boolean);
}

/**
 * CF-TCDB-ROW-READER (2026-09-13). Replaces the Person.cfm-only anchor walk.
 *
 * A checklist row is a <tr> whose FIRST relevant anchor is a ViewCard.cfm
 * link carrying the card number as its text (thumbnail anchors wrap an <img>
 * and have no text — skipped). The row's name comes from the row's own name
 * cell, read three ways in order of preference:
 *
 *   1. One or more Person.cfm anchors (the common case: individual players).
 *   2. Plain text in the same row as a Team.cfm anchor, when there is no
 *      Person.cfm anchor at all — 2014 Prizm World Cup Team Photos renders
 *      "Algerie TC" as bare text with the Team.cfm link in the NEXT cell, not
 *      on the name itself. Reading Person.cfm only made every one of these
 *      rows (15 of 136 rungs on this product) emit zero cards.
 *   3. Plain text with no anchor of any kind and a "/" separator — Combo
 *      Signatures multi-player cards ("Bobby Charlton / Steven Gerrard AU,
 *      SN10"). AU/SN attribute tokens are parsed off this text; see
 *      parseNameAttributes.
 *
 * Reading the row's cells directly (rather than only chasing anchors) is what
 * makes cases 2 and 3 reachable at all — a page with zero Person.cfm links in
 * the whole row still has a name to read.
 */
function extractRowsFromPage($, rows, seen, category) {
  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const viewCardAnchors = $tr.find("a[href*='ViewCard.cfm']").filter((_, a) => $(a).text().trim().length > 0);
    if (viewCardAnchors.length === 0) return; // not a card row (header/pagination/chrome)

    const numText = $(viewCardAnchors.get(0)).text().trim();
    if (!isCardNumber(numText)) return;
    const cardNumber = normalizeCardNumber(numText);

    // The name cell is the <td> that holds the number anchor's LATER sibling
    // cells; walk every <td> in the row after the number cell looking for
    // Person.cfm anchors first, else fall back to the first non-empty plain
    // text td that is not itself the Team.cfm cell.
    const tds = $tr.find("td").toArray();
    const personAnchors = $tr.find("a[href*='Person.cfm']");

    let rawName = "";
    let fromAnchors = false;
    if (personAnchors.length > 0) {
      rawName = personAnchors.map((_, a) => $(a).text().trim()).get().join(" / ");
      fromAnchors = true;
    } else {
      // No Person.cfm anchor anywhere in the row (team card or multi-player
      // plain text). Find the name cell by scanning tds for the first one
      // that (a) is not the number cell, (b) has non-empty text, and (c) is
      // not itself the Team.cfm cell (which is a distinct, later column).
      for (const td of tds) {
        const $td = $(td);
        if ($td.find("a[href*='ViewCard.cfm']").length > 0) continue; // number/thumbnail cell
        if ($td.find("a[href*='Team.cfm']").length > 0) continue; // team column, not the name
        const text = $td.text().trim().replace(/\s+/g, " ");
        if (text) { rawName = text; break; }
      }
    }
    if (!rawName) return;

    const { name: attrStripped, isAuto, printRun } = parseNameAttributes(rawName);
    const players = fromAnchors
      ? attrStripped.split("/").map((s) => cleanPlayerName(s)).filter(Boolean)
      : splitPlayers(attrStripped);
    if (players.length === 0) return;

    const player = players.join(" / ").replace(/,/g, "");
    const key = `${cardNumber}|${player}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      category, cardNumber, parallel: "Base",
      isAuto: isAuto ? "true" : "false",
      printRun,
      player,
    });
  });
}

/**
 * CF-TCDB-PAGINATION-UNCONDITIONAL (2026-09-13). TCDB pages checklists at 100
 * rows (`?PageIndex=N`). The previous shipped version only walked pages
 * behind an empty-rows guard after a `<td>` grid-walk that TCDB's current
 * markup never matches (no `<th>` cells at all — headerText is always empty,
 * so that branch always ran in practice), which was fragile: any future page
 * shape that let the grid-walk match even a handful of decoy rows would have
 * skipped pagination and the row reader entirely, silently clipping at
 * whatever page 1 produced. Paging is now unconditional, and is the only
 * extraction path — the dead `<td>` grid-walk (CF-TCDB-ANCHOR-EXTRACTOR's
 * "table walk found nothing" fallback) is removed rather than kept as a
 * no-op branch.
 *
 * A single-page read gave 100 of the 2014 Prizm World Cup base set's 201
 * cards and clipped every 100+ parallel rung at the same boundary (PR #2105).
 * Walk PageIndex until a page adds nothing new, same stop condition as
 * before.
 */
async function fetchAllPages(url, category, fetchPage) {
  const rows = [];
  const seen = new Set();

  const html = await fetchPage(url);
  extractRowsFromPage(cheerio.load(html), rows, seen, category);

  for (let page = 2; page <= 40; page++) {
    const before = rows.length;
    const paged = `${url}${url.includes("?") ? "&" : "?"}PageIndex=${page}`;
    let nextHtml;
    try { nextHtml = await fetchPage(paged); }
    catch { break; }
    extractRowsFromPage(cheerio.load(nextHtml), rows, seen, category);
    if (rows.length === before) break;
    console.log(`  page ${page}: +${rows.length - before} (total ${rows.length})`);
  }
  return rows;
}

async function main(opts = {}) {
  const env = readEnv();
  const fetchPage = opts.fetchHtml || fetchHtml;
  console.log(`▸ scraping ${env.TCDB_URL}`);

  const firstHtml = await fetchPage(env.TCDB_URL);
  console.log(`  ${firstHtml.length} bytes`);
  const $ = cheerio.load(firstHtml);

  const urlName = decodeURIComponent(env.TCDB_URL.split("/").pop() || "").replace(/-/g, " ");
  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(urlName) || /\b(19\d{2}|20\d{2})\b/.exec($("title").text());
  const year = env.YEAR ? Number(env.YEAR) : yearMatch ? Number(yearMatch[1]) : null;
  const pageTitle = $("title").text().replace(/\|.*$/, "").trim();
  const setName = env.SET_NAME || pageTitle.replace(/^Checklist\s*[-:]?\s*/i, "").trim();
  const productKey = slugify(urlName);
  console.log(`  product: year=${year} setName="${setName}" productKey="${productKey}"`);

  const rows = await fetchAllPages(env.TCDB_URL, env.CATEGORY, fetchPage);
  console.log(`\n  extracted ${rows.length} rows`);

  const outDir = opts.outDir || path.join(__dirname, "..", "data", "checklists", "scraped");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `tcdb-${productKey}.csv`);
  const csvHeader = "category,cardNumber,parallel,isAuto,printRun,player\n";
  const csvBody = rows.map((r) => `${r.category},${r.cardNumber},${r.parallel},${r.isAuto},${r.printRun},${r.player}`).join("\n");
  fs.writeFileSync(outPath, csvHeader + csvBody + "\n");
  console.log(`  wrote ${outPath}`);

  const manifestPath = outPath.replace(/\.csv$/, ".manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    sourceUrl: env.TCDB_URL, source: "tcdb",
    sport: env.SPORT, year, setName, productKey,
    setKey: env.SET_KEY,
    rowCount: rows.length,
  }, null, 2));
  console.log(`  wrote ${manifestPath}`);
  return { rows, productKey, year, setName, outPath, manifestPath };
}

// The parsing surface is exported so pins can run it over saved fixtures
// without touching the network or process.env, and `main` is exported so a
// run can be driven over fixtures with `fetchHtml` injected — the COMMITTED
// emission path is what gets checked, not a reimplementation of it (same
// shape as scrape-bcp-ladders.cjs's runBcpLaddersOverFixtures.cjs helper).
module.exports = {
  main, readEnv,
  isCardNumber, normalizeCardNumber, cleanPlayerName,
  parseNameAttributes, splitPlayers,
  extractRowsFromPage, fetchAllPages,
  fetchHtml, slugify,
};

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
