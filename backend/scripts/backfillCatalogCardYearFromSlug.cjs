// CF-CATALOG-CARDYEAR-BACKFILL (Drew, 2026-08-10).
// Root cause: BCP ingest wrote `year` but the rest of the codebase reads
// `cardYear` (707 references across 234 files). 1.3M+ BCP rows shipped
// without cardYear, so every downstream query filtering by
// `WHERE c.cardYear = YYYY` bypasses them. Same risk for sold_comps →
// catalog joins on (playerName, cardYear, setName).
//
// Fix: extract year from the hobbyiqCardId slug (position 2 after
// splitting on ':') and add `cardYear` as a top-level field via
// Cosmos patch operation. Idempotent — only writes rows missing
// cardYear.
//
// Ingest itself already fixed at backend/scripts/ingestBaseballCardPedia.cjs
// so future writes carry cardYear. This script cleans up existing rows.
//
// ── CF-CARDYEAR-IS-A-MIRROR, THE STORED HALF (2026-09-04) ──────────────────
//
// #1769 fixed the READER (`(c.cardYear = @y OR c.year = @y)`) and the WRITER
// (deriveCatalogEntry / the checklist ingest dual-write). Neither reaches a row
// already stored. Measured read-only against prod on 2026-09-04, 2,100,230 rows
// carry `year` and no `cardYear`, and every consumer that still filters on
// cardYear alone misses all of them:
//
//     1,521,172  baseballcardpedia-ladders-2026-09-04
//       373,603  hobbymonitor-2026-09-04
//       205,013  sportscardchecklist-2026-09-04
//           423  tcgdex-ja-2026-09-04
//            14  ingest-auto-seed
//             4  ingest-auto-seed-graded
//             1  user-verified
//
// THE RULING (Drew, 2026-09-04): stamp cardYear on EVERY row whose slug carries
// a year, regardless of source. `cardYear` is a MIRROR of the identity year in
// the slug, never a second fact and never an assertion about the card -- so a
// mirror that is present on a checklist row and absent on a vendor row is a
// mirror that is inconsistent, and the inconsistency is the whole defect. This
// is why NO source is excluded: a derived row that is invisible to a cardYear
// filter is a row whose derivedness cannot even be measured. The field asserts
// nothing about authority; `source` still decides that, everywhere, unchanged.
//
// The only rows this leaves alone are rows whose SLUG has no year to mirror --
// they are counted as `skipped`, never guessed at.
//
// Usage (local, report only):
//   DRY_RUN=true  node backend/scripts/backfillCatalogCardYearFromSlug.cjs
// Via the backfill runner: `apply` drives BACKFILL_APPLY, and `sources`
// carries the source scope (comma-separated; empty = every source).

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rows scanned
//   written  = patches acknowledged
//   skipped  = rows whose slug yields no year (left alone)
//   failed   = patches rejected
// Requires dist/ — the workflow builds before running this.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1765). The runner exports
// slot=0/slots=16 to EVERY script; this one sweeps a population once, so
// sharding is OPT-IN and the banner says which it is doing.
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit are the SHARED helper, never a local copy: a private
// copy of capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const crypto = require("crypto");

const CONN = process.env.COSMOS_CONNECTION_STRING;

// CF-RUNNER-EXPORTS-BACKFILL-APPLY-NOT-APPLY. The runner sets BACKFILL_APPLY
// from its `apply` boolean and never sets DRY_RUN, so a script reading DRY_RUN
// alone defaults to true and an APPLY dispatch silently reports. Both are read,
// and REPORT is the default of each: an apply has to be asked for.
const APPLY = String(process.env.BACKFILL_APPLY ?? "").trim().toLowerCase() === "true"
  || String(process.env.APPLY ?? "").trim().toLowerCase() === "true";
const DRY_RUN_ENV = String(process.env.DRY_RUN ?? "").trim().toLowerCase();
const DRY_RUN = DRY_RUN_ENV === "false" ? false : (DRY_RUN_ENV === "true" ? true : !APPLY);

// The source scope rides SOURCES -- the runner's existing `sources` input,
// already exported to every script -- so no new workflow_dispatch input is
// claimed (the form is at 24 of GitHub's 25). SOURCE_FILTER is kept as the
// local-operator spelling this script shipped with. Empty = EVERY source,
// which is the ruling above.
const SOURCES = String(process.env.SOURCES || process.env.SOURCE_FILTER || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || process.env.CONCURRENCY || 64);

