#!/usr/bin/env node
// CF-MIGRATE-CARDSIGHT-TO-STAGING (Drew, 2026-08-01).
//
// One-time migration of existing Cardsight sold_comps rows to a new
// cardsight_staging container. After this, sold_comps == confirmed-
// sold-only (cardhedge, ebay-*, manual-user-entry).
//
// Process:
//   1. Reads each Cardsight-source row from sold_comps.
//   2. Upserts a copy to cardsight_staging.
//   3. If MIGRATION_DELETE_SOURCE=true, deletes the row from sold_comps.
//      (Off by default — leaves the source rows in place until we've
//       verified the migration.)
//
// Env:
//   COSMOS_CONNECTION_STRING       required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   MIGRATION_DELETE_SOURCE        true | false (default false)
//   BACKFILL_CONCURRENCY           default 12

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This is the lane with the LARGEST
// blast radius on this wave's list: with MIGRATION_DELETE_SOURCE=true it
// COPIES a row to cardsight_staging and then DELETES it from sold_comps. Its
// own docblock puts the population at the whole Cardsight corpus (~530,000
// rows), which no 150-minute step holds, so before this it could only ever end
// by being KILLED at the ceiling -- mid-migration, with no marker, no
// reconcile, no finishLane line, and #1913's KILLED branch then withholding
// the re-dispatch. A half-migrated corpus with the delete arm ON is rows
// living in neither container's expected shape.
//
// THE UNIT IS ONE PAGE of up to 500 sold_comps rows -- fetched whole, then
// drained through a CONCURRENCY-wide (default 12) window where each item is a
// WHOLE-DOCUMENT upsert into staging FOLLOWED BY a delete from sold_comps. Two
// round trips per row, so the drain is roughly twice a single-write lane's:
// 120 seconds, checked BEFORE the page is fetched.
//
// A PARTIAL SCAN CANNOT PRODUCE A WRONG WRITE, and the copy-then-delete order
// is why. Each row is copied and only then deleted, so a stop between pages
// leaves every already-handled row present in staging; a stop between the two
// halves of ONE row leaves it in BOTH containers, which the re-read folds (the
// upsert is idempotent on id + cardId and the delete of an absent row is
// counted as an error rather than a loss). Nothing depends on the SHAPE of the
// whole scan.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 2 + 1 + 1 = 114m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 120 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const DELETE_SOURCE = process.env.MIGRATION_DELETE_SOURCE === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));
const STAGING_CONTAINER = process.env.COSMOS_CARDSIGHT_STAGING_CONTAINER || "cardsight_staging";

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sc = db.container("sold_comps");
  const { container: staging } = await db.containers.createIfNotExists({
    id: STAGING_CONTAINER,
    partitionKey: { paths: ["/cardId"] },
    defaultTtl: -1,
  });

  console.log(`[migrate-cardsight-to-staging]  mode=${MODE}  deleteSource=${DELETE_SOURCE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE c.source = 'cardsight'`
  }, { maxItemCount: 500 });

  let examined = 0, copied = 0, deleted = 0, errors = 0;
  const inFlight = [];
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count: the loop DISCOVERS rows page by page.
  let stoppedAtBudget = false;

  while (iter.hasMoreResults()) {
    // THE PRE-CHECK: BEFORE the page is fetched, never after its 500
    // copy-then-delete pairs have been issued.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      if (MODE !== "apply") { copied++; continue; }

      // Copy to staging container. Preserve id + cardId.
      const p = withRetry(() => staging.items.upsert(row))
        .then(async () => {
          copied++;
          if (DELETE_SOURCE) {
            try {
              await sc.item(row.id, row.cardId).delete();
              deleted++;
            } catch { errors++; }
          }
        })
        .catch(() => { errors++; });
      inFlight.push(p);
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
    }
    if (examined % 50000 === 0) console.log(`  examined=${examined}  copied=${copied}  deleted=${deleted}  errors=${errors}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===`);
  console.log(`  examined:  ${examined}`);
  console.log(`  copied to staging: ${copied}`);
  console.log(`  deleted from sold_comps: ${deleted} (delete-source=${DELETE_SOURCE})`);
  console.log(`  errors:    ${errors}`);

  // RECONCILE OVER WHAT WAS SEEN. Every scanned row is one this run intended
  // to copy -- the query selects Cardsight rows and nothing else -- so the
  // identity holds whether the loop finished or the budget stopped it. The
  // DELETE arm is reported separately rather than folded in: a copy that
  // landed and a delete that did not is a row in both containers, which the
  // re-read fixes, and hiding it inside one `written` number would make that
  // state invisible.
  if (MODE === "apply") {
    console.log(`  reconciled: intended ${examined} = written ${copied} + failed ${errors}`);
    if (copied + errors !== examined) {
      console.error("  !! RECONCILE MISMATCH -- a scanned row was neither copied nor failed");
      process.exitCode = 4;
    }
    if (DELETE_SOURCE) {
      console.log(`  delete arm: ${deleted} of ${copied} copied rows removed from sold_comps`
        + ` (a copied-but-undeleted row lives in BOTH containers until the next pass re-reads it)`);
    }
    reportWrites({
      job: "migrate-cardsight-to-staging",
      intended: examined, written: copied, skipped: 0, failed: errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this migration is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation is safe to re-read: the staging upsert is keyed on the row's"
      + " own id + cardId, so a row copied by this pass is overwritten with itself rather than"
      + " duplicated, and with MIGRATION_DELETE_SOURCE=true an already-deleted row simply"
      + " no longer appears in the scan.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
