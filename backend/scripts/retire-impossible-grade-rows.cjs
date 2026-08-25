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

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 32);
const LIMIT = Number(process.env.LIMIT || 0);

/** `9.5` -> `9-5`, matching the slug's grade suffix. */
const gradeSuffix = (co, v) => `${String(co).toLowerCase()}-${String(v).replace(".", "-")}`;

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), sc = db.container("sold_comps");
  const one = async (c, query) => (await c.items.query({ query }, { enableCrossPartitionQuery: true }).fetchAll()).resources;
  const f = (n) => Number(n).toLocaleString();

  // 1. Which (company, grade) pairs are impossible, and how many rows each.
  const pairs = (await one(cat, `SELECT c.gradeCompany AS co, c.gradeValue AS v, COUNT(1) AS n FROM c
      WHERE IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null AND IS_DEFINED(c.gradeValue) AND c.gradeValue != null
      GROUP BY c.gradeCompany, c.gradeValue`))
    .filter((r) => isImpossibleGrade(r.co, r.v))
    .map((r) => ({ co: canonicalGradeCompany(r.co), raw: r.co, v: r.v, n: r.n, suffix: gradeSuffix(canonicalGradeCompany(r.co), r.v) }));

  if (!pairs.length) { console.log("No impossible (company, grade) pairs found. Nothing to do."); return; }
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
    return;
  }
  console.log("  none. Safe to retire.\n");

  // 3. Retire.
  let scanned = 0, attempted = 0, deleted = 0, failed = 0, skipped = 0;
  for (const p of pairs) {
    let token;
    do {
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
  }
  process.stderr.write("\n");

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  rows matching an impossible grade  ${f(scanned)}`);
  console.log(`  retired                            ${f(deleted)}`);
  console.log(`  already gone (404)                 ${f(skipped)}`);
  console.log(`  failed                             ${f(failed)}`);
  if (APPLY) {
    reportWrites({ job: "retire-impossible-grade-rows", intended: attempted, written: deleted, skipped, failed });
  }
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
