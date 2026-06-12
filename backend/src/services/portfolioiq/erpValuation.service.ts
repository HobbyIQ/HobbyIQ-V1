// CF-ERP-EXPANSION-#3 (2026-06-03): unrealized P&L + inventory valuation.
//
// READS the existing 6h portfolioReprice snapshot fields written to each
// holding (fairMarketValue, lastUpdated). ZERO live computeEstimate calls
// in the read path.
//
// Freshness label vs 6h cycle:
//   "fresh"   ≤ 12h
//   "stale"   12h..72h
//   "missing" no fairMarketValue (cardless / repriced-skipped / never priced)
// Missing holdings count separately and are NOT folded into snapshotValue —
// surfaced honestly so the user knows the gap.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { aggregatePnl, type HoldingsById, type LedgerEntryForErp } from "./erpReconciliation.service.js";

export type ValuationFreshness = "fresh" | "stale" | "missing";

export const FRESH_MAX_MS = 12 * 60 * 60 * 1000;
export const STALE_MAX_MS = 72 * 60 * 60 * 1000;

export interface ValuationHolding {
  id: string;
  playerName: string;
  cardTitle: string;
  costBasis: number;
  snapshotValue: number | null;
  unrealizedGainLoss: number | null;
  unrealizedPct: number | null;
  lastUpdated: string | null;
  freshness: ValuationFreshness;
}

