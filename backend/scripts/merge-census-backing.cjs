#!/usr/bin/env node
/**
 * merge-census-backing.cjs -- sums the 32 slot artifacts' `backing` block
 * (written by rematch-sold-comps.cjs MODE=census SOURCES=backing, 2026-09-19
 * census batch) into ONE table: sports overall, per sport, and the top N
 * unbacked (sport, year, setKey) cells with a P0/P1/N/R class split.
 *
 * READ ONLY. Reads census-slot-*.json files off disk and writes ONE report
 * file; touches no Cosmos, no live config, nothing under APPLY.
 *
 * INPUT SHAPE (per slot artifact, `backing` key -- absent/null on a slot run
 * without SOURCES=backing, which this script reports rather than silently
 * treats as zero):
 *   { bySport: { "<sport>": {backedStrict, rowExistsNonStrict, noRow,
 *                             unparseable, parked, notPricedFlagged,
 *                             unknown}, ... },
 *     byCell:  { "<sport>|<year>|<setKey>": {same 7 buckets}, ...,
 *                "other"?: {same 7 buckets} },
 *     cellCap, cellOverflowed, preload: {failedCells, failedCellSamples, ...} }
 *
 * THE SEVEN BUCKETS, corrected 2026-09-19 per review:
 *   backedStrict        card_catalog row exists, strict-checklist-sourced
 *   rowExistsNonStrict  card_catalog row exists, not strict
 *   noRow               the cell loaded successfully; no row for this id
 *   unparseable         no hobbyiqCardId, or no readable cell (the U class)
 *   parked              identityUnverified===true
 *   notPricedFlagged    flaggedWrong===true or excludedFromFmv===true
 *   unknown             the cell's card_catalog load FAILED this census run
 *                        (retries exhausted) -- NEVER folded into noRow
 *
 * THE HEADLINE DENOMINATOR EXCLUDES parked, notPricedFlagged AND unknown.
 * Every printed share and every `report.overall*` field states BOTH the
 * included-in-denominator total and the excluded total explicitly, by name
 * -- never a single unlabelled percentage. A merge that only prints one
 * number invites exactly the ambiguity this design is trying to avoid: an
 * `unknown` share hidden inside `noRow` would silently overstate "the
 * catalog doesn't have this card" when the real fact is "this run could not
 * find out."
 *
 * CLASS SPLIT ON THE TOP-N UNBACKED CELLS (P0/P1/N/R), per the go:
 *   P0  no product rows at all               noRow === cell total (rowExistsNonStrict+backedStrict === 0)
 *   P1  product rows exist, none strict       rowExistsNonStrict > 0 && backedStrict === 0
 *   N   number missing from the loaded set    (see NOTE below -- needs the per-cell id set, not just counts)
 *   R   rung missing (number present under another parallel)
 *
 * NOTE ON N vs R. The per-slot artifact carries ONLY THE SEVEN BUCKET COUNTS
 * for a cell, not the set of card numbers/parallels the census loaded to
 * decide `noRow`/`rowExistsNonStrict` for each sale -- deliberately: carrying
 * a per-cell id set through 32 artifacts and a merge would be exactly the
 * unbounded-detail-in-an-artifact shape rematch-sold-comps.cjs's own
 * CENSUS_CURSOR_MAX_BYTES guard exists to refuse. So this script's N/R split
 * is a REPORT-ONLY, SEPARATE, OPTIONAL step: it re-queries card_catalog once
 * per flagged cell (top N only, never the full pool) to ask "does this
 * setKey/year have ANY row carrying this sale's card number, under a
 * DIFFERENT parallel" -- R if yes, N if no. Gated behind CATALOG_CHECK=true
 * because it is the one part of this script that touches Cosmos at all; the
 * default run emits P0/P1 only and marks N/R "unknown (pass CATALOG_CHECK=true)".
 *
 * Usage:
 *   node scripts/merge-census-backing.cjs --from artifacts/census-slot-*.json
 *   node scripts/merge-census-backing.cjs --from <dir> --top 300 --out <path>
 *   CATALOG_CHECK=true node scripts/merge-census-backing.cjs --from <dir>   (adds N/R split; needs COSMOS_CONNECTION_STRING)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const BUCKETS = [
  "backedStrict", "rowExistsNonStrict", "noRow", "unparseable",
  "parked", "notPricedFlagged", "unknown",
];
/** The four buckets a headline "backed" share is computed OVER. Every other
 *  bucket (parked, notPricedFlagged, unknown) is a sale nothing prices or a
 *  sale this run could not answer for -- excluded by name, never silently. */
