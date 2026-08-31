// CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): scheduled job that
// walks every connected user's ledger looking for unreconciled eBay
// entries inside the 90-day Finances window, fetches the Finances
// transactions for each, applies the enrichment, and persists.
//
// SHADOW MODE DEFAULT ON:
//   EBAY_FINANCES_ENRICHMENT_SHADOW=true (default)
//     → fetch + map + compute the would-be enrichment, LOG it, but DO
//       NOT persist. Lets us watch the first real ITEM_SOLD flow without
//       risking a destructive write before the bucketing's been
//       verified against a real Finances payload.
//   EBAY_FINANCES_ENRICHMENT_SHADOW=false
//     → active mode: persist the enrichment via writeUserDoc.
//
// Switching from shadow → active is a single env var change at deploy
// time; no code change required.
//
// Candidate filter per connected user:
//   source === "ebay" AND needsReconciliation === true
//   AND soldAt > now - 90d (skip past the Finances cutoff)
//   AND soldAt < now - 2d  (skip orders too fresh for payout to settle —
//                            Finances returns FUNDS_PROCESSING which
//                            doesn't yet carry final fees)
//
// Per-run cap: EBAY_FINANCES_ENRICHMENT_PER_RUN entries (default 100).
//
// Heartbeat: `[ebay.finances.enrichment.job] done` line matches the
// Group B PART 2 heartbeat-alert pattern; one matching az monitor
// alert covers the missing-heartbeat case.

import {
  readUserDoc,
  writeUserDoc,
  computeLedgerFinancials,
} from "../services/portfolioiq/portfolioStore.service.js";
import { listConnectedUserIds } from "../services/ebay/ebayTokenStore.service.js";
import {
  getTransactionsForOrder,
  mapFinancesToFeesWithDiagnostics,
} from "../services/ebay/ebayFinances.service.js";
import { applyFeeEnrichment } from "../services/portfolioiq/erpAgingOverride.service.js";
import type { LedgerEntryForErp } from "../services/portfolioiq/erpReconciliation.service.js";
import { runSingleFlight } from "./_singleFlight.js";

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_FIRST_DELAY_MS = 120_000;
const DEFAULT_PER_RUN_CAP = 100;

// D34 (2026-08-31). The 2-day floor is why Drew's 1991 Score Griffey #396
// (order 11-15096-50302, sold 2026-08-30) sat in the queue saying "waiting
// on 7 fee fields": at every sweep it was ~1 day old, so it was counted
// skippedFresh and NO eBay call was ever made for it. The 21:53Z REPORT
// ONLY run and the 18:46Z APPLY run both logged
// `skippedFresh=1 candidates=0` — the floor, not shadow mode and not the
// worker lock (#1553 fixed those), is what held this order.
//
// The floor's premise is real: fees post 1–3 days after the sale, and
// asking too early returns a FUNDS_PROCESSING transaction with no fee
// lines. But "too early" is eBay's answer to give, not ours to assume. A
// fresh order is now FETCHED; if the fees aren't posted yet the payload
// says so and it lands in noFinancesData, to be retried next sweep. That
// turns a silent 2-day blackout into at worst one wasted call per sweep.
//
// MIN_AGE_MS stays as the *reporting* boundary (skippedFreshFetched) so
// the counter still shows how many candidates were young, and stays
// overridable for a deliberate quiet period.
const MIN_AGE_MS = Number(
  process.env.EBAY_FINANCES_ENRICHMENT_MIN_AGE_MS ?? 2 * 24 * 60 * 60 * 1000,
);
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

export interface FinancesEnrichmentRunSummary {
  users: number;
  candidatesEvaluated: number;
  enriched: number;
  shadow: boolean;
  mode: EnrichmentMode;
  /** Candidates younger than MIN_AGE_MS that were fetched anyway (D34). */
  freshFetched: number;
  /** D34: refill mode — rows whose recomputed netPayout disagreed with stored. */
  payoutDisagreements: number;
  /** D34: distinct eBay fee types that fell through to otherFees. */
  unknownFeeTypes: string[];
  skippedFresh: number;
  skippedOverWindow: number;
  noFinancesData: number;
  errors: number;
  durationMs: number;
}

function isShadowMode(): boolean {
  // Default TRUE. Only the explicit string "false" turns shadow off.
  const v = process.env.EBAY_FINANCES_ENRICHMENT_SHADOW;
  return v !== "false";
}

