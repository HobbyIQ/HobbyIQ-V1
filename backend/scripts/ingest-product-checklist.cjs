#!/usr/bin/env node
// CF-INGEST-PRODUCT-CHECKLIST (Drew, 2026-07-30). Product-agnostic
// catalog seed. Reads checklist data files under data/checklists/
// (each exports { productKey, sport, year, setKey, base, inserts,
// autos }) and upserts card_catalog entries.
//
// Scope per product: base cards + insert-set base + auto-set base
// entries. Numbered-parallel expansion deferred (per-slug entries
// seeded on-demand via verify_queue triage).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   AUTH_SESSION_SECRET        required (transitive imports)
//   INGEST_APPLY=true          write (default false / dry-run)
//   INGEST_ONLY=product-key    process only the matching checklist

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
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane MINTS card_catalog rows for
// EVERY checklist under data/checklists -- catalog rows are the identities every
// later match resolves against -- and declared no budget at all. Its loop is
// one SEQUENTIAL `await upsertCatalogEntry` per card, nested three deep (base,
// then each insert set, then each auto set) across every file in the directory,
// with no concurrency and no cap. Its wall clock is (every card in every
// product x per-upsert latency), and nothing bounds it but how many checklists
// have been added. Before this it could only ever end by being KILLED at the
// 150-minute ceiling: no marker, no reconcile, no finishLane line, and #1913's
// KILLED branch then withholding the re-dispatch.
//
// >>> A PARTIAL RUN HERE IS SHORTER, NOT WRONG. <<<
//
// Nothing is derived across cards. Each entry is deriveCatalogEntry() over one
// checklist line's own fields, and upsertCatalogEntry keys on the derived id, so
// a re-run overwrites each row with itself. Files are read in sorted order and
// each product's cards in file order, so a continuation re-walks the finished
// prefix at the cost of idempotent upserts. No refusal is owed.
//
// THE UNIT IS ONE CARD: one deriveCatalogEntry (pure) plus one awaited catalog
// upsert. 30 seconds is generous for a single upsert and is what the pre-check
// reserves.
//
// THE CHECK IS AT THE CARD, NOT AT THE PRODUCT. A product is not a unit here:
// a single flagship base set is 700+ cards, so checking once per file would
// admit an entire product past expiry -- the loop-top defect #1799 fixed, one
// level up. INGEST_ONLY still scopes a dispatch to one product; the clock is
// what bounds the run when it does not.
//
// VERIFY_MS is nominal: this lane reads nothing after its loops.
// Worst case 110 + 0.5 + 1 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 30 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// CF-INGEST-APPLY-COMPATIBILITY (Drew, 2026-07-30). Accept either
// INGEST_APPLY (script's own env) or BACKFILL_APPLY (workflow's env)
// so this script slots into the whitelisted Backfill Runner workflow
// without a separate env-var branch.
const APPLY = process.env.INGEST_APPLY === "true" || process.env.BACKFILL_APPLY === "true";
const ONLY = process.env.INGEST_ONLY || null;

// Parse CSV checklists (schema: category,cardNumber,parallel,isAuto,printRun,player).
// Groups rows by category prefix into base / inserts / autos structure the
// ingester already knows how to walk. Category values:
//   base                    → base set
//   insert-<slug>           → insert set (prefix inferred from cardNumber)
//   auto-<slug>             → auto set (prefix inferred from cardNumber)
//   relic-<slug>            → relic set (treated as base non-auto with note)
//   auto-relic-<slug>       → auto relic (treated as auto)
function parseCsvChecklist(csvPath) {
  const raw = require("fs").readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.startsWith("#"));
  const header = lines[0].split(",");
  const rows = lines.slice(1).map(line => {
    const parts = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    const r = {};
    header.forEach((h, i) => { r[h.trim()] = (parts[i] ?? "").trim(); });
    return r;
  });

  const base = [];
  const insertsMap = new Map();  // key: insert slug → { prefix, cards[] }
  const autosMap = new Map();    // key: auto slug → { prefix, cards[] }

  for (const r of rows) {
    const cat = String(r.category || "").toLowerCase();
    const cardNumber = String(r.cardNumber || "").trim();
    const player = String(r.player || "").trim();
    const isAutoRow = String(r.isAuto || "").toLowerCase() === "true";
    const printRun = r.printRun ? Number(r.printRun) : null;
    if (!cardNumber || !player) continue;

    if (cat === "base") {
      base.push({ n: cardNumber, p: player });
      continue;
    }
    if (cat.startsWith("insert-") || cat.startsWith("relic-")) {
      const slug = cat.replace(/^(insert|relic)-/, "");
      if (!insertsMap.has(slug)) insertsMap.set(slug, { name: slug, cards: [], printRun });
      // CSV-driven: cardNumber pre-formed, preserve as-is
      insertsMap.get(slug).cards.push({ cardNumber, player });
      continue;
    }
    if (cat.startsWith("auto-")) {
      const slug = cat.replace(/^auto-/, "");
      if (!autosMap.has(slug)) autosMap.set(slug, { name: slug, cards: [], printRun });
      autosMap.get(slug).cards.push({ cardNumber, p: player });
      continue;
    }
    // Unknown category — skip silently (best-effort)
  }

  return {
    base,
    inserts: Array.from(insertsMap.values()),
    autos: Array.from(autosMap.values()),
  };
}

