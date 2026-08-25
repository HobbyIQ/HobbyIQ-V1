#!/usr/bin/env node
/**
 * CF-ONE-CHECKLIST-FORMAT (Drew, 2026-08-25: "the entire checklist to be in the
 * same format with the sales matching to the catalog").
 *
 * Every scraped checklist CSV has the same COLUMNS but not the same MEANING.
 * Three conventions are in the corpus today:
 *
 *   Beckett (post CF-CHECKLIST-VARIATION-IS-A-PARALLEL)
 *       parallel column is the truth; blank means "the source never said".
 *   baseballcardpedia / tcdb
 *       parallel is the literal string "Base" on every row, and the real
 *       parallel is hidden in the category slug for the ingester to rebuild.
 *   Pokemon
 *       parallel is "Normal" / "Holofoil" / "Reverse Holofoil".
 *
 * So ingest-scraped-checklist.cjs needs a branch per convention, and a reader
 * cannot tell from the file what a row means. This migration makes the parallel
 * column authoritative EVERYWHERE by materialising into the file exactly what
 * the ingester used to derive at read time.
 *
 * IT MUST NOT CHANGE A SINGLE SLUG. The derived label is load-bearing: every
 * tcdb-1995-96-fleer-* file shares setKey "fleer", so "Total O" in the parallel
 * is the only thing separating Total O #1 from Total D #1 and from base #1.
 * Blanking those would collapse four different cards onto one slug. This script
 * therefore computes each row's slug BOTH ways and refuses to write unless they
 * match, except where a variation deliberately folds onto its anchor.
 *
 * Env:
 *   APPLY=true   write the files (default: report only)
 *   ONLY=<name>  restrict to one csv basename
 */
const fs = require("fs");
const path = require("path");

const APPLY = process.env.APPLY === "true";
const ONLY = process.env.ONLY || "";
const backend = path.resolve(__dirname, "..");
const DIR = path.join(backend, "data/checklists/scraped");

const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const conv = require(path.join(backend, "scripts/convertBeckettChecklistXlsx.cjs"));

// ---- the legacy read-time derivation, copied verbatim so the comparison is
// against what the ingester ACTUALLY did, not against a tidied-up version.
const PLAIN_SECTION = /^(base[- ]?set|base|chrome[- ]prospects?|base[- ]prospects?|prospects?|chrome[- ]prospect[- ]autographs?|rookie[- ]autographs?|chrome[- ]rookie[- ]autographs?)$/;
const sectionLabel = (slug) => slug
  .replace(/^(insert|auto)-/, "")
  .split("-").filter(Boolean)
  .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
  .join(" ");

function legacyParallel(cat) {
  let parallel = "Base";
  let isAuto = false;
  if (cat === "base") return { parallel, isAuto };
  if (cat.startsWith("insert-")) {
    const label = sectionLabel(cat);
    if (!PLAIN_SECTION.test(label.toLowerCase())) parallel = label;
  } else if (cat.startsWith("auto-")) {
    isAuto = true;
    const label = sectionLabel(cat);
    if (!PLAIN_SECTION.test(label.toLowerCase())) parallel = label;
  }
  return { parallel, isAuto };
}