export interface ValuationResponse {
  asOf: string;             // freshest holding.lastUpdated; falls back to nowMs
  holdings: ValuationHolding[];
  totals: {
    costBasis: number;
    snapshotValue: number;          // sum over holdings with fairMarketValue
    unrealizedGainLoss: number;
    unrealizedPct: number;
    holdingCount: number;
    freshCount: number;
    staleCount: number;
    missingCount: number;
    // CF-VALUATION-TOTALS-SPLIT (2026-06-12): counts ONLY — no dollars.
    // Estimated holdings carry fairMarketValue=null on disk (Step 1
    // resolution tree), so they're already excluded from snapshotValue
    // and tracked under missingCount. estimatedCount + pendingCount are
    // SUB-buckets of the no-FMV set so the UI can tell "we couldn't
    // price it at all" from "we have a labeled estimate, just not on
    // the tax line." Schedule D CSV, tax accounting, all derived
    // dollar fields stay UNCHANGED.
    estimatedCount: number;
    pendingCount: number;
  };
  fullPosition: {
    realizedYtd: number;
    unrealized: number;
    total: number;
    realizedYtdNote: string;        // "excludes <N> unreconciled entries (CF-ERP rule)"
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function freshnessFor(lastUpdatedMs: number | null, hasValue: boolean, nowMs: number): ValuationFreshness {
  if (!hasValue) return "missing";
  if (lastUpdatedMs === null) return "missing";
  const age = nowMs - lastUpdatedMs;
  if (age <= FRESH_MAX_MS) return "fresh";
  if (age <= STALE_MAX_MS) return "stale";
  return "stale";   // ≥72h is still labelled "stale", not "missing", as long as a value exists
}

function shimmedTitle(h: PortfolioHolding): string {
  if (typeof h.cardTitle === "string" && h.cardTitle.trim()) return h.cardTitle;
  const parts = [h.cardYear, h.setName ?? h.product, h.playerName]
    .filter((p): p is string | number => p !== undefined && p !== null && String(p).length > 0);
  return parts.length > 0 ? parts.map(String).join(" ") : "(untitled)";
}

function costBasisFor(h: PortfolioHolding): number {
  if (typeof h.totalCostBasis === "number" && Number.isFinite(h.totalCostBasis)) return h.totalCostBasis;
  const unit = typeof h.purchasePrice === "number" ? h.purchasePrice : 0;
  const qty = typeof h.quantity === "number" ? h.quantity : 1;
  return unit * qty;
}

export function buildValuation(
  holdings: ReadonlyArray<PortfolioHolding>,
  ledger: ReadonlyArray<LedgerEntryForErp>,
  holdingsById: HoldingsById,
  nowMs: number,
): ValuationResponse {
  let totalCost = 0;
  let totalValue = 0;
  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;
  // CF-VALUATION-TOTALS-SPLIT (2026-06-12): counts only. Sub-buckets of
  // the no-FMV set — these holdings ARE in missingCount + NOT in
  // snapshotValue, but the UI can distinguish "couldn't price" (the
  // remainder of missingCount after subtracting these two) from
  // "labeled rail estimate, kept off the tax line" (estimatedCount) and
  // "rail says insufficient" (pendingCount). NO DOLLAR FROM AN ESTIMATE
  // ENTERS this function's outputs — Schedule D / tax integrity hard
  // invariant.
  let estimatedCount = 0;
  let pendingCount = 0;
  let asOfMs: number | null = null;

  const rows: ValuationHolding[] = holdings.map((h) => {
    const vs = (h as { valuationStatus?: string }).valuationStatus;
    if (vs === "estimated") estimatedCount += 1;
    else if (vs === "pending") pendingCount += 1;
    const fmv = typeof h.fairMarketValue === "number" && Number.isFinite(h.fairMarketValue) ? h.fairMarketValue : null;
    const qty = typeof h.quantity === "number" && h.quantity > 0 ? h.quantity : 1;
    const cost = costBasisFor(h);
    const snapshot = fmv !== null ? fmv * qty : null;
    const updatedMs = toMs(h.lastUpdated);
    const freshness = freshnessFor(updatedMs, fmv !== null, nowMs);

    if (freshness === "fresh") freshCount += 1;
    if (freshness === "stale") staleCount += 1;
    if (freshness === "missing") missingCount += 1;

    if (snapshot !== null) totalValue += snapshot;
    totalCost += cost;

    if (updatedMs !== null && (asOfMs === null || updatedMs > asOfMs)) asOfMs = updatedMs;

    const unrealizedGainLoss = snapshot !== null ? snapshot - cost : null;
    const unrealizedPct = snapshot !== null && cost > 0 ? ((snapshot - cost) / cost) * 100 : null;

    return {
      id: h.id,
      playerName: h.playerName ?? "",
      cardTitle: shimmedTitle(h),
      costBasis: r2(cost),
      snapshotValue: snapshot !== null ? r2(snapshot) : null,
      unrealizedGainLoss: unrealizedGainLoss !== null ? r2(unrealizedGainLoss) : null,
      unrealizedPct: unrealizedPct !== null ? r2(unrealizedPct) : null,
      lastUpdated: updatedMs !== null ? new Date(updatedMs).toISOString() : null,
      freshness,
    };
  });

  const unrealized = totalValue - totalCost;
  const unrealizedPct = totalCost > 0 ? (unrealized / totalCost) * 100 : 0;

  // Realized YTD: from-Jan-1 of the current year through nowMs, via the
  // existing aggregatePnl (carries the unreconciled-excluded rule).
  const now = new Date(nowMs);
  const ytdFrom = `${now.getUTCFullYear()}-01-01`;
  const ytdTo = now.toISOString().slice(0, 10);
  const pnl = aggregatePnl(ledger, holdingsById, { from: ytdFrom, to: ytdTo, groupBy: "month" });
  const realizedYtd = pnl.totals.realizedProfitLoss;

  return {
    asOf: asOfMs !== null ? new Date(asOfMs).toISOString() : new Date(nowMs).toISOString(),
    holdings: rows,
    totals: {
      costBasis: r2(totalCost),
      snapshotValue: r2(totalValue),
      unrealizedGainLoss: r2(unrealized),
      unrealizedPct: r2(unrealizedPct),
      holdingCount: holdings.length,
      freshCount,
      staleCount,
      missingCount,
      estimatedCount,
      pendingCount,
    },
    fullPosition: {
      realizedYtd: r2(realizedYtd),
      unrealized: r2(unrealized),
      total: r2(realizedYtd + unrealized),
      realizedYtdNote: `excludes ${pnl.excluded.unreconciledCount} unreconciled entries (CF-ERP rule)`,
    },
  };
}
