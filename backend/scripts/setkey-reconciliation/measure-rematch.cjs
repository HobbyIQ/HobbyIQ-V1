#!/usr/bin/env node
/**
 * RE-MATCH MEASUREMENT — read-only, no writes, no dispatches.
 *
 * The question #1689 left open: of the 2.6M pool rows whose checklist is
 * already in card_catalog under a key the deriver no longer emits, how many
 * find a checklist-backed destination once the reconciliation is applied?
 *
 * The method, and the reason it is honest:
 *
 *   A cell is (sport, cardYear, derivedSetKey) over sold_comps. For each cell
 *   we ask the SAME question twice — "is there a checklist-backed card_catalog
 *   row at this (sport, year, setKey)?" — once with the BASELINE deriver
 *   (dist built from the pre-change commit) and once with the RECONCILED one.
 *   The delta is rows that were unreachable and now are not.
 *
 *   `nowBacked` counts rows whose cell gains a checklist-backed destination.
 *   It is a CEILING on matched comps, not a promise: a checklist unblocks a
 *   comp only if that comp's cardNumber and parallel appear on it. #1689 made
 *   the same caveat about its class E and it applies here unchanged.
 *
 * Env: BASELINE_DIST=<path to a dist built from the pre-change commit>
 */
const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "out");

const BASELINE_DIST = process.env.BASELINE_DIST;
if (!BASELINE_DIST) { console.error("BASELINE_DIST required (a dist built from the pre-change commit)"); process.exit(1); }

const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const baseline = require(path.join(BASELINE_DIST, "services/portfolioiq/hobbyIqCardId.service.js"));
const reconciled = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
if (baseline.normalizeSetKey.toString().includes("reconcileSetKey")) {
  throw new Error("BASELINE_DIST already consumes the reconciliation — the measurement would be circular");
}

const catalog = require(path.join(OUT_DIR, "catalog.json"));
const pool = require(path.join(OUT_DIR, "pool.json"));

// Which (sport, year, setKey) cells hold a CHECKLIST-BACKED catalog row?
const backed = new Set();
for (const r of catalog) {
  if (catalogAuthorityOf(r.source) !== "checklist") continue;
  const k = String(r.setKey || "").trim().toLowerCase();
  if (!k) continue;
  backed.add(`${r.sport ?? ""}|${r.cardYear ?? ""}|${k}`);
}

// Pool demand, both vocabularies.
const cells = new Map();
for (const r of pool) {
  const setName = String(r.setName || "");
  if (!setName) continue;
  const before = baseline.normalizeSetKey(setName);
  const after = reconciled.normalizeSetKey(setName);
  const sport = r.sport ?? "", year = r.cardYear ?? "";
  const id = `${sport}|${year}|${before}`;
  let c = cells.get(id);
  if (!c) { c = { sport, year, before, after: new Map(), rows: 0, samples: [] }; cells.set(id, c); }
  c.rows += r.n;
  c.after.set(after, (c.after.get(after) || 0) + r.n);
  if (c.samples.length < 3) c.samples.push(setName);
}

// A cell "moves" when it had no checklist-backed destination before and its
// rows now land on one.
const moved = [];
for (const c of cells.values()) {
  const wasBacked = backed.has(`${c.sport}|${c.year}|${c.before}`);
  if (wasBacked) continue; // already matchable — not part of the gap
  let nowBacked = 0;
  const dests = [];
  for (const [dest, n] of c.after) {
    if (backed.has(`${c.sport}|${c.year}|${dest}`)) { nowBacked += n; dests.push(dest); }
  }
  if (nowBacked > 0) {
    moved.push({
      cell: `${c.sport}|${c.year}|${c.before}`,
      poolRows: c.rows, nowBacked,
      landsOn: [...new Set(dests)].slice(0, 3),
      sampleTitles: c.samples,
    });
  }
}
moved.sort((a, b) => b.nowBacked - a.nowBacked);

