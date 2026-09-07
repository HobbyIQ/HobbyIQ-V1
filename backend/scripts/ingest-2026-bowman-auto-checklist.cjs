#!/usr/bin/env node
// CF-INGEST-2026-BOWMAN-AUTO (Drew, 2026-07-30). Seed card_catalog from
// the definitive 2026 Bowman auto checklist Drew provided. Resolves
// the verify_queue "catalog-gap" backlog on his own CPA holdings +
// primes the whole 2026 Bowman auto product for FMV lookups.
//
// CSV shape: setKey,prefix,cardNumber,player,team,note
//
// setKey mapping (CSV → HobbyIQ):
//   chrome_prospect_autographs   → setKey=bowman, parallel=Base,       printRun=null
//   gold_ink_autographs          → setKey=bowman, parallel=Gold Ink,   printRun=15
//   packfractor_autographs       → setKey=bowman, parallel=Packfractor, printRun=89
//   chrome_rookie_autographs     → setKey=bowman, parallel=Base,       printRun=null
//   paper_prospect_retail_autographs   → setKey=bowman, parallel=Base, printRun=null (retail)
//   paper_rookies_veterans_retail_autographs → setKey=bowman, parallel=Base, printRun=null (retail)
//   draft_pick_pairings_autographs     → setKey=bowman, parallel=Base, printRun=null (dual — primary player only)
//
// Skip (no cardNumber in checklist):
//   all_america_game_autographs, bowman_sterling_autographs,
//   electric_sluggers_autographs, power_chords_autographs,
//   under_the_radar_autographs, ultimate_autograph_book
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   AUTH_SESSION_SECRET          — required (transitive imports)
//   INGEST_APPLY=false           — default dry-run; set true to write (the
//                                  runner's BACKFILL_APPLY is honoured too)

const path = require("path");
const fs = require("fs");
const backend = __dirname + "/..";
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane MINTS card_catalog rows
// from a Drew-verified checklist -- catalog rows are identities every later
// match resolves against -- and declared no budget at all. Its loop is one
// SEQUENTIAL `await upsertCatalogEntry` per CSV row, with no concurrency and no
// cap, so its wall clock is (rows x per-upsert latency) and nothing bounds it
// but the file's length. Before this it could only ever end by being KILLED at
// the 150-minute ceiling: no marker, no reconcile, no finishLane line, and
// #1913's KILLED branch then withholding the re-dispatch.
//
// >>> A PARTIAL RUN HERE IS SHORTER, NOT WRONG. <<<
//
// Nothing is derived across rows. Each entry is deriveCatalogEntry() over one
// CSV line's own fields, and upsertCatalogEntry keys on the derived id, so a
// re-run overwrites each row with itself. The CSV is read in a fixed order, so
// a continuation re-walks the finished prefix at the cost of idempotent
// upserts. No refusal is owed.
//
// THE UNIT IS ONE ENTRY: one deriveCatalogEntry (pure) plus one awaited
// catalog upsert. 30 seconds is generous for a single upsert and is what the
// pre-check reserves -- a lane whose unit is a 400-row page reserves seconds,
// and this one's unit is smaller still.
//
// VERIFY_MS is nominal: this lane reads nothing after its loop.
// Worst case 110 + 0.5 + 1 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 30 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// CF-RUNNER-FLAG-HYGIENE (D18, 2026-08-29). The runner exports BACKFILL_APPLY
// and never INGEST_APPLY, so under the runner this was PERMANENTLY DRY: an
// "APPLY" dispatch printed the plan and wrote nothing. An explicit INGEST_APPLY
// still wins; otherwise the runner's flag; with neither, dry.
const APPLY = (process.env.INGEST_APPLY ?? process.env.BACKFILL_APPLY) === "true";
// Reconciled (D18): intended = entries handed to upsertCatalogEntry, written =
// upserts that returned a row, failed = upserts that returned nothing or
// threw. A row that fails to DERIVE never reaches the write (failed_derive).

const SETKEY_MAP = {
  chrome_prospect_autographs: { setKey: "bowman", parallel: "Base", printRun: null, tag: "hobby" },
  gold_ink_autographs:        { setKey: "bowman", parallel: "Gold Ink", printRun: 15, tag: "hobby" },
  packfractor_autographs:     { setKey: "bowman", parallel: "Packfractor", printRun: 89, tag: "hobby" },
  chrome_rookie_autographs:   { setKey: "bowman", parallel: "Base", printRun: null, tag: "hobby" },
  paper_prospect_retail_autographs: { setKey: "bowman", parallel: "Base", printRun: null, tag: "retail" },
  paper_rookies_veterans_retail_autographs: { setKey: "bowman", parallel: "Base", printRun: null, tag: "retail" },
  draft_pick_pairings_autographs:   { setKey: "bowman", parallel: "Base", printRun: null, tag: "dual" },
};

const SKIP_SETS = new Set([
  "all_america_game_autographs",
  "bowman_sterling_autographs",
  "electric_sluggers_autographs",
  "power_chords_autographs",
  "under_the_radar_autographs",
  "ultimate_autograph_book",
]);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map(line => {
    // Handle commas inside quoted fields — simple parser sufficient for
    // this checklist (no embedded quotes)
    const parts = [];
    let cur = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "," && !inQuotes) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    const row = {};
    header.forEach((h, i) => { row[h] = (parts[i] ?? "").trim(); });
    return row;
  });
}

