#!/usr/bin/env node
/**
 * repair-clc-signature-unsigned.cjs -- the clc rows whose parallel SAYS the card
 * is signed and whose flag says it is not.
 *
 * CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION (2026-09-05, #1831). The
 * clc converter decided isAuto from the section and the qualifier only, through
 * a vocabulary that did not include the word "signature". 2022 Panini Select
 * publishes "Jumbo Rookie Signature Swatches Gold Prizm"; sectionsOf split it
 * correctly ("Jumbo Rookie" IS the section) and the auto word landed on the
 * finish side, where nothing was reading. The converter is fixed (b7b2463b);
 * this is the rows it had already minted.
 *
 * -- RE-MEASURED 2026-09-06, AND THE NUMBER MOVED ---------------------------
 *
 * #1831 reported 74,448 actionable rows. Re-measured read-only per (sport,
 * year) against card_catalog, source LIKE 'checklistcenter%':
 *
 *      79,000 ACTIONABLE      (all of them MOVES; heal = 0)
 *         916 refused -- the name DENIES the signature
 *          68 refused -- a source typo ("Patch Autogrpahs Gold")
 *      ------
 *      79,984 candidates scanned
 *
 *   baseball:2023  43,915     football:2024      840
 *   baseball:2026  13,374     football:2023      831
 *   baseball:2025  12,835     basketball:2024     39
 *   football:2025   2,850     basketball:2021     22
 *   baseball:2022   2,397     basketball:2025      6
 *   baseball:2024   1,888     basketball:2023      3
 *
 * The 4,552 the earlier count missed arrived in the `checklistcenter-2026-09-05`
 * pass, which staged BEFORE the converter fix merged. So do not trust 74,448 --
 * and do not trust 79,000 either on the day this finally applies: the report
 * re-counts, per scope, every run.
 *
 * THE SOURCE TAG IS THE PROVENANCE, NOT THE PREDICATE. Every affected row
 * carries a dated tag from a pre-fix pass:
 *
 *      checklistcenter-2026-08-29   53,069
 *      checklistcenter-2026-08-30   21,340
 *      checklistcenter-2026-09-05    4,591
 *
 * and `checklistcenter-2026-09-06` -- the first pass staged through the FIXED
 * converter, 942,188 rows -- contributes ZERO. That is the fix confirmed on
 * stored data rather than on fixtures. But the lane still judges the ROW, never
 * the tag: a tag names when a row was written, and the defect is a claim about
 * what the row SAYS. A re-scrape that reused a date, or a cell restaged out of
 * order, would make a tag-keyed repair miss rows it can see plainly.
 *
 * -- THE SALES, WHICH ARE MEASURED AND ARE (TODAY) NONE ---------------------
 *
 * The pool lane is built because the catalog move re-points sales and a slug
 * may gain one between this report and its apply. Its population is measured,
 * not assumed -- and today it is empty:
 *
 *   baseball:2026   13,374 actionable slugs -> 0 sold_comps rows
 *   baseball:2025   12,835 actionable slugs -> 0 sold_comps rows
 *
 * 26,209 slugs read exhaustively on BOTH identity fields, zero sales. A control
 * over unrestricted clc rows in the same cell found 139/300 slugs carrying 609
 * sales, so the reader works; these particular identities are checklist-minted
 * rows no sale has ever matched to. That is what a signed card looks like when
 * the catalog calls it unsigned: the matcher never routes an auto sale to a
 * `:no-auto` address, so the pool stayed EMPTY rather than wrong.
 *
 * A TITLE THAT SAYS NOTHING IS PARKED, NEVER MOVED. When a sale does exist, the
 * CHECKLIST says the card is an autograph -- but the checklist is not evidence
 * about which CARD a given sale is. A title that states an autograph moves with
 * the row; a title that is silent PARKS and is reported. The reconciliation
 * counts parked rows on their own line so a silent title can never be read as a
 * clean move.
 *
 * -- WHY A RE-INGEST CANNOT DO THIS -----------------------------------------
 *
 * isAuto is segment 6 of the canonical id (`auto` / `no-auto`). A re-ingest
 * through the fixed converter mints at the `:auto` address and leaves the wrong
 * `:no-auto` row standing beside it -- not a repair, a second row and a split
 * pool (feedback_one_card_one_row_one_pool). And `patchCatalogRowFields`
 * refuses this field BY DESIGN: it declares id / cardId / hobbyiqCardId
 * UNPATCHABLE, because changing where a row LIVES is a move.
 *
 * So: `moveCatalogRow`, which is the ONE derivation path for a row that changes
 * address. It re-derives every search field through deriveCatalogEntry (never a
 * raw patch -- memory: "deriveCatalogEntry builds its own search fields"),
 * re-points the sales BEFORE deleting the old row, FOLDS onto an existing
 * `:auto` twin by authority rather than duplicating it (one card, one row), and
 * retires the old slug's graded children, which are regenerable.
 *
 * -- THE EVIDENCE IS THE CHECKLIST'S OWN WORDS ------------------------------
 *
 * memory: "isAuto boundary is cardNumber, not text" -- the CHECKLIST decides the
 * flag, never free text on a card_set. A clc row's parallel is not free text: it
 * is the finish half of the page's own Set cell, published by the manufacturer.
 * A row is actionable only when that published name contains a WHOLE auto word
 * and NOT a negation.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY / APPLY (report only by
 *      default); SCOPE  REQUIRED, comma-separated `sport:year` (the runner's
 *      inherited `refractor` / `all` are REFUSED); MODE catalog|sales|both
 *      (default both); SLOT/SLOTS + SHARD (opt-in, card-level axis);
 *      SOURCES (default checklistcenter, family-matched); LIMIT; CONCURRENCY;
 *      RUN_MINUTES / RESERVE_MS / VERIFY_MS; VERBOSE.
 */