const totalNowBacked = moved.reduce((a, m) => a + m.nowBacked, 0);
const unbackedRows = [...cells.values()]
  .filter((c) => !backed.has(`${c.sport}|${c.year}|${c.before}`))
  .reduce((a, c) => a + c.rows, 0);

// -- WHERE THE REST OF THE GAP ACTUALLY IS -----------------------------------
//
// #1689 projected 2,621,638 rows in the "present under a stale key" class. This
// measurement recovers far fewer, and the difference is a finding, not a
// shortfall: the two biggest sub-classes are NOT reachable by a
// normalizeSetKey change at all.
//
//  (a) POOL-SIDE spellings. The 2.03M Pokemon rows are the largest single
//      class, and the stale key is on the POOL side, not the catalog side, so
//      they never enter the 2,646. The catalog files Pokemon under ZERO-PADDED
//      official codes (`sv08`, `sv02`, `me02-5`) and the pool asks for the long
//      marketing name (`pokemon-scarlet-violet-surging-sparks`). BOTH spellings
//      are already normalizeSetKey fixed points, so no rewrite here can join
//      them — it needs a code<->name map, which is its own piece of work and
//      its own ruling (Drew's bare-code ruling says the code side wins).
//
//  (b) SAME KEY, DIFFERENT YEAR. The key IS checklist-backed for the sport,
//      just not for that cardYear — the checklist for that season is genuinely
//      missing. That is #1689's class E (acquisition), not vocabulary.
//
// Both are measured here so the PR cannot overstate what it fixes.
const backedKeySport = new Set();
for (const r of catalog) {
  if (catalogAuthorityOf(r.source) !== "checklist") continue;
  const k = String(r.setKey || "").trim().toLowerCase();
  if (k) backedKeySport.add(`${r.sport ?? ""}|${k}`);
}
let sameKeyWrongYear = 0, keyNeverBackedForSport = 0;
for (const c of cells.values()) {
  if (backed.has(`${c.sport}|${c.year}|${c.before}`)) continue;
  if (backedKeySport.has(`${c.sport}|${c.before}`)) sameKeyWrongYear += c.rows;
  else keyNeverBackedForSport += c.rows;
}

const report = {
  $comment: "READ-ONLY re-match measurement. nowBacked is a CEILING on matched comps: a checklist unblocks a comp only if that comp's cardNumber and parallel appear on it.",
  generatedAt: "2026-09-03",
  poolRowsWithNoChecklistBackedDestination: unbackedRows,
  cellsThatGainABackedDestination: moved.length,
  poolRowsThatGainABackedDestination: totalNowBacked,
  whereTheRestOfTheGapIs: {
    $comment: "Not reachable by a normalizeSetKey change. Measured so this PR cannot overstate its own effect.",
    sameKeyChecklistBackedForSportButNotThatYear: sameKeyWrongYear,
    keyHasNoChecklistRowForThatSportAtAll: keyNeverBackedForSport,
    note: "The largest single class inside the second number is Pokemon (2.03M): the catalog files zero-padded official codes (sv08, sv02, me02-5) and the pool asks the long marketing name. Both spellings are ALREADY fixed points, so this needs a code<->name map, not a deriver rewrite.",
  },
  top30: moved.slice(0, 30),
};
fs.writeFileSync(path.join(OUT_DIR, "rematch-measurement.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({
  poolRowsWithNoChecklistBackedDestination: unbackedRows,
  cellsThatGainABackedDestination: moved.length,
  poolRowsThatGainABackedDestination: totalNowBacked,
}, null, 1));
console.log("\nTOP 30 CELLS");
for (const m of report.top30) {
  console.log(`  ${m.cell.padEnd(46)} poolRows=${String(m.poolRows).padStart(8)}  nowBacked=${String(m.nowBacked).padStart(8)}  -> ${m.landsOn.join(", ")}`);
}
