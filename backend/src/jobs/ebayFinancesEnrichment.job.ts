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
  mapFinancesToFees,
} from "../services/ebay/ebayFinances.service.js";
import { applyFeeEnrichment } from "../services/portfolioiq/erpAgingOverride.service.js";
import type { LedgerEntryForErp } from "../services/portfolioiq/erpReconciliation.service.js";

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_FIRST_DELAY_MS = 120_000;
const DEFAULT_PER_RUN_CAP = 100;
const MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

export interface FinancesEnrichmentRunSummary {
  users: number;
  candidatesEvaluated: number;
  enriched: number;
  shadow: boolean;
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

function isCandidate(e: any, nowMs: number): "candidate" | "skip-fresh" | "skip-over" | "skip-other" {
  if (e?.source !== "ebay") return "skip-other";
  if (e?.needsReconciliation !== true) return "skip-other";
  if (!e?.ebayOrderId) return "skip-other";
  const soldMs = Date.parse(e.soldAt ?? "");
  if (!Number.isFinite(soldMs)) return "skip-other";
  const age = nowMs - soldMs;
  if (age < MIN_AGE_MS) return "skip-fresh";
  if (age > MAX_AGE_MS) return "skip-over";
  return "candidate";
}

export async function runFinancesEnrichmentSweep(opts: {
  now?: Date;
} = {}): Promise<FinancesEnrichmentRunSummary> {
  const start = Date.now();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const cap = perRunCap();
  const shadow = isShadowMode();

  const summary: FinancesEnrichmentRunSummary = {
    users: 0,
    candidatesEvaluated: 0,
    enriched: 0,
    shadow,
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
      const verdict = isCandidate(entry, nowMs);
      if (verdict === "skip-fresh") { summary.skippedFresh += 1; continue; }
      if (verdict === "skip-over")  { summary.skippedOverWindow += 1; continue; }
      if (verdict !== "candidate")  { continue; }

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

      const feeMap = mapFinancesToFees(txns);
      const { entry: enriched, adjustment } = applyFeeEnrichment(
        entry as LedgerEntryForErp,
        feeMap,
        now.toISOString(),
      );

      // Recompute derived financials. netPayout-authoritative branch
      // fires when feeMap.netPayout != null.
      const granularSum =
        (feeMap.finalValueFee ?? 0)
        + (feeMap.paymentProcessingFee ?? 0)
        + (feeMap.promotedListingFee ?? 0)
        + (feeMap.adFee ?? 0)
        + (feeMap.otherFees ?? 0)
        + (feeMap.actualShippingCost ?? 0);
      const financials = computeLedgerFinancials({
        grossProceeds: (entry as any).grossProceeds,
        feesTotal: granularSum,
        tax: 0,
        shipping: 0,
        gradingCost: (entry as any).gradingCost ?? null,
        suppliesCost: (entry as any).suppliesCost ?? null,
        costBasisSold: (entry as any).costBasisSold,
        netPayoutOverride: feeMap.netPayout ?? null,
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
            priorNetProceeds: (entry as any).netProceeds,
            wouldBeNetProceeds: financials.netProceeds,
            wouldBeRealizedPL: financials.realizedProfitLoss,
            adjustmentReason: adjustment.reason,
          }),
        );
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

  console.log(
    `[ebay.finances.enrichment.job] done ` +
      `users=${summary.users} ` +
      `enriched=${summary.enriched} ` +
      `shadow=${summary.shadow} ` +
      `skippedFresh=${summary.skippedFresh} ` +
      `skippedOverWindow=${summary.skippedOverWindow} ` +
      `noFinancesData=${summary.noFinancesData} ` +
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
    runFinancesEnrichmentSweep().catch((err) => {
      console.error("[ebay.finances.enrichment.job] first run threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runFinancesEnrichmentSweep().catch((err) => {
        console.error("[ebay.finances.enrichment.job] interval run threw:", err?.message ?? err);
      });
    }, intervalMs);
  }, firstDelayMs);
}

export function stopEbayFinancesEnrichmentJob(): void {
  if (_firstRunTimer) { clearTimeout(_firstRunTimer); _firstRunTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}
