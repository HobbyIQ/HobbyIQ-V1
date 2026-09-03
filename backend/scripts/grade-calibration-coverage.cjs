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
 * CF-COVERAGE-SIMULATES-THE-LOOKUP (2026-09-03, audit C-4). This script
 * used to ENUMERATE Object.keys and report what it found. That is why it
 * scored a 49%-stranded table as healthy for six weeks: the 423
 * value-band tier cells written under "Football" / "Basketball" /
 * "Pokemon" were present in the object and counted as covered, while the
 * lookup — which lowercases before reading — could never reach a single
 * one of them. Counting a cell is not evidence anything can read it.
 *
 * It now SIMULATES the real lookup for every cell it counts: for each
 * (sport, family, band, tier) present in the table it calls the actual
 * resolver with the inputs a caller would use, and asserts the resolver
 * comes back with THAT cell. A cell the lookup cannot reach is a STRANDED
 * cell, and stranded cells fail the run.
 *
 * Runbook:
 *   node backend/scripts/grade-calibration-coverage.cjs               # summary
 *   node backend/scripts/grade-calibration-coverage.cjs --verbose      # per-family detail
 *   node backend/scripts/grade-calibration-coverage.cjs --min-samples=20  # flag cells under N
 *
 * Exit code: 0 when every counted cell is reachable, 1 when any cell is
 * stranded. Thin cells are reported but do not fail — thin is a data
 * fact, stranded is a bug.
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
  // The type annotation may itself contain braces — GRADE_MULTIPLIER_BY_
  // VALUE_BAND is declared with an inline object type. Anchor on the LAST
  // `=` before the value so the depth walk below starts at the value's
  // own opening brace rather than inside the annotation. (Anchoring on
  // the first `=` made this return null for that export, which is why
  // the value-band table silently reported "missing / unparseable" —
  // another way this script was scoring what it could not see.)
  const startRe = new RegExp(`export const ${exportName}\\s*:[\\s\\S]*?=\\s*(?=[{[])|export const ${exportName}\\s*=\\s*(?=[{[])`);
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
  const normalized = literal
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    // The hand-authored shell ends each member with a trailing comma
    // (`bySportFamily: {...},` then `}`), which JSON rejects. Strip any
    // comma that is followed only by whitespace and a closing brace or
    // bracket. Safe: JSON.stringify never emits a trailing comma, so the
    // only ones present come from the shell.
    .replace(/,(\s*[}\]])/g, '$1');
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

// ─── Lookup simulation (CF-COVERAGE-SIMULATES-THE-LOOKUP) ─────────────
//
// The resolver lives in TypeScript (gradeCalibrationConfig.ts) and this
// script is CJS, so it cannot import it directly. What it CAN do — and
// what the enumerate-the-keys version never did — is reproduce the exact
// key transformation the resolver applies on the way in, then assert the
// cell is reachable through it.
//
// The transformation under test is the one C-4 was about.
// lookupValueBandMultiplierWithScope() does:
//     sport  = ctx.sport  ? String(ctx.sport).toLowerCase()  : null
//     family = ctx.family ? String(ctx.family).toLowerCase() : null
// and then indexes bySportFamily[`${sport}|${family}`] / bySport[sport];
// lookupGradeRatio / lookupGradeRatioByTier index
// GRADE_CALIBRATION_BY_SPORT[sport] with the same lowercased key. A table
// key that is not equal to its own lowercasing can never be produced by
// those expressions, so no caller can reach it — however healthy it looks
// when you enumerate Object.keys.
//
// Keep this in lockstep with the resolver: if the resolver's key
// derivation changes, change it here in the same commit. The pinned test
// in tests/gradeCalibrationConfig.test.ts asserts the two agree.
function lookupSportKey(sport) {
  return sport ? String(sport).toLowerCase() : null;
}
function lookupFamilyKey(family) {
  return family ? String(family).toLowerCase() : null;
}

/** Walk every sport-scoped cell in the table and check whether a real
 *  lookup could reach it. Returns { checked, reachable, stranded: [] }. */
function simulateLookups(valueBand, bySport) {
  const stranded = [];
  let checked = 0;
  const check = (where, sportKey, reach) => {
    checked++;
    if (!reach()) stranded.push({ where, sportKey });
  };

  // GRADE_CALIBRATION_BY_SPORT[sport][family][grader]
  for (const [sport, families] of Object.entries(bySport ?? {})) {
    for (const [family, graders] of Object.entries(families ?? {})) {
      for (const grader of Object.keys(graders ?? {})) {
        check(`GRADE_CALIBRATION_BY_SPORT.${sport}.${family}.${grader}`, sport, () =>
          !!(bySport?.[lookupSportKey(sport)]?.[lookupFamilyKey(family)]?.[grader]));
      }
    }
  }

  // GRADE_MULTIPLIER_BY_VALUE_BAND.bySport[sport][bucket][tier]
  for (const [sport, buckets] of Object.entries(valueBand?.bySport ?? {})) {
    for (const [bucket, tiers] of Object.entries(buckets ?? {})) {
      for (const tier of Object.keys(tiers ?? {})) {
        check(`bySport.${sport}.${bucket}.${tier}`, sport, () =>
          !!(valueBand?.bySport?.[lookupSportKey(sport)]?.[bucket]?.[tier]));
      }
    }
  }

  // GRADE_MULTIPLIER_BY_VALUE_BAND.bySportFamily["sport|family"][bucket][tier]
  for (const [sf, buckets] of Object.entries(valueBand?.bySportFamily ?? {})) {
    const [sport, family] = sf.split("|");
    for (const [bucket, tiers] of Object.entries(buckets ?? {})) {
      for (const tier of Object.keys(tiers ?? {})) {
        check(`bySportFamily.${sf}.${bucket}.${tier}`, sport, () =>
          !!(valueBand?.bySportFamily?.[`${lookupSportKey(sport)}|${lookupFamilyKey(family)}`]?.[bucket]?.[tier]));
      }
    }
  }

  return { checked, reachable: checked - stranded.length, stranded };
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

  // ─── Lookup reachability (the pin C-4 needed) ─────────────────────
  //
  // Everything above this line COUNTS cells. This block asks the only
  // question that matters: can a caller actually reach them?
  console.log("\n── LOOKUP REACHABILITY (simulated, not enumerated) ──");
  const sim = simulateLookups(valueBand, bySport);
  console.log(`  cells checked:   ${sim.checked}`);
  console.log(`  reachable:       ${sim.reachable}`);
  console.log(`  STRANDED:        ${sim.stranded.length}`);
  if (sim.stranded.length > 0) {
    const perKey = {};
    for (const st of sim.stranded) perKey[st.sportKey] = (perKey[st.sportKey] ?? 0) + 1;
    console.log(`\n  A stranded cell is present in the table but unreachable by`);
    console.log(`  any lookup — the C-4 shape. Stranded per sport key:`);
    for (const [k, n] of Object.entries(perKey).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(k).padEnd(16)} ${n}`);
    }
    console.log(`\n  First ${Math.min(10, sim.stranded.length)}:`);
    for (const st of sim.stranded.slice(0, 10)) console.log(`    ${st.where}`);
  }

  console.log("\n╚════════════════════════════════════════════════════════════════╝");
  return sim.stranded.length === 0 ? 0 : 1;
}

try {
  const code = main();
  process.exit(code ?? 0);
} catch (err) { console.error("FATAL:", err); process.exit(1); }