async function ingestProduct(checklist) {
  const stats = {
    base: 0, insertBase: 0, autoBase: 0,
    // `attempted` is the denominator the old counters never had: `wrote` and
    // `failed` were reported against a "planned" total that included entries
    // which never reached an upsert at all (a failed derive, and now a card the
    // budget did not reach), so the two could never be made to balance.
    attempted: 0, wrote: 0, failed: 0, skipped_missing_field: 0, notReached: 0,
  };
  const preview = [];

  const buildAndPush = async (params) => {
    // THE PRE-CHECK, before the card is derived and upserted rather than after,
    // and at the CARD rather than at the product -- see THE CLOCK above. A stop
    // here is safe: upsertCatalogEntry keys on the derived id, so the
    // continuation overwrites the finished prefix with itself. Cards past the
    // stop are COUNTED, not silently dropped.
    if (stoppedAtBudget || CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      stats.notReached++;
      return;
    }
    const entry = deriveCatalogEntry({
      sport: checklist.sport,
      year: checklist.year,
      setKey: params.setKeyOverride || checklist.setKey,
      cardNumber: params.cardNumber,
      parallel: params.parallel,
      isAuto: params.isAuto,
      printRun: params.printRun ?? null,
      playerName: params.playerName,
      source: checklist.source,
      confidence: checklist.confidence,
      vendorIds: {},
      // CF-AUTHORITATIVE-SETKEY. A product checklist names its own product;
      // the vendor cardNumber-prefix repair must not re-home it.
      authoritativeSetKey: true,
    });
    if (!entry) { stats.skipped_missing_field++; return; }
    if (preview.length < 12) preview.push(`${entry.id.padEnd(60)} ${params.playerName}`);
    if (APPLY) {
      stats.attempted++;
      try {
        const w = await upsertCatalogEntry(entry);
        if (w) stats.wrote++;
        else stats.failed++;
      } catch (e) {
        stats.failed++;
      }
    }
  };

  // Base cards
  for (const row of (checklist.base ?? [])) {
    stats.base++;
    await buildAndPush({
      cardNumber: String(row.n),
      parallel: "Base",
      isAuto: false,
      playerName: row.p,
    });
  }

  // Insert sets — base entries only. Cards can be plain strings (legacy
  // JS-module shape with implicit "prefix-N" numbering) or objects
  // { cardNumber, player } (CSV shape with pre-formed cardNumber).
  for (const insert of (checklist.inserts ?? [])) {
    for (let i = 0; i < insert.cards.length; i++) {
      stats.insertBase++;
      const card = insert.cards[i];
      const isObj = typeof card === "object" && card !== null;
      const cardNumber = isObj ? card.cardNumber : `${insert.prefix}-${i + 1}`;
      const playerName = isObj ? card.player : card;
      await buildAndPush({
        cardNumber,
        parallel: "Base",
        isAuto: false,
        printRun: insert.printRun ?? null,
        playerName,
      });
    }
  }

  // Auto sets — base entries. Card entries expected as objects; support
  // legacy shape { code, p } (JS module) and CSV shape { cardNumber, p }.
  for (const autoSet of (checklist.autos ?? [])) {
    for (const card of autoSet.cards) {
      stats.autoBase++;
      const cardNumber = card.cardNumber
        ? card.cardNumber
        : `${autoSet.prefix}-${card.code}`;
      await buildAndPush({
        cardNumber,
        parallel: "Base",
        isAuto: true,
        printRun: autoSet.printRun ?? null,
        playerName: card.p,
      });
    }
  }

  console.log(`\n══ ${checklist.productKey} ══`);
  console.log(`  base:        ${stats.base}`);
  console.log(`  insertBase:  ${stats.insertBase}`);
  console.log(`  autoBase:    ${stats.autoBase}`);
  console.log(`  planned:     ${stats.base + stats.insertBase + stats.autoBase}`);
  if (APPLY) {
    console.log(`  attempted:   ${stats.attempted}`);
    console.log(`  wrote:       ${stats.wrote}`);
    console.log(`  failed:      ${stats.failed}`);
  }
  if (stats.notReached > 0) console.log(`  not reached (budget): ${stats.notReached}`);
  console.log(`  Sample:`);
  preview.slice(0, 6).forEach(s => console.log(`    ${s}`));
  return stats;
}

