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
const { computeHobbyIqCardId, normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
// CF-A-SECOND-INGESTER-IS-A-SECOND-SET-OF-RULES (2026-09-19). This script
// minted every row on `manifest.setKey` verbatim -- no insert-set separation,
// no id-collision guard, no unregistered-key refusal -- while
// ingest-checklist-csv-to-catalog.cjs, reading the SAME CSV contract, refuses
// on exactly those two things via lib/insert-set-key.cjs. Two ingesters
// disagreeing about what a row's ADDRESS is IS the defect
// CF-ONE-DERIVATION-OR-TWO-CENSUSES (in that module's own comments) exists to
// end, and it was live: a Beckett S3 Zenith Football conversion measured 646
// real id-collisions across 34 unregistered insert-set keys that this script's
// old code would have upserted over each other silently, one write per second
// on a shared source label. This is why "0 refused" from this script was never
// a green measurement -- there was no refusal path to trip.
//
// planFile is the SAME module ingest-checklist-csv-to-catalog.cjs calls, run
// here with the manifest's own setKey as the product key. A file with no
// same-numbered clash (the shape every HobbyMonitor product staged so far
// takes -- one set per file, one numbering run) computes `separate` as empty
// and plans every row onto the plain product key, UNCHANGED from what this
// script always did. Nothing here narrows what already worked; it only
// refuses what was silently colliding.
const INSERT_SET = require(path.join(__dirname, "lib", "insert-set-key.cjs"));

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

  // CF-A-SECOND-INGESTER-IS-A-SECOND-SET-OF-RULES. Measure the SAME address
  // every row below will compute, before writing a single one. `computeId`
  // mirrors this script's own per-row derivation (below) exactly enough for
  // the guard to agree with the write it is guarding: category ->
  // (parallel, isAuto), the one piece the two derivation branches disagree on.
  const productSetKey = String(manifest.setKey || manifest.setName || "").trim();
  const parallelColumnAuthoritative = manifest.parallelColumnAuthoritative === true;
  const PLAIN_SECTION_FOR_PLAN = /^(base[- ]?set|base|chrome[- ]prospects?|base[- ]prospects?|prospects?|chrome[- ]prospect[- ]autographs?|rookie[- ]autographs?|chrome[- ]rookie[- ]autographs?)$/;
  const sectionLabelForPlan = (slug) => slug
    .replace(/^(insert|auto)-/, "")
    .split("-").filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
  function planRowShape(row) {
    const cat = String(row.category || "").toLowerCase();
    if (parallelColumnAuthoritative) {
      return { category: cat, cardNumber: row.cardNumber, parallel: String(row.parallel || "").trim(), isAuto: cat.startsWith("auto-") };
    }
    let parallel = "";
    let isAuto = false;
    if (cat.startsWith("insert-")) {
      const label = sectionLabelForPlan(cat);
      if (!PLAIN_SECTION_FOR_PLAN.test(label.toLowerCase())) parallel = label;
    } else if (cat.startsWith("auto-")) {
      isAuto = true;
      const label = sectionLabelForPlan(cat);
      if (!PLAIN_SECTION_FOR_PLAN.test(label.toLowerCase())) parallel = label;
    }
    return { category: cat, cardNumber: row.cardNumber, parallel, isAuto };
  }
  const computeIdForPlan = (r) => computeHobbyIqCardId({
    sport: manifest.sport, year: manifest.year, setKey: r.setKey, cardNumber: r.cardNumber,
    parallel: r.parallel || "Base", isAuto: !!r.isAuto, printRun: null, authoritativeSetKey: true,
  });
  const planRows = rows.map(planRowShape).filter((r) => r.category === "base" || r.category.startsWith("insert-") || r.category.startsWith("auto-"));
  const plan = INSERT_SET.planFile({ rows: planRows, productSetKey, computeId: computeIdForPlan, normalize: normalizeSetKey });
  if (plan.verdict === "refuse") {
    console.error(`\n!! REFUSED ${csvPath} — ${plan.reason}`);
    if (plan.reason === "unregistered-set-keys") {
      console.error(`   ${plan.unregistered.length} insert-set key(s) this product needs are not yet normalizeSetKey fixed points:`);
      for (const u of plan.unregistered.slice(0, 20)) {
        console.error(`     ${u.setKey}  rows=${u.rows}  categories=${u.categories.slice(0, 2).join(", ")}${u.resolvesTo ? `  (resolves to "${u.resolvesTo}" -- would silently fold there, not refuse, if registered as-is)` : ""}`);
      }
      console.error(`   Register each in productSetKeys.ts + hobbyIqCardId.service.ts before re-running (see ingest-checklist-csv-to-catalog.cjs's own refusal for the pattern), then re-run.`);
    } else if (plan.reason === "id-collisions") {
      console.error(`   ${plan.collisions.length} address(es) claimed by more than one row:`);
      for (const c of plan.collisions.slice(0, 10)) console.error(INSERT_SET.formatCollision(c));
    }
    console.error(`   NO ROWS WRITTEN. The unit of refusal is the whole file -- a partial write here would leave some subsets minted on the flagship key and others not, indistinguishable from success.`);
    process.exit(1);
  }
  const finalIdFor = INSERT_SET.finalIdFor({ productSetKey, separate: plan.separate, foldRungs: plan.foldRungs }, computeIdForPlan);
  const setKeyFor = (row) => INSERT_SET.setKeyForRow({ productSetKey, category: String(row.category || "").toLowerCase(), parallel: row.parallel, subsetName: row.subsetName, separate: plan.separate, foldRungs: plan.foldRungs });

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
    // CF-A-SECOND-INGESTER-IS-A-SECOND-SET-OF-RULES. The plan already measured
    // this file at the top of main() and either refused or approved it. A
    // "pass" file's own `separate` set is, for the overwhelming majority of
    // staged checklists (one set per file, one numbering run — everything
    // HobbyMonitor has staged so far), EMPTY: setKeyFor then returns the plain
    // product key for every row, unchanged from what this script always
    // computed. Only a same-numbered clash moves a row onto its own
    // `<product>-<insert>` key, and only a measured colour rung's own name
    // rides the parallel axis instead of the key.
    const { setKey: rowSetKey } = setKeyFor({ category: cat, parallel, subsetName: row.subsetName });
    const rungFold = INSERT_SET.parallelForRow({ category: cat, parallel, subsetName: row.subsetName, foldRungs: plan.foldRungs });
    if (rungFold) parallel = rungFold;
    const entry = deriveCatalogEntry({
      sport: manifest.sport,
      year: manifest.year,
      setKey: rowSetKey || manifest.setKey || manifest.setName,
      // The publisher's own product name, so the row's search text and display
      // name lead with what a person would actually type. deriveCatalogEntry
      // builds both now (CF-DERIVE-BUILDS-ITS-OWN-SEARCH-FIELDS); without a
      // setName it still builds them from the setKey, so this improves the
      // wording rather than deciding whether the row is findable at all.
      setName: manifest.setName || null,
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
