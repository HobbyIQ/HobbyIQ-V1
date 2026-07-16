// CF-ERP-SUMMARY (2026-07-11, Drew): pro_seller dashboard summary.
//
// One call → one screen. Composes existing primitives (buildValuation,
// aggregatePnl, readValueHistory, computeChange30d) into the shape the
// iOS home-screen dashboard needs. Zero new persistence, zero new math.
//
// Returned in ONE HTTP round-trip so iOS doesn't have to fan out 4
// separate calls (/valuation + /pnl + value-history + top-holdings)
// on every app-open. Cache-friendly at 5 min (matches the reprice
// job's snapshot cadence loosely).

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { buildValuation, type ValuationHolding } from "./erpValuation.service.js";
import {
  aggregatePnl,
  type LedgerEntryForErp,
  type HoldingsById,
} from "./erpReconciliation.service.js";
import {
  readValueHistory,
  computeChange30d,
  type PortfolioValueSnapshot,
} from "./portfolioValueHistory.service.js";

export interface SummaryTopMoverEntry {
  holdingId: string;
  title: string;
  playerName: string;
  costBasis: number;
  snapshotValue: number;
  unrealizedGainLoss: number;
  unrealizedPct: number;
}

export interface SummaryTotals {
  costBasis: number;
  snapshotValue: number;
  unrealizedGainLoss: number;
  unrealizedPct: number;
  holdingCount: number;
  freshCount: number;
  staleCount: number;
  missingCount: number;
  estimatedCount: number;
  pendingCount: number;
}

export interface SummaryValueTrendPoint {
  date: string;                  // YYYY-MM-DD
  displayableTotal: number;
}

export interface SummaryChange30d {
  absolute: number;
  percent: number | null;        // null when baseline is 0
  asOfDate: string;              // baseline date
  rangeWeak: boolean;             // history < 30 days
}

export interface SummaryFullPosition {
  realizedYtd: number;
  unrealized: number;
  total: number;
  realizedYtdNote: string;
}

export interface SummaryResponse {
  asOf: string;
  totals: SummaryTotals;
  fullPosition: SummaryFullPosition;
  change30d: SummaryChange30d | null;
  topGainers: SummaryTopMoverEntry[];   // top 5 by unrealizedPct desc
  topLosers: SummaryTopMoverEntry[];    // bottom 5 by unrealizedPct asc
  valueTrend30d: SummaryValueTrendPoint[];  // last ~30 daily snapshots
}

/**
 * Compose a dashboard summary from the same primitives that back the
 * individual /valuation and /pnl routes.
 *
 * Not exported through a repository — this is a pure aggregation. Caller
 * (route handler) loads user doc + value history once and passes both in.
 *
 * Top movers rules:
 *   - Only holdings with snapshotValue !== null (excludes missing / estimated /
 *     pending). Gainers/losers on an unpriced card would be a lie.
 *   - Ties broken by absolute gain/loss (dollars, not percent).
 *   - N=5 fixed. Small enough that iOS renders a stable list; large enough
 *     to be interesting.
 *
 * Value trend truncation:
 *   - Last 30 snapshots (not last 30 DAYS). If the reprice job runs 4x/day,
 *     that's ~7 days of coverage. If it runs 1x/day, ~30 days. Callers
 *     handle the density on their own; the API stays honest — we return
 *     what history exists.
 */
export function composeErpSummary(
  holdings: ReadonlyArray<PortfolioHolding>,
  ledger: ReadonlyArray<LedgerEntryForErp>,
  holdingsById: HoldingsById,
  valueHistory: PortfolioValueSnapshot[],
  nowMs: number,
): SummaryResponse {
  // 1. Valuation (reads reprice snapshot fields — no live computeEstimate)
  const valuation = buildValuation(holdings, ledger, holdingsById, nowMs);

  // 2. Realized YTD comes from the same aggregatePnl the /pnl route uses.
  //    Filter ledger to current-year sold-at range.
  const year = new Date(nowMs).getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1)).toISOString();
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
  const ytdPnl = aggregatePnl(ledger, holdingsById, {
    from: yearStart,
    to: yearEnd,
    groupBy: "month",
  });

  // 3. Top gainers / losers — filter to priced rows, sort, take 5.
  const pricedRows = valuation.holdings.filter(
    (h): h is ValuationHolding & {
      snapshotValue: number;
      unrealizedGainLoss: number;
      unrealizedPct: number;
    } =>
      h.snapshotValue !== null &&
      h.unrealizedGainLoss !== null &&
      h.unrealizedPct !== null,
  );

  const sortedByPct = [...pricedRows].sort((a, b) => {
    if (b.unrealizedPct !== a.unrealizedPct) return b.unrealizedPct - a.unrealizedPct;
    // Tie-break on absolute $ so a $10→$11 (+10%) doesn't outrank $500→$700 (+40%)
    // if they somehow tied on pct — extra safety.
    return b.unrealizedGainLoss - a.unrealizedGainLoss;
  });
  const topGainers: SummaryTopMoverEntry[] = sortedByPct
    .filter((r) => r.unrealizedPct > 0)
    .slice(0, 5)
    .map(toMoverEntry);
  const topLosers: SummaryTopMoverEntry[] = [...sortedByPct]
    .reverse()
    .filter((r) => r.unrealizedPct < 0)
    .slice(0, 5)
    .map(toMoverEntry);

  // 4. Value trend from portfolio_value_history.
  const trend30 = valueHistory
    .slice(-30)
    .map<SummaryValueTrendPoint>((s) => ({
      date: s.date,
      displayableTotal: s.displayableTotal,
    }));

  // 5. Change30d — historical delta between latest and 30-days-ago snapshot.
  const change30d = computeChange30d(valueHistory, new Date(nowMs));

  return {
    asOf: valuation.asOf,
    totals: valuation.totals,
    fullPosition: {
      realizedYtd: ytdPnl.totals.realizedProfitLoss,
      unrealized: valuation.fullPosition.unrealized,
      total: ytdPnl.totals.realizedProfitLoss + valuation.fullPosition.unrealized,
      realizedYtdNote: valuation.fullPosition.realizedYtdNote,
    },
    change30d,
    topGainers,
    topLosers,
    valueTrend30d: trend30,
  };
}

function toMoverEntry(h: ValuationHolding & {
  snapshotValue: number;
  unrealizedGainLoss: number;
  unrealizedPct: number;
}): SummaryTopMoverEntry {
  return {
    holdingId: h.id,
    title: h.cardTitle,
    playerName: h.playerName,
    costBasis: h.costBasis,
    snapshotValue: h.snapshotValue,
    unrealizedGainLoss: h.unrealizedGainLoss,
    unrealizedPct: h.unrealizedPct,
  };
}
