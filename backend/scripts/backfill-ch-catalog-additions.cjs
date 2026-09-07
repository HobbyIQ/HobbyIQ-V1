#!/usr/bin/env node
// CF-BACKFILL-CH-CATALOG-ADDITIONS (Drew, 2026-08-01).
//
// Nightly wrapper for chAdditionsIngest.service.ts. Pulls CH's
// /cards/additions-summary since our last checkpoint and upserts
// new SKUs into ch_catalog_additions. Container was empty — this
// starts the flow.
//
// Env:
//   CARD_HEDGE_API_KEY         required (fetched by workflow from App Service)
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   LOOKBACK_DAYS              default 14 on cold start (per service default)

const path = require("node:path");
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

let ingestCatalogAdditions;
try {
  ({ ingestCatalogAdditions } = require("../dist/services/catalog/chAdditionsIngest.service.js"));
} catch (e) {
  console.error("Cannot import ingestCatalogAdditions from dist — build backend first (npm run build)");
  console.error(e.message);
  process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
if (!process.env.CARD_HEDGE_API_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(1); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

// -- THE CLOCK, AND WHY THIS ONE IS A PRE-FLIGHT GATE -----------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane upserts new CH SKUs into
// ch_catalog_additions and declared no budget: on the runner it could only ever
// end by being KILLED at the 150-minute ceiling -- no marker, no reconcile, no
// finishLane line, and #1913's KILLED branch then withholding the re-dispatch.
//
// >>> THE WORK LOOP IS NOT IN THIS FILE. <<<
//
// ingestCatalogAdditions() runs `while (true)` over CH's additions-summary
// pages (chAdditionsIngest.service.ts:86) and returns one summary. There is no
// seam here for a per-page outOfClock() PRE-check, and inventing one would mean
// racing the call and abandoning it -- an abandoned HTTP+Cosmos walk is exactly
// the wedge #1809 spent 150 minutes of a runner learning about.
//
// THE WALK IS BOUNDED, WHICH IS WHY THE RESERVE IS MINUTES AND NOT AN HOUR.
// The `while (true)` carries a safety cap of 50 pages at DEFAULT_PAGE_SIZE 200
// (chAdditionsIngest.service.ts:120) -- 10,000 additions, hard, per run -- so
// the worst case is 50 CardHedge round trips plus 50 upsertAdditions batches,
// even on a cold start over DEFAULT_LOOKBACK_DAYS (14) or a long checkpoint gap.
//
// So the clock is a PRE-FLIGHT GATE, the same shape as the two eBay sweeps: the
// check happens BEFORE the one call, which is the only unit there is. If the
// clock cannot seat a whole ingest, the lane REFUSES rather than starting one
// it cannot finish -- exit 5, nothing written, marker printed so the relaunch
// re-dispatches with a full clock. And because the ingest is CHECKPOINTED, a
// refusal costs nothing at all: the next run resumes from the same place.
//
// THE RESERVE IS THE WHOLE INGEST: 20 minutes, sized to the page cap (50 CH
// round trips + 50 upsert batches) rather than to the nightly one-day case,
// because the capped run is the one that would actually approach the ceiling.
//
// AND THE GATE IS NOT A GUARANTEE. If the ingest itself overruns its reserve
// nothing here can stop it; the margin under the 150m ceiling absorbs that, and
// the AFTER-check below names the overrun instead of leaving it to be inferred.
//
// VERIFY_MS is nominal: this lane reads nothing after the call.
// Worst case 110 + 20 + 1 + 1 + 1 = 133m, leaving 17m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 20 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function main() {
  console.log(`[backfill-ch-catalog-additions] apply=${APPLY}`);
  console.log(`  ${CLOCK.describe()}`);
  if (!APPLY) {
    console.log("  (dry run — the service is idempotent so we still call it, but skip if you don't want writes)");
    console.log("  (there is no separate dry-run mode; ingest writes to Cosmos on every APPLY=true call)");
    return { budget: CLOCK };
  }

  // -- THE PRE-FLIGHT GATE ---------------------------------------------------
  //
  // The ingest is ONE unit and this file cannot interrupt it, so the check
  // happens BEFORE it starts. Exit 5 is a VERDICT, not a crash (#1955 outcome
  // (d)), and the marker is printed FIRST because the relaunch's marker arm runs
  // BEFORE its outcome check -- so this re-dispatches with a full clock.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the ingest was NOT started; the relaunch continues from here`);
    console.error("  REFUSING THE INGEST: ingestCatalogAdditions walks CH's additions pages in a"
      + " `while (true)` loop INTERNALLY and returns one summary, so there is no seam at which"
      + " this lane could stop it half way. Starting it with less than the unit reserve left would"
      + " mean being KILLED mid-walk at the ceiling -- no summary, no reconcile, no finishLane"
      + " line. Nothing was written, and nothing is lost: the ingest is CHECKPOINTED, so the next"
      + " run resumes from exactly the same date.");
    reportWrites({ job: "backfill-ch-catalog-additions", intended: 0, written: 0, skipped: 0, failed: 0 });
    process.exitCode = 5;
    return { budget: CLOCK };
  }

  const ingestStartedAt = Date.now();
  const summary = await ingestCatalogAdditions({});
  const ingestMs = Date.now() - ingestStartedAt;
  console.log(`\n=== Ingest summary ===`);
  console.log(`  startDate:      ${summary.startDate}`);
  console.log(`  endDate:        ${summary.endDate}`);
  console.log(`  pagesFetched:   ${summary.pagesFetched}`);
  console.log(`  rowsSeen:       ${summary.rowsSeen}`);
  console.log(`  rowsUpserted:   ${summary.rowsUpserted}`);
  console.log(`  firstError:     ${summary.firstError ?? "none"}`);
  console.log(`  elapsedMs:      ${summary.elapsedMs}`);

  // RECONCILE OVER THE ROWS THE INGEST SAW. `rowsSeen` is its denominator and
  // `rowsUpserted` its written count; the residual is the rows it read and did
  // not write. There is no partial-run arm to carry: this lane either runs the
  // whole checkpointed ingest or refuses above.
  //
  // AND A firstError IS NOT ALWAYS A FAILURE, WHICH IS WHY IT IS SPLIT BELOW.
  // The old summary printed it on a line and exited 0 regardless, so an ingest
  // that threw on its FIRST page and wrote nothing reported
  // `firstError: <message>` and went GREEN. But the field carries three
  // different things (chAdditionsIngest.service.ts:96, 113, 121), and one of
  // them -- "page cap hit (50)" -- is not an error at all: it is the service
  // saying it stopped at its own safety cap with more additions waiting, i.e.
  // the CONTINUATION signal. Failing on that would turn every legitimate
  // backlog-drain run red and teach an operator to ignore this lane's failures.
  const rowsSeen = Number(summary.rowsSeen ?? 0);
  const rowsUpserted = Number(summary.rowsUpserted ?? 0);
  const notWritten = Math.max(0, rowsSeen - rowsUpserted);
  console.log(`  reconciled: intended ${rowsSeen} = written ${rowsUpserted} + skipped ${notWritten} + failed 0`);
  reportWrites({
    job: "backfill-ch-catalog-additions",
    intended: rowsSeen, written: rowsUpserted, skipped: notWritten, failed: 0,
  });

  // -- THE OVERRUN THE GATE CANNOT PREVENT -----------------------------------
  if (ingestMs > CLOCK.RESERVE_MS) {
    console.error(`  !! THE INGEST OUTRAN ITS RESERVE: ${Math.round(ingestMs / 1000)}s against a `
      + `${Math.round(CLOCK.RESERVE_MS / 1000)}s reserve. The work is durable and checkpointed; the `
      + `SIZING is wrong. Raise RESERVE_MS (and lower RUN_MINUTES to keep the 15m margin) before `
      + `the next dispatch, or this lane will eventually be killed mid-walk.`);
  }

  const pageCapHit = /page cap hit/i.test(String(summary.firstError ?? ""));
  if (pageCapHit) {
    // -- THE OTHER MARKER THE RELAUNCH GREPS --------------------------------
    //
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled
    // from variables. The service stopped at its 50-page / 10,000-addition
    // safety cap, not at this lane's clock -- but the OPERATIONAL fact is the
    // same one the marker exists to convey: this run did not finish the work,
    // and a re-dispatch continues it. Before this the cap was reported as a
    // `firstError:` line and `RELAUNCH_NEEDED=false`, so a capped run
    // announced completion and the backlog sat there until someone noticed.
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the service hit its own 50-page (10,000-addition) cap, so MORE ADDITIONS REMAIN; `
      + `the relaunch continues from here`);
    console.log("  the continuation resumes from the checkpoint this run just wrote, so the next"
      + " pass starts at the highest added_date it saw rather than re-walking these pages.");
  } else if (summary.firstError) {
    console.error(`FATAL: the ingest reported an error and stopped: ${summary.firstError}`);
    // A VERDICT the lane reached on its own, not a crash: it exits through
    // finishLane so the relaunch classifies it as (d) rather than as a kill.
    process.exitCode = 1;
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
