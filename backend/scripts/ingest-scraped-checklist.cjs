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
    // CF-CHECKLIST-SECTION-IS-THE-PARALLEL (Drew, 2026-08-13). This used to
    // hardcode parallel="Base" for EVERY category and only flip isAuto, so
    // every section of a set collapsed onto one slug. 2026 Bowman lists Justin
    // Gonzales three times:
    //
    //   auto-chrome-prospect-autographs             CPA-JG
    //   auto-chrome-prospect-gold-ink-autographs    CPA-JG
    //   auto-chrome-prospect-packfractor-autographs CPA-JG
    //
    // all three slugging to hiq:baseball:2026:bowman:cpa-jg:base:auto. The
    // checklist knows there are three distinct cards; the catalog stored one,
    // with each ingest overwriting the last. That is why "show me every auto
    // option for this player" cannot be answered from the catalog today, and
    // it applies to insert sections just as much as autographs.
    //
    // The section name IS the parallel. The converter already carries it in
    // the category slug (`auto-chrome-prospect-gold-ink-autographs`), so the
    // fix is to turn that back into a parallel label rather than discard it.
    // "Base Set" / "Chrome Prospects" style sections are the plain card and
    // stay "Base" — only genuinely distinct variants get their own parallel.
    const cat = String(row.category || "").toLowerCase();
    let isAutoRow = false;
    let parallel = "Base";

    // Sections that name the base card of their own numbering run, not a
    // variant of it. Anything else in an insert-/auto- category is a real,
    // separately-traded card and earns its own slug.
    const PLAIN_SECTION = /^(base[- ]?set|base|chrome[- ]prospects?|base[- ]prospects?|prospects?|chrome[- ]prospect[- ]autographs?|rookie[- ]autographs?|chrome[- ]rookie[- ]autographs?)$/;

    const sectionLabel = (slug) => slug
      .replace(/^(insert|auto)-/, "")
      .split("-").filter(Boolean)
      .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
      .join(" ");

    if (cat === "base") base++;
    else if (cat.startsWith("insert-")) {
      insertBase++;
      const label = sectionLabel(cat);
      if (!PLAIN_SECTION.test(label.toLowerCase())) parallel = label;
    } else if (cat.startsWith("auto-")) {
      autoBase++;
      isAutoRow = true;
      const label = sectionLabel(cat);
      if (!PLAIN_SECTION.test(label.toLowerCase())) parallel = label;
    } else { skipped++; continue; }

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
      // Provenance must name the real source. catalogVisibility tiers search
      // results by `source`, and stamping a Beckett checklist as
      // baseballcardpedia would make the row's origin unauditable. Defaults to
      // the historical label so existing callers are unchanged.
      source: `${process.env.SOURCE_LABEL || "baseballcardpedia"}-scraped-${new Date().toISOString().slice(0, 10)}`,
      confidence: 0.95,
      // A published checklist knows which product the card belongs to, so the
      // cardNumber-prefix repair for untrusted vendor text must not fire here.
      // Without this, 2026 Bowman CPA-AG (Adrian Gil) and 2026 Bowman Chrome
      // CPA-AG (Angeibel Gomez) collapse onto one slug. See
      // CF-AUTHORITATIVE-SETKEY.
      authoritativeSetKey: true,
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
