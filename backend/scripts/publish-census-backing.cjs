#!/usr/bin/env node
/**
 * publish-census-backing.cjs -- trims merge-census-backing.cjs's own
 * `topUnbackedCells` table down to a small, COMMITTED data file the GAP
 * ROUTER (route-backing-gaps.cjs) reads as its primary input.
 *
 * READ ONLY. Reads one merge-census-backing.cjs report off disk and writes
 * ONE trimmed JSON table; touches no Cosmos, no live config, nothing under
 * APPLY. There is no write mode at all -- this script has no APPLY branch to
 * gate, because it never talks to Cosmos in the first place.
 *
 * WHY THIS EXISTS. merge-census-backing.cjs's own report
 * (backing-merged/backing-report.json in the evidence run this script was
 * built against) is 142 KB and carries every sport, including pokemon and
 * the long tail of mis-tagged non-sport strings the census's own `sport`
 * field accumulates (soccer (足球), multi-sport, na, breaking, ...). The GAP
 * ROUTER's job is sports-only triage, and a committed input the router reads
 * on every invocation should carry only the rows the router can ever act on
 * -- never a live re-derivation (CF-A-REFERENCE-MUST-SAY-WHAT-IT-WAS-
 * MEASURED-UNDER), so this script's OWN job is narrow: filter and shrink,
 * nothing else.
 *
 * TRIM RULE, matching topUnbackedCells' own definition of "unbacked"
 * (merge-census-backing.cjs: unbacked = noRow + rowExistsNonStrict):
 *   1. sports only -- the cell's OWN `sport` field (not report.bySport's
 *      keys, which include every mis-tagged variant string the census ever
 *      saw) must be one of baseball/basketball/football/hockey/soccer.
 *      pokemon and everything else (non-sport, multi-sport, breaking, ...)
 *      is excluded. This is a per-CELL predicate, not a per-report one: a
 *      cell's own sport segment is read straight off `cell.sport` (which
 *      itself comes from `cell.split("|")[0]` in the merge tool), never
 *      inferred from setKey text.
 *   2. unbacked >= MIN_UNBACKED (default 200) -- the long tail below this
 *      floor is too small for a single cell to be worth a dispatch of its
 *      own; the router's job is triage of the cells big enough to matter.
 *
 * SIZE GUARD. The written file must stay under 3 MB. If the trimmed table
 * would exceed it, this script does NOT silently truncate the list -- it
 * raises MIN_UNBACKED in fixed steps, re-filters, and LOGS every step it
 * took plus the threshold it landed on, so the committed file's own
 * provenance says why some cells beneath the stated floor might still be
 * missing. (Measured against the 2026-09-20 evidence run: 166 sports rows,
 * ~80 KB written -- nowhere near the cap. The escalation path exists for a
 * future, larger merge report, not for this run.)
 *
 * Usage (mirrors merge-census-backing.cjs's own --from/--out CLI style):
 *   node scripts/publish-census-backing.cjs --from <backing-report.json> [--out backend/data/census/backing-cells.json] [--min-unbacked 200]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SPORTS = new Set(["baseball", "basketball", "football", "hockey", "soccer"]);
const DEFAULT_MIN_UNBACKED = 200;
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB

function args() {
  const out = { from: null, out: null, minUnbacked: DEFAULT_MIN_UNBACKED };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--from") out.from = a[++i];
    else if (a[i] === "--out") out.out = a[++i];
    else if (a[i] === "--min-unbacked") out.minUnbacked = Number(a[++i]);
  }
  return out;
}

/**
 * PURE: which rows of a merge-census-backing.cjs report's `topUnbackedCells`
 * survive the trim, at a given floor. Exported so the trim predicate itself
 * -- sports-only, unbacked >= floor -- is unit-testable without touching
 * disk. `report.topUnbackedCells` rows already carry `unbacked` (noRow +
 * rowExistsNonStrict, per that script's own topUnbackedCells) and `sport`
 * (the cell's own sport segment, never re-derived here).
 */
function trimmedRows(report, minUnbacked) {
  const rows = Array.isArray(report?.topUnbackedCells) ? report.topUnbackedCells : [];
  return rows
    .filter((r) => SPORTS.has(String(r?.sport ?? "").trim().toLowerCase()))
    .filter((r) => Number(r?.unbacked ?? 0) >= minUnbacked)
    .map((r) => ({
      cell: r.cell,
      sport: String(r.sport).trim().toLowerCase(),
      year: r.year,
      setKey: r.setKey,
      unbacked: Number(r.unbacked ?? 0),
      noRow: Number(r.noRow ?? 0),
      rowExistsNonStrict: Number(r.rowExistsNonStrict ?? 0),
      unknown: Number(r.unknown ?? 0),
      total: Number(r.total ?? 0),
    }))
    .sort((a, b) => b.unbacked - a.unbacked);
}

/**
 * Escalate MIN_UNBACKED in fixed steps until the trimmed table's serialised
 * size is under MAX_BYTES, or until the escalation stops shrinking the list
 * at all (every candidate step already excluded) -- whichever comes first.
 * Returns `{ rows, minUnbackedUsed, steps }`, `steps` being every
 * (threshold, rowCount, bytes) tried, in order, so the caller can log the
 * whole escalation rather than only the final answer.
 */
