#!/usr/bin/env node
/**
 * CF-ONE-GRADE-LADDER (Drew, 2026-08-25). Retire card_catalog rows asserting a
 * grade their own company does not issue.
 *
 * The population, measured 2026-08-25: 1,462,513 rows, every one PSA 9.5. PSA's
 * scale runs 8, 8.5, 9, 10 -- there is no 9.5 -- so these are cards that cannot
 * exist. They came from the grade explode, which generated one ladder for every
 * company instead of each company's own:
 *
 *   baseballcardpedia-graded 1,104,572 · bccp-graded 126,790
 *   checklistcenter-graded     121,782 · cardsight-graded 68,490 ...
 *
 * THE GUARD THAT MATTERS. Deleting a catalog row that sales point at converts a
 * bad match into an orphan, which is worse: the row stops being wrong and
 * starts being missing. So before ANY delete, this re-counts the sales
 * referencing each impossible grade's slug suffix and REFUSES the whole run if
 * the count is not zero. It does not trust the measurement I took by hand; it
 * takes its own, every run, and aborts rather than proceeding on a stale fact.
 *
 * (At the time of writing that count is 0 for `:psa-9-5`. Separately, 295
 * sold_comps rows carry gradeCompany=PSA gradeValue=9.5 in their FIELDS while
 * their slugs do not -- mis-parsed sales that need their own repair. This script
 * does not touch sold_comps.)
 *
 * NOT A GENERAL DEDUPE. It only removes rows whose (company, grade) pair the
 * ladder positively rejects. An unrecognised grader can never be condemned --
 * isImpossibleGrade returns false for any scale the service does not assert --
 * so a new grading company appearing in the data is skipped, not deleted.
 *
 * BGS 10 IS EXPLICITLY OUT OF SCOPE. Its 2.00x surplus is a lost Pristine /
 * Black Label distinction -- a duplicate whose label was dropped, not a phantom
 * grade. Deleting on that count would destroy half a legitimate population.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY=true                actually delete (default dry-run)
 *   CONCURRENCY=32
 *   LIMIT=0                   stop after N deletes (0 = no limit)
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { isImpossibleGrade, canonicalGradeCompany } =
  require(path.join(backend, "dist/services/catalog/gradeLadder.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 32);
const LIMIT = Number(process.env.LIMIT || 0);

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane DELETES card_catalog rows
// and declared no budget at all. Its measured population is 1,462,513 rows --
// far more than one 150-minute step holds -- so before this it could only ever
// end by being KILLED at the ceiling: no marker, no reconcile, no finishLane
// line, and #1913's KILLED branch then withholding the re-dispatch with a
// million-row delete half done.
//
// THE UNIT IS ONE PAGE of up to 200 catalog rows (maxItemCount: 200), and the
// page is the right unit rather than the row because the loop cannot stop
// inside one: the page is fetched whole, then drained in CONCURRENCY-wide
// (default 32) batches of point deletes. So the worst single unit this lane can
// start is 200 deletes issued 32 at a time -- seven serial batch waves, each
// wave as slow as its slowest delete, against a container that throttles (the
// connection policy below sits at 60 retries / 300s for exactly that reason).
// 90 seconds comfortably exceeds that wave train and is checked BEFORE the page
// is fetched, so the page whose 200 deletes would overrun is never STARTED --
// the loop-top defect #1799 named admits one whole extra page past expiry.
//
// VERIFY_MS is nominal: the post-loop report reads NOTHING. The one unbounded
// CONTAINS() aggregate in this file is the pre-flight referenced-sales guard,
// which runs BEFORE the first delete -- it spends budget the loop then does not
// get (covered by the reserve and the margin) and cannot strand a
// reconciliation, because at that point there is nothing yet to reconcile.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

/** `9.5` -> `9-5`, matching the slug's grade suffix. */
const gradeSuffix = (co, v) => `${String(co).toLowerCase()}-${String(v).replace(".", "-")}`;

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog"), sc = db.container("sold_comps");
  console.log(`  ${CLOCK.describe()}`);
  const one = async (c, query) => (await c.items.query({ query }, { enableCrossPartitionQuery: true }).fetchAll()).resources;
  const f = (n) => Number(n).toLocaleString();

  // 1. Which (company, grade) pairs are impossible, and how many rows each.
  const pairs = (await one(cat, `SELECT c.gradeCompany AS co, c.gradeValue AS v, COUNT(1) AS n FROM c
      WHERE IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null AND IS_DEFINED(c.gradeValue) AND c.gradeValue != null
      GROUP BY c.gradeCompany, c.gradeValue`))
    .filter((r) => isImpossibleGrade(r.co, r.v))
    .map((r) => ({ co: canonicalGradeCompany(r.co), raw: r.co, v: r.v, n: r.n, suffix: gradeSuffix(canonicalGradeCompany(r.co), r.v) }));

  if (!pairs.length) { console.log("No impossible (company, grade) pairs found. Nothing to do."); return { client, budget: CLOCK }; }
  console.log("impossible grades found:");
  for (const p of pairs) console.log(`  ${f(p.n).padStart(11)}  ${p.co} ${p.v}   slug suffix :${p.suffix}`);

  // 2. THE GUARD. Take our own count of sales pointing at each suffix, now.
  console.log("\nchecking whether any SALE references these slugs...");
  let referenced = 0;
  for (const p of pairs) {
    const n = (await one(sc, `SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(c.hobbyiqCardId, ':${p.suffix}')`))[0] || 0;
    console.log(`  :${p.suffix}  ->  ${f(n)} sales`);
    referenced += n;
  }
  if (referenced > 0) {
    console.error(`\nREFUSING TO DELETE: ${f(referenced)} sales point at these slugs.`);
    console.error("Deleting them would turn a wrong match into a missing one. Repair the sales first.");
    process.exitCode = 2;
    return { client, budget: CLOCK };
  }
  console.log("  none. Safe to retire.\n");

  // 3. Retire.
  let scanned = 0, attempted = 0, deleted = 0, failed = 0, skipped = 0;
  // Set when the budget stopped the page walk. There is NO `not reached` count
  // to print here and inventing one would be a lie: the GROUP BY above gives a
  // population per (company, grade), but the loop DISCOVERS the rows themselves
  // page by page, so a row never fetched was never seen and is not part of
  // `intended`. What the operator gets instead is the MARKER plus an honest
  // statement that the sweep is UNFINISHED, and a reconciliation over what was
  // SEEN (feedback: a slice is not a sibling counter).
  let stoppedAtBudget = false;
  for (const p of pairs) {
    let token;
    do {
      // THE PRE-CHECK: above the unit's work, above any branch fork, and BEFORE
      // the page is fetched rather than after it is deleted. `outOfClock()` is
      // true when less than the reserve remains, so the page whose 200 deletes
      // would overrun is never started.
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const page = await cat.items.query(
        { query: `SELECT c.id, c.cardId FROM c WHERE c.gradeCompany = @co AND c.gradeValue = @v`,
          parameters: [{ name: "@co", value: p.raw }, { name: "@v", value: p.v }] },
        { maxItemCount: 200, continuationToken: token },
      ).fetchNext();
      token = page.continuationToken;
      scanned += page.resources.length;
      if (!APPLY) continue;

      for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
        await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (r) => {
          attempted++;
          try {
            // A row with no partition key is addressable as (id, undefined) --
            // see CF-A-MISSING-PARTITION-KEY-IS-STILL-A-KEY.
            await cat.item(r.id, r.cardId === undefined || r.cardId === null ? undefined : r.cardId).delete();
            deleted++;
          } catch (e) {
            if (e.code === 404) { skipped++; return; }
            failed++;
            if (failed <= 5) console.error("  delete failed " + String(r.id).slice(0, 62) + ": " + String(e.message || e).slice(0, 70));
          }
        }));
        if (LIMIT && deleted >= LIMIT) { token = undefined; break; }
      }
      process.stderr.write(`\r  scanned ${scanned}  deleted ${deleted}  failed ${failed}   `);
    } while (token);
    // The inner `break` only leaves the page walk; without this the next pair
    // would start a fresh one and the budget would be honoured per pair rather
    // than per run.
    if (stoppedAtBudget) break;
  }
  process.stderr.write("\n");

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  rows matching an impossible grade  ${f(scanned)}`);
  console.log(`  retired                            ${f(deleted)}`);
  console.log(`  already gone (404)                 ${f(skipped)}`);
  console.log(`  failed                             ${f(failed)}`);
  // RECONCILE OVER WHAT WAS SEEN. `attempted` counts only the rows this run
  // actually handed to a delete, so the identity below holds whether the loop
  // finished or the budget stopped it -- a budget stop shrinks BOTH sides
  // rather than opening a gap that reads as loss.
  if (APPLY) {
    console.log(`  reconciled: attempted ${f(attempted)} = deleted ${f(deleted)} + already gone ${f(skipped)} + failed ${f(failed)}`);
    if (deleted + skipped + failed !== attempted) {
      console.error("  !! RECONCILE MISMATCH -- a row was neither deleted, already gone nor failed");
      process.exitCode = 4;
    }
    reportWrites({ job: "retire-impossible-grade-rows", intended: attempted, written: deleted, skipped, failed });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the retire is IDEMPOTENT: a row already deleted re-reads as 404 and counts"
      + " as `already gone`, so the continuation re-walks cheaply and deletes only what is left.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error("FATAL:", e?.stack || e?.message || String(e));
    await finishLane(3, { budget: CLOCK });
  });
