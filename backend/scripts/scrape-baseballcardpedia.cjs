// CF-CHECKLIST-SCRAPER-BCP (Drew, 2026-08-10). Scrape baseballcardpedia
// product pages + emit canonical CSV that ingest-product-checklist.cjs
// consumes. Uses cheerio for proper HTML parsing.
//
// BCP structure (observed):
//   - Section headings: <h2>/<h3> with <span class="mw-headline"> child
//   - Checklist content lives in adjacent <ul>/<ol>/<table> until next heading
//   - Player entries take one of several shapes:
//     (a) "N. Player Name" inside <li>
//     (b) "N Player Name" (no dot) inside <li>
//     (c) Table row with cardNumber cell + player cell
//     (d) Pipe-separated inline text: "1: Player | 2: Player | ..."
//   - Print run in prose: "numbered to 1,500", "serial-numbered", etc.
//
// Env:
//   BCP_URL     required — full URL
//   SET_KEY     optional — canonical setKey hint (else derived from URL)
//   YEAR        optional — derived from URL if absent
//   SPORT       default "baseball"

const https = require("https");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const { variationFinishOfSection } = require("./lib/variationSections.cjs");
const BCP_URL = process.env.BCP_URL;
if (!BCP_URL) { console.error("BCP_URL required"); process.exit(2); }

function fetchHtml(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("too many redirects"));
    const req = https.get(url, { headers: { "User-Agent": "HobbyIQ-catalog-builder/1.0 (contact: drew@hobbyiq.app)" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchHtml(next, depth + 1));
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

// Compare two DOM nodes' document order by their offset in serialized HTML
function isAfter($, a, b) {
  const html = $.html();
  return html.indexOf($.html(a)) > html.indexOf($.html(b));
}

// Extract card entries from a single <ul>/<ol>/<table>/<p>.
// Modern BCP uses <li> or <tr>; vintage uses one <p> per card.
function extractPlayersFromList($, list) {
  const players = [];
  const seen = new Set();
  const tag = (list.tagName || list.name || "").toLowerCase();

  // Vintage <p> path: the whole element is ONE card entry
  if (tag === "p") {
    const t = $(list).text().trim().replace(/\s+/g, " ");
    // Same "N Player" regex as <li>. Guard against short/empty <p>.
    if (t.length < 3 || t.length > 200) return players;
    const m = /^([A-Z]{0,4}\d{1,4}[A-Za-z]?)[\.\)\s:]+([A-Za-z].{2,150})$/.exec(t);
    if (!m) return players;
    const num = m[1].trim();
    const player = cleanPlayerName(m[2]);
    if (player) players.push({ n: num, p: player });
    return players;
  }

  // Modern <li> path
  $(list).find("li").each((_, el) => {
    const t = $(el).text().trim().replace(/\s+/g, " ");
    const m = /^([A-Z]{0,4}\d{1,4}[A-Za-z]?)[\.\)\s:]+([A-Za-z].{2,80})$/.exec(t);
    if (!m) return;
    const num = m[1].trim();
    const player = cleanPlayerName(m[2]);
    if (!player) return;
    const key = `${num}|${player}`;
    if (seen.has(key)) return;
    seen.add(key);
    players.push({ n: num, p: player });
  });
  if (players.length > 0) return players;
  // <tr><td>N</td><td>Player</td>
  $(list).find("tr").each((_, el) => {
    const cells = $(el).find("td").map((_, c) => $(c).text().trim().replace(/\s+/g, " ")).get();
    if (cells.length < 2) return;
    const num = cells[0].replace(/^#/, "").trim();
    if (!/^[A-Z]{0,4}\d{1,4}[A-Za-z]?$/.test(num)) return;
    const player = cleanPlayerName(cells[1]);
    if (!player) return;
    players.push({ n: num, p: player });
  });
  return players;
}

function cleanPlayerName(raw) {
  let s = String(raw || "").trim();
  // Strip trailing metadata like "(SP)", "RC", team names in parens
  s = s.replace(/\s*\([^)]+\)\s*$/, "").trim();
  s = s.replace(/,+$/, "").trim();
  // CF-A-COMMA-BEFORE-JR-IS-NOT-A-TEAM (D33). This scraper wrote "Bobby Witt,
  // Jr." while the ladders scraper wrote "Bobby Witt" for the same card off
  // the same page, so the picker showed two players. Mirrors the canonical
  // cleanPlayerName (cardCatalog.service.ts).
  s = s.replace(/,\s+(Jr\.?|Sr\.?|I{2,3}|IV)$/i, " $1").trim();
  // Strip "Series One" / "Cards X-Y" / "Numbered to..." tail
  s = s.replace(/\s+(Series|Cards?|Numbered)\s+.*$/i, "").trim();
  if (s.length < 2 || s.length > 80) return null;
  return s;
}

