#!/usr/bin/env node
// CF-CHROME-DRAFT-WORKSHEET-AUDIT (2026-06-29) — compare the hand-
// curated chromeDraftMultipliers worksheet against the empirical
// parallel-premiums-latest.json data. Surface stale entries where
// the worksheet's multiplier disagrees with the empirical median by
// more than 30%.
//
// Background: chromeDraftMultipliers.ts:60-127 is a 54-entry static
// table of (parallelName, baseMultiplier, refractorMultiplier) values.
// Hand-curated by Drew under Issue #25 Phase 3. The empirical
// parallel-premiums table (PR #192 + ongoing v2/v3 refreshes) gives
// us calibrated `baseRelativePremium` ratios from live CH data.
//
// Engine consumption: chromeDraftMultipliers' baseMultiplier is the
// fallback ratio for autograph parallels when the empirical table
// has no matching entry. When BOTH are present, the engine prefers
// the empirical value (via tryEmpiricalParallelLookup). So entries
// covered by the empirical table are effectively superseded; this
// audit identifies where the FALLBACK values are stale.
//
// Per the audit's findings, Drew triages each surfaced drift:
//   - Update worksheet to match empirical (refresh the fallback)
//   - OR: keep worksheet, flag empirical as suspicious (rare —
//     usually the empirical is more current)
//   - OR: investigate why they disagree (real engine drift?)
//
// Exit codes mirror audit-multiplier-tables.cjs:
//   0  — no drift > 30%
//   1  — drift only in low-priority entries
//   2  — drift > 30% in high-priority entries
//
// Usage: node scripts/audit-chromedraft-worksheet.cjs

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const WORKSHEET_PATH = path.join(ROOT, "src/services/compiq/chromeDraftMultipliers.ts");
const EMPIRICAL_PATH = path.join(DATA, "parallel-premiums-latest.json");

// Parse the worksheet's RAW_ENTRIES via regex (avoids ts-node dep)
function loadWorksheet() {
  const src = fs.readFileSync(WORKSHEET_PATH, "utf8");
  const start = src.indexOf("const RAW_ENTRIES");
  const end = src.indexOf("];", start);
  if (start < 0 || end < 0) throw new Error("RAW_ENTRIES block not found in worksheet");
  const block = src.slice(start, end);
  const entries = [];
  const re = /parallelName:\s*"([^"]+)"[^}]+baseMultiplier:\s*([\d.]+)[^}]+refractorMultiplier:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    entries.push({
      parallelName: m[1],
      baseMultiplier: Number(m[2]),
      refractorMultiplier: Number(m[3]),
    });
  }
  return entries;
}

