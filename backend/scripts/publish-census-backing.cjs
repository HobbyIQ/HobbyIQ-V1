#!/usr/bin/env node
/**
 * publish-census-backing.cjs -- turns a merge-census-backing.cjs report into
 * the small, COMMITTED per-cell table the GAP ROUTER
 * (route-backing-gaps.cjs) reads as its primary input.
 *
 * READ ONLY. Reads one report off disk and writes ONE JSON table; touches no
 * Cosmos, no live config. There is no write mode to gate.
 *
 * TWO INPUT SHAPES, preferred first:
 *   1. report.allSportsUnbackedCells -- merge-census-backing.cjs's compact
 *      columns+rows table of EVERY sports cell with >= 50 unbacked sales
 *      (added 2026-09-20 alongside this script). This is the real input: the
 *      router exists for the long tail, and the long tail is exactly what a
 *      top-N cuts off.
 *   2. report.topUnbackedCells -- the top-300 human worklist. Used ONLY when
 *      (1) is absent (a report written before the merge tool emitted it), and
 *      the written file is then stamped `placeholder: true` with
 *      `derivedFrom: "topUnbackedCells"`, and the banner says so loudly: a
 *      top-300-derived table reaches only as far down the tail as the 300th
 *      cell across ALL verticals (166 sports cells on the 2026-09-20 report,
 *      the smallest at several thousand unbacked sales).
 *
 * TRIM RULE, matching the merge tool's own definition (unbacked = noRow +
 * rowExistsNonStrict):
 *   - sports only: the cell's OWN sport segment must be one of
 *     baseball/basketball/football/hockey/soccer. pokemon and every
 *     mis-tagged variant string are excluded.
 *   - unbacked >= --min-unbacked (default 50, the merge tool's own floor).
 *
 * PER CELL, `unbackedShareOfSportGap` = cell.unbacked / that sport's whole
 * gap (report.bySport[sport].noRow + rowExistsNonStrict) -- so the router's
 * banner can say how far down a sport's tail a run reached. The sport totals
 * ride along as `sportGap`.
 *
 * OUTPUT FORM is columns+rows, one row per line: tens of thousands of cells
 * as objects would repeat every key per row, and one-row-per-line keeps the
 * committed file's diff readable when a new merge regenerates it.
 *
 * SIZE GUARD. The written file must stay under 3 MB. Over it, this script
 * does NOT silently truncate -- it doubles the floor, re-filters, LOGS every
 * step, and records the floor it landed on in the file itself.
 *
 * Usage (mirrors merge-census-backing.cjs's own --from/--out style):
 *   node scripts/publish-census-backing.cjs --from <backing-report.json> [--out data/census/backing-cells.json] [--min-unbacked 50]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SPORTS = new Set(["baseball", "basketball", "football", "hockey", "soccer"]);
const DEFAULT_MIN_UNBACKED = 50;
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB
const COLUMNS = ["sport", "year", "setKey", "unbacked", "noRow", "rowExistsNonStrict", "backedStrict", "total", "unbackedShareOfSportGap"];

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

/** PURE. Decode either input shape into plain cell objects, and say which
 *  shape it was. `backedStrict` is null for the top-300 shape, which does
 *  not carry it. */
function sourceCells(report) {
  const all = report?.allSportsUnbackedCells;
  if (all && Array.isArray(all.columns) && Array.isArray(all.rows)) {
    const idx = Object.fromEntries(all.columns.map((c, i) => [c, i]));
    return {
      derivedFrom: "allSportsUnbackedCells",
      cells: all.rows.map((r) => ({
        sport: r[idx.sport], year: r[idx.year], setKey: r[idx.setKey],
        unbacked: Number(r[idx.unbacked] ?? 0), noRow: Number(r[idx.noRow] ?? 0),
        rowExistsNonStrict: Number(r[idx.rowExistsNonStrict] ?? 0),
        backedStrict: idx.backedStrict === undefined ? null : Number(r[idx.backedStrict] ?? 0),
        total: Number(r[idx.total] ?? 0),
      })),
    };
  }
  const top = Array.isArray(report?.topUnbackedCells) ? report.topUnbackedCells : null;
  if (!top) return { derivedFrom: null, cells: [] };
  return {
    derivedFrom: "topUnbackedCells",
    cells: top.map((r) => ({
      sport: r.sport, year: r.year, setKey: r.setKey,
      unbacked: Number(r.unbacked ?? 0), noRow: Number(r.noRow ?? 0),
      rowExistsNonStrict: Number(r.rowExistsNonStrict ?? 0),
      backedStrict: null, total: Number(r.total ?? 0),
    })),
  };
}