const DENOMINATOR_BUCKETS = ["backedStrict", "rowExistsNonStrict", "noRow", "unparseable"];
const EXCLUDED_BUCKETS = ["parked", "notPricedFlagged", "unknown"];

function args() {
  const out = { from: [], top: 300, out: null, allMin: 50 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--from") { while (a[i + 1] && !a[i + 1].startsWith("--")) out.from.push(a[++i]); }
    else if (a[i] === "--top") out.top = Number(a[++i]);
    else if (a[i] === "--all-min") out.allMin = Number(a[++i]);
    else if (a[i] === "--out") out.out = a[++i];
  }
  return out;
}

function emptyBuckets() {
  const b = {};
  for (const k of BUCKETS) b[k] = 0;
  return b;
}

function addInto(acc, b) {
  for (const k of BUCKETS) acc[k] += Number(b?.[k] ?? 0);
  return acc;
}

/** Sum of ALL seven buckets -- "every sale backing saw", denominator and
 *  excluded together. Use `denominatorOf`/`excludedOf` when the question is
 *  "what fraction is backed", never this for a share computation. */
function totalOf(b) {
  return BUCKETS.reduce((a, k) => a + Number(b?.[k] ?? 0), 0);
}

/** The headline denominator: backedStrict + rowExistsNonStrict + noRow +
 *  unparseable. Named so a caller cannot compute "backed / totalOf(b)" by
 *  accident and silently understate the share by diluting it with
 *  parked/flagged/unknown sales that were never eligible to be "backed" in
 *  the first place. */
function denominatorOf(b) {
  return DENOMINATOR_BUCKETS.reduce((a, k) => a + Number(b?.[k] ?? 0), 0);
}

/** parked + notPricedFlagged + unknown -- the sales the headline share
 *  excludes, stated by name so a reader can see exactly what was left out
 *  and why, never inferred from a gap between two other numbers. */
function excludedOf(b) {
  return EXCLUDED_BUCKETS.reduce((a, k) => a + Number(b?.[k] ?? 0), 0);
}

/** Every ".json" file `spec` resolves to -- a single file, or every ".json"
 *  directly inside a directory. Mirrors rebaseline-i9-reference.cjs's own
 *  `--from` reader so the two scripts' artifact-discovery cannot disagree. */
function filesOf(spec) {
  if (!fs.existsSync(spec)) return [];
  if (fs.statSync(spec).isDirectory()) {
    return fs.readdirSync(spec).filter((n) => n.endsWith(".json")).map((n) => path.join(spec, n));
  }
  return spec.endsWith(".json") ? [spec] : [];
}

