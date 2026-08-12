// CF-SCRAPE-TCDB-BBM (Drew, 2026-08-11). Scrapes TCDB's BBM checklist
// pages for 1991-2026 coverage the sportsclick.jp PDFs don't reach.
//
// ⚠️  TOS NOTE: TCDB terms of service generally prohibit systematic
// automated data extraction. Drew explicitly authorized this pass to
// close the pre-2016 BBM coverage gap. Runs at 1 req/sec to be
// respectful of their infra; skips sets already scraped (idempotent).
//
// Strategy:
//   1. Read tcdb-bbm-sets.json (produced by manual curl + regex).
//   2. For each set, fetch Checklist.cfm/sid/{sid}?PageIndex=1..N.
//   3. Extract cards via regex on /ViewCard.cfm URLs (the URL slug
//      contains year, setKey, cardNumber, playerName — no HTML parse
//      needed).
//   4. Emit hand-fetched manifest per set.
//
// Env:
//   INPUT_FILE=path/to/tcdb-bbm-sets.json
//   OUT_DIR=path/to/hand-fetched
//   SLEEP_MS=1000
//   MAX_SETS=0  cap for smoke tests (0 = all)
//   YEAR_MIN=0  YEAR_MAX=0  optional year range filter

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const INPUT = process.env.INPUT_FILE || "C:/Users/dvabu/AppData/Local/Temp/claude/c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1/44ed1a3b-f8bb-43c5-948b-2d23cfb9d8f7/scratchpad/tcdb-bbm-sets.json";
const OUT_DIR = process.env.OUT_DIR || path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");
const SLEEP_MS = Number(process.env.SLEEP_MS || 1000);
const MAX_SETS = Number(process.env.MAX_SETS || 0);
const YEAR_MIN = Number(process.env.YEAR_MIN || 0);
const YEAR_MAX = Number(process.env.YEAR_MAX || 0);
const SCRATCH = path.dirname(INPUT);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(sid, slug, page) {
  // CF-TCDB-SLUG-REQUIRED (Drew, 2026-08-11). Without the /Name-Slug/
  // suffix TCDB redirects to /DefaultError404.html. The slug is
  // freeform (they don't validate content) but must be present.
  const url = `https://www.tcdb.com/Checklist.cfm/sid/${sid}/${slug}?PageIndex=${page}`;
  const dest = `${SCRATCH}/tcdb-scrape-${sid}-p${page}.html`;
  execSync(
    `curl -sf --max-time 30 -o "${dest}" -H "User-Agent: ${UA}" -H "Accept: text/html" "${url}"`,
    { stdio: "pipe" }
  );
  return fs.readFileSync(dest, "utf8");
}

function extractCards(html, expectedYear) {
  const re = /\/ViewCard\.cfm\/sid\/(\d+)\/cid\/(\d+)\/([A-Za-z0-9\-]+)/g;
  const cards = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[3];
    // Slug format: {year}-{setKey}-{cardNumber}-{playerName}
    const sm = /^(\d{4})-(.+?)-([A-Za-z0-9]+)-(.+)$/.exec(slug);
    if (!sm) continue;
    const [_, y, _setKey, cardNum, playerRaw] = sm;
    if (Number(y) !== expectedYear) continue; // skip cross-links
    const player = playerRaw.replace(/-/g, " ").trim();
    cards.set(m[2], { n: cardNum, p: player });
  }
  return [...cards.values()];
}

function slugifySetName(slug) {
  // Slug like "2011-BBM" or "2013-BBM-Genesis" or "2011-BBM-Golden-Age-88"
  const parts = slug.split("-");
  if (parts.length < 2) return "bbm";
  // Drop year, join rest as setKey
  const setNameParts = parts.slice(1);
  return "bbm-" + setNameParts.slice(1).join("-").toLowerCase().replace(/[^a-z0-9\-]/g, "");
}

async function scrapeSet(set) {
  const outPath = `${OUT_DIR}/${set.year}-tcdb-${set.slug.toLowerCase()}.json`;
  if (fs.existsSync(outPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(outPath, "utf8"));
      if ((doc.baseSet?.length || 0) > 0) return { skipped: true, cardCount: doc.baseSet.length };
    } catch {}
  }
  const cards = new Map();
  for (let page = 1; page <= 20; page++) {
    let html;
    try { html = await fetchPage(set.sid, set.slug, page); }
    catch (e) { return { error: `page ${page}: ${e.message.slice(0, 80)}` }; }
    const found = extractCards(html, set.year);
    if (found.length === 0) break;
    for (const c of found) cards.set(c.n, c);
    // Check if this was the last page (page number links go up to N)
    const maxPage = Math.max(...([...html.matchAll(/PageIndex=(\d+)/g)].map(x => Number(x[1])).concat([1])));
    if (page >= maxPage) break;
    await sleep(SLEEP_MS);
  }
  const baseSet = [...cards.values()];
  const setKey = slugifySetName(set.slug);
  const setNameHuman = set.slug.replace(/-/g, " ");
  const manifest = {
    sport: "baseball",
    year: set.year,
    setKey,
    setName: setNameHuman,
    source: "tcdb",
    sourceUrl: `https://www.tcdb.com/ViewSet.cfm/sid/${set.sid}`,
    fetchedAt: new Date().toISOString().slice(0, 10),
    note: "Scraped from TCDB HTML via URL-slug regex. Player names romanized/anglicized as TCDB stores them.",
    baseSet,
  };
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  return { cardCount: baseSet.length };
}

async function main() {
  const sets = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  const filtered = sets.filter(s => {
    if (YEAR_MIN && s.year < YEAR_MIN) return false;
    if (YEAR_MAX && s.year > YEAR_MAX) return false;
    return true;
  });
  const target = MAX_SETS ? filtered.slice(0, MAX_SETS) : filtered;
  console.log(`▸ scraping ${target.length} sets (of ${sets.length} total, year filter ${YEAR_MIN || "any"}..${YEAR_MAX || "any"})`);
  console.log(`  sleep=${SLEEP_MS}ms  out=${OUT_DIR}`);
  const t0 = Date.now();
  let ok = 0, skipped = 0, empty = 0, failed = 0, totalCards = 0;
  for (let i = 0; i < target.length; i++) {
    const s = target[i];
    try {
      const r = await scrapeSet(s);
      if (r.skipped) skipped++;
      else if (r.error) { failed++; console.log(`  ✗ ${s.year} sid=${s.sid} ${r.error}`); }
      else if (!r.cardCount) empty++;
      else { ok++; totalCards += r.cardCount; }
    } catch (e) { failed++; }
    if ((i + 1) % 25 === 0 || i === target.length - 1) {
      const dur = ((Date.now()-t0)/1000).toFixed(0);
      console.log(`  ${i+1}/${target.length}  ok=${ok} skipped=${skipped} empty=${empty} failed=${failed}  cards=${totalCards.toLocaleString()}  ${dur}s`);
    }
    if (!MAX_SETS || i < target.length - 1) await sleep(SLEEP_MS);
  }
  const dur = ((Date.now()-t0)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] ok=${ok}  skipped=${skipped}  empty=${empty}  failed=${failed}  totalCards=${totalCards.toLocaleString()}`);
}
main().catch(e => { console.error(e); process.exit(1); });
