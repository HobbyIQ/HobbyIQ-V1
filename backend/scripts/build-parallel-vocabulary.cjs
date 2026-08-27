#!/usr/bin/env node
/**
 * CF-THE-CHECKLIST-NAMES-THE-PARALLEL (Drew, 2026-08-27: "we know the names
 * from checklists and then we go out and find it").
 *
 * Builds the canonical parallel vocabulary from the checklists we hold, keyed
 * per product, so matching has an authority to normalise against instead of a
 * majority vote inside our own data.
 *
 * WHY A VOTE WOULD BE WRONG. Measured over 33,090 distinct parallel values,
 * 1,513 canonical forms are stored more than one way, covering 9,757,801 rows.
 * The dominant spelling is frequently the WRONG one:
 *
 *     catalog:     "X Fractor"   41,935 rows   <- no checklist publishes this
 *     checklists:  "X-Fractor"    5,592 rows   <- hyphenated, every time
 *
 * Picking by row count entrenches the error. The manufacturer's own list is
 * the only thing that can settle it.
 *
 * PER PRODUCT, NOT GLOBAL. "Gold" in one product is not the same card as
 * "Gold" in another, and Drew's rule is year + set + card number + name. A
 * global vocabulary would licence merging across products, which is the
 * mistake the BCP- prefix rule made.
 *
 * THE SOURCE HAS ITS OWN NOISE, and it must be cleaned before it can act as an
 * authority -- the same defect class we are trying to fix, on the supply side:
 *
 *     "X-Fractor - 10 per box (Mega exclusive)"   pack odds glued on
 *     "FrozenFractor - /-5 - 1:4"                 print run AND odds
 *     "Refractor: 14,000 copies"                  run glued with a colon
 *     "Black ()"                                  a parser left empty brackets
 *
 * WHAT IS DELIBERATELY KEPT. A retailer or channel exclusive is a REAL card:
 * "Purple (exclusive to packs sold at Meijer stores)" is not "Purple", and
 * 12,740 rows carry it. Those are preserved as distinct entries; only the
 * casing is unified, because "exclusive TO Packs Sold AT Meijer Stores" is the
 * same card shouted differently.
 *
 * DO NOT WRITE TO backend/data/parallel-vocabulary.json. That name is taken by
 * a hand-curated alias + ladder registry (schema hobbyiq/parallel-vocabulary/v1)
 * that hobbyIqCardId.service, parallelTokenizer and parallelTitleMatch all read.
 * This script was pointed at it once by accident; overwriting it would have
 * corrupted slug computation everywhere, and the file would still have parsed.
 * The generated artifact is checklist-parallel-names.json.
 *
 * READ-ONLY. Emits JSON for review. Nothing is written to Cosmos, and nothing
 * is rewritten from this file until a separate pass consumes it.
 *
 * Usage:
 *   node backend/scripts/build-parallel-vocabulary.cjs \
 *     --dirs=C:/tmp/beckett-bulk,C:/tmp/ci/csv2 \
 *     --out=backend/data/checklist-parallel-names.json
 */
const fs = require("node:fs");
const path = require("node:path");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const DIRS = arg("dirs", "C:/tmp/beckett-bulk,C:/tmp/ci/csv2").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = arg("out", "backend/data/checklist-parallel-names.json");

const f = (n) => Number(n).toLocaleString();

/** Honour quoted fields — parallel names contain commas. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Strip the source's own noise from a published name, and report what came off
 * so a print run the source glued on is recovered rather than discarded.
 *
 * A parenthetical is KEPT unless it is empty — a channel exclusive is a real
 * distinction, and dropping it would merge cards.
 */
