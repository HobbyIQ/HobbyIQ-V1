#!/usr/bin/env node
/**
 * rebaseline-i9-reference.cjs — record a fresh I9 reference under the CURRENT
 * derivation stamp, and report the old->new delta as a FINDING.
 *
 * CF-A-REFERENCE-MUST-SAY-WHAT-IT-WAS-MEASURED-UNDER (2026-09-07, I9 P1).
 *
 * WHY A SCRIPT AND NOT AN AUTOMATIC WRITE INSIDE THE AUDITOR. The corpus audit
 * has NO WRITE PATH AT ALL and its pins assert that (a recording fake sees zero
 * writes; the source contains no .patch/.upsert/.replace/.create/.delete). A
 * re-baseline that wrote from inside it would break the one property that makes
 * a read-only auditor trustworthy. So the auditor DETECTS the stale reference
 * and names the stamp owed; this script is the separate, explicit act that
 * records the new one.
 *
 * WHAT IT WRITES. `data/rematch-census-shares.json` only — a repo file, in a
 * PR, reviewed like any other diff. It never writes Cosmos.
 *
 * WHAT IT REFUSES.
 *   - APPLY unset: reports the delta and writes nothing (the default).
 *   - A stamp that already matches: there is nothing to re-baseline, and
 *     overwriting a comparable reference with a fresh sample would launder a
 *     REAL regression into a new baseline. This is the refusal that keeps the
 *     fix from becoming a silencer, and it is pinned.
 *   - A sample too small to be a corpus reference (MIN_ROWS, default 20,000).
 *
 * The delta between the old shares and the new ones is printed per sportClass
 * and written into the new table's `supersedes` block, so the history of what
 * each vocabulary change did to the corpus is readable from the file itself.
 *
 * Usage (read-only report):
 *   node scripts/rebaseline-i9-reference.cjs --from artifacts/census-slot-*.json
 * Apply:
 *   APPLY=true node scripts/rebaseline-i9-reference.cjs --from ...
 */
const fs = require("fs");
const path = require("path");

const DV = require(path.join(__dirname, "lib", "derivation-version.cjs"));

const TABLE_PATH = path.join(__dirname, "..", "data", "rematch-census-shares.json");
const APPLY = String(process.env.APPLY ?? "").toLowerCase() === "true";
const MIN_ROWS = Number(process.env.MIN_ROWS ?? 20000);
const CLASSES = ["AGREE", "IMPROVE", "CONFLICT", "UNDERIVABLE"];

function args() {
  const out = { from: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--from") { while (a[i + 1] && !a[i + 1].startsWith("--")) out.from.push(a[++i]); }
    else if (a[i] === "--force-stamp") out.forceStamp = true;
  }
  return out;
}

/** Shares from a `{AGREE, IMPROVE, ...}` count block over `classified` rows. */
function sharesOf(counts, classified) {
  const out = {};
  for (const k of CLASSES) out[k] = classified > 0 ? Number((Number(counts?.[k] ?? 0) / classified).toFixed(6)) : 0;
  return out;
}

/** Row-weighted average of `slots[].shares` weighted by `classified`. */
function weightedOf(slots) {
  const out = {};
  let total = 0;
  for (const s of slots) total += Number(s.classified ?? 0);
  for (const k of CLASSES) {
    let acc = 0;
    for (const s of slots) acc += Number(s.shares?.[k] ?? 0) * Number(s.classified ?? 0);
    out[k] = total > 0 ? Number((acc / total).toFixed(6)) : 0;
  }
  return { weighted: out, total };
}