function trimToFit(report, startMinUnbacked) {
  const STEP_MULTIPLIER = 2;
  const MAX_STEPS = 12;
  const steps = [];
  let floor = Math.max(1, Number(startMinUnbacked) || DEFAULT_MIN_UNBACKED);
  let rows = trimmedRows(report, floor);
  let bytes = Buffer.byteLength(JSON.stringify(rows));
  steps.push({ minUnbacked: floor, rowCount: rows.length, bytes });
  let tries = 0;
  while (bytes > MAX_BYTES && rows.length > 0 && tries < MAX_STEPS) {
    floor *= STEP_MULTIPLIER;
    const next = trimmedRows(report, floor);
    if (next.length === rows.length) break; // escalating further would not shrink anything
    rows = next;
    bytes = Buffer.byteLength(JSON.stringify(rows));
    steps.push({ minUnbacked: floor, rowCount: rows.length, bytes });
    tries++;
  }
  return { rows, minUnbackedUsed: floor, steps };
}

function main() {
  const { from, out, minUnbacked } = args();
  if (!from) {
    console.error("Usage: node scripts/publish-census-backing.cjs --from <backing-report.json> [--out backend/data/census/backing-cells.json] [--min-unbacked 200]");
    process.exit(2);
  }
  if (!fs.existsSync(from)) {
    console.error(`FATAL: --from path does not exist: ${from}`);
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(from, "utf8"));
  } catch (e) {
    console.error(`FATAL: could not parse --from as JSON: ${String(e?.message ?? e)}`);
    process.exit(2);
  }
  if (!Array.isArray(report?.topUnbackedCells)) {
    console.error("FATAL: input has no topUnbackedCells array -- is this a merge-census-backing.cjs report?");
    process.exit(3);
  }

  const outPath = out ? path.resolve(out) : path.resolve(process.cwd(), "backend/data/census/backing-cells.json");
  const { rows, minUnbackedUsed, steps } = trimToFit(report, minUnbacked);

  console.log("");
  console.log("=".repeat(78));
  console.log("  PUBLISH CENSUS BACKING -- trimmed sports-only unbacked-cell table");
  console.log("=".repeat(78));
  console.log(`  input             ${from}`);
  console.log(`  input rows        ${(report.topUnbackedCells ?? []).length} (topUnbackedCells, every sport incl. pokemon/non-sport)`);
  console.log(`  sports allowed    ${[...SPORTS].join(", ")}`);
  if (steps.length > 1) {
    console.log(`  SIZE GUARD FIRED: escalated MIN_UNBACKED to keep the file under ${MAX_BYTES.toLocaleString()} bytes (3 MB):`);
    for (const s of steps) {
      console.log(`    minUnbacked=${s.minUnbacked.toLocaleString().padStart(9)}  rows=${String(s.rowCount).padStart(4)}  bytes=${s.bytes.toLocaleString()}`);
    }
    console.log(`  NOTE: some cells at or above the ORIGINAL --min-unbacked (${minUnbacked}) are excluded by this`);
    console.log(`        escalation -- see the steps above for exactly which threshold this run landed on.`);
  } else {
    console.log(`  minUnbacked       ${minUnbackedUsed.toLocaleString()} (no escalation needed)`);
  }
  console.log(`  output rows       ${rows.length}`);

  const payload = {
    _doc: "publish-census-backing.cjs output. Trimmed, sports-only, "
      + `unbacked >= ${minUnbackedUsed} view of a merge-census-backing.cjs report's `
      + "topUnbackedCells (unbacked = noRow + rowExistsNonStrict, matching that "
      + "script's own definition). Consumed by route-backing-gaps.cjs as its "
      + "primary input -- READ ONLY, never re-derived live. pokemon and every "
      + "non-sports cell are excluded by design; see this script's own header "
      + "for the trim rule and the size-guard escalation path.",
    generatedAt: new Date().toISOString(),
    sourceFile: path.resolve(from),
    sourceGeneratedAt: report.generatedAt ?? null,
    minUnbackedUsed,
    sportsAllowed: [...SPORTS],
    rowCount: rows.length,
    cells: rows,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  const bytesWritten = fs.statSync(outPath).size;
  console.log(`  wrote             ${outPath}`);
  console.log(`  bytes written     ${bytesWritten.toLocaleString()}  (cap ${MAX_BYTES.toLocaleString()})`);
  if (bytesWritten > MAX_BYTES) {
    // Should be unreachable given trimToFit's own loop, but never silently
    // ship an oversized file if it happens anyway (e.g. non-cell metadata
    // growth) -- name it loudly rather than let a reviewer discover it later.
    console.error(`  !! wrote ${bytesWritten.toLocaleString()} bytes, OVER the ${MAX_BYTES.toLocaleString()}-byte cap -- investigate before committing this file.`);
    process.exit(4);
  }
}

if (require.main === module) {
  main();
}
module.exports = { SPORTS, DEFAULT_MIN_UNBACKED, MAX_BYTES, trimmedRows, trimToFit };
