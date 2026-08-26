#!/usr/bin/env node
/**
 * CF-EVERY-INGEST-USES-THE-ONE-FORMAT (Drew, 2026-08-26).
 *
 * Turns staged checklistinsider JSONL into the canonical checklist CSV --
 * the same six columns every other source emits:
 *
 *     category,cardNumber,parallel,isAuto,printRun,player
 *
 * "When we ingest it follows the same format. That is a rule." The scraper
 * stages faithful JSONL (ladder, sections, diagnostics, provenance); this is
 * the step that makes it ingestible, exactly as convertBeckettChecklistXlsx
 * does for Beckett workbooks. Raw artifact -> converter -> canonical CSV.
 *
 * ONE CLASSIFIER, NOT TWO. Section classification is imported from the Beckett
 * converter rather than reimplemented. checklistinsider's `subset` field is
 * the same shape of problem Beckett's sheets are: 2023 Panini Elite Extra
 * Edition publishes "Base", "Base Black", "Base Pink", "Base Aspirations Blue"
 * -- 224 subsets, each carrying the SAME card numbers 1..100. Those are
 * parallels of one card run, not 224 separate card runs, and deciding that by
 * card-number overlap is precisely what classifySections already does. A
 * second implementation would drift from the first.
 *
 * THE LADDER IS NOT CROSS-JOINED. A page may also carry a parallels LADDER --
 * 2023 Bowman Inception lists "Blue Foil /99", "Gold Foil /50" and 8 more,
 * with 295 base cards and no per-card parallel rows. Multiplying 295 x 10 would
 * manufacture 2,950 card rows no source ever published, which is the template
 * `no-synthetic-parallels` exists to forbid. The ladder stays in the JSONL and
 * is REPORTED here; only rows a source actually published become CSV.
 *
 * BLANK MEANS UNKNOWN. A card whose parallel we do not know emits an empty
 * parallel column -- never the literal "Base". That distinction is what lets a
 * later pass tell "this is the plain card" from "nobody told us".
 *
 * Usage:
 *   node backend/scripts/convertChecklistInsiderToChecklistCsv.cjs \
 *     --in=C:/tmp/ci-staging.jsonl --outDir=C:/tmp/ci-csv [--verbose]
 */
const fs = require("node:fs");
const path = require("node:path");
const { classifySections, categoryFor, PLAIN_SECTION } = require("./convertBeckettChecklistXlsx.cjs");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const IN = arg("in", "C:/tmp/ci-staging.jsonl");
const OUT_DIR = arg("outDir", "C:/tmp/ci-csv");
const VERBOSE = process.argv.includes("--verbose");

const f = (n) => Number(n).toLocaleString();
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * checklistinsider gives no sheet name, so derive the one thing categoryFor
 * needs from it: whether this run is signed. An explicit isAuto flag wins; the
 * subset naming itself an autograph run is the fallback.
 */
function sheetNameFor(subset, rows) {
  if (rows.some((r) => r.isAuto === true)) return "Autographs";
  if (subset && /\bautographs?\b/i.test(subset)) return "Autographs";
  // ONLY the plain run may map to the "Base" sheet. categoryFor returns "base"
  // for ANY section on that sheet, and classifySections treats category
  // "base" as an outright anchor -- so labelling every subset "Base" makes
  // every subset an anchor and nothing can ever fold. 2023 Panini Elite Extra
  // Edition is the proof: 224 subsets ("Base", "Base Black", "Base Pink" ...)
  // all carrying card numbers 1..100 came out as 224 anchors and 0 parallels,
  // and the dedup then collapsed 9,680 cards to 521 rows because every row
  // claimed the same blank parallel.
  const norm = String(subset || "Base").toLowerCase().replace(/\s*-\s*/g, " ").trim();
  if (PLAIN_SECTION.test(norm)) return "Base";
  return "Inserts";
}

/** Group a product's cards into the {key, section, category, numbers} sections classifySections wants. */
function sectionsFor(cards) {
  const bySubset = new Map();
  for (const c of cards) {
    const key = c.subset ?? "";
    if (!bySubset.has(key)) bySubset.set(key, []);
    bySubset.get(key).push(c);
  }
  const sections = new Map();
  for (const [subset, rows] of bySubset) {
    // An unsectioned product is one plain run. Naming it "Base" here makes it
    // an explicit ANCHOR for classifySections; it does NOT put "Base" in the
    // parallel column -- an anchor's rows emit a blank parallel.
    const label = subset || "Base";
    const sheet = sheetNameFor(subset, rows);
    sections.set(label, {
      key: label,
      section: label,
      category: categoryFor(sheet, label),
      numbers: new Set(rows.map((r) => String(r.cardNumber))),
      rows,
    });
  }
  return sections;
}

