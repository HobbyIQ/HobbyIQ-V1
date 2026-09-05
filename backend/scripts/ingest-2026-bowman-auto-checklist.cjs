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
  console.log(`  csv rows: ${rows.length}\n`);

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

  for (const row of rows) {
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
  if (APPLY) reportWrites({ job: "ingest-2026-bowman-auto-checklist", intended: stats.upsert_attempted, written: stats.wrote, failed: stats.upsert_failed });

  console.log(`\n══ Sample entries (first 15) ══`);
  preview.forEach(p => console.log(`  ${p.id.padEnd(60)} ${p.player}${p.note ? `  [${p.note}]` : ""}`));
}

main().catch(e => { console.error(e); process.exit(1); });
