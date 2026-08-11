// CF-INGEST-HAND-FETCHED (Drew, 2026-08-11). Ingest checklists we
// manually pulled via WebFetch/WebSearch when BCP didn't cover them
// (2026 flagship products + non-baseball). Reads every JSON in
// backend/data/checklists/hand-fetched/ and upserts catalog rows.
//
// JSON schema:
//   {
//     sport, year, setKey, setName, source, sourceUrl, fetchedAt,
//     baseSet: [{n, p}],
//     chromeProspects?: [{n, p}],    // BCP-* cards
//     inserts?: [{setName, cards:[{n,p}]}],
//     prospects?: [{n, p}]           // alt name for chromeProspects
//   }
//
// Env: APPLY=true

const fs = require("fs");
const path = require("path");
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "cardCatalog.service.js"));

const APPLY = process.env.APPLY === "true";
const DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");

async function ingestOne(manifest) {
  const stats = { attempted: 0, wrote: 0, failed: 0, skipped: 0 };
  const source = `${manifest.source || "hand-fetched"}-${manifest.fetchedAt || new Date().toISOString().slice(0, 10)}`;

  const rows = [];
  for (const c of (manifest.baseSet || [])) rows.push({ ...c, category: "base" });
  for (const c of (manifest.chromeProspects || manifest.prospects || [])) rows.push({ ...c, category: "insert-chrome-prospects" });
  for (const ins of (manifest.inserts || [])) {
    for (const c of (ins.cards || [])) rows.push({ ...c, category: `insert-${(ins.setName || "insert").toLowerCase().replace(/[^a-z0-9]+/g, "-")}` });
  }

  for (const row of rows) {
    stats.attempted++;
    const entry = deriveCatalogEntry({
      sport: manifest.sport,
      year: manifest.year,
      setKey: manifest.setName,
      cardNumber: String(row.n).toUpperCase(),
      parallel: "Base",
      isAuto: false,
      printRun: null,
      playerName: String(row.p).replace(/ - .+$/, "").trim(), // strip trailing team ("Player - Team")
      source, confidence: "high",
      vendorIds: {},
    });
    if (!entry) { stats.skipped++; continue; }
    if (APPLY) {
      try { await upsertCatalogEntry(entry); stats.wrote++; }
      catch (e) { stats.failed++; if (stats.failed < 3) console.warn(`   fail: ${e.message||e}`); }
    } else {
      stats.wrote++;
    }
  }
  return stats;
}

async function main() {
  if (!fs.existsSync(DIR)) { console.error(`no dir ${DIR}`); process.exit(1); }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith(".json"));
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  files=${files.length}`);
  let total = 0, failed = 0;
  for (const f of files) {
    const manifest = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    console.log(`\n=== ${f} → ${manifest.year} ${manifest.setName} (${manifest.sport}) ===`);
    const stats = await ingestOne(manifest);
    console.log(`   ${APPLY ? "wrote" : "would write"}=${stats.wrote}  failed=${stats.failed}  skipped=${stats.skipped}`);
    total += stats.wrote; failed += stats.failed;
  }
  console.log(`\n[done] total ${APPLY ? "wrote" : "would-write"}=${total}  failed=${failed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
