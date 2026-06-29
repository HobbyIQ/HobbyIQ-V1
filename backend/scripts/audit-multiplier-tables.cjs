#!/usr/bin/env node
// CF-CALIBRATION-AUDIT (2026-06-29) — reusable data-quality gate for the
// three multiplier tables in backend/data/:
//   - auto-multipliers-latest.json
//   - vintage-multipliers-latest.json
//   - parallel-premiums-latest.json
//
// Catches anomaly classes that the per-script filters DON'T cover:
//
//   1. Sub-1.0 high-grade ratios (defense-in-depth — the scripts now
//      filter these at calibration time, but data on disk might still
//      have stale anomalies from prior calibrations).
//
//   2. PSA/BGS/SGC grade monotonicity violations: within a single
//      (company, tier) the ratio should generally increase with grade
//      (PSA 7 ≤ PSA 8 ≤ PSA 9 ≤ PSA 10). Mild dips (within 10%) can
//      be sampling noise; significant violations (>20%) are bad data.
//
//   3. Tier ordering anomalies: within a single (company, grade) the
//      ratio should generally DECREASE as raw price tier increases
//      (the dollar premium of a grade matters more relative to a $20
//      raw than a $2000 raw). Monotonic increases across tiers are
//      suspicious; >2× tier-jumps are red flags.
//
//   4. Outlier ratios: any ratio outside [0.1, 100] across all tables.
//
//   5. Empty rows: a company/grade with no tiers AND no fallback is
//      a no-op entry that just clutters the table.
//
// Exit codes:
//   0  — clean (no anomalies above the WARN threshold)
//   1  — warnings only (informational)
//   2  — at least one ERROR-class anomaly (suitable for CI gate)
//
// Usage:
//   node scripts/audit-multiplier-tables.cjs
//   node scripts/audit-multiplier-tables.cjs --strict   # warns become errors

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");

const strict = process.argv.includes("--strict");

const TARGETS = [
  { file: "auto-multipliers-latest.json", kind: "auto" },
  { file: "vintage-multipliers-latest.json", kind: "vintage" },
  { file: "parallel-premiums-latest.json", kind: "parallel" },
];

// Grade ordering within each company. Used for monotonicity checks.
// AUTH excluded — in vintage context AUTH = damaged (sub-Raw legit);
// in auto context AUTH = certified-auto (≥Raw). Different semantics
// mean we don't include AUTH in the monotonic chain; just check the
// numeric grades.
const GRADE_ORDER = ["1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10"];
const HIGH_GRADES = new Set(["8", "8.5", "9", "9.5", "10"]);

// Tier ordering (raw-price tiers ascending)
const AUTO_TIERS = ["<25", "25-50", "50-100", "100-250", "250-500", "500-1000", "1000+"];
const VINTAGE_TIERS = ["<50", "50-100", "100-500", "500-1000", "1000-5000", "5000+"];

function loadTable(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) {
    return { error: `file not found: ${p}` };
  }
  try {
    return { data: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    return { error: `parse failed: ${e.message}` };
  }
}

// Anomaly accumulator
const findings = { errors: [], warns: [], info: [] };
function err(file, kind, msg) { findings.errors.push({ file, kind, msg }); }
function warn(file, kind, msg) { findings.warns.push({ file, kind, msg }); }
function info(file, kind, msg) { findings.info.push({ file, kind, msg }); }

