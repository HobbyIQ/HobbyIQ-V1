/**
 * Drive the COMMITTED emission path of scrape-bcp-ladders.cjs over saved
 * fixtures, so a pin asserts the CSV the scraper actually writes rather than a
 * reimplementation of its filters.
 *
 * The scraper reads OUT_DIR / TITLES from argv at module load and fetches over
 * the global `fetch`, so this runs as a SUBPROCESS: argv is set here and
 * `fetch` is stubbed to serve fixture files by page title. `main()` then runs
 * unmodified -- the range and player scoping in its emit loop is exactly what
 * produces the files the test reads back.
 *
 * Usage: node runBcpLaddersOverFixtures.cjs <outDir> <title=fixture> [...]
 */
const path = require("node:path");
const fs = require("node:fs");

const [, , outDir, ...pairs] = process.argv;
const byTitle = new Map();
for (const p of pairs) {
  const i = p.indexOf("=");
  byTitle.set(p.slice(0, i), path.resolve(__dirname, "../fixtures/bcp/" + p.slice(i + 1) + ".trimmed.html"));
}

// Serve the fixture whose title appears in the requested URL. Anything else is
// a 404, so a test can never silently reach the network.
globalThis.fetch = async (url) => {
  for (const [title, file] of byTitle) {
    if (String(url).includes(title)) {
      return { ok: true, status: 200, text: async () => fs.readFileSync(file, "utf8") };
    }
  }
  return { ok: false, status: 404, text: async () => "" };
};

process.argv = [process.argv[0], process.argv[1],
  "--titlesOnly=1",
  "--titles=" + [...byTitle.keys()].join(","),
  "--outDir=" + outDir,
  "--delayMs=0",
];

require(path.resolve(__dirname, "../../scripts/scrape-bcp-ladders.cjs"))
  .main()
  .catch((e) => { console.error("FATAL:", e && e.stack); process.exit(1); });