const SHARD_SCOPE = runnerShardScope({ label: "backfillCatalogCardYearFromSlug" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

// ── THE THREE CONSTANTS (lib/runner-budget.cjs) ────────────────────────────
//
// Spelled out here rather than left implicit in the budget() call because the
// pins that govern budgeted lanes -- runnerBudgetMargin and
// laneExitsWhenWorkIsDone -- select their population on the literal
// `RUN_MINUTES`. A lane carrying a real clock that never spells it is a lane
// NO pin governs, which is exactly how this one ran unbudgeted over a 2.1M-row
// population: the runner would kill it at the 150-minute ceiling mid-sweep,
// and a killed step prints no marker, no reconcile and no exit code.
//
// THE UNIT IS ONE PATCH dispatched into the CONCURRENCY inflight pool -- a
// single `cat.item(id, pk).patch([{op:"add", path:"/cardYear"}])`, one point
// write against one document, no read and no scan. That is the smallest unit
// any lane in this repo has: sub-second at rest, and bounded above by the SDK
// connection policy's own throttle retry rather than by anything this loop
// does. 60 seconds is therefore ~100x a healthy patch and still comfortably
// exceeds a single write riding out a 429 storm, which is the only way one
// patch gets slow.
//
// WHY THE PRE-CHECK IS NOT SIMPLY "PER ROW OF patchQueue". The pool admits a
// new unit only after `while (inflight.size >= CONCURRENCY) await Promise.race`
// has made room, so the check sits ABOVE that wait: an entry that would overrun
// is never ADMITTED, and the up-to-CONCURRENCY patches already in flight are
// then DRAINED by the `Promise.all` below before any count is printed. Checking
// after the admit would grant one more unit past expiry (the #1799 loop-top
// defect), and skipping the drain would reconcile against counters still being
// incremented by writes in flight.
//
// VERIFY_MS is 5 MINUTES because the AFTER read below is exactly the shape that
// killed run 33960686247: a post-loop cross-partition aggregate
// (`COUNT(1) ... GROUP BY c.source`) over the WHOLE card_catalog container,
// running after the reconcile has printed and the writes are durable. It is
// wired through CLOCK.capped() so it answers or says it could not; it never
// holds the step open to the ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 5 * 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

function yearFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.split(":");
  if (parts.length < 3 || parts[0] !== "hiq") return null;
  const year = Number(parts[2]);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return year;
}

const shardOf = (id) =>
  parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % (SLOTS || 1);

/** The MISSING-cardYear predicate, in one place: the scan and the verify-by-read
 *  must ask the same question or the before/after numbers are not comparable. */
const MISSING_WHERE = "IS_DEFINED(c.hobbyiqCardId) AND (NOT IS_DEFINED(c.cardYear) OR c.cardYear = null)";

function sourceClause(alias) {
  if (SOURCES.length === 0) return "";
  const list = SOURCES.map((s) => JSON.stringify(String(s))).join(", ");
  return ` AND ${alias}.source IN (${list})`;
}

/** VERIFY BY READ (CF-GREEN-WORKFLOW-IS-NOT-DATA-FLOW). The banner cannot
 *  certify the write; a COUNT per source, taken before and after, can. */
async function countMissingBySource(cat, abortSignal) {
  const q = `SELECT c.source, COUNT(1) AS n FROM c WHERE ${MISSING_WHERE}${sourceClause("c")} GROUP BY c.source`;
  // The signal is threaded to the SDK rather than dropped: the AFTER call below
  // runs under CLOCK.capped(), and a cap that merely ABANDONS its loser leaves
  // a cross-partition aggregate retrying on REF'd timers -- the handle that
  // held four reconciled-clean runs to the 150-minute ceiling in #1809.
  const rows = (await cat.items.query({ query: q }, { maxItemCount: 5000, abortSignal }).fetchAll()).resources;
  const out = new Map();
  for (const r of rows) out.set(r.source ?? "(none)", r.n);
  return out;
}

function printCounts(label, counts) {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  let total = 0;
  console.log(`  ${label}`);
  for (const [src, n] of entries) { total += n; console.log(`    ${String(n).padStart(10)}  ${src}`); }
  console.log(`    ${String(total).padStart(10)}  TOTAL`);
  return total;
}

async function main() {
  if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED and unchained, so finishLane() can dispose it: an undisposed SDK
  // keeps its keep-alive sockets open, and a live handle is exactly what kept
  // four APPLY shards alive to the ceiling in #1809.
  const client = new CosmosClient(CONN);
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog");
  const t0 = Date.now();

  console.log("");
  console.log("=== backfillCatalogCardYearFromSlug ===");
  console.log(`  mode                 : ${DRY_RUN ? "REPORT-ONLY (no writes)" : "APPLY"}`);
  console.log(`  source scope         : ${SOURCES.length ? SOURCES.join(", ") : "EVERY source (the ruling: a mirror is source-agnostic)"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  console.log("[verify-by-read] BEFORE — rows missing cardYear, per source:");
  const before = await countMissingBySource(cat);
  const beforeTotal = printCounts("before:", before);
  console.log("");

  const query = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.source FROM c WHERE ${MISSING_WHERE}${sourceClause("c")}`;
  console.log("[scan] querying:");
  console.log("  ", query);

  const iter = cat.items.query(query, { maxItemCount: 1000 });
  let scanned = 0, planned = 0, skippedBadSlug = 0, skippedOtherShard = 0;
  const patchQueue = [];
  const plannedBySource = new Map();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      if (SHARDED && shardOf(r.id) !== SLOT) { skippedOtherShard++; continue; }
      const y = yearFromSlug(r.hobbyiqCardId);
      if (!y) { skippedBadSlug++; continue; }
      patchQueue.push({ id: r.id, pk: r.cardId ?? r.id, year: y });
      const s = r.source ?? "(none)";
      plannedBySource.set(s, (plannedBySource.get(s) || 0) + 1);
      planned++;
    }
    if (scanned % 100000 === 0) console.log(`  scanned=${scanned.toLocaleString()}  planned=${planned.toLocaleString()}  skipped=${(skippedBadSlug + skippedOtherShard).toLocaleString()}`);
  }

  console.log("");
  console.log("[plan]");
  console.log(`  rows scanned         : ${scanned.toLocaleString()}`);
  console.log(`  patches planned      : ${planned.toLocaleString()}`);
  console.log(`  skipped (bad slug)   : ${skippedBadSlug.toLocaleString()}`);
  if (SHARDED) console.log(`  skipped (other shard): ${skippedOtherShard.toLocaleString()}`);
  if (plannedBySource.size > 0) {
    console.log("  planned per source   :");
    for (const [s, n] of [...plannedBySource].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(10)}  ${s}`);
    }
  }
  if (patchQueue.length > 0) {
    const yearCounts = new Map();
    for (const p of patchQueue) yearCounts.set(p.year, (yearCounts.get(p.year) || 0) + 1);
    const yearsSorted = [...yearCounts.entries()].sort((a, b) => a[0] - b[0]);
    console.log(`  year span            : ${yearsSorted[0][0]} - ${yearsSorted[yearsSorted.length - 1][0]}  (${yearsSorted.length} distinct years)`);
    console.log(`  top years            :`);
    const topYears = [...yearCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [y, n] of topYears) console.log(`    ${y}: ${n.toLocaleString()}`);
  }

  let patched = 0, patchFailed = 0;
  // THE BUDGET'S BOOKKEEPING. `notReached` is a REAL number here and not a
  // guess: `patchQueue` is fully materialised by the scan above, so this lane
  // knows its whole population before it writes a single row and can say
  // exactly how many patches the relaunch still owes. A lane that discovered
  // its population page by page could not, and must not invent one.
  let stoppedAtBudget = false, notReached = 0;

  if (DRY_RUN) {
    console.log("");
    console.log("[REPORT-ONLY] no writes issued. Re-dispatch with apply=true to apply.");
  } else {
    console.log("");
    console.log("[apply] patching…");
    const inflight = new Set();
    for (let qi = 0; qi < patchQueue.length; qi++) {
      const p = patchQueue[qi];
      // THE PRE-CHECK, AT THE POINT A NEW UNIT IS ADMITTED. Above the
      // `while (inflight.size >= CONCURRENCY)` wait, not below it: the wait is
      // where a patch enters the pool, so a check underneath it would already
      // have committed to the unit it was meant to refuse. `outOfClock()` is
      // true once less than RESERVE_MS remains, so the patch that would overrun
      // is never DISPATCHED -- the loop-top defect #1799 named is the opposite,
      // admitting one more unit of unbounded size after expiry.
      if (CLOCK.outOfClock()) {
        stoppedAtBudget = true;
        notReached = patchQueue.length - qi;
        break;
      }
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const task = cat.item(p.id, p.pk).patch([
        { op: "add", path: "/cardYear", value: p.year },
      ])
        .then(() => {
          patched++;
          if (patched % 25000 === 0) {
            const eps = (patched / ((Date.now() - t0) / 1000)).toFixed(0);
            console.log(`  patched ${patched.toLocaleString()}/${planned.toLocaleString()}  (${eps}/sec)`);
          }
        })
        .catch((err) => {
          patchFailed++;
          if (patchFailed <= 10) console.warn(`  patch-fail id=${p.id} pk=${p.pk}: ${(err && err.message) || err}`);
        })
        .finally(() => inflight.delete(task));
      inflight.add(task);
    }
    // THE POOL IS DRAINED BEFORE ANYTHING IS COUNTED. `patched` and
    // `patchFailed` are incremented inside the patch callbacks, so a reconcile
    // printed while up to CONCURRENCY writes are still in flight would balance
    // against counters that are still moving -- reporting a shortfall the
    // container does not have. This is on the budget path too: a break above
    // leaves a full pool, and it has to settle here, not be abandoned.
    await Promise.all([...inflight]);
  }

  console.log("");
  console.log("[verify-by-read] AFTER — rows missing cardYear, per source:");
  // UNDER THE CAP. This is the shape that killed run 33960686247: an aggregate
  // over the WHOLE card_catalog container, run AFTER the work, whose cost
  // scales with the corpus and not with what this slice just wrote. The writes
  // above are already durable, so this count is the one thing here allowed to
  // be missing -- and it says so rather than printing a zero.
  const vt0 = Date.now();
  const after = await CLOCK.capped(vt0, "rows still missing cardYear, per source",
    (abortSignal) => countMissingBySource(cat, abortSignal));
  // A count the cap cut short is UNCONFIRMED, and an UNCONFIRMED count is
  // UNREAD, not zero (feedback_never_dismiss_small_numbers_as_noise). Both
  // phrases are SOURCE LITERALS: the pin reads THIS FILE, not the helper's
  // return value.
  if (after === null) {
    console.log("  after: UNCONFIRMED (verify cap)");
    console.log("  the verify count is UNREAD, not zero — the writes above reconciled and are durable.");
  }
  const afterTotal = after === null ? null : printCounts("after:", after);
  console.log("");
  // A delta against an UNREAD count is not a delta at all. Printing
  // `beforeTotal - null` would render the whole BEFORE population as "moved",
  // which is the single most misleading number this lane could emit.
  console.log(afterTotal === null
    ? "  moved: UNCONFIRMED (verify cap) — the AFTER count was not read, so no delta is derivable"
    : `  moved: ${(beforeTotal - afterTotal).toLocaleString()} rows left the missing-cardYear population`);
  if (DRY_RUN && afterTotal !== null && afterTotal !== beforeTotal) {
    console.log("  (a REPORT-ONLY run wrote nothing; any delta here is another writer — the nightly ingest — landing rows mid-run.)");
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done]");
  console.log(`  patched        : ${patched.toLocaleString()}`);
  console.log(`  patch-failed   : ${patchFailed.toLocaleString()}`);
  console.log(`  elapsed        : ${elapsed}s`);

  // RECONCILIATION. intended = written + skipped + failed, exactly. In a
  // REPORT-ONLY run every planned row is a skip: nothing was written, and
  // saying "intended 2.1M, written 0" with no skip column is how an
  // under-sweep reads as a success.
  //
  // A BUDGET STOP IS A SKIP, NEVER A LOSS. `notReached` patches were planned
  // and not attempted, so they belong in the skip column with the rest: the
  // equation still balances, and the relaunch picks them up because a row that
  // already carries cardYear no longer matches MISSING_WHERE.
  const skipped = skippedBadSlug + skippedOtherShard
    + (DRY_RUN ? planned : (planned - patched - patchFailed));
  reportWrites({
    job: "backfillCatalogCardYearFromSlug",
    intended: scanned,
    written: patched,
    skipped,
    failed: patchFailed,
  });
  // The equation the reconcile asserts, restated with the budget's own term
  // broken out, so an operator reading a partial run can see WHY the written
  // count fell short of the plan without re-deriving it.
  // A mismatch is RED (exit 4), not a note.
  const accounted = patched + patchFailed + skipped;
  console.log(`  reconciled: intended ${scanned.toLocaleString()} = written ${patched.toLocaleString()}`
    + ` + skipped ${skipped.toLocaleString()} + failed ${patchFailed.toLocaleString()}`
    + ` (of which not reached ${notReached.toLocaleString()})`);
  if (accounted !== scanned) {
    console.error(`  RECONCILE MISMATCH: ${accounted.toLocaleString()} accounted vs ${scanned.toLocaleString()} scanned`);
    process.exitCode = 4;
  }

  // ── THE MARKER THE RELAUNCH GREPS ────────────────────────────────────────
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The runner greps stdout for
  // `stopped at the .*budget`, so the phrase is a SOURCE LITERAL rather than
  // assembled from variables: a marker built by concatenation is one a
  // refactor can silently reword, and a reworded marker ends the fan-out after
  // one slice with the run green.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${notReached.toLocaleString()} planned patches not reached; the relaunch continues from here`);
    console.log("  the stamp is IDEMPOTENT: a row that now carries cardYear no longer matches"
      + " MISSING_WHERE, so the continuation re-scans cheaply and patches only what is left.");
  }

  return { client, budget: CLOCK };
}

module.exports = { yearFromSlug, shardOf, SHARDED, SLOT, SLOTS, DRY_RUN, APPLY, SOURCES, MISSING_WHERE, sourceClause };

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes. `process.exitCode` may already carry
// the reconcile mismatch above, and that is the code finishLane is handed.
if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => {
      console.error("[FATAL]", (e && e.stack) || e);
      await finishLane(1, { budget: CLOCK });
    });
}