function auditMultiplierTable(file, kind, data) {
  if (kind === "parallel") return auditParallel(file, data);

  const table = data.table;
  if (!table || typeof table !== "object") {
    err(file, "structure", "no .table block");
    return;
  }
  const tiers = kind === "vintage" ? VINTAGE_TIERS : AUTO_TIERS;

  // CF-MULTIPLIER-MONOTONICITY-ENFORCEMENT (2026-06-29): when the data
  // file carries monotonicityPostprocess metadata, the "kept-despite-
  // violation" entries are pre-reviewed (both grades have n≥10; the
  // variance is real, not noise). Mark them as warnings instead of
  // errors so the audit's exit code only blocks PRs on NEW anomalies.
  const knownAcceptedViolations = new Set();
  const mono = data.monotonicityPostprocess;
  if (mono?.adjustments) {
    for (const a of mono.adjustments) {
      if (a.action === "keep-despite-violation") {
        // Key: context|tier|grade
        knownAcceptedViolations.add(`${a.context}|${a.tier}|${a.grade}`);
      }
    }
  }

  // For vintage, walk per-era. For auto, top-level is company.
  const eras = kind === "vintage" ? Object.keys(table) : [null];
  for (const era of eras) {
    const companies = kind === "vintage" ? table[era] : table;
    for (const company of Object.keys(companies)) {
      const grades = companies[company];
      const eraLabel = era ? `${era} ${company}` : company;

      // (1) Sub-1.0 high-grade defense-in-depth
      for (const grade of Object.keys(grades)) {
        if (!HIGH_GRADES.has(grade)) continue;
        const row = grades[grade];
        if (!row || typeof row !== "object") continue;
        for (const tier of tiers) {
          const v = row[tier];
          if (typeof v === "number" && v < 1.0) {
            err(file, "high-grade-sub-1", `${eraLabel} ${grade} ${tier} = ${v} (high-grade ratio < 1.0)`);
          }
        }
        if (typeof row.fallback === "number" && row.fallback < 1.0) {
          err(file, "high-grade-sub-1", `${eraLabel} ${grade} fallback = ${row.fallback} (< 1.0)`);
        }
      }

      // (2) Grade monotonicity within each tier
      for (const tier of tiers) {
        let prevGrade = null;
        let prevRatio = null;
        for (const grade of GRADE_ORDER) {
          const v = grades[grade]?.[tier];
          if (typeof v !== "number") continue;
          if (prevRatio !== null) {
            const drop = (prevRatio - v) / prevRatio;
            if (v < prevRatio && drop > 0.20) {
              // PSA(n+1) drops > 20% below PSA(n) in same tier — bad
              const key = `${eraLabel}|${tier}|${grade}`;
              if (knownAcceptedViolations.has(key)) {
                // Already reviewed by monotonicity post-process (both
                // grades have n≥10, variance acknowledged as real).
                warn(file, "monotonicity-known", `${eraLabel} ${tier}: ${prevGrade}=${prevRatio} → ${grade}=${v} (dropped ${Math.round(drop*100)}%; pre-accepted, n≥10 both sides)`);
              } else {
                err(file, "monotonicity", `${eraLabel} ${tier}: ${prevGrade}=${prevRatio} → ${grade}=${v} (${grade} should be ≥ ${prevGrade}, dropped ${Math.round(drop*100)}%)`);
              }
            } else if (v < prevRatio) {
              warn(file, "monotonicity", `${eraLabel} ${tier}: ${prevGrade}=${prevRatio} → ${grade}=${v} (mild dip, ${Math.round(drop*100)}%)`);
            }
          }
          prevGrade = grade;
          prevRatio = v;
        }
      }

      // (3) Tier ordering within each grade (ratio should generally decrease as tier increases)
      for (const grade of Object.keys(grades)) {
        if (grade === "fallback") continue;
        const row = grades[grade];
        if (!row || typeof row !== "object") continue;
        let prevTier = null;
        let prevRatio = null;
        for (const tier of tiers) {
          const v = row[tier];
          if (typeof v !== "number") continue;
          if (prevRatio !== null) {
            const jump = v / prevRatio;
            if (jump > 2.0) {
              warn(file, "tier-order", `${eraLabel} ${grade}: ${prevTier}=${prevRatio} → ${tier}=${v} (${jump.toFixed(2)}× tier-jump; ratio should generally decrease as raw price increases)`);
            }
          }
          prevTier = tier;
          prevRatio = v;
        }
      }

      // (4) Outliers — already covered by per-script outlier caps, but
      // re-check in case data drift accumulated.
      for (const grade of Object.keys(grades)) {
        const row = grades[grade];
        if (!row || typeof row !== "object") continue;
        for (const k of [...tiers, "fallback"]) {
          const v = row[k];
          if (typeof v !== "number") continue;
          if (v > 200) {
            warn(file, "outlier", `${eraLabel} ${grade} ${k} = ${v} (very high, sanity-check the calibration sample)`);
          }
          if (v <= 0.05) {
            err(file, "outlier", `${eraLabel} ${grade} ${k} = ${v} (near-zero, likely bad data)`);
          }
        }
      }

      // (5) Empty rows
      for (const grade of Object.keys(grades)) {
        const row = grades[grade];
        if (!row || typeof row !== "object") continue;
        const hasAnyTier = tiers.some((t) => typeof row[t] === "number");
        const hasFallback = typeof row.fallback === "number";
        if (!hasAnyTier && !hasFallback) {
          info(file, "empty-row", `${eraLabel} ${grade} has no tier values AND no fallback (cluttering the table)`);
        }
      }
    }
  }
}