// DPPA player field is "PlayerA / PlayerB". Return the primary (first).
function splitDualPlayer(playerField) {
  const parts = String(playerField).split(/\s*\/\s*/);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

async function main() {
  const csvPath = path.join(backend, "data/2026-bowman-auto-checklist.csv");
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, "utf-8"));
  console.log(`[ingest-2026-bowman-auto-checklist]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  csv rows: ${rows.length}`);
  console.log(`  ${CLOCK.describe()}\n`);

  const stats = {
    skipped_set: 0,
    skipped_no_cardnumber: 0,
    skipped_no_player: 0,
    entries_planned: 0,
    dual_expansions: 0,
    wrote: 0,
    failed: 0,
    upsert_attempted: 0,
    upsert_failed: 0,
  };
  const preview = [];

  let stoppedAtBudget = false;
  let rowsNotReached = 0;
  for (const row of rows) {
    // THE PRE-CHECK, before the row is derived and upserted rather than after.
    // A stop here is safe: upsertCatalogEntry keys on the derived id, so the
    // continuation overwrites the finished prefix with itself. The remaining
    // rows are counted rather than silently dropped -- that is the `not
    // reached` column the reconciliation below balances with.
    if (stoppedAtBudget || CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      rowsNotReached++;
      continue;
    }
    const setKey = row.setKey;
    if (SKIP_SETS.has(setKey)) {
      stats.skipped_set++;
      continue;
    }
    const map = SETKEY_MAP[setKey];
    if (!map) {
      console.warn(`  skip unknown setKey=${setKey} row=${row.cardNumber}`);
      stats.skipped_set++;
      continue;
    }
    if (!row.cardNumber) { stats.skipped_no_cardnumber++; continue; }
    if (!row.player) { stats.skipped_no_player++; continue; }

    // DPPA dual: create ONE entry per player, sharing the cardNumber.
    const players = map.tag === "dual" ? splitDualPlayer(row.player) : [row.player];
    if (players.length > 1) stats.dual_expansions++;

    for (const player of players) {
      const entry = deriveCatalogEntry({
        sport: "baseball",
        year: 2026,
        setKey: map.setKey,
        cardNumber: row.cardNumber,
        parallel: map.parallel,
        isAuto: true,
        printRun: map.printRun,
        playerName: player,
        source: "seed",
        confidence: 0.95,   // Drew-verified checklist
        vendorIds: {},
        // CF-AUTHORITATIVE-SETKEY. This is a published checklist, which is
        // the ground truth for which product a card belongs to, so the
        // cardNumber-prefix repair meant for untrusted VENDOR text must not
        // fire on it. Without the flag every CPA-/CRA- row this Bowman lane
        // mints is re-homed to `bowman-chrome` -- collapsing 2026 Bowman
        // CPA-AG (Adrian Gil) onto 2026 Bowman Chrome CPA-AG (Angeibel
        // Gomez), which is the merge the flag exists to prevent.
        authoritativeSetKey: true,
      });
      if (!entry) {
        stats.failed++;
        continue;
      }
      stats.entries_planned++;
      if (preview.length < 15) preview.push({ id: entry.id, player, note: row.note });

      if (APPLY) {
        stats.upsert_attempted++;
        try {
          const w = await upsertCatalogEntry(entry);
          if (w) stats.wrote++;
          else stats.upsert_failed++;
        } catch (e) {
          stats.upsert_failed++;
          console.warn(`  upsert failed: ${entry.id} — ${(e?.message ?? e).slice(0, 80)}`);
        }
      }
    }
  }

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  entries planned:     ${stats.entries_planned}`);
  console.log(`  DPPA dual splits:    ${stats.dual_expansions}`);
  console.log(`  skipped (no cardNumber): ${stats.skipped_no_cardnumber}`);
  console.log(`  skipped (name-only set): ${stats.skipped_set}`);
  console.log(`  skipped (no player): ${stats.skipped_no_player}`);
  console.log(`  failed derive:       ${stats.failed}`);
  if (APPLY) console.log(`  wrote to catalog:    ${stats.wrote}   (upsert failed: ${stats.upsert_failed})`);
  else console.log(`\n*** DRY-RUN. Set INGEST_APPLY=true (or dispatch with apply=true) to write. ***`);
  if (APPLY) {
    // RECONCILE OVER THE UPSERTS ATTEMPTED. Every attempt either returned a row
    // (wrote) or did not (upsert_failed), so the identity holds whether the
    // walk finished or the budget stopped it. The CSV rows the clock never
    // reached are reported SEPARATELY, in rows rather than in entries: a row
    // can expand to two entries (the DPPA dual split), so folding it into this
    // equation would mix two units (a slice is not a sibling counter).
    console.log(`  reconciled: intended ${stats.upsert_attempted} = written ${stats.wrote} + failed ${stats.upsert_failed}`);
    if (stats.wrote + stats.upsert_failed !== stats.upsert_attempted) {
      console.error("  !! RECONCILE MISMATCH -- an attempted upsert neither wrote nor failed");
      process.exitCode = 4;
    }
    if (rowsNotReached > 0) {
      console.log(`  csv rows NOT REACHED (budget): ${rowsNotReached} of ${rows.length}`);
    }
    reportWrites({ job: "ingest-2026-bowman-auto-checklist", intended: stats.upsert_attempted, written: stats.wrote, failed: stats.upsert_failed });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${rowsNotReached} of ${rows.length} checklist rows were NOT reached; the relaunch continues from here`);
    console.log("  the continuation re-walks the finished prefix at the cost of idempotent upserts:"
      + " upsertCatalogEntry keys on the derived entry id, so a row already minted is overwritten"
      + " with itself.");
  }

  console.log(`\n══ Sample entries (first 15) ══`);
  preview.forEach(p => console.log(`  ${p.id.padEnd(60)} ${p.player}${p.note ? `  [${p.note}]` : ""}`));
  return { budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
