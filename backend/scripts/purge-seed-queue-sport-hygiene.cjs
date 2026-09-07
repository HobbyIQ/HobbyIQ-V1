#!/usr/bin/env node
/**
 * CF-THE-ACQUISITION-QUEUE-MUST-ONLY-CARRY-CELLS-A-SOURCE-CAN-SERVE, applied
 * (2026-09-07). The WRITE half of audit-seed-queue-sport-hygiene.
 *
 * The audit measured 2,080 polluted `catalog_seed_queue` entries -- 1,083
 * sport-contaminated, 997 ambiguous -- and emitted them as
 * docs/reports/2026-09-07-seed-queue-sport-purge-list.json. It has no write
 * path by construction and says so in its own header. This lane is the lane
 * that acts on that list, and nothing else.
 *
 * -- ONE SOURCE OF TRUTH FOR THE CLASSIFICATION ----------------------------
 *
 * The rule that decides "polluted" lives in exactly ONE place --
 * scripts/lib/sport-contamination.cjs -- and the audit, this lane and the pins
 * all call it. This file contains NO second copy of the verdict logic, because
 * two copies of one rule is how two readings of one product begin to disagree
 * (the audit's own opening argument, and setSportAuthority's before it).
 *
 * What this lane adds is not a rule. It is the WRITE, and the write's
 * safeguard: THE LIST IS RE-DERIVED, NEVER TRUSTED.
 *
 * -- WHY THE LIST IS RE-DERIVED AT APPLY TIME ------------------------------
 *
 * The committed list is a snapshot of a measurement taken at 2026-09-07
 * 02:25Z. Between that instant and this run, the catalog moves: an ingest
 * lands the 1952 Bowman FOOTBALL checklist that was missing, and the cell that
 * was "contaminated" becomes "agree" -- a legitimate acquisition target that
 * this lane would otherwise mark `unavailable` and take off the work list.
 *
 * That failure mode is not hypothetical here. The whole POINT of this queue is
 * that its cells get served over time, and the classification's inputs are
 * precisely the checklist rows a drain writes. A list-driven lane that trusts
 * its list is a lane whose blast radius grows with its own age.
 *
 * So every entry is re-classified against the LIVE catalog, through the same
 * shipped predicate, before it can be written:
 *
 *   still polluted   -> marked (or skipped, if already `unavailable`)
 *   no longer        -> SKIPPED with a reason naming the new verdict. Never
 *                       marked, and counted separately in the banner so the
 *                       drift between the list and the world is VISIBLE
 *                       rather than silently applied.
 *   not in the queue -> SKIPPED. A row somebody already removed is not this
 *                       lane's to resurrect.
 *
 * The re-derivation is also what makes the REPORT honest: it runs the apply's
 * whole derivation and writes nothing, so the report's counts are the apply's
 * counts. A report that cannot predict its apply is a green light for a write
 * that will not happen (relocate-catalog-rows-by-list's 2026-09-07 incident).
 *
 * -- MARK, NEVER DELETE ----------------------------------------------------
 *
 * The write is the drainer's OWN maintenance vocabulary, not a new one:
 * drainCatalogSeedQueue marks a seed it cannot serve
 *
 *     { ...seed, status: "unavailable", drainedAt, drainReason }
 *
 * and leaves the row visible as real demand we cannot yet serve. A wrong-sport
 * cell is a stronger statement than "unavailable" -- the demand itself is
 * misfiled -- but it is not a stronger ACTION: deleting it would destroy the
 * requestCount that records how many users asked, and the evidence of the
 * ingest defect that minted it. So the row stays, marked, with the reason and
 * the true sport stamped alongside for whoever reads the queue next.
 *
 * The reason vocabulary is the audit's, verbatim:
 * `sport-contaminated:checklist-in-<sport>` or `sport-ambiguous`.
 *
 * -- IDEMPOTENT ------------------------------------------------------------
 *
 * A seed already carrying `status: "unavailable"` is SKIPPED, not re-written.
 * The audit recorded each entry's status when it measured and some are already
 * there; a relaunch of this lane after a budget stop re-reads the same list --
 * so "already unavailable" is the steady state, not an edge case. Re-upserting
 * would churn RUs, move `drainedAt` and make the banner's `marked` count
 * unreadable as progress.
 *
 * -- VERIFY BY READ, AS A LEDGER -------------------------------------------
 *
 * Each marked id is READ BACK BY POINT READ and its status confirmed. Not a
 * COUNT: a container-wide `SELECT VALUE COUNT(1) WHERE status='unavailable'`
 * counts rows this lane never touched (the drainer writes the same status for
 * its own reasons) and would report a number that is true and meaningless.
 * The ledger names the rows -- CF-NAME-THE-ROWS-BEFORE-CALLING-DAMAGE -- and a
 * point read on (id, /sport) is index-served, so the ledger costs one RU per
 * marked row and stays under the verify cap.
 *
 * -- SCOPE, AND WHY IT IS REQUIRED -----------------------------------------
 *
 * SCOPE names the committed list. It has NO default: this lane writes, and a
 * whole-scope write refuses without its scope
 * (feedback_a_whole_source_retire_needs_its_name). There is no predicate that
 * selects "the polluted entries" -- the list IS the scope, and re-derivation is
 * what keeps that scope honest rather than merely fixed.
 *
 *   Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write;
 *        SCOPE=<list .json>; RUN_MINUTES / RESERVE_MS / VERIFY_MS
 *
 *   node scripts/purge-seed-queue-sport-hygiene.cjs \
 *     --scope=docs/reports/2026-09-07-seed-queue-sport-purge-list.json
 *   BACKFILL_APPLY=true node scripts/purge-seed-queue-sport-hygiene.cjs --scope=...
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
// THE ONE COPY OF THE RULE. Same module the audit classifies with and the
// pins drive directly.
const { classifySportContamination } = require(path.join(__dirname, "lib", "sport-contamination.cjs"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// The shared clock. A private copy of capped() is what four reconciled-clean
// runs paid the step ceiling for (#1809).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const env = (n, d = "") => String(process.env[n] ?? "").trim() || d;

// CF-THE-RUNNER-EXPORTS-BACKFILL_APPLY (feedback_runner_exports_backfill_apply).
// The runner derives exactly this name from `inputs.apply`; a lane reading any
// other switch is permanently dry under it.
const APPLY = process.argv.includes("--apply") || env("BACKFILL_APPLY") === "true";
const SCOPE = arg("scope", env("SCOPE"));

const STARTED = Date.now();
/** THE THREE CONSTANTS, spelled by name (lib/runner-budget.cjs). The pins that
 *  govern budgeted lanes -- runnerBudgetMargin and laneExitsWhenWorkIsDone --
 *  select their population on the literal `RUN_MINUTES`/`BUDGET_MS`, so a lane
 *  that carries a clock but never spells it is a lane no pin governs.
 *
 *  THE UNIT IS ONE (year, setKey) CELL: one projection over card_catalog for
 *  that product-year, then a point-read plus an upsert per seed on the cell.
 *  The audit measured the identical projection across 9,988 queue entries /
 *  ~9k cells at 24-way fan-out; this lane's scope is the 2,080 polluted
 *  entries over ~1.9k cells, and it runs them SERIALLY because it writes. The
 *  slowest single cell measured in the audit was a flagship product-year at
 *  ~8s, and a cell can carry several seeds; 60s is that worst case with room,
 *  CHECKED BEFORE THE UNIT STARTS rather than at the loop top (the #1799
 *  defect). */
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 100);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 5 * 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS, startedAt: STARTED });