function readSlotArtifacts(fromSpecs) {
  const slots = [];
  const skipped = [];
  for (const spec of fromSpecs) {
    for (const file of filesOf(spec)) {
      let j;
      try { j = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { skipped.push({ file, reason: "unreadable" }); continue; }
      if (j.slot === undefined || !j.backing) { skipped.push({ file, reason: "not a backing-armed census artifact" }); continue; }
      // `classified` is the slot's own `stats.seen` (rematch-sold-comps.cjs's
      // `total`) -- carried here so this script can check backing coverage
      // against it without re-deriving anything the writer already computed.
      slots.push({ slot: Number(j.slot), file, backing: j.backing, classified: Number(j.classified) || 0 });
    }
  }
  slots.sort((a, b) => a.slot - b.slot);
  return { slots, skipped };
}

/**
 * THE BACKING-COVERAGE GUARD (2026-09-20, the census self-relaunch
 * backing-loss fix, part 3). Before this, a slot artifact whose `backing`
 * block was PRESENT but INCOMPLETE -- a resumed pass that forwarded
 * `sources` (so `backing` is non-null) but whose backing tallies were not
 * (yet) checkpointed, so they cover only a fraction of what the slot
 * actually classified -- merged in silently: `mergeSlots` sums whatever
 * bucket counts a slot's artifact carries, with no way to tell "this is the
 * whole slot's backing answer" apart from "this is a partial one that
 * happens to look like a normal, small slot".
 *
 * A slot's own artifact already carries the ground truth for "how much did
 * this slot classify" (`classified`, rematch-sold-comps.cjs's `total`) and
 * `rematch-sold-comps.cjs` now asserts, at write time, that its OWN
 * backing total equals that number (INCOMPLETE_BACKING_EXIT_CODE) -- but a
 * merge reading artifacts off disk has no access to that process's exit
 * code, only the files it left behind, so the SAME equality is checked here
 * too, independently, against every slot before any number derived from it
 * is trusted.
 *
 * `null`/absent backing is already caught by `readSlotArtifacts` (skipped,
 * never reaches `slots`) -- this guard is for the artifact that DID pass
 * that check but is still short. `MERGE_CENSUS_BACKING_ALLOW_SHORT=true`
 * is the explicit override, named so a deliberate "merge anyway, I know
 * it's partial" is visible in the command line, never a silent default.
 */
/** The slot's own `backing.bySport`, summed across every sport into one
 *  seven-bucket total -- "how many sales this slot's backing tally
 *  actually covers", independent of `classified` (what the slot itself
 *  says it walked). */
function backingTotalOf(backing) {
  const bySport = backing?.bySport ?? {};
  return totalOf(Object.values(bySport).reduce((acc, b) => addInto(acc, b), emptyBuckets()));
}

function shortSlots(slots) {
  return slots
    .map((s) => {
      const bt = backingTotalOf(s.backing);
      return { slot: s.slot, file: s.file, classified: s.classified, backingTotal: bt, short: s.classified - bt };
    })
    .filter((r) => r.short > 0);
}

/** Sums every slot's bySport/byCell into one table, plus the failed-cell
 *  reporting from each slot's `preload` block. A cell keyed "other" in more
 *  than one slot is the SAME overflow bucket and sums correctly; a cell that
 *  overflowed in one slot but not another is still summed correctly -- it is
 *  simply slightly more visible in the slot(s) where it did not. */
function mergeSlots(slots) {
  const bySport = new Map();
  const byCell = new Map();
  let anyOverflowed = false;
  let totalFailedCells = 0;
  const failedCellSamples = [];
  // THE CURSOR'S OWN FOLD, SUMMED ACROSS SLOTS (2026-09-20, cursor-size
  // follow-up). This is about the CURSOR a slot checkpointed mid-run, never
  // this slot's own ARTIFACT byCell table above (which is always the full,
  // unfolded table -- see rematch-sold-comps.cjs's own comment on the
  // field). Non-zero for a slot only means: at some point during that
  // slot's pass, a checkpoint save had to fold its smallest cells into
  // "other" to fit the cursor's byte cap -- a fact about a RESUME's
  // resolution, not about this merge's own totals (which are exact
  // regardless, by construction of the fold itself).
  let totalCellsFoldedForCheckpoint = 0;
  const slotsWithFolds = [];
  for (const s of slots) {
    for (const [sport, b] of Object.entries(s.backing.bySport ?? {})) {
      addInto(bySport.get(sport) ?? bySport.set(sport, emptyBuckets()).get(sport), b);
    }
    for (const [cell, b] of Object.entries(s.backing.byCell ?? {})) {
      addInto(byCell.get(cell) ?? byCell.set(cell, emptyBuckets()).get(cell), b);
    }
    if (s.backing.cellOverflowed) anyOverflowed = true;
    totalFailedCells += Number(s.backing.preload?.failedCells ?? 0);
    for (const sample of s.backing.preload?.failedCellSamples ?? []) {
      failedCellSamples.push({ slot: s.slot, ...sample });
    }
    const foldedForThisSlot = Number(s.backing.backingByCellFoldedForCheckpoint ?? 0);
    if (foldedForThisSlot > 0) {
      totalCellsFoldedForCheckpoint += foldedForThisSlot;
      slotsWithFolds.push({ slot: s.slot, folded: foldedForThisSlot });
    }
  }
  return { bySport, byCell, anyOverflowed, totalFailedCells, failedCellSamples, totalCellsFoldedForCheckpoint, slotsWithFolds };
}

/** Every non-parked, non-unparseable, non-flagged, non-unknown row that
 *  ISN'T backedStrict, ranked by volume -- the census's own unbacked
 *  worklist. `other` (the overflow bucket) is EXCLUDED from ranking: it is a
 *  real number but names no single product, and mixing it into a per-cell
 *  top-N would misattribute volume to whichever real cell happens to sort
 *  next to it. It is reported once, separately, as its own line. */
function topUnbackedCells(byCell, topN) {
  const rows = [];
  for (const [cell, b] of byCell) {
    if (cell === "other") continue;
    const unbacked = b.noRow + b.rowExistsNonStrict;
    if (unbacked <= 0) continue;
    const [sport, year, setKey] = cell.split("|");
    rows.push({
      cell, sport, year, setKey, unbacked,
      noRow: b.noRow, rowExistsNonStrict: b.rowExistsNonStrict,
      unknown: b.unknown, total: totalOf(b),
    });
  }
  rows.sort((a, b) => b.unbacked - a.unbacked);
  return rows.slice(0, topN);
}

/**
 * THE LONG TAIL, COMPACT (2026-09-20, gap-router follow-up). topUnbackedCells
 * is a top-N (default 300) human worklist -- but route-backing-gaps.cjs
 * exists precisely for the cells BELOW that line, so a top-N is the wrong
 * input for it. This emits EVERY sports cell with >= `minUnbacked` unbacked
 * sales (unbacked = noRow + rowExistsNonStrict, the SAME definition
 * topUnbackedCells uses), in a columns+rows array form: tens of thousands of
 * cells as objects would repeat every key name per row for no information.
 * Sports are named by the cell's OWN sport segment against an explicit set
 * -- bySport's keys carry every mis-tagged variant string the pool ever saw
 * ("soccer (足球)", "multi-sport", ...) and none of those is a sport a repair
 * lane can be dispatched at. "other" (the overflow bucket) is excluded for
 * the same reason topUnbackedCells excludes it.
 */
const SPORTS_CELLS = new Set(["baseball", "basketball", "football", "hockey", "soccer"]);
const ALL_CELLS_COLUMNS = ["sport", "year", "setKey", "unbacked", "noRow", "rowExistsNonStrict", "backedStrict", "unknown", "total"];
function allSportsUnbackedCells(byCell, minUnbacked = 50) {
  const rows = [];
  for (const [cell, b] of byCell) {
    if (cell === "other") continue;
    const [sport, year, setKey] = cell.split("|");
    if (!SPORTS_CELLS.has(sport)) continue;
    const unbacked = b.noRow + b.rowExistsNonStrict;
    if (unbacked < minUnbacked) continue;
    rows.push([sport, year, setKey, unbacked, b.noRow, b.rowExistsNonStrict, b.backedStrict, b.unknown, totalOf(b)]);
  }
  rows.sort((a, b) => b[3] - a[3]);
  return { columns: ALL_CELLS_COLUMNS, minUnbacked, rows };
}

/** OPTIONAL N/R split for the top-N cells, one card_catalog query per
 *  flagged cell (never per sale) -- see the module header's "NOTE ON N vs R".
 *  Classifies a cell P0 (no product rows), P1 (rows exist, none strict), and
 *  additionally reports whether the product's OWN checklist has any row at
 *  all (informs N vs R at the PRODUCT level; a true per-sale N/R needs the
 *  sale's own card number, which this merge step does not carry -- see the
 *  header). Best-effort: a query failure marks the cell "unknown", never
 *  fatal to the merge. */
async function classifyTopCells(rows, catContainer) {
  for (const r of rows) {
    if (r.noRow === r.total) { r.class = "P0"; continue; }
    if (r.rowExistsNonStrict > 0 && r.noRow < r.total) { r.class = "P1"; continue; }
    r.class = "P0"; // noRow-dominant with no strict rows anywhere in the cell
  }
  if (!catContainer) {
    for (const r of rows) r.classDetail = "unknown (pass CATALOG_CHECK=true for a real card_catalog read)";
    return rows;
  }
  for (const r of rows) {
    try {
      const { resources } = await catContainer.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.setKey = @sk AND (c.cardYear = @y OR c.year = @y)",
        parameters: [{ name: "@sk", value: r.setKey }, { name: "@y", value: Number(r.year) }],
      }, { maxItemCount: -1 }).fetchAll();
      const productRows = Number(resources?.[0] ?? 0);
      r.productCatalogRows = productRows;
      r.classDetail = productRows > 0
        ? "product has SOME catalog rows -- a per-sale N/R split needs the sale's own card number (out of scope for this merge step)"
        : "product has NO catalog rows at all";
    } catch (e) {
      r.classDetail = `unknown (card_catalog query failed: ${String(e?.message ?? e)})`;
    }
  }
  return rows;
}