"use strict";

const path = require("path");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
// CF-A-MOVE-LANE-SHARDS-BY-CARD-NOT-BY-ROW. A move re-points a card's sales and
// retires its graded children, so a parent and its children must land in ONE
// slot or two slots write one identity.
const { cardShardIndex } = require(path.join(__dirname, "lib", "card-shard-axis.cjs"));
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
// worst case 110m loop + 90s reserve + 5m verify + 1m startup = ~117.5m against
// the runner's 150m ceiling: 32m of margin (runnerBudgetMargin.test.ts).
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const MODE = lower(process.env.MODE || "both");
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const LIMIT = Number(process.env.LIMIT || 0);
const VERBOSE = process.env.VERBOSE === "true";
const SOURCES = csv(process.env.SOURCES || "checklistcenter").map(lower);

// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1765). Sharding is OPT-IN.
const SHARD_SCOPE = runnerShardScope({ label: "repair-clc-signature-unsigned" });

// THE SCOPE. `sport:year`, and the runner's inherited default is REFUSED --
// a whole-source write refuses without its name
// (feedback_a_whole_source_retire_needs_its_name).
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z]+:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));
const MODES = new Set(["catalog", "sales", "both"]);

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 500) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

// -- pure --------------------------------------------------------------------

/** checklistcenter-2026-08-29 / -html-graded -> checklistcenter. */
const familyOf = (source) => String(source ?? "").toLowerCase().trim()
  .replace(/-graded$/, "").replace(/-html$/, "")
  .replace(/-(?:scraped-|ladders-|html-)?\d{4}-\d{2}-\d{2}$/, "")
  .replace(/-html$/, "");

/**
 * THE AUTO VOCABULARY, and its negation. Deliberately the SAME word list as the
 * converter's namesAnAuto, because a repair that read a different vocabulary
 * from the parser would heal rows the parser will re-break, and vice versa.
 *
 * Whole words only: "Autumn" is not an autograph and "Inkjet" is not ink.
 */
