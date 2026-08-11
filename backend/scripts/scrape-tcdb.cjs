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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity", // don't ask for gzip; simplifies
  "Cache-Control": "no-cache",
};

function fetchHtml(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("too many redirects"));
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        return resolve(fetchHtml(new URL(res.headers.location, url).toString(), depth + 1));
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
        category: "base",
        cardNumber: num,
        parallel: "Base",
        isAuto: "false",
        printRun: "",
        player: player.replace(/,/g, ""),
      });
    });
  });

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