// Set the first time a card is refused for want of clock. Module scope because
// the refusal happens inside buildAndPush, three loops down from main().
let stoppedAtBudget = false;

async function main() {
  const checklistsDir = path.join(backend, "data/checklists");
  if (!fs.existsSync(checklistsDir)) {
    console.error(`checklists dir not found: ${checklistsDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(checklistsDir)
    .filter(f => f.endsWith(".js") || f.endsWith(".csv"))
    .sort();

  console.log(`[ingest-product-checklist]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  files found: ${files.length}`);
  if (ONLY) console.log(`  filter: ${ONLY}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  let grandPlanned = 0;
  let grandWrote = 0;
  let grandAttempted = 0;
  let grandFailed = 0;
  let grandNotReached = 0;
  for (const f of files) {
    let checklist;
    if (f.endsWith(".js")) {
      checklist = require(path.join(checklistsDir, f));
    } else {
      // CSV path — meta from sibling <name>.csv.meta.json
      const metaPath = path.join(checklistsDir, f + ".meta.json");
      if (!fs.existsSync(metaPath)) {
        console.warn(`  skip ${f}: missing meta ${path.basename(metaPath)}`);
        continue;
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      checklist = { ...meta, ...parseCsvChecklist(path.join(checklistsDir, f)) };
    }
    if (ONLY && checklist.productKey !== ONLY) continue;
    const s = await ingestProduct(checklist);
    grandPlanned += s.base + s.insertBase + s.autoBase;
    grandWrote += s.wrote;
    grandAttempted += s.attempted;
    grandFailed += s.failed;
    grandNotReached += s.notReached;
  }

  console.log(`\n════════════════ TOTAL ════════════════`);
  console.log(`  entries planned: ${grandPlanned}`);
  if (APPLY) console.log(`  entries written: ${grandWrote}`);
  else console.log(`\n*** DRY-RUN. Set INGEST_APPLY=true to write. ***`);
  if (grandNotReached > 0) console.log(`  entries NOT REACHED (budget): ${grandNotReached}`);

  // RECONCILE OVER THE UPSERTS ATTEMPTED. Every attempt either returned a row
  // (wrote) or did not (failed), so the identity holds whether the walk
  // finished or the budget stopped it. `planned` is deliberately NOT the
  // denominator: it counts cards SEEN, which includes ones that failed to
  // derive and ones the clock never reached -- neither of which ever became a
  // write to reconcile (a slice is not a sibling counter). Those two are
  // reported on their own lines instead.
  if (APPLY) {
    console.log(`  reconciled: intended ${grandAttempted} = written ${grandWrote} + failed ${grandFailed}`);
    if (grandWrote + grandFailed !== grandAttempted) {
      console.error("  !! RECONCILE MISMATCH -- an attempted upsert neither wrote nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "ingest-product-checklist",
      intended: grandAttempted, written: grandWrote, skipped: 0, failed: grandFailed,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${grandNotReached} checklist entr(ies) were NOT reached; the relaunch continues from here`);
    console.log("  the continuation re-walks the finished prefix at the cost of idempotent upserts:"
      + " files are read in sorted order and cards in file order, and upsertCatalogEntry keys on the"
      + " derived entry id, so a row already minted is overwritten with itself. INGEST_ONLY scopes a"
      + " re-dispatch to one product when the whole directory does not fit.");
  }
  return { budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