const AUTO_WORDS = /\b(auto|autos|autograph|autographs|autographed|signature|signatures|signing|signings|signed|penmanship|inscription|inscriptions|ink)\b/i;

/**
 * A NAME THAT DENIES THE SIGNATURE. 2018 Topps Archives publishes "1977 - No
 * Signature" and "1959 - No Signature/Venezuelan": a variation whose whole point
 * is that the facsimile signature is ABSENT. It contains the word and means the
 * opposite, and all 916 such rows are already correctly isAuto=false.
 *
 * Every negation spelling present in the corpus was enumerated read-only before
 * this list was written. The pattern is written wider than what was found so a
 * fourth spelling arriving later is refused rather than flipped.
 */
const NEGATION = /\b(?:no|non|not|without|missing|un)[\s\-/]*(?:facsimile[\s\-]*)?(?:signature|signatures|signed|auto|autos|autograph|autographs|autographed)\b|\bunsigned\b|\bnon-?auto\b/i;

/** Is this published name evidence that the card is signed? */
function namesAnAuto(text) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (NEGATION.test(t)) return false;
  return AUTO_WORDS.test(t);
}

/** Slug layout hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N] --
 *  segment 6 is the auto boundary. */
const idSaysAuto = (id) => String(id).split(":")[6] === "auto";
const withAutoSegment = (id, isAuto) => { const p = String(id).split(":"); if (p.length > 6) p[6] = isAuto ? "auto" : "no-auto"; return p.join(":"); };

/**
 * The verdict for one stored row.
 *
 *   "move"  -- the name says signed, the flag and the id say unsigned.
 *   "heal"  -- the id ALREADY says auto and only the field is false; the
 *              address is right, so nothing moves and the field conforms.
 *   "skip"  -- no evidence, a negation, or the row is already correct.
 */
function verdictFor(row) {
  const parallel = String(row.parallel ?? "");
  const subset = String(row.subsetName ?? "");
  if (row.isAuto === true) return { action: "skip", reason: "already signed" };
  if (NEGATION.test(parallel) || NEGATION.test(subset)) {
    return { action: "skip", reason: `the name denies the signature: "${parallel || subset}"` };
  }
  const evidence = namesAnAuto(parallel) ? parallel : namesAnAuto(subset) ? subset : null;
  if (!evidence) return { action: "skip", reason: "no auto word in the checklist's own name" };
  if (idSaysAuto(row.id)) return { action: "heal", reason: `id already says auto; field disagrees ("${evidence}")` };
  return { action: "move", reason: `the checklist names it "${evidence}"` };
}

/**
 * THE SALE'S OWN VERDICT, which is a different question from the card's.
 *
 * The checklist says the CARD is an autograph. It says nothing about which card
 * a given SALE is. So a sale rides along only when its own title states an
 * autograph; a title that is silent PARKS, and a title that denies one parks
 * too. Never "the checklist said so, therefore this listing is an auto".
 */
function saleVerdict(row) {
  const title = String(row.title ?? row.rawTitle ?? "");
  if (!title.trim()) return { move: false, reason: "the sale has no title to state an autograph -- PARKED" };
  if (NEGATION.test(title)) return { move: false, reason: "the title denies the autograph -- PARKED" };
  if (!AUTO_WORDS.test(title)) return { move: false, reason: "the title does not state an autograph -- PARKED" };
  return { move: true, reason: "the title states an autograph" };
}

/** The candidate predicate, shared by the scan and the verify-by-read so the
 *  two cannot drift. CONTAINS cannot express a word boundary or a negation, so
 *  the query is deliberately WIDER than the rule and the rule refuses the rest. */