function perRunCap(): number {
  const v = Number(process.env.EBAY_FINANCES_ENRICHMENT_PER_RUN ?? DEFAULT_PER_RUN_CAP);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_PER_RUN_CAP;
}

/**
 * D34: the modes the sweep runs in.
 *   "enrich"           — the 6-hourly default: unreconciled eBay entries.
 *   "refill-fee-lines" — entries that already have netPayout but are
 *                        missing one or more of the five fee fields, i.e.
 *                        the rows the pre-D34 mapper closed without a
 *                        breakdown (Ohtani). Re-fetches and fills them.
 */
export type EnrichmentMode = "enrich" | "refill-fee-lines";

export function resolveMode(raw: string | undefined): EnrichmentMode {
  return String(raw ?? "").trim().toLowerCase() === "refill-fee-lines"
    ? "refill-fee-lines"
    : "enrich";
}

/** The five granular fee fields — netPayout/shipping are tracked apart. */
const GRANULAR_FEE_FIELDS = [
  "finalValueFee",
  "paymentProcessingFee",
  "promotedListingFee",
  "adFee",
  "otherFees",
] as const;

function missingAnyFeeLine(e: any): boolean {
  return GRANULAR_FEE_FIELDS.some((f) => e?.[f] == null);
}

type Verdict = "candidate" | "candidate-fresh" | "skip-over" | "skip-other";

function isCandidate(e: any, nowMs: number, mode: EnrichmentMode): Verdict {
  if (e?.source !== "ebay") return "skip-other";
  if (!e?.ebayOrderId) return "skip-other";
  const soldMs = Date.parse(e.soldAt ?? "");
  if (!Number.isFinite(soldMs)) return "skip-other";
  const age = nowMs - soldMs;
  // The 90-day Finances retention window is a hard boundary in both
  // modes: past it eBay has nothing left to return.
  if (age > MAX_AGE_MS) return "skip-over";

  if (mode === "refill-fee-lines") {
    // Target the already-reconciled rows the old mapper left hollow:
    // payout known, breakdown absent. Deliberately NOT gated on
    // needsReconciliation — these rows are closed, and that is the point.
    if (e.netPayout == null) return "skip-other";
    if (!missingAnyFeeLine(e)) return "skip-other";
    return age < MIN_AGE_MS ? "candidate-fresh" : "candidate";
  }

  if (e?.needsReconciliation !== true) return "skip-other";
  // D34: a fresh order is still a candidate — see MIN_AGE_MS above. It is
  // counted separately so "how many did we ask about early" stays visible.
  return age < MIN_AGE_MS ? "candidate-fresh" : "candidate";
}