function main() {
  const { from, forceStamp } = args();
  const current = DV.currentStamp();
  const old = fs.existsSync(TABLE_PATH) ? JSON.parse(fs.readFileSync(TABLE_PATH, "utf8")) : null;
  const oldStamp = old?.measuredUnder?.stamp ?? null;

  console.log(`I9 REFERENCE RE-BASELINE  ${new Date().toISOString()}`);
  console.log(`  current stamp   ${current.combined ?? "(uncomputable)"}`);
  console.log(`  reference stamp ${oldStamp ?? "(unstamped)"}`);
  if (DV.missingInputs().length) {
    console.error(`REFUSED — declared derivation inputs missing: ${DV.missingInputs().join(", ")}`);
    process.exit(2);
  }

  const agreement = DV.stampsAgree(oldStamp, current);
  console.log(`  comparable      ${agreement.comparable}${agreement.reason ? ` (${agreement.reason})` : ""}`);

  // THE REFUSAL THAT KEEPS THIS FROM BEING A SILENCER. A reference already at
  // the current stamp is COMPARABLE, so any drift against it is a real finding
  // about the corpus. Re-recording it would convert that finding into the new
  // normal — laundering a regression. Only an explicit --force-stamp (for a
  // deliberate re-measure of the same code) gets past it.
  if (agreement.comparable && !forceStamp) {
    console.error("REFUSED — the reference is already at the current derivation stamp.");
    console.error("  Nothing changed the derivation, so a drift against it is a REAL corpus finding,");
    console.error("  and re-recording it would launder that finding into the baseline.");
    console.error("  Re-measure the same code deliberately with --force-stamp.");
    process.exit(3);
  }

  if (!from.length) {
    console.log("\nNo --from artifacts given: reporting the stamp comparison only.");
    console.log(agreement.comparable
      ? "  The reference is current; the alarm is live."
      : "  The reference is NOT comparable; I9's alarm is suppressed and a re-baseline is owed.");
    console.log(`  Re-run with --from <census-slot-*.json ...> to record one under ${current.combined}.`);
    return;
  }

  const slots = [];
  for (const spec of from) {
    for (const file of (fs.existsSync(spec) && fs.statSync(spec).isDirectory()
      ? fs.readdirSync(spec).map((n) => path.join(spec, n)) : [spec])) {
      if (!file.endsWith(".json")) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.error(`  skip (unreadable) ${file}`); continue; }
      const classified = Number(j.classified ?? 0);
      if (!classified || j.slot === undefined || !j.counts) { console.error(`  skip (not a census slot artifact) ${file}`); continue; }
      slots.push({
        slot: Number(j.slot), runId: j.runId ?? null, measuredAt: j.measuredAt ?? null,
        classified, counts: j.counts, shares: sharesOf(j.counts, classified),
        classMix: j.classMix ?? null,
      });
    }
  }
  slots.sort((a, b) => a.slot - b.slot);
  const { weighted, total } = weightedOf(slots);
  console.log(`\n  slots read      ${slots.length}`);
  console.log(`  rows classified ${total.toLocaleString()}`);

  if (total < MIN_ROWS) {
    console.error(`REFUSED — ${total} rows is below MIN_ROWS ${MIN_ROWS}; that is a sample, not a corpus reference.`);
    process.exit(4);
  }

  // THE DELTA IS THE FINDING. What the vocabulary changes did to the corpus,
  // stated in the same units the alarm uses.
  console.log("\n  OLD -> NEW (the re-baseline finding):");
  for (const k of CLASSES) {
    const o = Number(old?.weighted?.[k] ?? 0), n = Number(weighted[k] ?? 0);
    const d = n - o;
    console.log(`    ${k.padEnd(12)} ${(100 * o).toFixed(1)}%  ->  ${(100 * n).toFixed(1)}%   `
      + `${d >= 0 ? "+" : ""}${(100 * d).toFixed(1)}pp`);
  }

  const next = {
    _doc: old?._doc ?? "Per-slot classification from the GREAT REMATCH IMPROVE fleet.",
    source: `rematch IMPROVE fleet census artifacts, ${slots.length}/${slots.length} slots`,
    measuredAt: new Date().toISOString().slice(0, 10),
    measuredUnder: {
      stamp: current.combined, derivation: current.derivation, contract: current.contract,
      commit: process.env.GITHUB_SHA ?? null,
      note: "Recorded by scripts/rebaseline-i9-reference.cjs. The alarm compares only "
        + "against a reference carrying THIS stamp; a stamp change makes the drift a finding, not an alarm.",
    },
    container: old?.container ?? "sold_comps",
    slotCount: slots.length,
    classifiedTotal: total,
    weighted,
    bySportClass: old?.bySportClass ?? null,
    supersedes: old ? {
      stamp: oldStamp, measuredAt: old.measuredAt ?? null, classifiedTotal: old.classifiedTotal ?? null,
      weighted: old.weighted ?? null,
      delta: Object.fromEntries(CLASSES.map((k) =>
        [k, Number((Number(weighted[k] ?? 0) - Number(old?.weighted?.[k] ?? 0)).toFixed(6))])),
      reason: agreement.reason,
    } : null,
    slots,
  };

  if (!APPLY) {
    console.log("\nDRY RUN — set APPLY=true to write data/rematch-census-shares.json.");
    return;
  }
  fs.writeFileSync(TABLE_PATH, `${JSON.stringify(next, null, 1)}\n`, "utf8");
  console.log(`\nWROTE ${TABLE_PATH} under stamp ${current.combined}`);
}

if (require.main === module) main();
module.exports = { sharesOf, weightedOf, TABLE_PATH };