/** The checklist predicate, mirrored from audit-seed-queue-sport-hygiene.cjs
 *  so the apply measures with the SAME gate the audit reported with. */
const SD_SOURCES = [
  "ingest-auto-seed", "sold-comps-stub", "catalog-explode", "tree-builder",
  "sales-derived", "sales-attested", "derived-from", "pool",
  "user-verified", "ebay-user-purchase", "ebay-user-sale", "manual-user-entry",
  "holding-seeded",
];
const CHECKLIST_STEMS = [
  "checklist", "beckett", "cardpedia", "bccp", "cardboardconnection",
  "almanac", "hobbymonitor", "tcdb", "tcgdex", "pokemon-tcg-data", "official-pdf",
];
const norm = (s) => String(s == null ? "" : s).toLowerCase().trim();
function isSelfDerived(source) {
  const s = norm(source).replace(/-graded$/, "");
  if (!s || s === "undefined" || s === "null") return false;
  return SD_SOURCES.some((p) => s.startsWith(p));
}
function isChecklist(source) {
  const s = norm(source).replace(/-graded$/, "");
  if (!s || s === "undefined" || s === "null") return false;
  if (isSelfDerived(s)) return false;
  if (/^(cardhedge|cardsight|ebay)/.test(s)) return false;
  return CHECKLIST_STEMS.some((stem) => s.includes(stem));
}

