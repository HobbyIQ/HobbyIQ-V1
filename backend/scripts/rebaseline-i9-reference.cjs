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

/**
 * THE VINTAGE BOUNDARY THE REFERENCE IS BUILT ON. A unit is `pokemon` when the
 * shard axis says so, `vintage` when its cardYear is before 2000, `modern`
 * otherwise. This is not a new choice: it is the rule the shipped 2026-09-06
 * reference was built under, recovered by reproducing all 32 of its `classMix`
 * entries exactly (any other cutoff mismatches at least one slot), and pinned
 * below so a future re-baseline cannot silently re-bucket the corpus and make
 * two references incomparable while both claim the same class names.
 */
const VINTAGE_BEFORE = 2000;

/** Which sportClass frame one shard unit belongs to. */
function classOfUnit(unit) {
  if (String(unit?.sportClass ?? "") === "pokemon") return "pokemon";
  const y = unit?.year;
  return y !== null && y !== undefined && Number(y) < VINTAGE_BEFORE ? "vintage" : "modern";
}

/**
 * A slot's sportClass mix, apportioned BY ROWS across the units it holds.
 *
 * WHY DERIVED AND NOT CARRIED FORWARD. The mix is a property of the SHARD AXIS
 * in the artifacts being read, so re-recording a reference while keeping the
 * previous run's mix would describe last week's frame with this week's counts.
 * Slot 0 is 484,940 pokemon rows plus 39,000 rows of 1953 -- 93/7, never 50/50.
 */
function classMixOf(units) {
  if (!Array.isArray(units) || !units.length) return null;
  const acc = {};
  let total = 0;
  for (const u of units) {
    const rows = Number(u?.rows ?? 0);
    if (!rows) continue;
    acc[classOfUnit(u)] = (acc[classOfUnit(u)] ?? 0) + rows;
    total += rows;
  }
  if (!total) return null;
  const out = {};
  for (const k of Object.keys(acc)) out[k] = Number((acc[k] / total).toFixed(6));
  return out;
}

/**
 * The per-sportClass reference: each slot's classified rows apportioned across
 * the classes its units belong to, then row-weighted within each class.
 *
 * `slots` lists each slot under its DOMINANT class only -- it is a reader's
 * index of where a slot mostly lives, not the apportionment, which is by rows.
 */
