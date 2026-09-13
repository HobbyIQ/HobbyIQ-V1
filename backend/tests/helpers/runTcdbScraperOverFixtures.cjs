/**
 * Drive the COMMITTED emission path of scrape-tcdb.cjs over saved fixtures, so
 * a pin asserts the CSV the scraper actually writes rather than a
 * reimplementation of its pagination / row-reading logic.
 *
 * scrape-tcdb.cjs's main() takes an injectable `fetchHtml` (see
 * CF-ENV-READ-INSIDE-MAIN / module.exports in the scraper) rather than
 * requiring a subprocess + global fetch stub the way scrape-bcp-ladders.cjs
 * does — this runs in-process. TCDB_URL / CATEGORY / SET_KEY / SPORT are read
 * from process.env inside main(), so they're set here before calling it.
 *
 * Usage: node runTcdbScraperOverFixtures.cjs <outDir> <url> <category>
 *          <page1Fixture> [<page2Fixture> <page3Fixture> ...]
 *
 * Fixtures are looked up under ../fixtures/tcdb/<name>.trimmed.html. Any
 * fixture beyond the first is served for ?PageIndex=2, ?PageIndex=3, ... in
 * order; a PageIndex beyond what was supplied 404s, so a test can never
 * silently paginate past its own fixtures.
 */
const path = require("node:path");
const fs = require("node:fs");

const [, , outDir, url, category, ...fixtureNames] = process.argv;
if (!outDir || !url || !category || fixtureNames.length === 0) {
  console.error("usage: runTcdbScraperOverFixtures.cjs <outDir> <url> <category> <fixture1> [<fixture2> ...]");
  process.exit(2);
}

const fixturePath = (name) => path.resolve(__dirname, "../fixtures/tcdb", `${name}.trimmed.html`);
const pageHtml = fixtureNames.map((name) => fs.readFileSync(fixturePath(name), "utf8"));

async function fetchHtml(requestedUrl) {
  const m = /[?&]PageIndex=(\d+)/.exec(requestedUrl);
  const pageIndex = m ? Number(m[1]) : 1;
  const html = pageHtml[pageIndex - 1];
  if (html === undefined) throw new Error(`no fixture supplied for PageIndex=${pageIndex} (${requestedUrl})`);
  return html;
}

process.env.TCDB_URL = url;
process.env.CATEGORY = category;

const scraper = require(path.resolve(__dirname, "../../scripts/scrape-tcdb.cjs"));

scraper.main({ fetchHtml, outDir })
  .then((result) => {
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({
      rows: result.rows.length, productKey: result.productKey, year: result.year, setName: result.setName,
    }, null, 2));
  })
  .catch((e) => { console.error("FATAL:", e && e.stack); process.exit(1); });