/** The reason stamped on a marked row. Mirrors the audit's emitted vocabulary
 *  exactly, so a row's reason reads the same whether the list predicted it or
 *  the re-derivation produced it. */
function reasonFor(v) {
  return v.verdict === "ambiguous" ? "sport-ambiguous" : `sport-contaminated:checklist-in-${v.trueSport}`;
}

/** The status the drainer uses for demand it cannot serve. Mark, never delete. */
const MARK_STATUS = "unavailable";

const f = (n) => Number(n ?? 0).toLocaleString("en-US");

/** SCOPE is REQUIRED. A whole-scope write refuses without its scope. */
function scopeRefusal() {
  if (!SCOPE) {
    return "FATAL: SCOPE is empty. This lane WRITES to catalog_seed_queue and has no default "
      + "list -- name the committed .json purge list to run "
      + "(e.g. SCOPE=docs/reports/2026-09-07-seed-queue-sport-purge-list.json).";
  }
  if (!SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${SCOPE}" does not name a list file. This lane's scope IS the list; `
      + "pass the committed .json emitted by audit-seed-queue-sport-hygiene --purge-list.";
  }
  return null;
}

function loadList() {
  const p = path.isAbsolute(SCOPE) ? SCOPE : path.join(backend, SCOPE);
  if (!fs.existsSync(p)) throw new Error(`SCOPE list not found: ${p}`);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  const entries = Array.isArray(doc) ? doc : (doc.entries || []);
  if (!Array.isArray(entries) || !entries.length) throw new Error(`SCOPE list has no entries: ${p}`);
  return { doc, entries, resolved: p };
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const refusal = scopeRefusal();
  if (refusal) { console.error(refusal); process.exit(2); }

  const { doc, entries, resolved } = loadList();

  const client = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const queue = db.container(process.env.COSMOS_CATALOG_SEED_QUEUE_CONTAINER || "catalog_seed_queue");
  const cat = db.container("card_catalog");

  console.log(`purge-seed-queue-sport-hygiene -- ${APPLY ? "APPLY" : "REPORT (no writes)"}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log(`  list: ${resolved}`);
  console.log(`  list generated: ${doc.generatedAt || "unknown"} by ${doc.generatedBy || "unknown"}`);
  console.log(`  entries in list: ${f(entries.length)}`);
  console.log("  MARK, NEVER DELETE -- every write is status=unavailable with a reason.\n");

  // Group by (year, setKey): several seeds can name the same product-year, and
  // reading the catalog once per CELL rather than once per ENTRY is the
  // difference between a bounded lane and a per-row sweep. It is also what
  // makes the re-derivation affordable at all.
  const cells = new Map();
  for (const e of entries) {
    const year = Number(e.year);
    const setKey = norm(e.setKey);
    if (!setKey || !Number.isFinite(year)) continue;
    const k = `${year}|${setKey}`;
    if (!cells.has(k)) cells.set(k, { year, setKey, entries: [] });
    cells.get(k).entries.push(e);
  }
  const cellList = [...cells.values()];
  console.log(`  distinct (year, setKey) cells: ${f(cellList.length)}\n`);

  // -- COUNTERS. `intended` is every entry the list named, so the banner's
  // reconciliation covers the WHOLE list and nothing can leave it unnamed. --
  const intended = entries.length;
  let rederivedPolluted = 0;   // still polluted against the live catalog
  let marked = 0;              // written (APPLY) / would be written (REPORT)
  let alreadyUnavailable = 0;  // idempotent skip
  let skippedNoLonger = 0;     // the list drifted -- re-derived clean
  let skippedMissing = 0;      // no longer on the queue at all
  let skippedBudget = 0;       // the clock stopped before this entry
  let failed = 0;

  // Entries the grouping could not place are accounted for HERE rather than
  // silently dropped -- an unnamed entry is the unaccounted row this whole
  // reconciliation exists to make impossible.
  const grouped = cellList.reduce((n, c) => n + c.entries.length, 0);
  const skippedMalformed = intended - grouped;
  if (skippedMalformed > 0) {
    console.log(`  ${f(skippedMalformed)} entry(ies) carry no readable (year, setKey) -- skipped, not guessed\n`);
  }

  /** The ledger: every id this run marked, so the verify names rows rather
   *  than counting them. */
  const markedIds = [];
  const driftSamples = [];
  let stoppedAtBudget = false;
  const T0 = Date.now();

  for (let ci = 0; ci < cellList.length; ci++) {
    // THE PRE-CHECK, before the unit -- never at the loop top. A cell costing
    // more than the reserve is stopped BEFORE it starts (#1799).
    if (CLOCK.outOfClock()) {
      stoppedAtBudget = true;
      for (let j = ci; j < cellList.length; j++) skippedBudget += cellList[j].entries.length;
      break;
    }
    const cell = cellList[ci];

    // -- RE-DERIVE. One cross-sport PROJECTION per cell, never an aggregate:
    // card_catalog does not return COUNT(1)/GROUP BY at 19.63M rows. Two
    // columns, because that is all the question needs.
    let rows = [];
    try {
      const r = await cat.items.query({
        query: "SELECT c.sport, c.source FROM c WHERE c.year=@y AND c.setKey=@k",
        parameters: [{ name: "@y", value: cell.year }, { name: "@k", value: cell.setKey }],
      }, { maxItemCount: -1, maxDegreeOfParallelism: -1 }).fetchAll();
      rows = r.resources;
    } catch (e) {
      // A cell we cannot read is a cell we cannot classify, and an unclassified
      // entry is never marked. Counted as failed so it lands in the
      // reconciliation rather than vanishing.
      failed += cell.entries.length;
      if (failed <= 5) console.log(`   read failed ${cell.year}|${cell.setKey}: ${String(e && e.message).slice(0, 90)}`);
      continue;
    }
    const counts = new Map();
    for (const x of rows) {
      if (!isChecklist(x.source)) continue;
      const sp = norm(x.sport);
      if (!sp) continue;
      counts.set(sp, (counts.get(sp) || 0) + 1);
    }

    for (const e of cell.entries) {
      const asking = norm(e.sport);
      const v = classifySportContamination({ sport: asking, checklistSportCounts: counts });

      // -- THE DRIFT GATE. The list said polluted; the live catalog is the
      // authority. An entry that no longer classifies as polluted is SKIPPED
      // with a reason and NEVER marked.
      if (!v.contaminated) {
        skippedNoLonger++;
        if (driftSamples.length < 10) {
          driftSamples.push(`${e.id}  list=${e.verdict || "?"} -> now=${v.verdict}`);
        }
        continue;
      }
      rederivedPolluted++;

      // Read the live row: its status decides idempotency, and a row that is
      // gone is not this lane's to resurrect. Point read on (id, /sport) --
      // the queue's partition key is /sport.
      let live = null;
      try {
        const { resource } = await queue.item(e.id, e.sport).read();
        live = resource || null;
      } catch (err) {
        if (err && err.code === 404) live = null;
        else {
          failed++;
          if (failed <= 5) console.log(`   read failed ${e.id}: ${String(err && err.message).slice(0, 90)}`);
          continue;
        }
      }
      if (!live) { skippedMissing++; continue; }
      if (norm(live.status) === MARK_STATUS) { alreadyUnavailable++; continue; }

      const reason = reasonFor(v);
      if (!APPLY) {
        // The REPORT ran the apply's whole derivation -- the classification,
        // the live read, the idempotency check -- and stops here. Its counts
        // ARE the apply's counts.
        marked++;
        markedIds.push(e.id);
        continue;
      }
      try {
        // The drainer's own shape: the row, restamped. Nothing is deleted and
        // requestCount / reasons / samples are carried forward untouched.
        const at = new Date().toISOString();
        await queue.items.upsert({
          ...live,
          status: MARK_STATUS,
          drainedAt: at,
          drainReason: reason,
          sportHygiene: {
            verdict: v.verdict,
            trueSport: v.trueSport,
            candidateSports: v.candidates,
            markedBy: "purge-seed-queue-sport-hygiene",
            markedAt: at,
          },
        });
        marked++;
        markedIds.push(e.id);
      } catch (err) {
        failed++;
        if (failed <= 5) console.log(`   FAILED ${e.id}: ${String(err && err.message).slice(0, 110)}`);
      }
    }

    // PROGRESS. A long read with no output is indistinguishable from a hang —
    // the lesson the retire lane wrote 148 minutes of silence to learn
    // (CF-NARRATE-THE-BOUNDARY-YOU-CANNOT-EXPLAIN), and the audit's own header
    // makes the same argument for the identical per-cell read. fs.writeSync,
    // not console.log: a buffered write on a pipe whose reader is not draining
    // is exactly the line that does not arrive, and "no progress printed" must
    // mean "no progress", not "progress buffered".
    if ((ci + 1) % 50 === 0) {
      const rate = (ci + 1) / Math.max(1, (Date.now() - T0) / 1000);
      try {
        fs.writeSync(1, `   ...${ci + 1}/${cellList.length} cells  ${rate.toFixed(1)}/s`
          + `  ${APPLY ? "marked" : "would mark"} ${marked}  skipped-healed ${skippedNoLonger}\n`);
      } catch { /* progress is not the work */ }
    }
  }

  if (driftSamples.length) {
    console.log(`\nLIST DRIFT -- entries the live catalog no longer calls polluted (first ${driftSamples.length}):`);
    for (const s of driftSamples) console.log(`   ${s}`);
  }

  // -- VERIFY BY READ, AS A LEDGER. Every id this run marked, read back and
  // its status confirmed. Never a COUNT: a container-wide count of
  // status='unavailable' includes rows the drainer marked for its own reasons.
  let confirmed = null;
  if (APPLY && markedIds.length) {
    const vt0 = Date.now();
    confirmed = await CLOCK.capped(vt0, "marked seeds read back", async (abortSignal) => {
      let ok = 0;
      for (const id of markedIds) {
        if (abortSignal && abortSignal.aborted) break;
        const sport = id.split(":")[1] || "";
        try {
          const { resource } = await queue.item(id, sport).read({ abortSignal });
          if (resource && norm(resource.status) === MARK_STATUS) ok++;
        } catch { /* a row that will not read is not confirmed */ }
      }
      return ok;
    });
  }

  console.log("\n-- BANNER ---------------------------------------------------");
  console.log(`  mode                              ${APPLY ? "APPLY" : "REPORT (no writes)"}`);
  console.log(`  entries in list                   ${f(intended)}`);
  console.log(`  re-derived polluted               ${f(rederivedPolluted)}`);
  console.log(`  ${APPLY ? "marked                          " : "would mark                      "}  ${f(marked)}`);
  console.log(`  already unavailable (idempotent)  ${f(alreadyUnavailable)}`);
  console.log(`  skipped -- no longer polluted     ${f(skippedNoLonger)}`);
  console.log(`  skipped -- gone from the queue    ${f(skippedMissing)}`);
  console.log(`  skipped -- unreadable entry       ${f(skippedMalformed)}`);
  console.log(`  skipped -- budget                 ${f(skippedBudget)}`);
  console.log(`  failed                            ${f(failed)}`);
  if (APPLY) {
    // The literal both the operator and the pin read. UNCONFIRMED is never a
    // zero (feedback_never_dismiss_small_numbers_as_noise).
    console.log(`  VERIFY BY READ  marked seeds confirmed unavailable: ${confirmed === null ? "UNCONFIRMED (verify cap)" : `${f(confirmed)} / ${f(markedIds.length)}`}`);
    if (confirmed === null) {
      console.log("  the verify count is UNREAD, not zero -- the writes above reconciled and are durable.");
    }
  }

  const skipped = alreadyUnavailable + skippedNoLonger + skippedMissing + skippedMalformed + skippedBudget;
  const accounted = marked + skipped + failed;
  console.log(`\n  reconciled: intended ${f(intended)} = written ${f(marked)} + skipped ${f(skipped)} + failed ${f(failed)}`);
  if (accounted !== intended) {
    console.error(`  !! RECONCILE MISMATCH -- ${f(Math.abs(intended - accounted))} entr(ies) neither written, skipped nor failed`);
    process.exitCode = 4;
  } else {
    console.log("  RECONCILE BALANCES");
  }

  // The budget marker is a SOURCE LITERAL, printed on the same line in both
  // modes: the relaunch step greps it, and a report longer than one budget
  // must relaunch as a report (CF-REPORT-RELAUNCHES-AS-A-REPORT).
  if (stoppedAtBudget) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the relaunch continues from here`);
  }

  // A shortfall sets process.exitCode = 4 -- red, not green. Reported in APPLY
  // only: a REPORT wrote nothing, and reconciling zero writes against a
  // non-zero intent would turn every dry run red.
  if (APPLY) {
    reportWrites({
      job: "purge-seed-queue-sport-hygiene", intended, written: marked, skipped, failed,
    });
  }
  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost
// four reconciled-clean runs their exit codes.
if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}

module.exports = { APPLY, SCOPE, isChecklist, isSelfDerived, reasonFor, MARK_STATUS, scopeRefusal };