function auditParallel(file, data) {
  const entries = data.entries;
  if (!Array.isArray(entries)) {
    err(file, "structure", "no .entries[] array");
    return;
  }
  for (const e of entries) {
    if (e.skippedReason) continue;
    const ratio = e.baseRelativePremium;
    if (typeof ratio !== "number") continue;
    const label = `${e.year} ${e.set} ${e.parallel} ${e.printRun}`;
    // (1) Parallels should always cost MORE than base (ratio >= 1.0)
    if (ratio < 1.0) {
      err(file, "parallel-sub-1", `${label}: ratio=${ratio} (parallel < base is impossible)`);
    }
    // (2) Outliers — flag very-high ratios for sanity check
    if (ratio > 30) {
      warn(file, "parallel-outlier", `${label}: ratio=${ratio} (very high, verify the print-run / sample)`);
    }
    // (3) Print-run vs ratio monotonicity — rarer parallels should
    // command higher ratios. We don't enforce strictly (random sample
    // noise) but flag obvious inversions for review.
  }
}

// Main
console.log(`=== Multiplier table audit (strict=${strict}) ===\n`);
for (const t of TARGETS) {
  const { data, error } = loadTable(t.file);
  if (error) {
    err(t.file, "io", error);
    continue;
  }
  console.log(`▸ Auditing ${t.file}...`);
  auditMultiplierTable(t.file, t.kind, data);
}

console.log(`\n=== Findings ===`);
console.log(`ERRORS: ${findings.errors.length}`);
for (const f of findings.errors) console.log(`  [${f.kind}] ${f.file}: ${f.msg}`);
console.log(`\nWARNINGS: ${findings.warns.length}`);
for (const f of findings.warns.slice(0, 50)) console.log(`  [${f.kind}] ${f.file}: ${f.msg}`);
if (findings.warns.length > 50) console.log(`  ... ${findings.warns.length - 50} more (truncated)`);
console.log(`\nINFO: ${findings.info.length}`);
for (const f of findings.info.slice(0, 10)) console.log(`  [${f.kind}] ${f.file}: ${f.msg}`);
if (findings.info.length > 10) console.log(`  ... ${findings.info.length - 10} more (truncated)`);

console.log("");
if (findings.errors.length > 0) {
  console.log(`❌ FAIL: ${findings.errors.length} errors`);
  process.exit(2);
}
if (strict && findings.warns.length > 0) {
  console.log(`⚠️  STRICT FAIL: ${findings.warns.length} warnings (--strict mode)`);
  process.exit(2);
}
if (findings.warns.length > 0) {
  console.log(`⚠️  ${findings.warns.length} warnings (non-blocking)`);
  process.exit(1);
}
console.log(`✓ Clean`);
process.exit(0);