function bySportClassOf(slots) {
  const acc = {};
  const dominant = {};
  for (const s of slots) {
    const mix = s.classMix;
    if (!mix) continue;
    let best = null;
    for (const [cls, w] of Object.entries(mix)) {
      const rows = Number(s.classified ?? 0) * Number(w);
      const a = acc[cls] ?? (acc[cls] = { classified: 0, sum: {} });
      a.classified += rows;
      for (const k of CLASSES) a.sum[k] = (a.sum[k] ?? 0) + Number(s.shares?.[k] ?? 0) * rows;
      if (!best || Number(w) > best[1]) best = [cls, Number(w)];
    }
    if (best) (dominant[best[0]] ?? (dominant[best[0]] = [])).push(Number(s.slot));
  }
  if (!Object.keys(acc).length) return null;
  const out = {};
  for (const cls of Object.keys(acc).sort()) {
    const a = acc[cls];
    const shares = {};
    for (const k of CLASSES) shares[k] = a.classified > 0 ? Number((a.sum[k] / a.classified).toFixed(6)) : 0;
    out[cls] = {
      classified: Math.round(a.classified),
      shares,
      slots: (dominant[cls] ?? []).sort((x, y) => x - y),
    };
  }
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
      // HOW MUCH OF THE SLOT THIS ACTUALLY SAW. A census run walks its slot
      // until it finishes or hits its budget, and a slot that stopped at budget
      // classified a PREFIX of its rows, not a sample of them. Recording
      // `classified` alone would present a 34%-walked slot and a finished one
      // as equally authoritative references. `coverage` can exceed 1: rows land
      // in the container between the shard table's row estimate and the walk.
      const expectedRows = j.expectedRows === undefined || j.expectedRows === null
        ? null : Number(j.expectedRows);
      slots.push({
        slot: Number(j.slot), runId: j.runId ?? null, measuredAt: j.measuredAt ?? null,
        generatedAt: j.generatedAt ?? null,
        classified,
        expectedRows,
        coverage: expectedRows && expectedRows > 0
          ? Number((classified / expectedRows).toFixed(4)) : null,
        stoppedAtBudget: j.stoppedAtBudget === undefined ? null : Boolean(j.stoppedAtBudget),
        counts: j.counts, shares: sharesOf(j.counts, classified),
        classMix: j.classMix ?? classMixOf(j.units),
      });
    }
  }
  slots.sort((a, b) => a.slot - b.slot);
  const { weighted, total } = weightedOf(slots);

  // WHAT FRACTION OF THE CORPUS THIS REFERENCE ACTUALLY SAW, and which slots
  // are partial. A reference built from budget-stopped walks is still a valid
  // reference -- every slot's shares are over the rows it did classify -- but a
  // reader comparing against it is entitled to know that 18 of 32 slots stopped
  // early, and which. Stated, never silently averaged away.
  const expectedTotal = slots.reduce((a, s) => a + Number(s.expectedRows ?? 0), 0);
  const partialSlots = slots.filter((s) => s.stoppedAtBudget === true).map((s) => s.slot);
  const generatedAts = slots.map((s) => s.generatedAt).filter(Boolean).sort();
  const window = generatedAts.length
    ? { from: generatedAts[0], to: generatedAts[generatedAts.length - 1] } : null;
  const coverage = {
    expectedRows: expectedTotal || null,
    classified: total,
    coverage: expectedTotal > 0 ? Number((total / expectedTotal).toFixed(4)) : null,
    completedSlots: slots.filter((s) => s.stoppedAtBudget === false).map((s) => s.slot),
    partialSlots,
    window,
    note: "Per-slot `coverage` is classified/expectedRows; `stoppedAtBudget` says the walk "
      + "hit its budget rather than finishing the slot. A partial slot's shares are still "
      + "over the rows it classified, so they are comparable -- but they describe a PREFIX "
      + "of the slot, and a reader weighing this reference should see which slots those are.",
  };

  console.log(`\n  slots read      ${slots.length}`);
  console.log(`  rows classified ${total.toLocaleString()}`
    + (expectedTotal ? ` of ${expectedTotal.toLocaleString()} expected `
      + `(${(100 * total / expectedTotal).toFixed(0)}%)` : ""));
  console.log(`  walks completed ${coverage.completedSlots.length}`
    + `, stopped at budget ${partialSlots.length}`
    + (partialSlots.length ? ` [${partialSlots.join(",")}]` : ""));
  if (window) console.log(`  artifact window ${window.from} .. ${window.to}`);

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

  /** `2026-09-08T18:22Z..2026-09-09T12:41Z` — minute precision, as the _doc reads. */
  const minuteZ = (iso) => `${String(iso).slice(0, 16)}Z`;
  const windowText = window
    ? `${minuteZ(window.from)}..${minuteZ(window.to)}`
    : "(window unknown)";

  const next = {
    _doc: "CF-THE-REFERENCE-IS-THE-WHOLE-CORPUS-NOT-ONE-SLOT (2026-09-06). Per-slot "
      + "classification from the GREAT REMATCH IMPROVE fleet, recovered from each run's "
      + "rematch-census-slot-<N>-<runId> artifact (file census-slot-<N>.json, fields "
      + "classified + counts.*). One entry per shard-table slot, latest run per slot in the "
      + `window ${windowText}. \`weighted\` is the row-weighted corpus average -- the reference `
      + "a whole-corpus draw is compared against; `slots[].shares` is what a SINGLE-SLOT draw "
      + "must be compared against instead. NOT EVERY SLOT FINISHED ITS WALK: `slots[].coverage` "
      + "is classified/expectedRows and `slots[].stoppedAtBudget` says the run hit its budget "
      + "first, so a partial slot's shares describe a PREFIX of that slot; `coverage` at the "
      + "top states the corpus fraction and names the partial slots. NOTE the four classes do "
      + "not sum to 1: the runs report UNDERIVABLE-for-subset in byTier and leave it out of "
      + "counts, so a share of rows is in none of the four. The shares are therefore comparable "
      + "to each other and to a sample classified the same way, which is what frameHealth does.",
    source: `rematch IMPROVE fleet census artifacts, ${slots.length}/${slots.length} slots, `
      + `${window ? `${window.from.slice(0, 10)}/${window.to.slice(8, 10)}` : "window unknown"}`,
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
    coverage,
    weighted,
    // DERIVED FROM THESE ARTIFACTS, never carried forward: the per-class
    // reference must describe the frame that was actually measured.
    bySportClass: bySportClassOf(slots) ?? old?.bySportClass ?? null,
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
module.exports = {
  sharesOf, weightedOf, classMixOf, bySportClassOf, classOfUnit, VINTAGE_BEFORE, TABLE_PATH,
};
