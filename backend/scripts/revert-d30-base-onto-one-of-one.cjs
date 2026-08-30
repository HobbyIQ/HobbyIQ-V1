/**
 * REVERT the 190 sold_comps rows an operator-error APPLY probe moved on
 * 2026-08-30 20:11-20:12Z, restoring them to the un-numbered base identity.
 *
 * WHAT HAPPENED. While validating the D30 fleet, the previous builder ran it
 * with BACKFILL_APPLY=true against prod to check that the contentHash guard
 * refuses. The guard sat at the END of the run, so the group loop wrote before
 * reaching it and a 2-minute foreground timeout killed the run mid-loop.
 * (That ordering defect is fixed on this branch: the guard is now a read-only
 * PRE-FLIGHT that refuses before the first write.)
 *
 * Blast radius, verified by read on 2026-08-30 -- 190 sold_comps rows, ONE
 * loser group, ZERO card_catalog rows moved:
 *
 *   hiq:football:2024:panini-prizm:347:base:no-auto            [beckett, un-numbered]
 *     -> hiq:football:2024:panini-prizm:347:base:no-auto:num-1 [checklistinsider, /1]
 *
 * WHY IT IS ALSO A REAL BUG. A Panini Prizm BASE card is not a 1/1.
 * checklistinsider-2026-08-28 transcribed the base row as /1, and D30 rule 2
 * ("numbered beats un-numbered") folded the genuine un-numbered base card onto
 * it -- carrying 190 ordinary base sales ($24-$136, Jayden Daniels #347 RC)
 * onto a row that reads as a one-of-one. A real 1/1 Daniels rookie is worth
 * thousands, so this corrupts that identity's FMV in the expensive direction.
 * The rule fix is `baseCardCannotBeOneOfOne`; this script restores the pool.
 *
 * WHY THIS IS NOT THE PRIOR BUILDER'S SCRIPT. Theirs
 * (C:/tmp/d30out/REVERT-190-rows.cjs) selected the right rows -- its predicate
 * matches 190 of 190, verified by read -- but its WRITE was wrong in two ways,
 * both found by reading the CURRENT prod state rather than trusting the note:
 *
 *   1. IT PATCHED, BUT THE ROWS CHANGED PARTITION. All 190 rows have
 *      `cardId = ...:num-1` (measured: cardId==WRONG 190, cardId==LOSER 0), so
 *      they were RELOCATED cross-partition, not patched in place. A patch that
 *      sets only `hobbyiqCardId` leaves `cardId` on the /1 partition: the sale
 *      would read as base by one field and as the 1/1 by the other, which is
 *      worse than the state it is fixing. `cardId` is the partition key and
 *      cannot be patched -- the row must be re-written under the new key and
 *      the old one deleted.
 *   2. IT LEFT contentHash STALE. `contentHash` includes `cardId`, so every
 *      one of the 190 carries the /1 partition's hash (verified: the stored
 *      hash on a sample row recomputes exactly from cardId=...:num-1). Left
 *      behind, the store's pre-write dedup could never match a re-emit of that
 *      sale, and the row would duplicate on the next ingest.
 *
 * So the revert goes through `relocateSoldComp` -- upsert-verify-delete, the
 * same path the fold used -- and recomputes the hash for the destination
 * partition. It is the exact inverse of what was done.
 *
 * SCOPE SAFETY. It touches ONLY rows that satisfy all three: sitting on the /1
 * slug, stamped `reslugedFrom` = that exact loser, and `reslugedReason`
 * containing "D30 r2" -- the stamp that run wrote. It cannot reach a row any
 * other job moved. Measured 2026-08-30: that predicate matches 190, and the
 * looser predicates match 190 too, so it neither over- nor under-reaches.
 *
 * REPORT ONLY BY DEFAULT. Like every runner script here, it writes only when
 * BACKFILL_APPLY=true, and the runner is the only place that should set it.
 */
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

// ---------------------------------------------------------------------------
// SCOPE REFUSAL, ABOVE ANY dist REQUIRE (#1565). A whole-scope write must
// refuse without an explicit scope, and the refusal must fire with `dist`
// absent -- otherwise a MODULE_NOT_FOUND masquerades as a guard.
// ---------------------------------------------------------------------------
const LOSER = "hiq:football:2024:panini-prizm:347:base:no-auto";
const WRONG = `${LOSER}:num-1`;
const REASON_MARK = "D30 r2";

const SCOPE = String(process.env.SCOPE || "").trim();
if (SCOPE !== "d30-base-one-of-one-incident") {
  console.error("FATAL: this script reverts ONE named incident and refuses to run unscoped.");
  console.error("       Pass SCOPE=d30-base-one-of-one-incident to mean it.");
  console.error(`       It re-points only rows on ${WRONG} stamped reslugedFrom=${LOSER}`);
  console.error(`       whose reslugedReason contains "${REASON_MARK}".`);
  process.exit(1);
}