function toCsvRows(product) {
  const cards = product.cards ?? [];
  if (!cards.length) return { rows: [], anchors: 0, parallels: 0 };
  const sections = sectionsFor(cards);
  classifySections(sections);

  const rows = [];
  let anchors = 0, parallels = 0;
  for (const sec of sections.values()) {
    if (sec.rung) parallels++; else anchors++;
    for (const c of sec.rows) {
      rows.push({
        category: sec.category,
        cardNumber: String(c.cardNumber ?? "").trim(),
        // A rung name when this section folded onto an anchor; blank otherwise.
        // Blank is "unknown", and is never the string "Base".
        parallel: sec.rung ?? "",
        isAuto: c.isAuto === true ? "true" : c.isAuto === false ? "false" : "",
        printRun: c.printRun ?? "",
        player: String(c.player ?? "").trim(),
      });
    }
  }
  return { rows, anchors, parallels };
}

function writeCsv(file, rows) {
  const q = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const out = ["category,cardNumber,parallel,isAuto,printRun,player"];
  const seen = new Set();
  for (const r of rows) {
    const k = [r.category, r.cardNumber, r.parallel, r.isAuto, r.player].join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([r.category, q(r.cardNumber), q(r.parallel), r.isAuto, r.printRun, q(r.player)].join(","));
  }
  fs.writeFileSync(file, out.join("\n") + "\n");
  // Report what the dedup ate. A collapse from 9,680 to 521 was invisible
  // until it was counted -- "duplicate" is a conclusion, not an observation,
  // and a silent drop looks exactly like a product that was always small.
  return { written: out.length - 1, dropped: rows.length - (out.length - 1) };
}

function main() {
  if (!fs.existsSync(IN)) { console.error(`FATAL: no staged JSONL at ${IN}`); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let products = 0, written = 0, cardRows = 0, ladderRungs = 0, stubs = 0, unparsed = 0, empty = 0, deduped = 0;
  let totalAnchors = 0, totalParallels = 0;

  for (const line of fs.readFileSync(IN, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    products++;
    if (p.isStub) { stubs++; continue; }
    if (p.bookUnparsed) { unparsed++; continue; }

    // Counted and reported, never multiplied into cards.
    ladderRungs += (p.parallels ?? []).length;

    const { rows, anchors, parallels } = toCsvRows(p);
    if (!rows.length) { empty++; continue; }
    totalAnchors += anchors; totalParallels += parallels;

    const file = path.join(OUT_DIR, `${slugify(p.slug || `${p.year}-${products}`)}.csv`);
    const { written: n, dropped } = writeCsv(file, rows);
    written++; cardRows += n; deduped += dropped;
    if (VERBOSE) {
      const warn = dropped > n ? "  <- MORE dropped than kept, check the sections" : "";
      console.log(`  ${path.basename(file).padEnd(50)} ${String(f(n)).padStart(7)} rows  ${String(anchors).padStart(3)} anchor /${String(parallels).padStart(4)} parallel  dedup -${f(dropped)}${warn}`);
    }
  }

  console.log(`\nproducts read              ${f(products)}`);
  console.log(`  CSVs written             ${f(written)}`);
  console.log(`  card rows                ${f(cardRows)}`);
  console.log(`  sections: anchors        ${f(totalAnchors)}`);
  console.log(`  sections: parallel rungs ${f(totalParallels)}`);
  console.log(`  STUBS (published nothing)${f(stubs)}`);
  console.log(`  workbook unparsed        ${f(unparsed)}`);
  console.log(`  readable but no rows     ${f(empty)}`);
  console.log(`  dropped by dedup         ${f(deduped)}`);
  console.log(`\n  ladder rungs NOT expressed as cards: ${f(ladderRungs)}`);
  console.log(`  (a ladder without per-card rows is a template — see no-synthetic-parallels)`);
  console.log(`\n  format: category,cardNumber,parallel,isAuto,printRun,player`);
}

module.exports = { toCsvRows, sectionsFor, sheetNameFor };

if (require.main === module) main();
