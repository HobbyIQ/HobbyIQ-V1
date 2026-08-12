// CF-INGEST-SCRAPED-CHECKLIST (Drew, 2026-08-10). Take a scraped
// checklist CSV + manifest from scrape-baseballcardpedia.cjs and upsert
// card_catalog rows. Reuses the derive/upsert logic from the existing
// hand-curated ingest pipeline.
//
// Env:
//   CSV_PATH   required — path to scraped CSV (from scraper output)
//   APPLY=true — write to catalog (default dry-run)

const fs = require("fs");
const path = require("path");
const APPLY = process.env.APPLY === "true";
const CSV_PATH = process.env.CSV_PATH;
if (!CSV_PATH) { console.error("CSV_PATH required"); process.exit(2); }

const backend = path.resolve(__dirname, "..");
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.startsWith("#"));
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const parts = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    const r = {};
    header.forEach((h, i) => { r[h.trim()] = (parts[i] ?? "").trim(); });
    return r;
  });
}

async function main() {
  const csvPath = path.resolve(CSV_PATH);
  const manifestPath = csvPath.replace(/\.csv$/, ".manifest.json");
  if (!fs.existsSync(csvPath)) { console.error(`csv not found: ${csvPath}`); process.exit(1); }
  if (!fs.existsSync(manifestPath)) { console.error(`manifest not found: ${manifestPath}`); process.exit(1); }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  csv=${csvPath}  rows=${rows.length}`);
  console.log(`  product: ${manifest.setName} (${manifest.year}, ${manifest.sport})`);
  console.log(`  source URL: ${manifest.sourceUrl}`);

  let base = 0, insertBase = 0, autoBase = 0, wrote = 0, failed = 0, skipped = 0;
  const preview = [];

  for (const row of rows) {
    const cat = String(row.category || "").toLowerCase();
    let isAutoRow = false, parallel = "Base";
    if (cat === "base") base++;
    else if (cat.startsWith("insert-")) insertBase++;
    else if (cat.startsWith("auto-")) { autoBase++; isAutoRow = true; }
    else { skipped++; continue; }

    const printRun = row.printRun && row.printRun.trim() ? Number(row.printRun) : null;
    // Canonicalize setKey from manifest (setName is display-only; passing
    // it as setKey stores an un-normalized value that breaks setKey
    // filters even though the slug computation strips the year).
    const entry = deriveCatalogEntry({
      sport: manifest.sport,
      year: manifest.year,
      setKey: manifest.setKey || manifest.setName,
      cardNumber: row.cardNumber,
      parallel,
      isAuto: isAutoRow,
      printRun: Number.isFinite(printRun) && printRun > 0 ? printRun : null,
      playerName: row.player,
      source: `baseballcardpedia-scraped-${new Date().toISOString().slice(0, 10)}`,
      confidence: 0.95,
      vendorIds: {},
    });
    if (!entry) { skipped++; continue; }

    if (preview.length < 8) preview.push(`${entry.id}  ${row.player}`);

    if (APPLY) {
      try {
        const ok = await upsertCatalogEntry(entry);
        if (ok) wrote++; else failed++;
      } catch (e) {
        failed++;
        if (failed < 5) console.warn(`  fail ${entry.id}: ${e.message||e}`);
      }
    }
  }

  console.log(`\npreview:`);
  for (const p of preview) console.log(`  ${p}`);
  console.log(`\n[done] base=${base} insert=${insertBase} auto=${autoBase} skipped=${skipped}`);
  if (APPLY) console.log(`  wrote=${wrote} failed=${failed}`);
  else console.log(`  (dry-run; total would-upsert=${base + insertBase + autoBase})`);
}
main().catch(e => { console.error(e); process.exit(1); });
