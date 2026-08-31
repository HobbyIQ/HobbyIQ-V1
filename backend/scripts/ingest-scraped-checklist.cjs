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
  const byParallel = new Map();
  const rarityCounts = new Map();

  for (const row of rows) {
    // CF-CHECKLIST-VARIATION-IS-A-PARALLEL (Drew, 2026-08-25). The converter
    // now classifies each section by whether its card numbers already exist in
    // an anchor section, and writes the resulting rung into the CSV's parallel
    // column — so a Packfractor is a rung ON BCP-151 rather than a category
    // beside it. When the manifest says that column is authoritative, read it
    // instead of re-deriving a label from the category slug.
    //
    // Deriving from the slug is what produced parallels like "Chrome Prospect
    // Packfractor Autographs": the anchor's own name baked into the rung, a
    // slug no parsed sale title can ever match. The rung is "PackFractor".
    //
    // Opt-in, because the other scrapers' parallel columns mean something
    // different — the Pokemon checklists write "Normal" for the base tier,
    // which would slug to `normal` instead of `base` if read literally. Those
    // files carry no flag and keep the derivation below, unchanged.
    const cat = String(row.category || "").toLowerCase();
    let isAutoRow = false;
    let parallel = "Base";

    if (manifest.parallelColumnAuthoritative === true) {
      if (cat !== "base" && !cat.startsWith("insert-") && !cat.startsWith("auto-")) { skipped++; continue; }
      isAutoRow = cat.startsWith("auto-");
      // Blank is the honest value for a card list that never stated a finish;
      // normalizeParallel() already reads "" as the base tier.
      parallel = String(row.parallel || "").trim();
      if (cat === "base") base++;
      else if (cat.startsWith("insert-")) insertBase++;
      else autoBase++;
    } else {
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
    }

    const printRun = row.printRun && row.printRun.trim() ? Number(row.printRun) : null;
    // CF-RARITY-IS-NOT-A-PRINT-RUN (Drew ruling, 2026-08-30). `rarity` is an
    // OPTIONAL trailing column carrying a set-level production or odds
    // statement in the source's own words ("approximately 30,000 sets
    // produced", "1:12/packs"). It NEVER backfills printRun: a production
    // figure counts factory sets, a serial counts copies of one card. A file
    // written before the column existed simply has none, and blank stays
    // unknown. See backend/docs/reference/checklist-csv-contract.md.
    const rarity = row.rarity && row.rarity.trim() ? row.rarity.trim() : null;
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
      rarity,
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

    if (rarity) rarityCounts.set(rarity, (rarityCounts.get(rarity) ?? 0) + 1);
    if (preview.length < 8) preview.push(`${entry.id}  ${row.player}`);
    // A dry-run is only useful if it shows the rows it wants to create. Group
    // by the parallel actually derived so the ladder is readable at a glance,
    // and keep one worked example of each rung.
    const pk = `${entry.parallel || "(blank)"}${isAutoRow ? "  [auto]" : ""}`;
    if (!byParallel.has(pk)) byParallel.set(pk, { n: 0, eg: `${entry.id}   ${row.player}` });
    byParallel.get(pk).n++;

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
  // A dry-run is only worth running if it shows the rows it wants to create.
  // Grouping by the derived parallel makes the whole ladder readable at a
  // glance — a rung filed under the wrong name is obvious here and nowhere else.
  console.log(`\nproposed rows by parallel (${byParallel.size} distinct):`);
  for (const [k, v] of [...byParallel.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(v.n).padStart(5)}  ${k.padEnd(30)} e.g. ${v.eg}`);
  }
  // A dry-run must show what the optional rarity column would persist, or the
  // field is invisible until it is already in Cosmos.
  if (rarityCounts.size) {
    console.log(`
rarity statements (${rarityCounts.size} distinct) — DESCRIPTIVE, never printRun:`);
    for (const [k, n] of [...rarityCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)) {
      console.log(`  ${String(n).padStart(5)}  ${k}`);
    }
  } else {
    console.log(`
rarity statements: none in this file`);
  }
  console.log(`\n[done] base=${base} insert=${insertBase} auto=${autoBase} skipped=${skipped}`);
  if (APPLY) console.log(`  wrote=${wrote} failed=${failed}`);
  else console.log(`  (dry-run; total would-upsert=${base + insertBase + autoBase})`);
}
main().catch(e => { console.error(e); process.exit(1); });