function extractPrintRun(text) {
  const t = text.replace(/\s+/g, " ");
  const patterns = [
    /(?:numbered|serial\s*-?\s*numbered|limited)\s+to\s+([\d,]+)\s+(?:copies?)?/i,
    /(\d[\d,]{2,})\s+copies\s+each/i,
    /(?:print\s+run\s+of|out\s+of|of\s+only)\s+([\d,]+)/i,
    /\/(\d{1,5})\b/,
    /one[-\s]of[-\s]one/i,
  ];
  for (const p of patterns) {
    const m = p.exec(t);
    if (m) {
      if (m[0].toLowerCase().includes("one-of-one") || m[0].toLowerCase().includes("one of one")) return 1;
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 100000) return n;
    }
  }
  return null;
}

function classifySection(title) {
  const t = title.toLowerCase();
  if (/base\s*set|^checklist$|^base$|series\s*(one|two|1|2)/.test(t)) return { category: "base", subset: null };
  if (/^parallel/.test(t)) return null; // skip — parallels are metadata, not new cards
  if (/auto(graph)?/.test(t)) return { category: `auto-${slugify(title)}`, subset: title };
  return { category: `insert-${slugify(title)}`, subset: title };
}

async function main() {
  console.log(`▸ scraping ${BCP_URL}`);
  const html = await fetchHtml(BCP_URL);
  console.log(`  ${html.length} bytes`);
  const $ = cheerio.load(html);

  // Product hints from URL
  const urlName = decodeURIComponent(BCP_URL.split("/").pop() || "").replace(/_/g, " ");
  const yearMatch = /\b(\d{4})\b/.exec(urlName);
  const year = process.env.YEAR ? Number(process.env.YEAR) : yearMatch ? Number(yearMatch[1]) : null;
  const setName = urlName.replace(/^\d{4}\s+/, "").trim();
  const productKey = slugify(urlName);
  const sport = process.env.SPORT || "baseball";
  console.log(`  product: year=${year} setName="${setName}" sport=${sport} productKey="${productKey}"`);

  // Walk .mw-parser-output. For every <ul>/<ol>/<table>, determine the
  // MOST-RECENT preceding heading (any level) via document position.
  // That heading names the section the list belongs to. Extract card
  // rows from the list, classify by heading title.
  const $content = $(".mw-parser-output").first();
  if (!$content.length) { console.error("no .mw-parser-output found"); process.exit(1); }

  // Build a list of "heading anchors" in document order with their titles
  // and levels, and the ancestor chain (h2 > h3 > h4 > ...)
  const allHeadings = $content.find("h1, h2, h3, h4, h5").toArray();
  const rows = [];
  const sectionsReport = [];

  // Walk every <ul>, <ol>, <table>, AND <p> in .mw-parser-output.
  // CF-VINTAGE-P-TAGS (Drew, 2026-08-11). Vintage BCP pages (1968
  // Topps and older era) render each checklist card as a standalone
  // <p> paragraph ("1 N.L. Batting Leaders", "20 Brooks Robinson")
  // instead of <li> items. Fold those into the same section-attribution
  // walk. extractPlayersFromList understands <p> too via its fallback
  // "single-node text" path.
  const lists = $content.find("ul, ol, table, p").toArray();

  for (const list of lists) {
    // Find the nearest preceding heading anchor in document order
    let precedingHeading = null;
    let level = 0;
    for (const h of allHeadings) {
      // In cheerio, DOM position: use nextAll to compare
      if (isAfter($, h, list)) break;
      precedingHeading = h;
      level = Number($(h).prop("tagName").slice(1));
    }
    if (!precedingHeading) continue;

    // Build the section title breadcrumb: walk backward from
    // precedingHeading to find higher-level ancestors
    const breadcrumb = [];
    let curLevel = level;
    let seen = precedingHeading;
    for (let i = allHeadings.indexOf(precedingHeading); i >= 0; i--) {
      const h = allHeadings[i];
      const l = Number($(h).prop("tagName").slice(1));
      if (l <= curLevel) {
        breadcrumb.unshift($(h).text().replace(/\[.*?\]/g, "").trim());
        curLevel = l - 1;
        if (curLevel <= 0) break;
      }
    }
    const sectionTitle = breadcrumb.join(" > ");
    // Skip navigation/TOC noise
    if (/^(Contents|Description|Toggle|Navigation|Tools|Actions|General|Appearance|Retrieved from)/i.test(precedingHeading ? $(precedingHeading).text().trim() : "")) continue;

    const players = extractPlayersFromList($, list);
    if (players.length === 0) continue;

    // Classify by scanning breadcrumb TOP-DOWN for a category marker.
    // BCP nests "Base Set" under "Checklist" (h1), so a plain topLevel
    // check misses it.
    const joined = breadcrumb.join(" > ").toLowerCase();
    const leaf = breadcrumb[breadcrumb.length - 1] || "";
    let category = null;
    // Skip parallels-only sections entirely (they're metadata, not new
    // card entries; the same cardNumbers appear in the Base Set section)
    if (/\bparallels?\b/.test(joined)) continue;
    // CF-A-VARIATION-IS-A-CARD (D22). A "Variations" / "Image Variations" /
    // "SP Variations" heading lists the base set's variations: the same
    // numbers, a different card. It is a base-category section whose rows
    // carry the variation finish — never "Base", never skipped.
    const variationFinish = variationFinishOfSection(leaf);
    if (variationFinish) category = "base";
    else if (/\bbase\s*set\b/.test(joined)) category = "base";
    else if (/\bpromotional?\b|\bpromo\b/.test(joined)) category = `insert-promo`;
    else if (/\binserts?\b/.test(joined)) category = `insert-${slugify(leaf)}`;
    else if (/\bautographs?\b|\bauto\b/.test(joined)) category = `auto-${slugify(leaf)}`;
    if (!category) continue;

    const printRun = extractPrintRun($(list).text() + " " + $(precedingHeading).text());

    sectionsReport.push({ breadcrumb: sectionTitle, category, playerCount: players.length, printRun });

    for (const { n, p } of players) {
      if (!p) continue;
      rows.push({
        category,
        cardNumber: n,
        parallel: variationFinish ?? "Base",
        isAuto: category.startsWith("auto-") ? "true" : "false",
        printRun: printRun ?? "",
        player: p.replace(/,/g, ""),
      });
    }
  }

  console.log(`\nsection report:`);
  for (const s of sectionsReport) {
    console.log(`  [${s.category}] "${(s.breadcrumb||s.title||"").slice(0, 80)}": ${s.playerCount} card(s) printRun=${s.printRun ?? "?"}`);
  }
  console.log(`\ntotal rows: ${rows.length}`);

  const outDir = path.join(__dirname, "..", "data", "checklists", "scraped");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${productKey}.csv`);
  const csvHeader = "category,cardNumber,parallel,isAuto,printRun,player\n";
  const csvBody = rows.map((r) => `${r.category},${r.cardNumber},${r.parallel},${r.isAuto},${r.printRun},${r.player}`).join("\n");
  fs.writeFileSync(outPath, csvHeader + csvBody + "\n");
  console.log(`  wrote ${outPath}`);

  const manifestPath = outPath.replace(/\.csv$/, ".manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    sourceUrl: BCP_URL,
    sport, year, setName, productKey,
    setKey: process.env.SET_KEY || null,
    rowCount: rows.length,
    sectionsReport,
  }, null, 2));
  console.log(`  wrote ${manifestPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
