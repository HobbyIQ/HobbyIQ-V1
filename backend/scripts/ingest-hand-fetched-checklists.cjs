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

// CF-INGEST-ACTUAL-PARALLELS (Drew, 2026-08-11). Manifest now supplies
// EITHER:
//   - baseParallels / prospectParallels / autoParallels inline (best),
//   - OR a `parallelsFile` pointing at a parallels-{product}.json in
//     the same dir (extracted from BCP/checklistinsider actuals).
// The old templated approach (baseTemplate/autoTemplate) was
// synthetic; actuals-only from here forward.

function loadParallels(manifest) {
  if (manifest.parallelsFile) {
    const p = path.join(DIR, manifest.parallelsFile);
    if (fs.existsSync(p)) {
      const doc = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        baseParallels: doc.baseParallels || [{ name: "Base", printRun: null }],
        prospectParallels: doc.prospectParallels || doc.baseParallels || [{ name: "Base", printRun: null }],
        autoParallels: doc.autoParallels || [{ name: "Base", printRun: null }],
      };
    }
  }
  return {
    baseParallels: manifest.baseParallels || [{ name: "Base", printRun: null }],
    prospectParallels: manifest.prospectParallels || manifest.baseParallels || [{ name: "Base", printRun: null }],
    autoParallels: manifest.autoParallels || [{ name: "Base", printRun: null }],
  };
}

async function ingestOne(manifest) {
  const stats = { attempted: 0, wrote: 0, failed: 0, skipped: 0 };
  const source = `${manifest.source || "hand-fetched"}-${manifest.fetchedAt || new Date().toISOString().slice(0, 10)}`;
  const parallelSet = loadParallels(manifest);

  const rows = [];
  for (const c of (manifest.baseSet || [])) rows.push({ ...c, category: "base", isAuto: false, parallels: parallelSet.baseParallels });
  for (const c of (manifest.chromeProspects || manifest.prospects || [])) rows.push({ ...c, category: "insert-chrome-prospects", isAuto: false, parallels: parallelSet.prospectParallels });
  for (const c of (manifest.autoSeries || [])) rows.push({ ...c, category: "auto-cpa", isAuto: true, parallels: parallelSet.autoParallels });
  for (const ins of (manifest.inserts || [])) {
    for (const c of (ins.cards || [])) rows.push({ ...c, category: `insert-${(ins.setName || "insert").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, isAuto: false, parallels: [{ name: "Base", printRun: null }] });
  }

  const exploded = [];
  for (const row of rows) {
    for (const par of row.parallels) {
      exploded.push({
        cardNumber: String(row.n).toUpperCase(),
        parallel: par.name,
        isAuto: row.isAuto,
        printRun: par.printRun,
        player: String(row.p).replace(/ - .+$/, "").trim(),
      });
    }
  }
  stats.attempted = exploded.length;

  // Batch write with progress
  let done = 0;
  for (const row of exploded) {
    // Prefer the canonical setKey from the manifest; fall back to setName
    // for older manifests that only carried the display name.
    const entry = deriveCatalogEntry({
      sport: manifest.sport, year: manifest.year,
      setKey: manifest.setKey || manifest.setName,
      cardNumber: row.cardNumber, parallel: row.parallel,
      isAuto: row.isAuto, printRun: row.printRun,
      playerName: row.player,
      source, confidence: 0.95, vendorIds: {},
      // CF-AUTHORITATIVE-SETKEY. A hand-fetched checklist names its own
      // product; the vendor cardNumber-prefix repair must not re-home it.
      authoritativeSetKey: true,
    });
    if (!entry) { stats.skipped++; continue; }
    if (APPLY) {
      try { await upsertCatalogEntry(entry); stats.wrote++; }
      catch (e) { stats.failed++; if (stats.failed < 3) console.warn(`   fail: ${e.message||e}`); }
    } else {
      stats.wrote++;
    }
    done++;
    if (done % 1000 === 0) process.stdout.write(`\r      ${done}/${exploded.length}`);
  }
  return stats;
}

async function main() {
  if (!fs.existsSync(DIR)) { console.error(`no dir ${DIR}`); process.exit(1); }
  // Exclude parallels-*.json — those are parallel-data files consumed by manifests, not manifests themselves.
  const files = fs.readdirSync(DIR).filter(f => f.endsWith(".json") && !f.startsWith("parallels-"));
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