function splitCsv(l) {
  const o = []; let c = "", q = false;
  for (const ch of l) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { o.push(c); c = ""; continue; }
    c += ch;
  }
  o.push(c); return o;
}
const q = (v) => (/[",]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);

function slugOf(manifest, cardNumber, parallel, isAuto, printRun) {
  return computeHobbyIqCardId({
    sport: manifest.sport, year: manifest.year,
    setKey: manifest.setKey || manifest.setName,
    cardNumber, parallel, isAuto,
    printRun: printRun || null,
    authoritativeSetKey: true,
  });
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".csv"))
  .filter((f) => !ONLY || f === ONLY);

let totalChanged = 0, totalFiles = 0, totalFolds = 0, blocked = [];

for (const file of files) {
  const csvPath = path.join(DIR, file);
  const manPath = csvPath.replace(/\.csv$/, ".manifest.json");
  if (!fs.existsSync(manPath)) { console.log(`SKIP ${file} — no manifest`); continue; }
  const manifest = JSON.parse(fs.readFileSync(manPath, "utf8"));
  if (manifest.parallelColumnAuthoritative === true) continue;   // already migrated

  const lines = fs.readFileSync(csvPath, "utf8").replace(/\r/g, "").trim().split("\n");
  const rows = lines.slice(1).map(splitCsv).map((f) => ({
    category: f[0], cardNumber: f[1], parallel: f[2], isAuto: f[3], printRun: f[4], player: f[5],
  }));
  if (!rows.length) continue;

  // Sections, reconstructed from the category column — the category IS the
  // slugged section name for every generator in this corpus.
  const sections = new Map();
  for (const r of rows) {
    if (!sections.has(r.category)) {
      sections.set(r.category, {
        sheet: "-", section: sectionLabel(r.category) || r.category, key: r.category,
        category: r.category, numbers: new Set(), cards: 0,
      });
    }
    const s = sections.get(r.category);
    s.numbers.add(String(r.cardNumber).toUpperCase());
    s.cards++;
  }
  // FOLDING IS OFF BY DEFAULT HERE, and that is the point of this script being
  // separate from the converter. Folding needs a real section NAME to subtract
  // the anchor from; these legacy files only have a category slug, and the slug
  // carries the whole path rather than the rung. "insert-chrome-prospects-
  // packfractor-variation" minus the anchor "Base" yields "Chrome Prospects
  // Packfractor Variation" — which slugs no better than what it replaced, and
  // no parsed sale title will ever match it. The rung is "PackFractor", and
  // only the source workbook's own section headings can tell us that.
  //
  // So this migration does the safe half — materialise the parallel the
  // ingester already derived, provably slug-identical — and leaves folding to a
  // re-run of convertBeckettChecklistXlsx.cjs against the real .xlsx.
  const report = conv.classifySections(sections);
  const FOLD = process.env.FOLD === "true";
  if (!FOLD) for (const s of sections.values()) { delete s.parallelOf; delete s.rung; }
  const folds = FOLD ? report.filter((r) => r.role === "parallel") : [];
  const deferred = FOLD ? [] : report.filter((r) => r.role === "parallel");

  const out = [];
  const diffs = [];
  for (const r of rows) {
    const sec = sections.get(r.category);
    const before = legacyParallel(r.category);
    const beforeSlug = slugOf(manifest, r.cardNumber, before.parallel, before.isAuto, r.printRun);

    // Pokemon writes the base tier as "Normal"; it is the plain card, so it
    // becomes blank like every other plain card.
    let newParallel;
    let newCategory = r.category;
    let newIsAuto = before.isAuto;
    if (sec.parallelOf) {
      newParallel = sec.rung;
      newCategory = sec.parallelOf.category;
      newIsAuto = newCategory.startsWith("auto-");
    } else if (/^(base|normal)$/i.test(before.parallel)) {
      newParallel = "";
    } else {
      newParallel = before.parallel;
    }
    const afterSlug = slugOf(manifest, r.cardNumber, newParallel, newIsAuto, r.printRun);
    if (beforeSlug !== afterSlug && !sec.parallelOf) {
      diffs.push(`${r.cardNumber} ${r.player}\n        was ${beforeSlug}\n        now ${afterSlug}`);
    }
    out.push({ ...r, category: newCategory, parallel: newParallel, isAuto: String(newIsAuto) });
  }

  totalFiles++;
  const changedRows = out.filter((o, i) => o.parallel !== rows[i].parallel).length;
  totalChanged += changedRows;
  totalFolds += folds.length;

  console.log(`${file}`);
  console.log(`   rows ${rows.length}  parallel-column rewrites ${changedRows}  folds ${folds.length}`);
  for (const f of folds) console.log(`      FOLD ${f.section} (${f.cards}) -> ${f.anchor}  parallel="${f.rung}"`);
  for (const d of deferred) console.log(`      deferred fold: ${d.section} (${d.cards}) -> ${d.anchor}  (needs the source workbook to name the rung)`);
  for (const a of report.filter((x) => x.role === "own-cards-AMBIGUOUS")) {
    console.log(`      !! AMBIGUOUS ${a.section} (${a.cards}) ${a.overlapPct}% vs ${a.anchor} — left alone`);
  }
  if (diffs.length) {
    blocked.push(file);
    console.log(`   !! ${diffs.length} rows would CHANGE SLUG without folding — not written:`);
    for (const d of diffs.slice(0, 4)) console.log(`        ${d}`);
    continue;
  }

  if (APPLY) {
    const csv = ["category,cardNumber,parallel,isAuto,printRun,player"];
    for (const r of out) {
      csv.push([r.category, r.cardNumber, q(r.parallel), r.isAuto, r.printRun, q(r.player)].join(","));
    }
    fs.writeFileSync(csvPath, csv.join("\n") + "\n");
    manifest.parallelColumnAuthoritative = true;
    manifest.migratedAt = new Date().toISOString();
    manifest.migratedBy = "CF-ONE-CHECKLIST-FORMAT — parallel materialised from the category slug; slug-identical";
    fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2));
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"}: ${totalFiles} files, ${totalChanged} parallel-column rewrites, ${totalFolds} variation sections folded`);
if (blocked.length) {
  console.log(`BLOCKED (slug would change): ${blocked.join(", ")}`);
  process.exitCode = 1;
}