// Normalize parallel name for cross-table matching.
function normalize(name) {
  return name.toLowerCase()
    .replace(/\s+refractor$/i, "")  // worksheet has bare names; empirical adds "Refractor"
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadEmpirical() {
  if (!fs.existsSync(EMPIRICAL_PATH)) {
    throw new Error(`empirical data not found: ${EMPIRICAL_PATH}`);
  }
  const data = JSON.parse(fs.readFileSync(EMPIRICAL_PATH, "utf8"));
  return Array.isArray(data.entries) ? data.entries : [];
}

function main() {
  console.log("=== Chrome-Draft Worksheet Audit ===\n");

  const worksheet = loadWorksheet();
  const empirical = loadEmpirical();
  console.log(`Worksheet entries: ${worksheet.length}`);
  console.log(`Empirical entries (raw): ${empirical.length}`);

  // CF-AUDIT-CHROMEDRAFT-PRODUCT-FAMILY-FIX (2026-06-29): scope guard.
  // Worksheet is owner-authored for "Topps Bowman Chrome / Bowman Draft
  // Chrome" only (chromeDraftMultipliers.ts:5-8). Empirical data spans
  // multiple product families (Bowman Chrome Prospects, Bowman Draft
  // Chrome, Topps Chrome, Topps Chrome Update). The PRIOR audit
  // normalized by parallel name alone and picked the highest-sample
  // empirical entry across ALL families — for "Green Wave" that meant
  // Topps Chrome Update (n=30) winning over Bowman Chrome Prospects
  // (n=27), producing a phantom -57.8% drift on what's actually a
  // -29.5% drift (within the 30% tolerance). Filter empirical to the
  // worksheet's scope BEFORE choosing the best entry.
  const IN_SCOPE_SET_PATTERN = /(bowman chrome (prospects )?baseball|bowman draft chrome baseball|bowman chrome$|bowman draft chrome$)/i;
  const inScope = empirical.filter((e) => {
    if (e.skippedReason || e.baseRelativePremium == null) return false;
    return IN_SCOPE_SET_PATTERN.test(String(e.set ?? ""));
  });
  console.log(`Empirical entries in worksheet scope (Bowman Chrome / Bowman Draft Chrome): ${inScope.length} of ${empirical.length}`);

  // Index by normalized name. If multiple in-scope entries match a name
  // (e.g., different years), pick the highest-sample entry.
  const empiricalAutoByName = new Map();
  for (const e of inScope) {
    const key = normalize(e.parallel);
    if (!empiricalAutoByName.has(key)) {
      empiricalAutoByName.set(key, { entries: [] });
    }
    empiricalAutoByName.get(key).entries.push(e);
  }
  console.log(`Empirical entries (in-scope, normalized & grouped by name): ${empiricalAutoByName.size}`);

  const findings = { drift: [], match: [], worksheetOnly: [], empiricalOnly: [] };

  for (const w of worksheet) {
    const key = normalize(w.parallelName);
    const empMatch = empiricalAutoByName.get(key);
    if (!empMatch) {
      findings.worksheetOnly.push({ parallelName: w.parallelName, baseMultiplier: w.baseMultiplier });
      continue;
    }
    // Use the highest-sample-size empirical entry as the comparison
    const best = empMatch.entries.sort((a, b) => b.sampleSize - a.sampleSize)[0];
    const ratio = best.baseRelativePremium / w.baseMultiplier;
    const driftPct = (ratio - 1) * 100;
    const absDrift = Math.abs(driftPct);
    if (absDrift <= 30) {
      findings.match.push({
        parallelName: w.parallelName,
        worksheet: w.baseMultiplier,
        empirical: best.baseRelativePremium,
        driftPct: Math.round(driftPct * 10) / 10,
        sampleSize: best.sampleSize,
      });
    } else {
      findings.drift.push({
        parallelName: w.parallelName,
        worksheet: w.baseMultiplier,
        empirical: best.baseRelativePremium,
        driftPct: Math.round(driftPct * 10) / 10,
        sampleSize: best.sampleSize,
        empiricalSet: best.set,
      });
    }
    empiricalAutoByName.delete(key);
  }

  // Anything left in the empirical map is in calibration but not in
  // the worksheet — informational only.
  for (const [key, g] of empiricalAutoByName) {
    const best = g.entries.sort((a, b) => b.sampleSize - a.sampleSize)[0];
    findings.empiricalOnly.push({
      parallel: best.parallel,
      year: best.year,
      set: best.set,
      baseRelativePremium: best.baseRelativePremium,
      sampleSize: best.sampleSize,
    });
  }

  console.log(`\n=== Findings ===`);
  console.log(`Within ±30% drift (worksheet ≈ empirical): ${findings.match.length}`);
  console.log(`DRIFT > 30%: ${findings.drift.length}`);
  console.log(`Worksheet entries with no empirical counterpart: ${findings.worksheetOnly.length}`);
  console.log(`Empirical-only (not in worksheet): ${findings.empiricalOnly.length}`);

  if (findings.drift.length > 0) {
    console.log("\n--- DRIFT > 30% (auto baseMultiplier vs empirical baseRelativePremium) ---");
    findings.drift.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));
    for (const d of findings.drift) {
      const sign = d.driftPct > 0 ? "+" : "";
      console.log(`  ${d.parallelName.padEnd(28)}  worksheet=${d.worksheet.toString().padStart(7)}  empirical=${d.empirical.toString().padStart(7)}  drift=${sign}${d.driftPct}%  (n=${d.sampleSize}, ${d.empiricalSet ?? "?"})`);
    }
  }

  if (findings.match.length > 0 && process.argv.includes("-v")) {
    console.log("\n--- WITHIN ±30% (informational, -v) ---");
    for (const m of findings.match) {
      const sign = m.driftPct > 0 ? "+" : "";
      console.log(`  ${m.parallelName.padEnd(28)}  worksheet=${m.worksheet}  empirical=${m.empirical}  drift=${sign}${m.driftPct}%  (n=${m.sampleSize})`);
    }
  }

  if (findings.empiricalOnly.length > 0) {
    console.log(`\n--- Empirical-only entries (worksheet doesn't have these) ---`);
    findings.empiricalOnly.sort((a, b) => b.sampleSize - a.sampleSize);
    for (const e of findings.empiricalOnly.slice(0, 20)) {
      console.log(`  ${e.year} ${e.set} · ${e.parallel.padEnd(38)}  ${e.baseRelativePremium}× (n=${e.sampleSize})`);
    }
    if (findings.empiricalOnly.length > 20) {
      console.log(`  ... ${findings.empiricalOnly.length - 20} more`);
    }
  }

  if (findings.worksheetOnly.length > 0) {
    console.log(`\n--- Worksheet entries with no empirical match (uncalibrated yet) ---`);
    for (const w of findings.worksheetOnly) {
      console.log(`  ${w.parallelName.padEnd(28)} baseMultiplier=${w.baseMultiplier}`);
    }
  }

  // Exit code
  const highImpactDrift = findings.drift.filter(d => Math.abs(d.driftPct) > 50);
  if (highImpactDrift.length > 0) {
    console.log(`\n[FAIL] ${highImpactDrift.length} entries with drift > 50%`);
    process.exit(2);
  }
  if (findings.drift.length > 0) {
    console.log(`\n[WARN] ${findings.drift.length} entries with 30-50% drift (review recommended)`);
    process.exit(1);
  }
  console.log(`\n[OK] No significant worksheet/empirical drift detected`);
  process.exit(0);
}

main();