function fmtPct(n, total) { return total > 0 ? `${(100 * n / total).toFixed(1)}%` : "n/a"; }

async function main() {
  const { from, top, out, allMin } = args();
  if (!from.length) {
    console.error("Usage: node scripts/merge-census-backing.cjs --from <census-slot-*.json | dir> [--top 300] [--out path]");
    process.exit(2);
  }
  const { slots, skipped } = readSlotArtifacts(from);
  if (skipped.length) {
    console.log(`  skipped ${skipped.length} file(s) (not backing-armed census artifacts):`);
    for (const s of skipped.slice(0, 10)) console.log(`    ${s.file}  (${s.reason})`);
    if (skipped.length > 10) console.log(`    ... and ${skipped.length - 10} more`);
  }
  if (!slots.length) {
    console.error("REFUSED -- no backing-armed slot artifacts found under the given --from path(s).");
    console.error("  These are written by rematch-sold-comps.cjs MODE=census SOURCES=backing.");
    process.exit(3);
  }

  // THE BACKING-COVERAGE GUARD (see shortSlots' own header). Printed and
  // refused BEFORE any merged number is computed from these slots -- a
  // short slot's bucket counts are still real numbers, and summing them in
  // first and only checking afterwards would let a caller read the printed
  // OVERALL table before ever reaching this refusal.
  const allowShort = String(process.env.MERGE_CENSUS_BACKING_ALLOW_SHORT ?? "").toLowerCase() === "true";
  const short = shortSlots(slots);
  const shortBySlot = new Map(short.map((r) => [r.slot, r]));
  console.log(`\n  BACKING COVERAGE, per slot read (${slots.length} slot(s)):`);
  for (const s of slots) {
    const backingTotal = backingTotalOf(s.backing);
    const row = shortBySlot.get(s.slot);
    const note = row ? `  !! SHORT by ${row.short.toLocaleString()}` : "";
    console.log(`    slot ${String(s.slot).padStart(2)}  classified ${s.classified.toLocaleString().padStart(10)}  backingTotal ${backingTotal.toLocaleString().padStart(10)}${note}`);
  }
  if (short.length) {
    console.error(`\n  !! INCOMPLETE BACKING across ${short.length} slot(s): ${short.map((r) => `slot ${r.slot} (short ${r.short.toLocaleString()})`).join(", ")}.`);
    console.error("  Each of these slots' backing bucket counts cover LESS than what the slot itself classified --");
    console.error("  the artifact is short (a resumed pass whose backing tallies were not fully checkpointed/merged,");
    console.error("  or an older artifact written before rematch-sold-comps.cjs checkpointed backing at all).");
    console.error("  REFUSING to merge -- using it would silently understate this cell's real coverage.");
    console.error("  Pass MERGE_CENSUS_BACKING_ALLOW_SHORT=true to merge anyway (explicit override, never a default).");
    if (!allowShort) process.exit(4);
    console.error("  MERGE_CENSUS_BACKING_ALLOW_SHORT=true set -- merging the short slot(s) anyway, per explicit override.");
  }

  const seenSlots = new Set(slots.map((s) => s.slot));
  const missing = Array.from({ length: 32 }, (_, i) => i).filter((i) => !seenSlots.has(i));

  const { bySport, byCell, anyOverflowed, totalFailedCells, failedCellSamples, totalCellsFoldedForCheckpoint, slotsWithFolds } = mergeSlots(slots);

  const grandTotal = emptyBuckets();
  for (const b of bySport.values()) addInto(grandTotal, b);
  const grandDenominator = denominatorOf(grandTotal);
  const grandExcluded = excludedOf(grandTotal);
  const grandTotalRows = totalOf(grandTotal);

  console.log(`CENSUS BACKING MERGE  ${new Date().toISOString()}`);
  console.log(`  slot artifacts read  ${slots.length}/32${missing.length ? `  MISSING SLOTS: [${missing.join(",")}]` : ""}`);
  console.log(`  rows tallied         ${grandTotalRows.toLocaleString()}`);
  if (anyOverflowed) console.log(`  NOTE: at least one slot's byCell hit its cellCap -- the "other" bucket absorbs its overflow.`);
  // THE CURSOR'S OWN FOLD, ACROSS SLOTS (2026-09-20, cursor-size follow-up).
  // Never affects any total this merge computes (a fold preserves every
  // bucket's total exactly, by construction -- see rematch-sold-comps.cjs's
  // foldBackingByCellToFit) -- named here purely so a reader who sees a
  // slot's own per-cell detail look coarser than expected knows why, rather
  // than suspecting a merge defect.
  if (totalCellsFoldedForCheckpoint > 0) {
    console.log(`  NOTE: ${totalCellsFoldedForCheckpoint.toLocaleString()} cell(s), across slot(s) ${slotsWithFolds.map((s) => s.slot).join(",")}, were folded into "other" INSIDE a mid-run CURSOR checkpoint (never in this slot's own artifact byCell table) to fit the cursor's byte cap -- totals are exact regardless; only that slot's resumed-checkpoint cell RESOLUTION was reduced.`);
  }

  // *** PRINT unknown LOUDLY, ALWAYS, EVEN AT ZERO. *** A silent zero here is
  // indistinguishable from "this script forgot to check" -- printing it
  // unconditionally is what makes a NON-zero unknown impossible to miss.
  console.log(`\n  LOAD FAILURES (backing.preload.failedCells, summed across slots): ${totalFailedCells.toLocaleString()} distinct cell(s) permanently failed this run.`);
  if (totalFailedCells > 0) {
    console.log(`  !! ${grandTotal.unknown.toLocaleString()} sale(s) are bucketed 'unknown' because their cell's card_catalog load failed -- NOT counted as noRow, NOT in the headline denominator.`);
    console.log(`  Failed-cell samples (up to 20 shown; full list in the written report):`);
    for (const s of failedCellSamples.slice(0, 20)) {
      console.log(`    slot ${s.slot}  ${s.cell}  attempt ${s.attempt}  ${s.error}`);
    }
  } else {
    console.log(`  none -- every cell this census touched loaded successfully.`);
  }

  console.log(`\n  OVERALL (sports + pokemon combined):`);
  for (const k of BUCKETS) console.log(`    ${k.padEnd(20)} ${grandTotal[k].toLocaleString().padStart(12)}  ${fmtPct(grandTotal[k], grandTotalRows)}`);
  console.log(`    ---`);
  console.log(`    denominator (backedStrict+rowExistsNonStrict+noRow+unparseable) = ${grandDenominator.toLocaleString()}`);
  console.log(`    excluded    (parked+notPricedFlagged+unknown)                   = ${grandExcluded.toLocaleString()}`);
  const strictClean = fmtPct(grandTotal.backedStrict, grandDenominator);
  console.log(`    strict-clean share, OF THE ${grandDenominator.toLocaleString()}-SALE DENOMINATOR (excludes parked/flagged/unknown): ${strictClean}`);

  console.log(`\n  BY SPORT:`);
  const bySportSorted = [...bySport.entries()].sort((a, b) => totalOf(b[1]) - totalOf(a[1]));
  for (const [sport, b] of bySportSorted) {
    const denom = denominatorOf(b);
    const excl = excludedOf(b);
    console.log(`    ${sport.padEnd(12)} total ${totalOf(b).toLocaleString().padStart(10)}   denom ${denom.toLocaleString().padStart(9)}   backedStrict ${fmtPct(b.backedStrict, denom)}   noRow ${fmtPct(b.noRow, denom)}   excluded(parked+flagged+unknown) ${excl.toLocaleString()}   unparseable(U) ${b.unparseable.toLocaleString()}`);
  }

  const topRows = topUnbackedCells(byCell, top);
  const catalogCheck = String(process.env.CATALOG_CHECK ?? "").toLowerCase() === "true";
  let cat = null;
  if (catalogCheck) {
    const { CosmosClient } = require("@azure/cosmos");
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) { console.error("CATALOG_CHECK=true but COSMOS_CONNECTION_STRING is unset -- refusing the N/R read, P0/P1 only."); }
    else {
      const client = new CosmosClient(conn);
      const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
      cat = db.container("card_catalog");
    }
  }
  await classifyTopCells(topRows, cat);

  console.log(`\n  TOP ${topRows.length} UNBACKED CELLS (by sport|year|setKey, excl. "other"):`);
  for (const r of topRows.slice(0, 20)) {
    console.log(`    ${r.class.padEnd(3)} ${r.cell.padEnd(40)} unbacked ${r.unbacked.toLocaleString().padStart(9)}  (noRow ${r.noRow.toLocaleString()}, rowExistsNonStrict ${r.rowExistsNonStrict.toLocaleString()}, unknown ${r.unknown.toLocaleString()})`);
  }
  if (topRows.length > 20) console.log(`    ... ${topRows.length - 20} more in the written report`);

  console.log(`\n  ALL SPORTS CELLS with >= ${allMin} unbacked sales (report.allSportsUnbackedCells, the gap router's input): ${allSportsUnbackedCells(byCell, allMin).rows.length.toLocaleString()}  [--all-min to change the floor]`);

  const otherBucket = byCell.get("other") ?? null;
  if (otherBucket) {
    console.log(`\n  "other" overflow cell (beyond cellCap, not attributable to one product):`);
    console.log(`    total ${totalOf(otherBucket).toLocaleString()}  noRow ${otherBucket.noRow.toLocaleString()}  rowExistsNonStrict ${otherBucket.rowExistsNonStrict.toLocaleString()}  unknown ${otherBucket.unknown.toLocaleString()}`);
  }

  // *** COMPARABLE WITH THE 15,418-SALE SAMPLE. *** Per the go: the sample
  // measured 49.9% backed, with the unbacked 50.1% split V 19% / N+R 35% /
  // P 28% / U 11%. This full-population run's OWN class split -- backed /
  // row-non-strict / no-row / unparseable(U) / parked / flagged / unknown --
  // is printed per sport AND overall so the two can be set side by side; the
  // sample's V/N/R/P vocabulary does not map one-to-one onto this run's
  // buckets (this run has no per-sale title-contradiction check, so it
  // cannot itself distinguish V from N/R/P the way the sample did), so the
  // comparison is stated as "our U (unparseable) vs the sample's U", not
  // claimed as a full V/N/R/P reproduction.
  console.log(`\n  FULL-POPULATION CLASS SPLIT, for comparison against the 15,418-sale sample (49.9% backed; unbacked 50.1% split V 19% / N+R 35% / P 28% / U 11%):`);
  for (const [sport, b] of bySportSorted) {
    const denom = denominatorOf(b);
    console.log(`    ${sport.padEnd(12)} backed ${fmtPct(b.backedStrict, denom)}   rowExistsNonStrict ${fmtPct(b.rowExistsNonStrict, denom)}   noRow ${fmtPct(b.noRow, denom)}   U(unparseable) ${fmtPct(b.unparseable, denom)}   [of ${denom.toLocaleString()} in-denominator]`);
  }
  console.log(`    OVERALL      backed ${strictClean}   U(unparseable) ${fmtPct(grandTotal.unparseable, grandDenominator)}   [of ${grandDenominator.toLocaleString()} in-denominator]`);
  console.log(`    NOTE: this run's U is "no hobbyiqCardId or no readable (sport,year,setKey) cell" -- comparable in KIND to the sample's U class, not necessarily identical in definition (the sample's V/N/R split requires a per-sale title-contradiction check this census does not run -- see the module's own P0/P1 vs N/R note above).`);

  const distinctCellsAcrossSlots = new Set([...byCell.keys()].filter((k) => k !== "other")).size;

  const report = {
    _doc: "merge-census-backing.cjs output. bySport/overall are the SUM of every "
      + "backing-armed slot's bucket counts (see rematch-sold-comps.cjs SOURCES="
      + "backing). Seven buckets: backedStrict, rowExistsNonStrict, noRow, "
      + "unparseable (the U class), parked, notPricedFlagged, unknown (a "
      + "FAILED card_catalog load for that cell -- never folded into noRow). "
      + "THE HEADLINE DENOMINATOR (overallDenominator/bySport[].denominator) "
      + "EXCLUDES parked+notPricedFlagged+unknown BY NAME -- every share in "
      + "this report is computed over that denominator, never over totalOf(). "
      + "topUnbackedCells is ranked by (noRow+rowExistsNonStrict) volume, "
      + "excluding the 'other' overflow bucket, which is reported separately. "
      + "P0/P1 are computed from the cell's own bucket counts; N/R require a "
      + "per-sale card number this merge step does not carry -- see the module "
      + "header 'NOTE ON N vs R'. This is catalog BACKING only, not the "
      + "title-contradiction strict-clean check, which stays a sample measure.",
    generatedAt: new Date().toISOString(),
    slotsRead: slots.length, missingSlots: missing,
    // BACKING COVERAGE per slot read (see shortSlots' own header) -- empty
    // when every slot's backing tally fully covers what it classified.
    // Non-empty here means this report was written only because
    // MERGE_CENSUS_BACKING_ALLOW_SHORT=true overrode the refusal above --
    // a reader of the JSON alone (no console output) must still be able to
    // see that some slot's numbers are short.
    shortSlots: short,
    cellCap: slots[0]?.backing?.cellCap ?? null, anyOverflowed,
    distinctCellsTouched: distinctCellsAcrossSlots,
    loadFailures: { totalFailedCells, failedCellSamples },
    // THE CURSOR'S OWN FOLD, ACROSS SLOTS (2026-09-20, cursor-size follow-
    // up) -- see the console NOTE printed above for what this does and does
    // not mean. Zero/empty when no slot's mid-run checkpoint ever needed to
    // fold.
    cellsFoldedForCheckpoint: { total: totalCellsFoldedForCheckpoint, bySlot: slotsWithFolds },
    overall: grandTotal,
    overallTotalRows: grandTotalRows,
    overallDenominator: grandDenominator,
    overallExcluded: grandExcluded,
    overallBackedStrictShareOfDenominator: grandDenominator > 0 ? Number((grandTotal.backedStrict / grandDenominator).toFixed(4)) : null,
    bySport: Object.fromEntries(bySportSorted.map(([sport, b]) => [sport, {
      ...b,
      denominator: denominatorOf(b),
      excluded: excludedOf(b),
      backedStrictShareOfDenominator: denominatorOf(b) > 0 ? Number((b.backedStrict / denominatorOf(b)).toFixed(4)) : null,
    }])),
    otherOverflow: otherBucket,
    topUnbackedCells: topRows,
    // EVERY sports cell with >= allMin unbacked sales, compact (see
    // allSportsUnbackedCells' own header) -- publish-census-backing.cjs's
    // input for route-backing-gaps.cjs. topUnbackedCells above is unchanged.
    allSportsUnbackedCells: allSportsUnbackedCells(byCell, allMin),
  };
  const outPath = out ?? path.join(process.cwd(), "census-backing-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  wrote ${outPath}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`FATAL: ${String(e?.stack ?? e)}`); process.exit(1); });
}
module.exports = {
  BUCKETS, DENOMINATOR_BUCKETS, EXCLUDED_BUCKETS,
  emptyBuckets, addInto, totalOf, denominatorOf, excludedOf,
  mergeSlots, topUnbackedCells, readSlotArtifacts, filesOf,
  allSportsUnbackedCells, SPORTS_CELLS, ALL_CELLS_COLUMNS,
  // 2026-09-20 (the census self-relaunch backing-loss fix, part 3): the
  // backing-coverage guard, exported so its refusal rule is pinned on the
  // SHIPPED function rather than a test's re-implementation of it.
  shortSlots, backingTotalOf,
};
