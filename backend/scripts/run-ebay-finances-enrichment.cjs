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

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const RAW_MODE = String(process.env.MODE || "").trim().toLowerCase();
const MODE = RAW_MODE === "refill-fee-lines" ? "refill-fee-lines" : "enrich";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

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
  if (MODE === "refill-fee-lines") {
    console.log(`  refill-fee-lines: rows WITH netPayout whose breakdown was never FETCHED (feeFetchedAt unset), or whose shipping is still open; fills the breakdown, keeps the stored payout, never blanks a known value`);
  }
  const s = await runFinancesEnrichmentSweep({ mode: MODE });
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
  if (APPLY) reportWrites({ job: `run-ebay-finances-enrichment[${MODE}]`, intended: Number(s.candidatesEvaluated ?? 0), written: Number(s.enriched ?? 0), skipped: Number(s.noFinancesData ?? 0), failed: Number(s.errors ?? 0) });
  if (Number(s.errors ?? 0) > 0) { console.error(`FATAL: ${s.errors} error(s)`); process.exit(1); }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || e); process.exit(3); });
