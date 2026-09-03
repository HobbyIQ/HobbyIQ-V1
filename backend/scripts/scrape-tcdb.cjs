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

const https = require("https");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const TCDB_URL = process.env.TCDB_URL;
if (!TCDB_URL) { console.error("TCDB_URL required"); process.exit(2); }

// CF-TCDB-INSERT-CATEGORY (Drew, 2026-08-17). An insert set has its OWN
// numbering, so scraping 1995-96 Fleer - Class Encounters as category "base"
// would mint `hiq:basketball:1995:fleer:4:base:no-auto` and overwrite Fleer
// base #4 (Andrew Lang) with Class Encounters #4 — a different card entirely.
// ingest-scraped-checklist maps an `insert-<name>` category onto the parallel
// segment, which is how this codebase already models inserts and finishes.
const CATEGORY = process.env.CATEGORY || "base";

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
 * CF-TCDB-ANCHOR-EXTRACTOR (Drew, 2026-08-17). Pull card rows from the anchor
 * structure rather than a <td> grid — see the call site for why the grid walk
 * returns nothing. Appends into `rows`, deduping through `seen`.
 */
function extractAnchorRows($, rows, seen) {
  let pendingNum = null;
  let players = [];
  const flush = () => {
    if (pendingNum && players.length) {
      const player = players.join(" / ").replace(/,/g, "");
      const key = `${pendingNum}|${player}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push({
          category: CATEGORY, cardNumber: pendingNum, parallel: "Base",
          isAuto: "false", printRun: "", player,
        });
      }
    }
    pendingNum = null; players = [];
  };

  $("a").each((_, a) => {
    const href = String($(a).attr("href") || "");
    const text = $(a).text().trim().replace(/\s+/g, " ");
    if (/\/ViewCard\.cfm\//i.test(href)) {
      // Thumbnail anchors wrap an <img> and carry no text.
      if (!text) return;
      // Card numbers are frequently HYPHENATED, especially on inserts: S-1,
      // R-8, SS-3. An unhyphenated pattern silently drops the entire set —
      // Stackhouse's Scrapbook (all cards S-1..S-8) extracted 0 rows from a
      // page that had every card in it.
      //
      // CF-TCDB-INITIALS-NUMBERS (Drew, 2026-08-31): a card number need not
      // contain a digit. Whole sets are numbered by the player's INITIALS —
      // 2018 Bowman Chrome NSCC Wrapper Redemption is BNR-AA..BNR-WB, and
      // #BowmanTrending is "#-VG" where the # is part of the number, not a
      // decoration. Requiring a digit extracted 0 rows from a page holding
      // all 50 BNR cards, which is why those checklists were never ingested
      // and BNR-VGJ had no catalog row. Strip a LEADING number sign only
      // when something follows it that is not the hyphen — "#12" is card 12,
      // but "#-VG" is the card number in full.
      const num = text.replace(/^#(?=[A-Za-z0-9])/, "").trim();
      if (!/^#?[A-Za-z0-9]{0,8}(?:-[A-Za-z0-9]{1,8})?$/.test(num)) return;
      if (!/[A-Za-z0-9]/.test(num)) return;
      // A bare word with no digit and no hyphen is link text ("Base", "More"),
      // not a card number. Initials numbers always carry the separator.
      if (!/\d/.test(num) && !num.includes("-")) return;
      flush();
      pendingNum = num;
    } else if (/\/Person\.cfm\//i.test(href) && pendingNum) {
      const p = cleanPlayerName(text);
      if (p) players.push(p);
    }
  });
  flush();
}

async function main() {
  console.log(`▸ scraping ${TCDB_URL}`);
  const html = await fetchHtml(TCDB_URL);
  console.log(`  ${html.length} bytes`);
  const $ = cheerio.load(html);

  const urlName = decodeURIComponent(TCDB_URL.split("/").pop() || "").replace(/-/g, " ");
  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(urlName) || /\b(19\d{2}|20\d{2})\b/.exec($("title").text());
  const year = process.env.YEAR ? Number(process.env.YEAR) : yearMatch ? Number(yearMatch[1]) : null;
  const pageTitle = $("title").text().replace(/\|.*$/, "").trim();
  const setName = process.env.SET_NAME || pageTitle.replace(/^Checklist\s*[-:]?\s*/i, "").trim();
  const productKey = slugify(urlName);
  const sport = process.env.SPORT || "baseball";
  console.log(`  product: year=${year} setName="${setName}" productKey="${productKey}"`);

  // TCDB checklist page: player rows live in <tr> inside the main table.
  // Typical row shape (as of 2026):
  //   <tr><td>{cardNumber}</td><td><a>{playerName}</a></td><td>{team}</td>...</tr>
  // Header row identified by <th> cells.
  const rows = [];
  const seen = new Set();
  const sectionHeadingRe = /^(subset|insert|parallel|autograph|relic)/i;

  // Walk every table, then every row in it
  $("table").each((_, table) => {
    const $table = $(table);
    // Try to figure out if this is a checklist table (has thead with "Card"
    // + "Player" columns typically)
    const headerText = $table.find("th").map((_, th) => $(th).text().trim()).get().join(" | ").toLowerCase();
    if (!headerText.includes("card") && !headerText.includes("no")) return; // not a checklist table

    $table.find("tbody tr, tr").each((_, tr) => {
      const cells = $(tr).find("td").map((_, td) => $(td).text().trim().replace(/\s+/g, " ")).get();
      if (cells.length < 2) return;
      // First cell should be a card number (alphanumeric + optional letter suffix)
      const num = cells[0].replace(/^#/, "").trim();
      if (!/^[A-Z]{0,4}\d{1,4}[A-Za-z]?$/.test(num)) return;
      // Second cell = player (may contain team + notes)
      const player = cleanPlayerName(cells[1]);
      if (!player) return;
      const key = `${num}|${player}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        category: CATEGORY,
        cardNumber: num,
        parallel: "Base",
        isAuto: "false",
        printRun: "",
        player: player.replace(/,/g, ""),
      });
    });
  });

  // CF-TCDB-ANCHOR-EXTRACTOR (Drew, 2026-08-17). The table walk above assumes
  // <td>{number}</td><td>{player}</td>. TCDB does not render that any more —
  // a card row is a run of mostly-EMPTY <td> cells carrying anchors:
  //
  //   <a href="/ViewCard.cfm/sid/2346/cid/684317/1995-96-Fleer-22-Michael-Jordan">22</a>
  //   ... <a href="/Person.cfm/pid/7391/Michael-Jordan">Michael Jordan</a>
  //   ... <a href="/Team.cfm/tid/67/Chicago-Bulls">Chicago Bulls</a>
  //
  // so cells[0] is "" and cells[1] is "", and every row is skipped. On
  // 1995-96 Fleer that yielded 0 rows from a 161KB page holding all 350 cards.
  //
  // The anchors are the stable structure, so pair them directly: a ViewCard
  // link whose TEXT is the card number (the thumbnail links wrapping <img>
  // have empty text and are ignored), then the Person link(s) that follow it.
  // Multi-player cards keep both names rather than dropping one.
  if (rows.length === 0) {
    extractAnchorRows($, rows, seen);
    if (rows.length) console.log(`  (anchor extractor: table walk found nothing)`);

    // TCDB PAGINATES AT 100 CARDS. 1995-96 Fleer is 350 cards over 4 pages, so
    // stopping at page 1 silently delivers a 100-row "checklist" that looks
    // complete and quietly drops 250 cards — worse than no checklist, because
    // coverage maths would then trust it. Walk PageIndex until a page adds
    // nothing new.
    for (let page = 2; page <= 40; page++) {
      const before = rows.length;
      const paged = `${TCDB_URL}${TCDB_URL.includes("?") ? "&" : "?"}PageIndex=${page}`;
      let nextHtml;
      try { nextHtml = await fetchHtml(paged); }
      catch { break; }
      extractAnchorRows(cheerio.load(nextHtml), rows, seen);
      if (rows.length === before) break;
      console.log(`  page ${page}: +${rows.length - before} (total ${rows.length})`);
    }
  }

  console.log(`\n  extracted ${rows.length} rows`);

  const outDir = path.join(__dirname, "..", "data", "checklists", "scraped");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `tcdb-${productKey}.csv`);
  const csvHeader = "category,cardNumber,parallel,isAuto,printRun,player\n";
  const csvBody = rows.map((r) => `${r.category},${r.cardNumber},${r.parallel},${r.isAuto},${r.printRun},${r.player}`).join("\n");
  fs.writeFileSync(outPath, csvHeader + csvBody + "\n");
  console.log(`  wrote ${outPath}`);

  const manifestPath = outPath.replace(/\.csv$/, ".manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    sourceUrl: TCDB_URL, source: "tcdb",
    sport, year, setName, productKey,
    setKey: process.env.SET_KEY || null,
    rowCount: rows.length,
  }, null, 2));
  console.log(`  wrote ${manifestPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