/** PURE. Each sport's WHOLE gap (noRow + rowExistsNonStrict) off
 *  report.bySport -- the denominator of unbackedShareOfSportGap. */
function sportGapOf(report) {
  const out = {};
  for (const sport of SPORTS) {
    const b = report?.bySport?.[sport];
    out[sport] = b ? Number(b.noRow ?? 0) + Number(b.rowExistsNonStrict ?? 0) : 0;
  }
  return out;
}

/** PURE. Sports-only, unbacked >= floor, ranked, with the share stamped. */
function trimmedRows(report, minUnbacked) {
  const gap = sportGapOf(report);
  return sourceCells(report).cells
    .map((c) => ({ ...c, sport: String(c.sport ?? "").trim().toLowerCase(), year: String(c.year), setKey: String(c.setKey ?? "") }))
    .filter((c) => SPORTS.has(c.sport) && c.setKey && c.unbacked >= minUnbacked)
    .map((c) => ({ ...c, unbackedShareOfSportGap: gap[c.sport] > 0 ? Number((c.unbacked / gap[c.sport]).toFixed(6)) : null }))
    .sort((a, b) => b.unbacked - a.unbacked);
}

const toRow = (c) => COLUMNS.map((k) => c[k] ?? null);
const bytesOf = (rows) => rows.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(toRow(c))) + 2, 0);

/** Double the floor until the rows fit under MAX_BYTES (or doubling stops
 *  shrinking the list). Every step tried is returned so the caller logs the
 *  whole escalation, never only its answer. */
function trimToFit(report, startMinUnbacked, maxBytes = MAX_BYTES) {
  const steps = [];
  let floor = Math.max(1, Number(startMinUnbacked) || DEFAULT_MIN_UNBACKED);
  let rows = trimmedRows(report, floor);
  let bytes = bytesOf(rows);
  steps.push({ minUnbacked: floor, rowCount: rows.length, bytes });
  for (let tries = 0; bytes > maxBytes - 4096 && rows.length > 0 && tries < 16; tries++) {
    floor *= 2;
    rows = trimmedRows(report, floor);
    bytes = bytesOf(rows);
    steps.push({ minUnbacked: floor, rowCount: rows.length, bytes });
  }
  return { rows, minUnbackedUsed: floor, steps };
}

/** PURE. The router's reader: columns+rows back into cell objects, with the
 *  `cell` key ("sport|year|setKey") the census uses. */
function decodeCells(payload) {
  const cols = Array.isArray(payload?.columns) ? payload.columns : [];
  return (payload?.rows ?? []).map((r) => {
    const c = Object.fromEntries(cols.map((k, i) => [k, r[i]]));
    c.cell = `${c.sport}|${c.year}|${c.setKey}`;
    return c;
  });
}