export async function runFinancesEnrichmentSweep(opts: {
  now?: Date;
  mode?: EnrichmentMode;
} = {}): Promise<FinancesEnrichmentRunSummary> {
  const start = Date.now();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const cap = perRunCap();
  const shadow = isShadowMode();
  const mode = opts.mode ?? resolveMode(process.env.MODE);
  const unknownFeeTypes = new Set<string>();

  const summary: FinancesEnrichmentRunSummary = {
    users: 0,
    candidatesEvaluated: 0,
    enriched: 0,
    shadow,
    mode,
    freshFetched: 0,
    payoutDisagreements: 0,
    unknownFeeTypes: [],
    skippedFresh: 0,
    skippedOverWindow: 0,
    noFinancesData: 0,
    errors: 0,
    durationMs: 0,
  };

  let userIds: string[];
  try {
    userIds = await listConnectedUserIds();
  } catch (err: any) {
    console.error(
      "[ebay][ebay.finances.enrichment.job] listConnectedUserIds failed:",
      err?.message ?? err,
    );
    summary.errors += 1;
    summary.durationMs = Date.now() - start;
    return summary;
  }

  let processedAcrossUsers = 0;

  for (const userId of userIds) {
    summary.users += 1;
    if (processedAcrossUsers >= cap) break;

    let doc: any;
    try {
      doc = await readUserDoc(userId);
    } catch (err: any) {
      console.error(
        "[ebay][ebay.finances.enrichment.job] readUserDoc failed:",
        err?.message ?? err,
        "userId=", userId,
      );
      summary.errors += 1;
      continue;
    }

    const ledger: any[] = Array.isArray(doc?.ledger) ? doc.ledger : [];
    let docMutated = false;

    for (let i = 0; i < ledger.length; i++) {
      if (processedAcrossUsers >= cap) break;
      const entry = ledger[i];
      const verdict = isCandidate(entry, nowMs, mode);
      if (verdict === "skip-over")  { summary.skippedOverWindow += 1; continue; }
      if (verdict === "skip-other") { continue; }
      if (verdict === "candidate-fresh") {
        // D34: still fetched. Counted in BOTH skippedFresh (so the
        // historical counter keeps its meaning) and freshFetched.
        summary.skippedFresh += 1;
        summary.freshFetched += 1;
      }

      summary.candidatesEvaluated += 1;
      processedAcrossUsers += 1;

      let txns: any[] | null;
      try {
        txns = await getTransactionsForOrder(userId, String(entry.ebayOrderId));
      } catch (err: any) {
        console.error(
          "[ebay][ebay.finances.enrichment.job] getTransactionsForOrder threw:",
          err?.message ?? err,
          "userId=", userId,
          "orderId=", entry.ebayOrderId,
        );
        summary.errors += 1;
        continue;
      }

      if (txns === null || txns.length === 0) {
        summary.noFinancesData += 1;
        continue;
      }

      const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics(txns);
      for (const t of diagnostics.unknownFeeTypes) unknownFeeTypes.add(t);
      if (diagnostics.unknownFeeTypes.length > 0) {
        // Never dropped, never silent: an unrecognized fee still sums into
        // otherFees, and its name is logged so the taxonomy grows on
        // purpose instead of by a P&L discrepancy months later.
        console.warn(
          "[ebay][ebay.finances.enrichment.job] unknown_fee_types " +
          JSON.stringify({
            orderId: entry.ebayOrderId,
            unknownFeeTypes: diagnostics.unknownFeeTypes,
          }),
        );
      }

      // D34 refill: the breakdown is what's being added; the payout is
      // already trusted and drives realized P&L. If the re-fetch disagrees,
      // report it and KEEP the stored payout — a silent restatement of a
      // closed row's P&L is exactly what this mode must not do.
      let payoutDisagreed = false;
      if (mode === "refill-fee-lines" && entry.netPayout != null && feeMap.netPayout != null) {
        if (Math.abs(Number(entry.netPayout) - feeMap.netPayout) > 0.01) {
          payoutDisagreed = true;
          summary.payoutDisagreements += 1;
          console.warn(
            "[ebay][ebay.finances.enrichment.job] payout_disagreement " +
            JSON.stringify({
              orderId: entry.ebayOrderId,
              storedNetPayout: entry.netPayout,
              recomputedNetPayout: feeMap.netPayout,
              netPayoutBasis: diagnostics.netPayoutBasis,
            }),
          );
        }
      }

      const effectiveFeeMap = payoutDisagreed
        ? { ...feeMap, netPayout: Number(entry.netPayout) }
        : feeMap;

      const { entry: enriched, adjustment } = applyFeeEnrichment(
        entry as LedgerEntryForErp,
        effectiveFeeMap,
        now.toISOString(),
      );

      // Recompute derived financials. netPayout-authoritative branch
      // fires when netPayout != null.
      const granularSum =
        (effectiveFeeMap.finalValueFee ?? 0)
        + (effectiveFeeMap.paymentProcessingFee ?? 0)
        + (effectiveFeeMap.promotedListingFee ?? 0)
        + (effectiveFeeMap.adFee ?? 0)
        + (effectiveFeeMap.otherFees ?? 0)
        + (effectiveFeeMap.actualShippingCost ?? 0);
      const financials = computeLedgerFinancials({
        grossProceeds: (entry as any).grossProceeds,
        feesTotal: granularSum,
        tax: 0,
        shipping: 0,
        gradingCost: (entry as any).gradingCost ?? null,
        suppliesCost: (entry as any).suppliesCost ?? null,
        costBasisSold: (entry as any).costBasisSold,
        netPayoutOverride: effectiveFeeMap.netPayout ?? null,
      });
      const finalEntry = {
        ...enriched,
        netProceeds: financials.netProceeds,
        realizedProfitLoss: financials.realizedProfitLoss,
        realizedProfitLossPct: financials.realizedProfitLossPct,
      };

      if (shadow) {
        // Shadow mode: log the full enrichment proposal as a structured
        // line (visible in App Insights), but do NOT mutate the doc.
        console.log(
          "[ebay][ebay.finances.enrichment.job] shadow_enrichment " +
          JSON.stringify({
            userId,
            entryId: (entry as any).id,
            orderId: entry.ebayOrderId,
            financesTransactionCount: txns.length,
            feeMap,
            diagnostics,
            priorNetProceeds: (entry as any).netProceeds,
            wouldBeNetProceeds: financials.netProceeds,
            wouldBeRealizedPL: financials.realizedProfitLoss,
            adjustmentReason: adjustment.reason,
          }),
        );
        // D34: the fixture tap. The five fee fields came back null on
        // every real order because the mapper read a top-level fees[]
        // that eBay does not send — and nothing ever printed the actual
        // response, so the shape was never checked against reality. With
        // EBAY_FINANCES_DUMP_TRANSACTIONS=true a REPORT ONLY run prints
        // the raw transactions, which is what backend/tests/fixtures/
        // ebay-finances/ is built from. Opt-in: the payload carries order
        // and line-item ids. It carries no token — tokens live only in
        // the Authorization header, which is never part of a response.
        if (process.env.EBAY_FINANCES_DUMP_TRANSACTIONS === "true") {
          console.log(
            "[ebay][ebay.finances.enrichment.job] raw_transactions " +
            JSON.stringify({ orderId: entry.ebayOrderId, transactions: txns }),
          );
        }
        summary.enriched += 1; // counted as "would-have-enriched"
        continue;
      }

      // Active mode: persist.
      ledger[i] = finalEntry;
      docMutated = true;
      summary.enriched += 1;
    }

    if (docMutated && !shadow) {
      try {
        await writeUserDoc(userId, doc);
      } catch (err: any) {
        console.error(
          "[ebay][ebay.finances.enrichment.job] writeUserDoc failed:",
          err?.message ?? err,
          "userId=", userId,
        );
        summary.errors += 1;
      }
    }
  }

  summary.durationMs = Date.now() - start;
  summary.unknownFeeTypes = [...unknownFeeTypes].sort();

  console.log(
    `[ebay.finances.enrichment.job] done ` +
      `users=${summary.users} ` +
      `mode=${summary.mode} ` +
      `enriched=${summary.enriched} ` +
      `shadow=${summary.shadow} ` +
      `skippedFresh=${summary.skippedFresh} ` +
      `freshFetched=${summary.freshFetched} ` +
      `skippedOverWindow=${summary.skippedOverWindow} ` +
      `noFinancesData=${summary.noFinancesData} ` +
      `payoutDisagreements=${summary.payoutDisagreements} ` +
      `unknownFeeTypes=${summary.unknownFeeTypes.join("|") || "(none)"} ` +
      `errors=${summary.errors} ` +
      `durationMs=${summary.durationMs}`,
  );

  return summary;
}