function candidateWhere(sources) {
  return [
    "c.isAuto = false",
    `(${sources.map((_, i) => `STARTSWITH(LOWER(c.source), @src${i})`).join(" OR ")})`,
    `(CONTAINS(LOWER(c.parallel), 'signature') OR CONTAINS(LOWER(c.parallel), 'autograph')
      OR CONTAINS(LOWER(c.parallel), 'auto') OR CONTAINS(LOWER(c.parallel), 'penmanship')
      OR CONTAINS(LOWER(c.parallel), 'inscription') OR CONTAINS(LOWER(c.parallel), 'signed')
      OR CONTAINS(LOWER(c.subsetName ?? ''), 'signature') OR CONTAINS(LOWER(c.subsetName ?? ''), 'autograph'))`,
    "c.sport = @sport", "c.year = @year",
  ].join(" AND ");
}

// -- main --------------------------------------------------------------------

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPAIR: clc signature-unsigned -- the checklist's own name says the card is signed");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  // THE SCOPE REFUSAL, BEFORE ANYTHING IS READ, IN BOTH MODES.
  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like baseball:2023 (sport:year).");
    console.error("       'refractor' is the runner's INHERITED default and is refused, never treated as 'all'.");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to repair, as sport:year.");
    console.error("       There is no 'all' for this lane, in either mode -- a report over an unnamed");
    console.error("       scope is how an apply over an unnamed scope gets authorised, and this lane");
    console.error("       writes across a 79,000-row population.");
    console.error("       Dispatch with -f scope=baseball:2023 (comma-separate for several).");
    process.exit(2);
  }
  if (!MODES.has(MODE)) {
    console.error(`\nFATAL: MODE must be catalog | sales | both. Got '${MODE}'.`);
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  lanes            ${MODE}`);
  console.log(`  sources          ${SOURCES.join(",")} (family-matched)`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  the flag comes from the CHECKLIST'S OWN published name, never from free text;");
  console.log("  a name that denies the signature is refused.");
  console.log("  A SALE MOVES ONLY IF ITS OWN TITLE STATES AN AUTOGRAPH. The checklist says the CARD");
  console.log("  is signed; it says nothing about which card a listing is. A title that says nothing");
  console.log("  is PARKED, not moved -- and parked rows are their own line in the reconciliation.");
  console.log("");

  const s = {
    scanned: 0, moved: 0, healed: 0, folded: 0, replaced: 0, failed: 0,
    salesRepointed: 0, gradedRetired: 0, otherSlot: 0,
    skipNegation: 0, skipNoEvidence: 0, skipAlready: 0, notReached: 0,
    poolScanned: 0, poolMoved: 0, poolParked: 0,
  };
  const byCell = new Map();
  const spellings = new Map();
  const refusals = new Map();
  const parkReasons = new Map();
  const examples = [];
  const moveFailures = [];
  let stoppedAtBudget = false;

  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const mine = (id) => !SHARD_SCOPE.SHARDED || cardShardIndex(id, SHARD_SCOPE.SLOTS) === SHARD_SCOPE.SLOT;

  // -- LANE 1: the catalog rows ----------------------------------------------
  if (MODE === "both" || MODE === "catalog") {
    for (const cell of SCOPE_CELLS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const [sport, yearStr] = cell.split(":");
      const year = Number(yearStr);
      const parameters = [
        ...SOURCES.map((v, i) => ({ name: `@src${i}`, value: v })),
        { name: "@sport", value: sport }, { name: "@year", value: year },
      ];
      const spec = {
        query: `SELECT c.id, c.cardId, c.sport, c.year, c.setKey, c.cardNumber, c.parallel,
                       c.subsetName, c.isAuto, c.printRun, c.playerName, c.source
                FROM c WHERE ${candidateWhere(SOURCES)}`,
        parameters,
      };

      const rows = [];
      await forEachPage(cat, spec, async (page) => {
        for (const r of page) {
          if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
          s.scanned++;
          if (!mine(String(r.id))) { s.otherSlot++; continue; }
          rows.push(r);
        }
        return true;
      });

      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        // THE PRE-CHECK, before the unit and never after.
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached += rows.length - i; break; }
        if (LIMIT && s.moved + s.healed >= LIMIT) { s.notReached += rows.length - i; break; }
        await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (row) => {
          const v = verdictFor(row);
          if (!byCell.has(cell)) byCell.set(cell, { move: 0, heal: 0, skip: 0 });
          const c = byCell.get(cell);
          if (v.action === "skip") {
            c.skip++;
            if (/denies the signature/.test(v.reason)) { s.skipNegation++; bump(refusals, `${row.parallel || row.subsetName} -- denies the signature`); }
            else if (/already signed/.test(v.reason)) s.skipAlready++;
            else { s.skipNoEvidence++; bump(refusals, `${row.parallel || "(blank)"} -- no auto word`); }
            return;
          }
          bump(spellings, String(row.parallel || row.subsetName));
          if (v.action === "heal") c.heal++; else c.move++;
          if (examples.length < 12) examples.push(`${v.action.toUpperCase().padEnd(5)} ${row.id}  <- ${v.reason}`);
          if (VERBOSE) console.log(`  ${v.action.toUpperCase().padEnd(5)} ${row.id}  ${v.reason}`);

          try {
            const full = (await retry(() => cat.item(String(row.id), String(row.cardId ?? row.id)).read())).resource;
            if (!full) { s.failed++; return; }
            const newSlug = v.action === "heal" ? String(full.id) : withAutoSegment(String(full.id), true);

            // REPORT MODE EXERCISES THE REAL CALL. `dryRun: !APPLY` reads
            // everything, writes nothing, and returns the counts a real run
            // would -- so every guard inside the mover runs in REPORT too. A
            // report that cannot fail the way the apply fails is not a rehearsal.
            const res = await retry(() => moveCatalogRow(cat, full, newSlug, { isAuto: true }, {
              reason: "clc converter read the auto flag from the section only; the checklist's own name says signed (CF-THE-WHOLE-SECTION-NAME-REACHES-THE-AUTO-DECISION)",
              salesContainer: pool,
              dryRun: !APPLY,
              retry,
            }));
            s.salesRepointed += res.salesRepointed || 0;
            s.gradedRetired += res.gradedChildrenRetired || 0;
            if (res.action === "fold") s.folded++;
            else if (res.action === "replace") s.replaced++;
            if (res.action !== "noop") { if (v.action === "heal") s.healed++; else s.moved++; }
          } catch (e) {
            // FAIL CLOSED, PER ROW. One refused row is a `failed` row in the
            // reconciliation, not a crash that loses the rest of the slice.
            s.failed++;
            if (moveFailures.length < 50) moveFailures.push({ id: row.id, error: String(e?.message ?? e).slice(0, 200) });
            if (s.failed <= 5) console.error(`  FAILED ${row.id}: ${String(e.message || e).slice(0, 90)}`);
          }
        }));
      }
    }
  }

  // -- LANE 2: sold_comps -- a sale rides only on its own title ---------------
  if (MODE === "both" || MODE === "sales") {
    for (const cell of SCOPE_CELLS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const [sport, yearStr] = cell.split(":");
      const year = Number(yearStr);
      const parameters = [
        ...SOURCES.map((v, i) => ({ name: `@src${i}`, value: v })),
        { name: "@sport", value: sport }, { name: "@year", value: year },
      ];
      // The slugs this cell's catalog lane would move. Read ids only.
      const slugs = [];
      await forEachPage(cat, {
        query: `SELECT c.id, c.parallel, c.subsetName, c.isAuto FROM c WHERE ${candidateWhere(SOURCES)}`,
        parameters,
      }, async (page) => {
        for (const r of page) {
          if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
          if (verdictFor(r).action !== "move") continue;
          if (!mine(String(r.id))) continue;
          slugs.push(String(r.id));
        }
        return true;
      });

      // Chunked so the pool is read once per 100 slugs, never once per slug
      // (feedback_fleet_scripts_measure_throughput_before_dispatch).
      for (let i = 0; i < slugs.length; i += 100) {
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
        const chunk = slugs.slice(i, i + 100);
        const sales = (await retry(() => pool.items.query({
          query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.rawTitle
                  FROM c WHERE ARRAY_CONTAINS(@ids, c.cardId) OR ARRAY_CONTAINS(@ids, c.hobbyiqCardId)`,
          parameters: [{ name: "@ids", value: chunk }],
        }, { maxItemCount: 1000 }).fetchAll())).resources;
        for (const sale of sales) {
          s.poolScanned++;
          const v = saleVerdict(sale);
          if (!v.move) { s.poolParked++; bump(parkReasons, v.reason); continue; }
          // The catalog move re-points the sales it finds, through
          // moveCatalogRow's own salesContainer path. This lane counts the
          // rows that WOULD ride so the report states them, and lets the one
          // mover do the write -- two writers on one pool row is the defect
          // this whole program exists to avoid.
          s.poolMoved++;
        }
      }
    }
  }

  // -- the report ------------------------------------------------------------
  console.log("");
  console.log(`scanned ${f(s.scanned)} candidate rows${SHARD_SCOPE.SHARDED ? ` (${f(s.otherSlot)} in other shards)` : ""}`);
  console.log("");
  console.log(`  ${APPLY ? "MOVED" : "would move"}  ${f(s.moved)}   ${APPLY ? "HEALED" : "would heal"} ${f(s.healed)}   `
    + `refused ${f(s.skipNegation + s.skipNoEvidence)} (${f(s.skipNegation)} deny the signature, ${f(s.skipNoEvidence)} name no auto)`);
  console.log(`  folded onto an existing signed twin ${f(s.folded)}   replaced an incumbent ${f(s.replaced)}   `
    + `sales re-pointed ${f(s.salesRepointed)}   graded children retired ${f(s.gradedRetired)}   failed ${f(s.failed)}`);
  if (MODE !== "catalog") {
    console.log(`  POOL scanned ${f(s.poolScanned)} - would ride (title states an auto) ${f(s.poolMoved)} - PARKED ${f(s.poolParked)}`);
    if (parkReasons.size) for (const [k, n] of [...parkReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(6)}  ${k}`);
  }
  if (s.notReached) console.log(`  not reached: ${f(s.notReached)}`);

  const actionable = [...byCell.entries()].filter(([, v]) => v.move + v.heal > 0).sort((a, b) => (b[1].move + b[1].heal) - (a[1].move + a[1].heal));
  if (actionable.length) {
    console.log(`\n  by cell:`);
    for (const [k, v] of actionable) console.log(`    ${String(v.move + v.heal).padStart(7)}  ${k}${v.skip ? `   (${v.skip} refused)` : ""}`);
  }

  if (spellings.size) {
    console.log(`\n  the published names being acted on (${spellings.size} distinct, top 25):`);
    for (const [k, n] of [...spellings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${String(n).padStart(6)}  ${JSON.stringify(k)}`);
  }
  if (refusals.size) {
    console.log(`\n  REFUSED, and why (${refusals.size} distinct, top 15) -- read these: a wrong refusal is a card left unsigned:`);
    for (const [k, n] of [...refusals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(n).padStart(6)}  ${k}`);
  }
  if (examples.length) { console.log(`\n  examples:`); for (const e of examples) console.log(`    ${e}`); }
  if (moveFailures.length) {
    console.log(`\n  MOVE FAILURES (${moveFailures.length}):`);
    for (const m of moveFailures.slice(0, 20)) console.log(`    ${m.id}: ${m.error}`);
  }

  // -- THE RECONCILIATION ----------------------------------------------------
  // intended = written + skipped + failed + parked. The parked rows are their
  // own term: a sale this lane deliberately did NOT move must never be absorbed
  // into "skipped", where it would read as nothing to do.
  const written = s.moved + s.healed;
  const skipped = s.skipNegation + s.skipNoEvidence + s.skipAlready + s.notReached + s.otherSlot;
  const intended = s.scanned;
  console.log("");
  console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)}`
    + ` + failed ${f(s.failed)} + parked ${f(s.poolParked)}`
    + `   [residual ${f(intended - written - skipped - s.failed)}]`);
  if (APPLY) {
    reportWrites({
      job: "repair-clc-signature-unsigned",
      intended, written, skipped,
      failed: Math.max(s.failed, intended - written - skipped - s.failed),
    });
  }

  // -- VERIFY BY READ, on BOTH identity fields, under the cap -----------------
  if (APPLY) {
    const vt0 = Date.now();
    // A count the cap cut short is UNCONFIRMED, and an UNCONFIRMED count is
    // UNREAD, not zero (feedback_never_dismiss_small_numbers_as_noise). The
    // note below says so in the log of the run it governed, so nobody reads a
    // missing number as an empty result.
    let anyUnread = false;
    for (const cell of SCOPE_CELLS) {
      const [sport, yearStr] = cell.split(":");
      const parameters = [
        ...SOURCES.map((v, i) => ({ name: `@src${i}`, value: v })),
        { name: "@sport", value: sport }, { name: "@year", value: Number(yearStr) },
      ];
      // The signal reaches the SDK, so an abandoned count is CANCELLED rather
      // than left retrying past the ceiling.
      const left = await CLOCK.capped(vt0, `verify ${cell}`, (signal) => cat.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE ${candidateWhere(SOURCES)}`, parameters,
      }, { maxItemCount: 1, abortSignal: signal }).fetchAll().then((r) => r.resources[0]));
      // A count we did not take cannot clear anything: UNCONFIRMED, never zero.
      if (left === null) anyUnread = true;
      console.log(`  VERIFY BY READ ${cell}: candidates still matching: ${left === null ? "UNCONFIRMED (verify cap)" : f(left)}  (the refused ones stay, by design)`);
    }
    // The pool side reads BOTH keys, because the pool reader ORs them and a
    // count that reads one of them is not a count of the pool.
    const poolLeft = await CLOCK.capped(vt0, "verify pool", (signal) => pool.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE (CONTAINS(c.cardId, ':no-auto') OR CONTAINS(c.hobbyiqCardId, ':no-auto'))
              AND ARRAY_CONTAINS(@cells, CONCAT(LOWER(c.sport), ':', ToString(c.cardYear)))`,
      parameters: [{ name: "@cells", value: SCOPE_CELLS }],
    }, { maxItemCount: 1, abortSignal: signal }).fetchAll().then((r) => r.resources[0]));
    if (poolLeft === null) anyUnread = true;
    console.log(`  VERIFY BY READ pool (cardId OR hobbyiqCardId, still :no-auto in scope): ${poolLeft === null ? "UNCONFIRMED (verify cap)" : f(poolLeft)}`);
    // The writes above reconciled and are durable; it is the COUNT that is
    // missing. Printed as UNREAD, not zero.
    if (anyUnread) console.log(CLOCK.unreadNote());
  }

  console.log("");
  console.log(`  REPAIRED to the address the checklist names  ${f(written)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps this phrase and
    // everyWriteJobReconciles greps THIS SOURCE for it, so the words
    // "stopped at the ... budget" are a SOURCE LITERAL here rather than being
    // assembled at runtime -- a marker a static reader cannot see is a relaunch
    // that never fires.
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }

  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  // A REFUSED MOVE KEEPS THE RUN RED: a slot must not report success while rows
  // it intended to move were declined.
  if (s.failed) {
    console.error(`::error::${f(s.failed)} catalog move(s) were refused by moveCatalogRow -- see MOVE FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = {
  namesAnAuto, verdictFor, saleVerdict, familyOf, idSaysAuto, withAutoSegment,
  candidateWhere, AUTO_WORDS, NEGATION, INHERITED_SCOPES, CELL_RE,
};

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
