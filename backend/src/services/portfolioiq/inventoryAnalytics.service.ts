// CF-INVENTORY-TURNOVER-AGING (2026-07-12) — pure analytics over the
// current portfolio doc. Produces the shape iOS's inventory dashboard
// needs in one call. Zero I/O; caller passes doc.holdings + doc.ledger.
//
// Consumed by GET /api/portfolio/erp/inventory-analytics.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { LedgerEntryForErp } from "./erpReconciliation.service.js";

// ─── Aging buckets ──────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  { label: "0-30", minDays: 0, maxDays: 30 },
  { label: "30-90", minDays: 30, maxDays: 90 },
  { label: "90-180", minDays: 90, maxDays: 180 },
  { label: "180-365", minDays: 180, maxDays: 365 },
  { label: "365+", minDays: 365, maxDays: Infinity },
] as const;

export type AgingBucketLabel = (typeof AGING_BUCKETS)[number]["label"];

export interface AgingBucketMetric {
  label: AgingBucketLabel;
  minDays: number;
  maxDays: number;              // Infinity → 365+
  count: number;
  costBasis: number;
}

// ─── Return shape ───────────────────────────────────────────────────────────

export interface OldestHoldingEntry {
  holdingId: string;
  playerName: string | null;
  cardTitle: string | null;
  daysInInventory: number;
  costBasis: number;
  addedAt: string;
}

export interface InventoryAnalytics {
  asOf: string;
  totals: {
    holdingCount: number;
    totalCostBasis: number;
  };
  aging: {
    buckets: AgingBucketMetric[];
    /** null when the portfolio is empty. */
    avgDaysOnHand: number | null;
    /** null when the portfolio is empty. */
    medianDaysOnHand: number | null;
  };
  oldestHoldings: OldestHoldingEntry[];   // top 10 (or fewer)
  /**
   * Coarse turnover proxy. TRUE turnover ratio requires historical inventory
   * levels which we don't track (portfolio_value_history stores totals, not
   * per-holding history). Using current inventory as the denominator:
   *   turnoverProxy = costBasisSold / currentInventoryCost
   * Callers should read this as "in the sample window, we sold ~X× current
   * inventory value in cost basis." Null when currentInventoryCost === 0.
   */
  turnover: {
    windowFrom: string | null;
    windowTo: string | null;
    costBasisSold: number;
    currentInventoryCost: number;
    turnoverProxy: number | null;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseIsoOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function acquisitionMsFor(h: PortfolioHolding): number | null {
  // Prefer purchaseDate; fall back to addedAt; last resort lastUpdated.
  return (
    parseIsoOrNull((h as any).purchaseDate) ??
    parseIsoOrNull((h as any).addedAt) ??
    parseIsoOrNull((h as any).lastUpdated)
  );
}

function costBasisFor(h: PortfolioHolding): number {
  const tcb = typeof h.totalCostBasis === "number" && Number.isFinite(h.totalCostBasis) ? h.totalCostBasis : null;
  if (tcb !== null) return tcb;
  const price = typeof h.purchasePrice === "number" && Number.isFinite(h.purchasePrice) ? h.purchasePrice : 0;
  const qty = typeof h.quantity === "number" && h.quantity > 0 ? h.quantity : 1;
  return price * qty;
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / (24 * 60 * 60 * 1000)));
}

function inWindow(soldAt: string, fromIso: string | null, toIso: string | null): boolean {
  const datePart = soldAt.slice(0, 10);
  if (fromIso && datePart < fromIso) return false;
  if (toIso && datePart > toIso) return false;
  return true;
}

function bucketFor(days: number): AgingBucketMetric {
  const template = AGING_BUCKETS.find((b) => days >= b.minDays && days < b.maxDays)!;
  return { ...template, count: 0, costBasis: 0 };
}

// ─── Public entrypoint ──────────────────────────────────────────────────────

