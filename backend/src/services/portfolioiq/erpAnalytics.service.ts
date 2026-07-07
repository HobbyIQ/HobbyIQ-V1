// CF-ERP-EXPANSION-#2 (2026-06-03): seller-grade analytics over the ledger.
//
// Pure functions over (entries, holdingsById). Same unreconciled-excluded
// rule the CF-ERP /pnl + /tax-export layer enforces: needsReconciliation
// rows do NOT contribute to margin/ROI/avg-days-to-sale/sell-through totals
// or to any time-series bucket — they're counted separately on
// `excluded` so the caller knows the totals are honest-but-partial.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import {
  effectivePaymentMethod,
  effectiveSalesChannel,
  isReconciled,
  type HoldingsById,
  type LedgerEntryForErp,
} from "./erpReconciliation.service.js";

export type AnalyticsGroupBy =
  | "player"
  | "set"
  | "grade"
  | "source"
  | "salesChannel"
  | "paymentMethod";

export const VALID_ANALYTICS_GROUP_BY: ReadonlyArray<AnalyticsGroupBy> = [
  "player",
  "set",
  "grade",
  "source",
  "salesChannel",
  "paymentMethod",
];

export type TimeseriesBucket = "month" | "quarter";

export interface AnalyticsGroup {
  key: string;
  label: string;
  entryCount: number;
  totalGross: number;
  totalCost: number;
  totalRealized: number;
  marginPct: number;        // realized / gross × 100, 0 when gross == 0
  roiPct: number;           // realized / cost × 100, 0 when cost == 0
  avgDaysToSale: number | null;  // null when no entry has acquisition date
}

export interface AnalyticsResponse {
  window: { from: string | null; to: string | null };
  groupBy: AnalyticsGroupBy;
  groups: AnalyticsGroup[];
  totals: {
    entryCount: number;
    totalGross: number;
    totalCost: number;
    totalRealized: number;
    marginPct: number;
    roiPct: number;
    avgDaysToSale: number | null;
    sellThroughPct: number | null;  // sales / holdings-ever-owned-in-window
  };
  excluded: {
    unreconciledCount: number;
  };
}

export interface TimeseriesPoint {
  bucket: string;            // "2026-05" or "2026-Q2"
  entryCount: number;
  totalGross: number;
  totalFees: number;
  totalNet: number;
  totalCost: number;
  totalRealized: number;
}