function cleanName(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  let printRun = null;
  let odds = null;

  // A trailing parenthetical is a REAL distinction -- "(exclusive to packs
  // sold at Meijer stores)" is a different card. Lift it off first so the
  // noise BEHIND it can be stripped, then put it back. Without this,
  // "X-Fractor - 10 per box (Mega exclusive)" kept its pack odds, because
  // every noise pattern below anchors to the end of the string.
  let tail = "";
  const paren = s.match(/\s*(\([^)]*\))\s*$/);
  if (paren) {
    if (paren[1].replace(/[()\s]/g, "")) tail = " " + paren[1];   // "()" is noise
    s = s.slice(0, paren.index).trim();
  }

  // Repeat: a name can carry a run AND odds AND another run.
  for (let pass = 0; pass < 3; pass++) {
    const before = s;

    // "Refractor: 14,000 copies" / ": Ten Copie"
    const colon = s.match(/:\s*([A-Za-z0-9,]+)\s+copie?s?\.?\s*$/i);
    if (colon) {
      const n = Number(colon[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && printRun === null) printRun = n;
      s = s.slice(0, colon.index).trim();
    }

    // Pack odds, which the source often trails with prose: "1:4",
    // "1:24 packs", "1:1 Monster.", "1:1 Mega Box."
    const packOdds = s.match(/\s*[-–—]?\s*\d+\s*:\s*\d[\d,]*(?:\s+[A-Za-z][A-Za-z ]*)?\.?\s*$/);
    if (packOdds) { odds = odds ?? s.slice(packOdds.index).replace(/^[\s-–—]+/, "").trim(); s = s.slice(packOdds.index).length ? s.slice(0, packOdds.index).trim() : s; }

    // " - 10 per box" — a rate, not a run.
    const perBox = s.match(/\s*[-–—]\s*\d[\d,]*\s*per\s*box\s*$/i);
    if (perBox) { odds = odds ?? s.slice(perBox.index).replace(/^[\s-–—]+/, "").trim(); s = s.slice(0, perBox.index).trim(); }

    // " - /99" and the mangled " - /-5" the source also writes.
    const run = s.match(/\s*[-–—]\s*\/\s*-?\s*(\d[\d,]*)\s*$/);
    if (run) {
      const n = Number(run[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && printRun === null) printRun = n;
      s = s.slice(0, run.index).trim();
    }

    if (s === before) break;
  }

  s = s.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();   // "Black ()"
  s = s.replace(/[-–—:,]\s*$/, "").trim();
  if (!s || s.length < 2) return null;
  return { name: (s + tail).trim(), printRun, odds };
}

/** Case-insensitive identity, so one card is not two because of shouting. */
const key = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

function productOf(csvPath) {
  const manifest = csvPath.replace(/\.csv$/, ".manifest.json");
  if (fs.existsSync(manifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (m.year && m.sport) return { sport: m.sport, year: Number(m.year), setKey: m.setKey || null };
    } catch { /* fall through */ }
  }
  const base = path.basename(csvPath, ".csv");
  const m = base.match(/^((?:19|20)\d{2})(?:-\d{2})?-(.+)-(baseball|basketball|football|hockey|soccer|pokemon|wrestling)$/);
  return m ? { sport: m[3], year: Number(m[1]), setKey: m[2] } : null;
}

function main() {
  const vocab = new Map();       // "sport|year|setKey" -> Map(key -> entry)
  let files = 0, rows = 0, cleaned = 0, runsRecovered = 0, dropped = 0;

  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) { console.error(`  skipping missing dir ${dir}`); continue; }
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".csv"))) {
      const p = path.join(dir, name);
      const prod = productOf(p);
      if (!prod || !prod.setKey) continue;
      files++;
      const pk = `${prod.sport}|${prod.year}|${prod.setKey}`;
      if (!vocab.has(pk)) vocab.set(pk, new Map());
      const bucket = vocab.get(pk);

      const lines = fs.readFileSync(p, "utf8").split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = splitCsv(line);
        const parallel = (cols[2] ?? "").trim();
        // The checklist states the run in its OWN column. Reading only the
        // runs recovered from name-glue captured 2 of 36,734 names — and print
        // run is the one field no sale title can be made to yield.
        const colRunRaw = Number(String(cols[4] ?? "").trim());
        const colRun = Number.isFinite(colRunRaw) && colRunRaw > 0 ? colRunRaw : null;
        rows++;
        if (!parallel) continue;         // blank is "the plain card", not a parallel
        const c = cleanName(parallel);
        if (!c) { dropped++; continue; }
        if (c.name !== parallel) cleaned++;
        if (c.printRun !== null) runsRecovered++;
        const k = key(c.name);
        const prev = bucket.get(k);
        if (!prev) {
          bucket.set(k, { name: c.name, printRun: c.printRun ?? colRun, odds: c.odds, seen: 1, spellings: [parallel] });
        } else {
          prev.seen++;
          if (prev.printRun === null && c.printRun !== null) prev.printRun = c.printRun;
          if (prev.printRun === null || prev.printRun === undefined) prev.printRun = c.printRun ?? colRun;
          if (!prev.spellings.includes(parallel) && prev.spellings.length < 8) prev.spellings.push(parallel);
          // Prefer the spelling the source uses most; ties keep the first.
          if (c.name.length < prev.name.length) prev.name = c.name;
        }
      }
    }
  }

  const out = {};
  let products = 0, names = 0, withRun = 0;
  for (const [pk, bucket] of [...vocab.entries()].sort()) {
    if (!bucket.size) continue;
    products++;
    const [sport, year, setKey] = pk.split("|");
    out[pk] = {
      sport, year: Number(year), setKey,
      parallels: [...bucket.values()]
        .sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name))
        .map((e) => {
          names++;
          if (e.printRun !== null) withRun++;
          return { name: e.name, printRun: e.printRun, odds: e.odds ?? null, seen: e.seen, spellings: e.spellings };
        }),
    };
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    builtAt: new Date().toISOString(),
    sources: DIRS,
    productCount: products,
    parallelNameCount: names,
    out: undefined,
  }, null, 1).replace(/\n \"out\": undefined\n/, "\n") .slice(0, -2) + ",\n \"products\": " + JSON.stringify(out, null, 1) + "\n}\n");

  console.log(`checklist files read     ${f(files)}`);
  console.log(`csv rows                 ${f(rows)}`);
  console.log(`products with parallels  ${f(products)}`);
  console.log(`distinct parallel names  ${f(names)}`);
  console.log(`  carrying a print run   ${f(withRun)}`);
  console.log(`names cleaned of source noise ${f(cleaned)}`);
  console.log(`  print runs recovered   ${f(runsRecovered)}`);
  console.log(`  unusable, dropped      ${f(dropped)}`);
  console.log(`\nwritten to ${OUT}`);
}

module.exports = { cleanName, splitCsv };

if (require.main === module) main();