export function buildInventoryAnalytics(
  holdingsById: Record<string, PortfolioHolding>,
  ledger: ReadonlyArray<LedgerEntryForErp>,
  options: { now?: Date; from?: string; to?: string } = {},
): InventoryAnalytics {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const fromIso = options.from ? options.from.slice(0, 10) : null;
  const toIso = options.to ? options.to.slice(0, 10) : null;

  const holdings = Object.values(holdingsById);
  const holdingCount = holdings.length;

  let totalCostBasis = 0;
  const daysArr: number[] = [];
  // Initialize empty buckets so response shape is stable even on empty portfolio.
  const buckets: AgingBucketMetric[] = AGING_BUCKETS.map((b) => ({
    label: b.label, minDays: b.minDays, maxDays: b.maxDays, count: 0, costBasis: 0,
  }));

  const holdingDetails: Array<{ h: PortfolioHolding; days: number; cost: number }> = [];

  for (const h of holdings) {
    const cost = costBasisFor(h);
    totalCostBasis += cost;

    const acqMs = acquisitionMsFor(h);
    if (acqMs === null) continue;         // can't age it — skip aging metrics
    const days = daysBetween(acqMs, nowMs);
    daysArr.push(days);

    const bucket = buckets.find((b) => days >= b.minDays && days < b.maxDays)!;
    bucket.count += 1;
    bucket.costBasis += cost;

    holdingDetails.push({ h, days, cost });
  }

  // ── Aging summary stats ──────────────────────────────────────────────
  const sortedDays = [...daysArr].sort((a, b) => a - b);
  const avgDaysOnHand =
    sortedDays.length > 0
      ? Math.round(sortedDays.reduce((s, d) => s + d, 0) / sortedDays.length)
      : null;
  const medianDaysOnHand =
    sortedDays.length > 0
      ? sortedDays.length % 2 === 1
        ? sortedDays[Math.floor(sortedDays.length / 2)]
        : Math.round(
            (sortedDays[sortedDays.length / 2 - 1] + sortedDays[sortedDays.length / 2]) / 2,
          )
      : null;

  // ── Oldest holdings top-10 ───────────────────────────────────────────
  const oldest = [...holdingDetails]
    .sort((a, b) => b.days - a.days)
    .slice(0, 10)
    .map<OldestHoldingEntry>(({ h, days, cost }) => ({
      holdingId: h.id,
      playerName: h.playerName ?? null,
      cardTitle: h.cardTitle ?? null,
      daysInInventory: days,
      costBasis: Math.round(cost * 100) / 100,
      addedAt: new Date(acquisitionMsFor(h)!).toISOString(),
    }));

  // ── Turnover proxy ───────────────────────────────────────────────────
  // Window-scope costBasisSold from the ledger. Only reconciled sale entries.
  let costBasisSold = 0;
  for (const e of ledger) {
    if ((e as any).action === "regrade") continue;    // not a sale
    if (e.needsReconciliation === true) continue;      // excluded from /pnl too
    if (!inWindow(e.soldAt, fromIso, toIso)) continue;
    costBasisSold += e.costBasisSold ?? 0;
  }
  const currentInventoryCost = totalCostBasis;
  const turnoverProxy =
    currentInventoryCost > 0
      ? Math.round((costBasisSold / currentInventoryCost) * 100) / 100
      : null;

  const r2 = (n: number) => Math.round(n * 100) / 100;

  return {
    asOf: now.toISOString(),
    totals: {
      holdingCount,
      totalCostBasis: r2(totalCostBasis),
    },
    aging: {
      buckets: buckets.map((b) => ({ ...b, costBasis: r2(b.costBasis) })),
      avgDaysOnHand,
      medianDaysOnHand,
    },
    oldestHoldings: oldest,
    turnover: {
      windowFrom: fromIso,
      windowTo: toIso,
      costBasisSold: r2(costBasisSold),
      currentInventoryCost: r2(currentInventoryCost),
      turnoverProxy,
    },
  };
}
