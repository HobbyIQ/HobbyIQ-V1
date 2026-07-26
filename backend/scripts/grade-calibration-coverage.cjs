#!/usr/bin/env node
/**
 * CF-GRADE-CALIBRATION-COVERAGE (Drew, 2026-07-26). After the weekly
 * Grade Calibration Refresh workflow lands a fresh
 * `backend/src/services/compiq/gradeCalibrationData.ts`, this script
 * reads it and prints a per-sport coverage summary so we can see at a
 * glance where cells populated vs stayed thin.
 *
 * Ships alongside PR #793 (expand FB/BB/Pokemon family lists + 730d
 * lookback) so we have instant visibility on whether the expanded
 * family lists actually produced more per-cell samples.
 *
 * READ-ONLY. Parses the TS file via targeted regex → JSON.parse (the
 * data blocks are auto-generated as JSON.stringify(obj, null, 2), so
 * they're valid JSON — we only need to skip the TypeScript
 * `: TypeName = ` prefix on each export).
 *
 * Runbook:
 *   node backend/scripts/grade-calibration-coverage.cjs               # summary
 *   node backend/scripts/grade-calibration-coverage.cjs --verbose      # per-family detail
 *   node backend/scripts/grade-calibration-coverage.cjs --min-samples=20  # flag cells under N
 *
 * Exits 0 always. Purely informational.
 */
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { verbose: false, minSamples: 10, file: null };
  for (const a of argv) {
    if (a === "--verbose") args.verbose = true;
    else if (a.startsWith("--min-samples=")) args.minSamples = parseInt(a.slice(14), 10);
    else if (a.startsWith("--file=")) args.file = a.slice(7);
  }
  return args;
}

/** Extract a top-level `export const NAME: ... = {...};` value block
 *  from the TS source. Returns the parsed JSON object, or null if the
 *  export isn't found. Assumes the value is a JSON-valid literal (which
 *  the auto-generator always emits via JSON.stringify). */
function extractExport(source, exportName) {
  const startRe = new RegExp(`export const ${exportName}[^=]*=\\s*`);
  const m = source.match(startRe);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  // Walk the source from startIdx, counting {}/[] depth, until we hit
  // the balanced close. Then strip trailing ";" / whitespace.
  let depth = 0;
  let end = -1;
  let inStr = false;
  let strCh = "";
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  const literal = source.slice(startIdx, end);
  // GRADE_MULTIPLIER_BY_VALUE_BAND has a hand-authored outer shell
  // (unquoted keys like `bySport`, `bySportFamily`, `baseline`) with
  // JSON-quoted nested blocks. Normalize bare-identifier keys to
  // quoted keys so JSON.parse accepts the whole tree. Safe because
  // JSON.stringify writes all string values already-quoted, so the
  // only unquoted colons are object-literal keys.
  const normalized = literal.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  try { return JSON.parse(normalized); }
  catch (err) { console.error(`Failed to parse ${exportName}: ${err.message}`); return null; }
}

/** Summarize a per-family-per-grader map. Returns {families, cells,
 *  byTierCells, totalSamples, thinCells: [{family, grader, tier,
 *  sampleSize}]}. */