export interface TimeseriesResponse {
  window: { from: string | null; to: string | null };
  bucket: TimeseriesBucket;
  points: TimeseriesPoint[];
  excluded: { unreconciledCount: number };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDateInput(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function inWindow(soldAtIso: string, fromIso: string | null, toIso: string | null): boolean {
  const datePart = soldAtIso.slice(0, 10);
  if (fromIso && datePart < fromIso) return false;
  if (toIso && datePart > toIso) return false;
  return true;
}

function entryFeeTotal(e: LedgerEntryForErp): number {
  if (e.source === "ebay") {
    return (
      (e.finalValueFee ?? 0) +
      (e.paymentProcessingFee ?? 0) +
      (e.promotedListingFee ?? 0) +
      (e.adFee ?? 0) +
      (e.otherFees ?? 0)
    );
  }
  return e.fees ?? 0;
}

function purchaseDateMs(h: PortfolioHolding | undefined): number | null {
  if (!h?.purchaseDate) return null;
  if (typeof h.purchaseDate === "number") return h.purchaseDate;
  const t = Date.parse(String(h.purchaseDate));
  return Number.isFinite(t) ? t : null;
}

function daysBetween(soldAtIso: string, holding: PortfolioHolding | undefined): number | null {
  const acq = purchaseDateMs(holding);
  if (acq === null) return null;
  const sold = Date.parse(soldAtIso);
  if (!Number.isFinite(sold)) return null;
  return Math.max(0, Math.round((sold - acq) / (24 * 60 * 60 * 1000)));
}

function groupKey(e: LedgerEntryForErp, h: PortfolioHolding | undefined, groupBy: AnalyticsGroupBy): { key: string; label: string } {
  switch (groupBy) {
    case "player": {
      const n = e.playerName?.trim() || "(unknown)";
      return { key: n.toLowerCase(), label: n };
    }
    case "set": {
      const s = h?.setName?.trim() || h?.product?.trim() || "(unknown)";
      return { key: s.toLowerCase(), label: s };
    }
    case "grade": {
      const company = h?.gradeCompany?.trim() || h?.gradingCompany?.trim();
      const value = typeof h?.gradeValue === "number" ? h.gradeValue : null;
      if (!company || value === null) return { key: "raw", label: "Raw" };
      const label = `${company.toUpperCase()} ${value}`;
      return { key: label.toLowerCase(), label };
    }
    case "source": {
      const s = e.source ?? "manual";
      return { key: s, label: s === "ebay" ? "eBay" : "Manual" };
    }
    case "salesChannel": {
      const c = effectiveSalesChannel(e);
      return { key: c, label: c === "unknown" ? "(unknown)" : c };
    }
    case "paymentMethod": {
      const p = effectivePaymentMethod(e);
      return { key: p, label: p === "unknown" ? "(unknown)" : p };
    }
  }
}

function buildGroup(label: string, entries: LedgerEntryForErp[], holdingsById: HoldingsById): AnalyticsGroup {
  let totalGross = 0;
  let totalCost = 0;
  let totalRealized = 0;
  let daysSum = 0;
  let daysCount = 0;
  for (const e of entries) {
    totalGross += e.grossProceeds ?? 0;
    totalCost += e.costBasisSold ?? 0;
    totalRealized += e.realizedProfitLoss ?? 0;
    const d = daysBetween(e.soldAt, holdingsById[e.holdingId]);
    if (d !== null) {
      daysSum += d;
      daysCount += 1;
    }
  }
  const marginPct = totalGross > 0 ? (totalRealized / totalGross) * 100 : 0;
  const roiPct = totalCost > 0 ? (totalRealized / totalCost) * 100 : 0;
  const avgDaysToSale = daysCount > 0 ? Math.round(daysSum / daysCount) : null;
  return {
    key: "",
    label,
    entryCount: entries.length,
    totalGross: r2(totalGross),
    totalCost: r2(totalCost),
    totalRealized: r2(totalRealized),
    marginPct: r2(marginPct),
    roiPct: r2(roiPct),
    avgDaysToSale,
  };
}

export function aggregateAnalytics(
  entries: ReadonlyArray<LedgerEntryForErp>,
  holdingsById: HoldingsById,
  options: { from?: string; to?: string; groupBy: AnalyticsGroupBy },
): AnalyticsResponse {
  const fromIso = parseDateInput(options.from);
  const toIso = parseDateInput(options.to);
  // CF-REGRADE-LEDGER-LINE-ITEM (2026-07-06): analytics is sale-only.
  // Regrade entries carry zeroed financials + action="regrade" so
  // downstream P&L / tax rollups would produce identical totals even
  // if they didn't filter; belt-and-braces the exclusion here to
  // avoid entryCount inflation on the sales-mix dashboards.
  const salesOnly = entries.filter((e) => (e as any).action !== "regrade");
  const windowed = salesOnly.filter((e) => inWindow(e.soldAt, fromIso, toIso));
  const reconciled = windowed.filter((e) => isReconciled(e));
  const unreconciled = windowed.filter((e) => !isReconciled(e));

  // Build groups.
  const buckets = new Map<string, { label: string; entries: LedgerEntryForErp[] }>();
  for (const e of reconciled) {
    const { key, label } = groupKey(e, holdingsById[e.holdingId], options.groupBy);
    let g = buckets.get(key);
    if (!g) {
      g = { label, entries: [] };
      buckets.set(key, g);
    }
    g.entries.push(e);
  }
  const groups: AnalyticsGroup[] = Array.from(buckets.entries())
    .map(([key, g]) => ({ ...buildGroup(g.label, g.entries, holdingsById), key }))
    .sort((a, b) => Math.abs(b.totalRealized) - Math.abs(a.totalRealized));

  // Totals (over reconciled only).
  const totalsGroup = buildGroup("(all)", reconciled, holdingsById);

  // sellThrough: sales count / holdings-ever-owned-in-window.
  // "ever-owned-in-window" = holdings whose purchaseDate ≤ window-end OR no
  // window-end (open-ended report). Pure heuristic that doesn't depend on
  // any new field — the user's current holdings + the sold ones from the
  // ledger window approximate the inventory the user had.
  let everOwnedCount: number | null = null;
  if (Object.keys(holdingsById).length > 0) {
    const windowEndMs = toIso ? Date.parse(toIso) + 86_400_000 : Number.MAX_SAFE_INTEGER;
    let owned = 0;
    for (const h of Object.values(holdingsById)) {
      if (!h) continue;
      const acq = purchaseDateMs(h);
      if (acq === null || acq <= windowEndMs) owned += 1;
    }
    everOwnedCount = owned + reconciled.length; // current holdings + already-sold
  }
  const sellThroughPct = everOwnedCount && everOwnedCount > 0
    ? r2((reconciled.length / everOwnedCount) * 100)
    : null;

  return {
    window: { from: fromIso, to: toIso },
    groupBy: options.groupBy,
    groups,
    totals: {
      entryCount: totalsGroup.entryCount,
      totalGross: totalsGroup.totalGross,
      totalCost: totalsGroup.totalCost,
      totalRealized: totalsGroup.totalRealized,
      marginPct: totalsGroup.marginPct,
      roiPct: totalsGroup.roiPct,
      avgDaysToSale: totalsGroup.avgDaysToSale,
      sellThroughPct,
    },
    excluded: { unreconciledCount: unreconciled.length },
  };
}

// ─── Time-series ───────────────────────────────────────────────────────────

function bucketKey(soldAtIso: string, bucket: TimeseriesBucket): string {
  if (bucket === "month") return soldAtIso.slice(0, 7);
  const year = soldAtIso.slice(0, 4);
  const month = Number(soldAtIso.slice(5, 7));
  const q = Math.ceil(month / 3);
  return `${year}-Q${q}`;
}

function bucketsBetween(fromIso: string | null, toIso: string | null, bucket: TimeseriesBucket): string[] {
  if (!fromIso || !toIso) return [];
  const out: string[] = [];
  const fromY = Number(fromIso.slice(0, 4));
  const fromM = Number(fromIso.slice(5, 7));
  const toY = Number(toIso.slice(0, 4));
  const toM = Number(toIso.slice(5, 7));
  if (bucket === "month") {
    let y = fromY, m = fromM;
    while (y < toY || (y === toY && m <= toM)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  } else {
    let y = fromY, q = Math.ceil(fromM / 3);
    const toQ = Math.ceil(toM / 3);
    while (y < toY || (y === toY && q <= toQ)) {
      out.push(`${y}-Q${q}`);
      q += 1;
      if (q > 4) { q = 1; y += 1; }
    }
  }
  return out;
}

export function aggregateTimeseries(
  entries: ReadonlyArray<LedgerEntryForErp>,
  options: { from?: string; to?: string; bucket: TimeseriesBucket },
): TimeseriesResponse {
  const fromIso = parseDateInput(options.from);
  const toIso = parseDateInput(options.to);
  // CF-REGRADE-LEDGER-LINE-ITEM (2026-07-06): analytics is sale-only.
  // Regrade entries carry zeroed financials + action="regrade" so
  // downstream P&L / tax rollups would produce identical totals even
  // if they didn't filter; belt-and-braces the exclusion here to
  // avoid entryCount inflation on the sales-mix dashboards.
  const salesOnly = entries.filter((e) => (e as any).action !== "regrade");
  const windowed = salesOnly.filter((e) => inWindow(e.soldAt, fromIso, toIso));
  const reconciled = windowed.filter((e) => isReconciled(e));
  const unreconciled = windowed.filter((e) => !isReconciled(e));

  const map = new Map<string, TimeseriesPoint>();
  for (const e of reconciled) {
    const key = bucketKey(e.soldAt, options.bucket);
    let p = map.get(key);
    if (!p) {
      p = { bucket: key, entryCount: 0, totalGross: 0, totalFees: 0, totalNet: 0, totalCost: 0, totalRealized: 0 };
      map.set(key, p);
    }
    p.entryCount += 1;
    p.totalGross += e.grossProceeds ?? 0;
    p.totalFees += entryFeeTotal(e);
    p.totalNet += e.netProceeds ?? 0;
    p.totalCost += e.costBasisSold ?? 0;
    p.totalRealized += e.realizedProfitLoss ?? 0;
  }

  // Fill missing buckets with zeros when both from/to are present.
  const allKeys = bucketsBetween(fromIso, toIso, options.bucket);
  if (allKeys.length === 0) {
    // No window — return only buckets that have data, sorted.
    for (const v of map.values()) {
      v.totalGross = r2(v.totalGross);
      v.totalFees = r2(v.totalFees);
      v.totalNet = r2(v.totalNet);
      v.totalCost = r2(v.totalCost);
      v.totalRealized = r2(v.totalRealized);
    }
    const points = Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
    return {
      window: { from: fromIso, to: toIso },
      bucket: options.bucket,
      points,
      excluded: { unreconciledCount: unreconciled.length },
    };
  }

  const points: TimeseriesPoint[] = allKeys.map((k) => {
    const p = map.get(k);
    if (p) {
      return {
        bucket: k,
        entryCount: p.entryCount,
        totalGross: r2(p.totalGross),
        totalFees: r2(p.totalFees),
        totalNet: r2(p.totalNet),
        totalCost: r2(p.totalCost),
        totalRealized: r2(p.totalRealized),
      };
    }
    return {
      bucket: k,
      entryCount: 0,
      totalGross: 0,
      totalFees: 0,
      totalNet: 0,
      totalCost: 0,
      totalRealized: 0,
    };
  });

  return {
    window: { from: fromIso, to: toIso },
    bucket: options.bucket,
    points,
    excluded: { unreconciledCount: unreconciled.length },
  };
}