export function startEbayFinancesEnrichmentJob(): void {
  if (process.env.EBAY_FINANCES_ENRICHMENT_DISABLE_SCHEDULER === "true") {
    console.log(
      "[ebay.finances.enrichment.job] scheduler disabled via EBAY_FINANCES_ENRICHMENT_DISABLE_SCHEDULER",
    );
    return;
  }
  if (_firstRunTimer || _intervalTimer) {
    console.warn(
      "[ebay.finances.enrichment.job] scheduler already running; ignoring duplicate start",
    );
    return;
  }

  const hours = Number(
    process.env.EBAY_FINANCES_ENRICHMENT_INTERVAL_HOURS ?? DEFAULT_INTERVAL_HOURS,
  );
  const intervalMs = Math.max(1 * 60 * 60 * 1000, hours * 60 * 60 * 1000);
  const firstDelayMs = Math.max(
    0,
    Number(process.env.EBAY_FINANCES_ENRICHMENT_FIRST_DELAY_MS ?? DEFAULT_FIRST_DELAY_MS),
  );

  console.log(
    `[ebay.finances.enrichment.job] scheduling first run in ${Math.round(firstDelayMs / 1000)}s, ` +
      `then every ${(intervalMs / 1000 / 60 / 60).toFixed(1)}h, shadow=${isShadowMode()}`,
  );

  _firstRunTimer = setTimeout(() => {
    runSingleFlight("ebay.finances.enrichment.job", intervalMs, runFinancesEnrichmentSweep).catch((err) => {
      console.error("[ebay.finances.enrichment.job] first run threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runSingleFlight("ebay.finances.enrichment.job", intervalMs, runFinancesEnrichmentSweep).catch((err) => {
        console.error("[ebay.finances.enrichment.job] interval run threw:", err?.message ?? err);
      });
    }, intervalMs);
  }, firstDelayMs);
}

export function stopEbayFinancesEnrichmentJob(): void {
  if (_firstRunTimer) { clearTimeout(_firstRunTimer); _firstRunTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}
