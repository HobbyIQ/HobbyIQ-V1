#!/usr/bin/env node
/**
 * run-ebay-finances-enrichment.cjs — the eBay Finances fee enrichment sweep,
 * run on the backfill runner instead of inside the API process.
 *
 * Why (Drew, 2026-08-30 12:40Z, "wont reconcile"): the reconciliation queue
 * showed sales "waiting on 7 fee fields from eBay" forever. Two causes, both in
 * the in-process job: EBAY_FINANCES_ENRICHMENT_SHADOW defaults to TRUE unless
 * the env is exactly "false" (HobbyIQ3 never set it — the job has only ever
 * logged "would-have-enriched"), and every cycle on both workers logged
 * "cycle skipped — another worker holds the lock", so not even the shadow
 * pass ran. Same lock defect the order poll had; same cure: the runner.
 *
 * D34 (2026-08-31) — the two defects that survived that fix:
 *
 *   1. THE AGE FLOOR. Candidates had to be 2–90 days old. Drew's 1991 Score
 *      Griffey #396 (order 11-15096-50302, sold 2026-08-30) was ~1 day old at
 *      every sweep, so it was counted skippedFresh and NO eBay call was ever
 *      made for it. Both the 18:46Z APPLY run and the 21:53Z REPORT ONLY run
 *      logged `skippedFresh=1 candidates=0`. Fresh orders are now fetched;
 *      eBay says whether the fees have posted.
 *
 *   2. THE WRONG FEE PATH. mapFinancesToFees read a top-level `fees[]`.
 *      eBay puts the breakdown on `orderLineItems[].marketplaceFees[]`.
 *      Every unit test built fixtures the wrong way, so the suite was green
 *      while all five fee fields came back null on real orders — Ohtani
 *      (17-15031-43259) reconciled at netPayout $2,396.85 on $2,999.99 gross
 *      with $603.14 of fees itemized nowhere.
 *
 * MODE:
 *   (default) "enrich"  — unreconciled eBay ledger entries inside the window.
 *   "refill-fee-lines"  — rows that already have netPayout but are missing a
 *                         fee line: the ones closed before the mapper was
 *                         fixed. Re-fetches and fills the breakdown only;
 *                         netProceeds / realizedProfitLoss are left alone
 *                         when the recomputed payout agrees, and a
 *                         disagreement is REPORTED with the stored payout
 *                         kept, never silently restated. Idempotent: a row
 *                         whose breakdown has been FETCHED is no longer a
 *                         candidate, so a second run does nothing.
 *
 * D34 R2 (2026-09-01) — four corrections to the above, all of which wrote or
 * hid wrong money:
 *
 *   BLANK vs ZERO. Fee sighting is now PER BUCKET. A bucket no eBay line
 *   touched stays NULL; a bucket eBay valued at "0.00" is recorded as 0.
 *   R1 had a single global flag and got both directions wrong — one fee
 *   line fabricated zeros into all five buckets, and an explicit 0.00 was
 *   discarded as if unknown. So a row that never had a payment-processing
 *   line still keeps a NULL there after a successful fetch. That is the
 *   correct record, and it is why refill candidacy keys on the FETCH
 *   (feeFetchedAt), not on counting nulls.
 *
 *   THE PAYOUT. Attribution is per SALE transaction — each one's own
 *   totalFeeAmount off its own amount — and REFUND amounts are netted out.
 *   R1 subtracted one global fee sum from one global gross, which on a
 *   mixed-basis multi-SALE order took one line item's fees off two line
 *   items' gross. Watch netPayoutBasis: "mixed_per_line_item" means the
 *   derivation was compound, and it now says so instead of reporting a
 *   clean basis.
 *
 *   SHIPPING. Never fabricated. A payload with no SHIPPING_LABEL leaves
 *   actualShippingCost NULL and records shippingAbsentFromEbay; that fact,
 *   not an invented 0, is what lets the row close. A label eBay posts after
 *   the sale is still picked up, because such a row stays a candidate.
 *
 *   THE QUEUE. "Waiting on" is keyed on whether the fee fetch ANSWERED, not
 *   on whether netPayout is set. R1 keyed it on netPayout and thereby
 *   reported that nothing was outstanding on the Ohtani row — the one with
 *   $603.14 itemized nowhere, whose payout had posted through the very
 *   mapper that never read the breakdown.
 *
 * A refill ADDS; it never blanks a value the row already knows.
 *
 * EBAY_FINANCES_DUMP_TRANSACTIONS=true (REPORT ONLY only) prints the raw
 * Finances transactions — how the committed fixtures were captured.
 *
 * Writes only with BACKFILL_APPLY=true — otherwise SHADOW stays on and every
 * candidate is logged as would-have-enriched, nothing written.
 *
 * Reconciliation: intended = candidates evaluated; written = enriched;
 * skipped = no finances data yet (eBay has not posted the fees); failed =
 * errors. Exit 1 on errors.
 *
 * Env: COSMOS_CONNECTION_STRING; EBAY_CLIENT_ID/SECRET/ENV/REDIRECT_URI;
 *      AUTH_SESSION_SECRET; BACKFILL_APPLY; EBAY_FINANCES_ENRICHMENT_PER_RUN
 *      (default 100 — raise for a backlog); MODE.
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const RAW_MODE = String(process.env.MODE || "").trim().toLowerCase();
const MODE = RAW_MODE === "refill-fee-lines" ? "refill-fee-lines" : "enrich";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane writes FEES, net proceeds
// and realized P&L, and declared no budget: on the runner it could only ever
// end by being KILLED at the 150-minute ceiling -- no marker, no reconcile, no
// finishLane line, and #1913 KILLED branch then withholding the re-dispatch.
//
// THE WORK LOOP IS NOT IN THIS FILE, same as run-ebay-purchase-sync:
// runFinancesEnrichmentSweep() walks the users internally
// (ebayFinancesEnrichment.job.ts:215) and returns one summary. So the clock
// takes the same PRE-FLIGHT GATE shape -- the only unit is the whole sweep, so
// the only place a clock can act is before it starts.
//
// BUT THIS ONE IS ALREADY BOUNDED, AND THAT IS WHY ITS RESERVE IS SMALL. The
// sweep carries its own per-run entry cap -- EBAY_FINANCES_ENRICHMENT_PER_RUN,
// default 100 (ebayFinancesEnrichment.job.ts:47) -- so a run is at most 100
// Finances fetches, not "every candidate there is". 10 minutes covers that
// comfortably at eBay latency.
//
// THE CAP IS AN INPUT, AND THE GATE READS IT. An operator draining a backlog
// raises PER_RUN, and a reserve sized for 100 would then be sized for the
// wrong job. So the reserve SCALES with the cap the run was actually given
// (6 seconds an entry, floored at 10 minutes) rather than being a constant
// that silently stops describing the work. The pin reads the literal FLOOR --
// RESERVE_FLOOR_MS -- which is the worst case for the default cap and the
// number the margin is computed from.
//
// VERIFY_MS is nominal: this lane reads nothing after the call.
// Worst case at the floor: 110 + 10 + 1 + 1 + 1 = 123m under the 150m ceiling.
// A raised PER_RUN raises the reserve, which is the point: the margin shrinks
// visibly instead of the run being killed invisibly.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_FLOOR_MS = Number(process.env.RESERVE_FLOOR_MS || 10 * 60 * 1000);
const PER_RUN_CAP = Math.max(1, Number(process.env.EBAY_FINANCES_ENRICHMENT_PER_RUN || 100));
const RESERVE_MS = Number(process.env.RESERVE_MS || Math.max(RESERVE_FLOOR_MS, PER_RUN_CAP * 6000));
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function main() {
  for (const k of ["COSMOS_CONNECTION_STRING", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "AUTH_SESSION_SECRET"]) {
    if (!process.env[k]) { console.error(`FATAL: ${k} not set`); process.exit(1); }
  }
  if (RAW_MODE && RAW_MODE !== "enrich" && RAW_MODE !== "refill-fee-lines") {
    // A typo'd MODE silently running the DEFAULT population is how a
    // dispatch reports a perfectly green nothing. Refuse instead.
    console.error(`FATAL: MODE="${RAW_MODE}" is not a mode (enrich | refill-fee-lines)`);
    process.exit(1);
  }
  // The job reads SHADOW from the env at call time: only the exact string
  // "false" writes. REPORT ONLY keeps shadow on.
  process.env.EBAY_FINANCES_ENRICHMENT_SHADOW = APPLY ? "false" : "true";
  if (APPLY && process.env.EBAY_FINANCES_DUMP_TRANSACTIONS === "true") {
    // The dump exists to build fixtures from a REPORT ONLY run. Letting it
    // ride along with a write run just puts order ids in a log for no
    // reason, so it is refused rather than quietly ignored.
    console.error("FATAL: EBAY_FINANCES_DUMP_TRANSACTIONS is REPORT ONLY (apply=false)");
    process.exit(1);
  }
  const { runFinancesEnrichmentSweep } = require(path.join(backend, "dist/jobs/ebayFinancesEnrichment.job.js"));
  console.log(`run-ebay-finances-enrichment  ${APPLY ? "APPLY (writes fees, net proceeds, realized P&L)" : "REPORT ONLY -- shadow, nothing written"}  mode=${MODE}  env=${process.env.EBAY_ENV || "(default)"}  perRun=${process.env.EBAY_FINANCES_ENRICHMENT_PER_RUN || "100"}`);
  console.log(`  ${CLOCK.describe()}   (reserve scales with perRun=${PER_RUN_CAP})`);
  if (MODE === "refill-fee-lines") {
    console.log(`  refill-fee-lines: rows WITH netPayout whose breakdown was never FETCHED (feeFetchedAt unset), or whose shipping is still open; fills the breakdown, keeps the stored payout, never blanks a known value`);
  }
  // -- THE PRE-FLIGHT GATE ---------------------------------------------------
  //
  // The sweep is ONE unit and this file cannot interrupt it, so the check
  // happens BEFORE it starts. Exit 5 is a VERDICT, not a crash (#1955 outcome
  // (d)), and the marker is printed FIRST because the relaunch marker arm runs
  // BEFORE its outcome check -- so this re-dispatches with a full clock.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the sweep was NOT started; the relaunch continues from here`);
    console.error("  REFUSING THE SWEEP: runFinancesEnrichmentSweep walks its candidates"
      + " INTERNALLY and returns one summary, so there is no seam at which this lane could stop"
      + " it half way. Starting it with less than the unit reserve left would mean being KILLED"
      + " mid-sweep at the ceiling -- no summary, no reconcile, no finishLane line. Nothing was"
      + " written.");
    if (APPLY) {
      reportWrites({ job: `run-ebay-finances-enrichment[${MODE}]`, intended: 0, written: 0, skipped: 0, failed: 0 });
    }
    process.exitCode = 5;
    return { budget: CLOCK };
  }

  const sweepStartedAt = Date.now();
  const s = await runFinancesEnrichmentSweep({ mode: MODE });
  const sweepMs = Date.now() - sweepStartedAt;
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  users                 ${f(s.users)}`);
  console.log(`  candidates            ${f(s.candidatesEvaluated)}   <- ${MODE === "refill-fee-lines" ? "ebay, netPayout set, breakdown never fetched (or shipping still open), <=90 days old" : "ebay, needsReconciliation, <=90 days old"}`);
  console.log(`  ENRICHED              ${f(s.enriched)}${APPLY ? "" : "   <- would-have-enriched (shadow)"}`);
  console.log(`  no finances data yet  ${f(s.noFinancesData)}   <- eBay has not posted the fees`);
  console.log(`  fresh (<2d) fetched   ${f(s.freshFetched)}   <- D34: fetched anyway, eBay decides`);
  console.log(`  skipped over window   ${f(s.skippedOverWindow)}   (>90d, outside Finances retention)`);
  if (MODE === "refill-fee-lines") {
    console.log(`  payout disagreements  ${f(s.payoutDisagreements)}   <- stored payout KEPT; see payout_disagreement lines`);
  }
  console.log(`  unknown fee types     ${(s.unknownFeeTypes ?? []).join(", ") || "(none)"}   <- landed in otherFees, never dropped`);
  console.log(`  errors                ${f(s.errors)}   (${f(s.durationMs)} ms)`);
  // RECONCILE OVER WHAT THE SWEEP EVALUATED -- AND `errors` IS NOT THE FAILED
  // COUNT, WHICH IS THE DEFECT THIS FOUND.
  //
  // `intended` is candidatesEvaluated: the ledger entries the sweep actually
  // looked at, so the identity holds on a capped run exactly as on an
  // exhaustive one (the candidates beyond PER_RUN were never a denominator
  // this run had -- a slice is not a sibling counter). skippedOverWindow is
  // deliberately NOT in it: the job increments it and `continue`s BEFORE
  // candidatesEvaluated (ebayFinancesEnrichment.job.ts:239), so an entry
  // outside eBay 90-day Finances retention was never a candidate at all.
  //
  // BUT `summary.errors` COUNTS TWO DIFFERENT POPULATIONS. Two of its three
  // increments are USER-level and happen where no candidate exists -- a
  // readUserDoc failure (line 227) skips a whole user before its ledger is
  // read, and a doc-save failure lands after the per-entry loop has closed.
  // Only the getTransactionsForOrder throw is per-candidate. The old banner
  // passed `failed: s.errors` against `intended: s.candidatesEvaluated`, so a
  // single unreadable user made the equation OVER by one on a run where every
  // candidate it did see was handled perfectly -- a mismatch that says
  // "writes were lost" about a run that lost nothing.
  //
  // So the per-candidate failures are DERIVED as the residual, and the
  // user-level ones are reported separately by name rather than folded into an
  // equation they do not belong in (feedback: a slice is not a sibling
  // counter; never dismiss small numbers as noise).
  if (APPLY) {
    const intended = Number(s.candidatesEvaluated ?? 0);
    const written = Number(s.enriched ?? 0);
    const awaitingFees = Number(s.noFinancesData ?? 0);
    // Every candidate the sweep evaluated either enriched, was told by eBay
    // that the fees have not posted, or threw on the fetch. The third is the
    // residual, because it is the only one of the three `summary.errors` does
    // not report cleanly.
    const failed = Math.max(0, intended - written - awaitingFees);
    console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(awaitingFees)} + failed ${f(failed)}`);
    console.log(`    skipped = eBay has not posted the fees. NOT counted as candidates at all: `
      + `${f(s.skippedOverWindow ?? 0)} outside the 90-day Finances window.`);
    if (written + awaitingFees + failed !== intended) {
      console.error("  !! RECONCILE MISMATCH -- an evaluated candidate was neither enriched, awaiting fees nor failed");
      process.exitCode = 4;
    }
    const userLevelErrors = Math.max(0, Number(s.errors ?? 0) - failed);
    if (userLevelErrors > 0) {
      console.error(`  ${f(userLevelErrors)} USER-level error(s) -- a ledger that could not be read or `
        + `could not be saved. These are outside the equation above because they touched no candidate; `
        + `they still fail the run below.`);
    }
    reportWrites({ job: `run-ebay-finances-enrichment[${MODE}]`, intended, written, skipped: awaitingFees, failed });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables. The sweep is CAPPED at PER_RUN candidates, so a run that filled
  // its cap has more work waiting and must say so -- otherwise the backlog
  // drains one dispatch at a time, by hand, which is how the queue got to
  // "waiting on 7 fee fields from eBay" forever in the first place.
  if (APPLY && Number(s.candidatesEvaluated ?? 0) >= PER_RUN_CAP) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the per-run cap of ${f(PER_RUN_CAP)} candidates was FILLED, so more remain; `
      + `the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass wrote: candidacy keys on the"
      + " FETCH (feeFetchedAt), so a row whose breakdown was fetched is no longer a candidate.");
  }

  // -- THE OVERRUN THE GATE CANNOT PREVENT -----------------------------------
  //
  // The pre-flight gate sizes the reserve to a whole sweep; it cannot ENFORCE
  // it, because the sweep is opaque. Name the overrun rather than leave it to
  // be inferred from a wall-clock diff.
  if (sweepMs > CLOCK.RESERVE_MS) {
    console.error(`  !! THE SWEEP OUTRAN ITS RESERVE: ${f(Math.round(sweepMs / 1000))}s against a `
      + `${f(Math.round(CLOCK.RESERVE_MS / 1000))}s reserve for perRun=${f(PER_RUN_CAP)}. The work is `
      + `durable and reconciled; the SIZING is wrong. Raise RESERVE_MS (and lower RUN_MINUTES to keep `
      + `the 15m margin), or lower EBAY_FINANCES_ENRICHMENT_PER_RUN, before the next dispatch.`);
  }

  if (Number(s.errors ?? 0) > 0) {
    console.error(`FATAL: ${s.errors} error(s)`);
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
    console.error("FATAL:", e?.stack || e?.message || e);
    await finishLane(3, { budget: CLOCK });
  });