const backend = path.resolve(__dirname, "..");
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
const D = (...p) => require(path.join(backend, "dist", ...p));
const { reportWrites } = D("services", "ops", "writeReconciliation.js");

const APPLY = process.env.BACKFILL_APPLY === "true";
const f = (n) => Number(n).toLocaleString();

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const pool = db.container("sold_comps");

  console.log(`revert-d30-base-onto-one-of-one   ${APPLY ? "APPLY" : "REPORT ONLY -- nothing is written"}`);
  console.log(`  from  ${WRONG}   (checklistinsider transcribed the BASE row as /1)`);
  console.log(`  to    ${LOSER}   (beckett, un-numbered -- the real base card)`);
  console.log(`  only rows stamped reslugedFrom=<loser> AND reslugedReason contains "${REASON_MARK}"`);

  const { resources } = await retry(() => pool.items.query({
    query: `SELECT * FROM c WHERE c.hobbyiqCardId = @w AND c.reslugedFrom = @l AND CONTAINS(c.reslugedReason, @m)`,
    parameters: [{ name: "@w", value: WRONG }, { name: "@l", value: LOSER }, { name: "@m", value: REASON_MARK }],
  }).fetchAll());

  console.log(`\n  matched ${f(resources.length)} rows`);

  const stats = { relocated: 0, patched: 0, failed: 0, alreadyRight: 0 };
  for (const src of resources) {
    // The rows were RELOCATED cross-partition by the fold, so the revert is a
    // relocate too. A row whose cardId is already the base slug only needs the
    // slug field put back.
    if (String(src.cardId) !== WRONG) {
      if (APPLY) {
        try {
          await retry(() => pool.item(src.id, src.cardId).patch([
            { op: "set", path: "/hobbyiqCardId", value: LOSER },
            { op: "set", path: "/reslugedReason", value: "REVERTED: a D30 validation APPLY folded the base card onto a mis-transcribed /1 row; restored to the un-numbered base identity" },
            { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
          ]));
          stats.patched++;
        } catch (e) { stats.failed++; console.log(`  fail(patch) ${src.id}: ${String(e.message).slice(0, 80)}`); }
      } else stats.patched++;
      continue;
    }

    // cardId IS the /1 slug: re-key the row back onto the base partition and
    // recompute the hash for its destination, or the store's pre-write dedup
    // can never match this sale again.
    const keep = {
      ...stripSystem(src),
      cardId: LOSER,
      hobbyiqCardId: LOSER,
      reslugedFrom: WRONG,
      reslugedReason: "REVERTED: a D30 validation APPLY folded the base card onto a mis-transcribed /1 row; restored to the un-numbered base identity",
      reslugedAt: new Date().toISOString(),
    };
    keep.contentHash = contentHashOf(keep);
    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: src.id, cardId: WRONG }],
      retry,
      verifyFields: ["cardId", "hobbyiqCardId"],
      dryRun: !APPLY,
    });
    if (res.ok) stats.relocated++;
    else { stats.failed++; console.log(`  fail(relocate) ${src.id}: ${String(res.reason ?? "unknown").slice(0, 80)}`); }
  }

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows matched            ${f(resources.length)}`);
  console.log(`  re-keyed (relocate)     ${f(stats.relocated)}   <- cardId was the /1 slug; upsert-verify-delete + fresh contentHash`);
  console.log(`  slug patched in place   ${f(stats.patched)}   <- cardId already on the base partition`);
  console.log(`  failed                  ${f(stats.failed)}`);
  const accounted = stats.relocated + stats.patched + stats.failed;
  console.log(`  RECONCILES              ${f(accounted)} vs ${f(resources.length)} matched  ${accounted === resources.length ? "OK" : "MISMATCH"}`);

  if (APPLY) {
    // DISJOINT counters. `relocated` and `patched` are the two disjoint halves
    // of `written`; neither is a slice of the other and neither is `skipped`.
    reportWrites({
      job: "revert-d30-base-onto-one-of-one",
      intended: resources.length,
      written: stats.relocated + stats.patched,
      skipped: 0,
      failed: stats.failed,
      notes: `re-keyed ${stats.relocated}; slug-patched ${stats.patched}`,
    });

    const count = async (slug) => (await pool.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s",
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll()).resources[0];
    console.log(`\n  VERIFY BY READ  on the /1 row: ${f(await count(WRONG))}   on the base row: ${f(await count(LOSER))}`);
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