function summarizeFamilyMap(map, minSamples) {
  const thinCells = [];
  let cells = 0;
  let byTierCells = 0;
  let totalSamples = 0;
  const families = Object.keys(map ?? {});
  for (const family of families) {
    for (const [grader, entry] of Object.entries(map[family] ?? {})) {
      cells++;
      totalSamples += entry.sampleSize ?? 0;
      if (entry.byTier) {
        for (const [tier, tierEntry] of Object.entries(entry.byTier)) {
          byTierCells++;
          if ((tierEntry.sampleSize ?? 0) < minSamples) {
            thinCells.push({ family, grader, tier, sampleSize: tierEntry.sampleSize ?? 0 });
          }
        }
      }
    }
  }
  return { families: families.length, cells, byTierCells, totalSamples, thinCells };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args.file ?? path.join(__dirname, "..", "src", "services", "compiq", "gradeCalibrationData.ts");
  if (!fs.existsSync(filePath)) {
    console.error(`FATAL: ${filePath} not found`);
    process.exit(1);
  }
  const source = fs.readFileSync(filePath, "utf8");

  const baseline = extractExport(source, "GRADE_CALIBRATION");
  const bySport = extractExport(source, "GRADE_CALIBRATION_BY_SPORT");
  const valueBand = extractExport(source, "GRADE_MULTIPLIER_BY_VALUE_BAND");

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║           Grade Calibration Coverage Report                    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`Source: ${filePath}`);
  console.log(`min-samples threshold for thin-cell flag: ${args.minSamples}\n`);

  // ─── Baseline (baseball-implicit) ──────────────────────────────────────
  console.log("── BASELINE (GRADE_CALIBRATION, baseball-implicit pool) ──");
  if (!baseline) console.log("  (missing / unparseable)");
  else {
    const s = summarizeFamilyMap(baseline, args.minSamples);
    console.log(`  families: ${s.families}`);
    console.log(`  (family × grader) cells: ${s.cells}`);
    console.log(`  (family × grader × tier) cells: ${s.byTierCells}`);
    console.log(`  total sample size: ${s.totalSamples.toLocaleString()}`);
    console.log(`  thin cells (n < ${args.minSamples}): ${s.thinCells.length}`);
    if (args.verbose) {
      for (const family of Object.keys(baseline)) {
        const graders = Object.keys(baseline[family]);
        console.log(`    ${family.padEnd(28)} graders=${graders.join(",")}`);
      }
    }
  }

  // ─── Per-sport overlays ────────────────────────────────────────────────
  console.log("\n── PER-SPORT (GRADE_CALIBRATION_BY_SPORT) ──");
  if (!bySport) console.log("  (missing / unparseable)");
  else {
    const sports = Object.keys(bySport);
    console.log(`  sports covered: ${sports.join(", ") || "(none)"}\n`);
    // Header row
    console.log(`  ${"sport".padEnd(12)} ${"families".padStart(9)} ${"cells".padStart(7)} ${"byTier".padStart(8)} ${"samples".padStart(10)} ${"thin".padStart(6)}`);
    console.log(`  ${"─".repeat(12)} ${"─".repeat(9)} ${"─".repeat(7)} ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(6)}`);
    for (const sport of sports) {
      const s = summarizeFamilyMap(bySport[sport], args.minSamples);
      console.log(`  ${sport.padEnd(12)} ${String(s.families).padStart(9)} ${String(s.cells).padStart(7)} ${String(s.byTierCells).padStart(8)} ${String(s.totalSamples).padStart(10)} ${String(s.thinCells.length).padStart(6)}`);
    }
    if (args.verbose) {
      for (const sport of sports) {
        console.log(`\n  ─ ${sport} families ─`);
        for (const family of Object.keys(bySport[sport])) {
          const graders = Object.keys(bySport[sport][family]);
          console.log(`    ${family.padEnd(28)} graders=${graders.join(",")}`);
        }
      }
    }
  }

  // ─── Value-band table ──────────────────────────────────────────────────
  // Structure: { baseline: {bucket:{tier:entry}}, bySport: {sport:{bucket:{tier:entry}}},
  //              bySportFamily: {sportFamily:{bucket:{tier:entry}}} }
  console.log("\n── VALUE-BAND (GRADE_MULTIPLIER_BY_VALUE_BAND) ──");
  if (!valueBand) console.log("  (missing / unparseable)");
  else {
    function summarizeVB(bucketMap) {
      const buckets = Object.keys(bucketMap ?? {});
      let cells = 0;
      let samples = 0;
      for (const b of buckets) {
        for (const [t, entry] of Object.entries(bucketMap[b] ?? {})) {
          cells++;
          samples += entry.sampleSize ?? 0;
        }
      }
      return { buckets: buckets.length, cells, samples };
    }
    const base = summarizeVB(valueBand.baseline);
    console.log(`  baseline: ${base.buckets} buckets, ${base.cells} (bucket × tier) cells, ${base.samples.toLocaleString()} samples`);
    const sportKeys = Object.keys(valueBand.bySport ?? {});
    console.log(`  bySport: ${sportKeys.length} sports covered${sportKeys.length ? ": " + sportKeys.join(", ") : ""}`);
    for (const sport of sportKeys) {
      const s = summarizeVB(valueBand.bySport[sport]);
      console.log(`    ${sport.padEnd(12)} ${s.buckets} buckets, ${s.cells} cells, ${s.samples.toLocaleString()} samples`);
    }
    const sfKeys = Object.keys(valueBand.bySportFamily ?? {});
    console.log(`  bySportFamily: ${sfKeys.length} sport|family combinations`);
    if (args.verbose && sfKeys.length) {
      for (const sf of sfKeys.slice(0, 20)) {
        const s = summarizeVB(valueBand.bySportFamily[sf]);
        console.log(`    ${sf.padEnd(40)} ${s.cells} cells, ${s.samples} samples`);
      }
      if (sfKeys.length > 20) console.log(`    ... and ${sfKeys.length - 20} more`);
    }
  }

  // ─── Thin-cell diagnostic ──────────────────────────────────────────────
  if (bySport && args.verbose) {
    console.log("\n── THIN CELLS PER SPORT ──");
    for (const sport of Object.keys(bySport)) {
      const s = summarizeFamilyMap(bySport[sport], args.minSamples);
      if (s.thinCells.length === 0) continue;
      console.log(`\n  ${sport} (${s.thinCells.length} cells below n=${args.minSamples}):`);
      const top = s.thinCells.slice().sort((a, b) => a.sampleSize - b.sampleSize).slice(0, 20);
      for (const t of top) {
        console.log(`    ${t.family.padEnd(28)} ${t.grader.padEnd(5)} tier=${t.tier.padEnd(4)} n=${t.sampleSize}`);
      }
      if (s.thinCells.length > 20) console.log(`    ... and ${s.thinCells.length - 20} more`);
    }
  }

  console.log("\n╚════════════════════════════════════════════════════════════════╝");
}

try { main(); }
catch (err) { console.error("FATAL:", err); process.exit(1); }