function main() {
  const { from, out, minUnbacked } = args();
  if (!from) {
    console.error("Usage: node scripts/publish-census-backing.cjs --from <backing-report.json> [--out data/census/backing-cells.json] [--min-unbacked 50]");
    process.exit(2);
  }
  if (!fs.existsSync(from)) { console.error(`FATAL: --from path does not exist: ${from}`); process.exit(2); }
  let report;
  try { report = JSON.parse(fs.readFileSync(from, "utf8")); }
  catch (e) { console.error(`FATAL: could not parse --from as JSON: ${String(e?.message ?? e)}`); process.exit(2); }

  const { derivedFrom, cells: inputCells } = sourceCells(report);
  if (!derivedFrom) {
    console.error("FATAL: input has neither allSportsUnbackedCells nor topUnbackedCells -- is this a merge-census-backing.cjs report?");
    process.exit(3);
  }
  const placeholder = derivedFrom !== "allSportsUnbackedCells";

  const outPath = path.resolve(out ?? path.join(__dirname, "..", "data", "census", "backing-cells.json"));
  const { rows, minUnbackedUsed, steps } = trimToFit(report, minUnbacked);
  const sportGap = sportGapOf(report);

  console.log("");
  console.log("=".repeat(78));
  console.log("  PUBLISH CENSUS BACKING -- sports-only unbacked-cell table for the gap router");
  console.log("=".repeat(78));
  console.log(`  input             ${from}`);
  console.log(`  derived from      report.${derivedFrom}  (${inputCells.length.toLocaleString()} input rows)`);
  if (placeholder) {
    console.log("  !! PLACEHOLDER: this report predates allSportsUnbackedCells, so the table below is cut");
    console.log("     from the TOP-300 worklist and carries NONE of the long tail. Re-run");
    console.log("     merge-census-backing.cjs on the slot artifacts and publish again to replace it.");
  }
  console.log(`  sports allowed    ${[...SPORTS].join(", ")}`);
  if (steps.length > 1) {
    console.log(`  SIZE GUARD FIRED: the floor was raised to keep the file under ${MAX_BYTES.toLocaleString()} bytes:`);
    for (const s of steps) console.log(`    minUnbacked=${String(s.minUnbacked).padStart(7)}  rows=${String(s.rowCount).padStart(6)}  bytes=${s.bytes.toLocaleString()}`);
  } else {
    console.log(`  minUnbacked       ${minUnbackedUsed} (no escalation needed)`);
  }
  console.log(`  output rows       ${rows.length.toLocaleString()}`);
  for (const sport of SPORTS) {
    const mine = rows.filter((c) => c.sport === sport);
    const covered = mine.reduce((n, c) => n + c.unbacked, 0);
    const pct = sportGap[sport] > 0 ? `${((100 * covered) / sportGap[sport]).toFixed(1)}%` : "n/a";
    console.log(`    ${sport.padEnd(11)} ${String(mine.length).padStart(6)} cells  ${covered.toLocaleString().padStart(11)} unbacked of a ${sportGap[sport].toLocaleString()}-sale gap  (${pct})`);
  }

  const head = {
    _doc: "publish-census-backing.cjs output: sports-only cells with unbacked >= minUnbackedUsed "
      + "(unbacked = noRow + rowExistsNonStrict), ranked, columns+rows. unbackedShareOfSportGap = "
      + "cell.unbacked / sportGap[sport]. backedStrict is null when derivedFrom is topUnbackedCells, "
      + "which does not carry it. Read by route-backing-gaps.cjs; never re-derived live. "
      + "placeholder=true means this was cut from the top-300 worklist and holds NO long tail.",
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(from),
    sourceGeneratedAt: report.generatedAt ?? null,
    derivedFrom, placeholder, minUnbackedUsed,
    sportsAllowed: [...SPORTS], sportGap,
    rowCount: rows.length, columns: COLUMNS,
  };
  const headJson = JSON.stringify(head, null, 2);
  const body = `${headJson.slice(0, headJson.lastIndexOf("\n}"))},\n  "rows": [\n${rows.map((c) => `    ${JSON.stringify(toRow(c))}`).join(",\n")}\n  ]\n}\n`;
  JSON.parse(body); // never write a file the router cannot read

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
  const bytesWritten = fs.statSync(outPath).size;
  console.log(`  wrote             ${outPath}`);
  console.log(`  bytes written     ${bytesWritten.toLocaleString()}  (cap ${MAX_BYTES.toLocaleString()})`);
  if (bytesWritten > MAX_BYTES) {
    console.error(`  !! OVER the ${MAX_BYTES.toLocaleString()}-byte cap -- do not commit this file.`);
    process.exit(4);
  }
}

if (require.main === module) main();
module.exports = { SPORTS, DEFAULT_MIN_UNBACKED, MAX_BYTES, COLUMNS, sourceCells, sportGapOf, trimmedRows, trimToFit, decodeCells };
