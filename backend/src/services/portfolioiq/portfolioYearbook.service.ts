// CF-SOCIAL-SURFACES (Drew, 2026-07-17): Portfolio Yearbook.
//
// Annual (or quarterly) recap of a portfolio's performance. Shape is
// designed for a shareable / social summary: total realized + unrealized
// P&L, top-3 performers, biggest-3 misses, "what if you had held every
// card you sold" counterfactual.
//
// Period semantics:
//   - Annual: [YYYY-01-01T00:00:00Z, (YYYY+1)-01-01T00:00:00Z)
//   - Quarterly: [YYYY-Qn-start, YYYY-Q(n+1)-start)
//   - All windows are half-open, UTC-aligned. A card sold at
//     2026-12-31T23:59:59Z counts in 2026; a card sold at
//     2027-01-01T00:00:00Z counts in 2027.
//
// Row inclusion:
//   - Realized rows: ledger entries with soldAt inside the window AND
//     action !== "regrade" (grade conversions carry 0 realized P&L and
//     would flood the ranking with false zeros).
//   - Unrealized rows: currently-held holdings whose purchaseDate falls
//     ON OR BEFORE the window end (i.e. owned during the period). If
//     purchaseDate is absent, the holding is treated as "long-held" and
//     included.
//
// Ranking:
//   - topPerformers = top 3 by gainPct DESC (realized + unrealized pool)
//   - biggestMisses = bottom 3 by gainPct ASC, but only rows with
//     gainPct < 0 (a zero-loss doesn't belong on a "misses" list).
//   - Ties broken by absolute gainUsd magnitude.
//
// "whatIfHeldAll" counterfactual:
//   - Assumes any card the user SOLD in the period would have
//     appreciated at the aggregate multiplier of their currently-held
//     inventory (heldMultiplier = totalCurrentValue / totalCostBasis).
//   - Bounded in [0.5, 3.0] to prevent flap on thin baskets (a tiny
//     one-card portfolio in a bull run would otherwise multiply
//     everything by 10x and misrepresent the counterfactual).
//   - opportunityCostUsd = counterfactualSoldValue − grossSalesProceeds
//     (positive → held would have been better; negative → sold was the
//     right call).

import { readUserDoc, type PortfolioLedgerEntry } from "./portfolioStore.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

// ── Bounds ──────────────────────────────────────────────────────────────────
// PINNED. Change → re-pin the "constants" test in portfolioYearbook.test.ts.
export const YEARBOOK_MIN_HELD_MULTIPLIER = 0.5;
export const YEARBOOK_MAX_HELD_MULTIPLIER = 3.0;
export const YEARBOOK_TOP_N = 3;

export type PeriodQuarter = "Q1" | "Q2" | "Q3" | "Q4";

export interface PeriodWindow {
  label: string;         // "2026" or "2026-Q4"
  windowStart: Date;     // inclusive
  windowEnd: Date;       // exclusive (half-open)
}

export interface YearbookInputs {
  period: PeriodWindow;
  holdings: PortfolioHolding[];
  ledger: PortfolioLedgerEntry[];
}

export interface YearbookRankedRow {
  player: string;
  gainPct: number;
  gainUsd: number;
  rowType: "realized" | "unrealized";
}

export interface YearbookWhatIf {
  counterfactualCurrentValue: number;
  opportunityCostUsd: number;
  note: string;
}

export interface YearbookResult {
  period: string;
  generatedAt: string;
  totalRealizedGainUsd: number;
  totalUnrealizedGainUsd: number;
  totalCostBasis: number;
  totalCurrentValue: number;
  cardsBought: number;      // acquisitions in period (purchaseDate ∈ window)
  cardsSold: number;        // realized ledger entries in period
  cardsHeld: number;        // currently held (independent of period)
  topPerformers: YearbookRankedRow[];
  biggestMisses: YearbookRankedRow[];
  whatIfHeldAll: YearbookWhatIf;
}

// ── Period parsing ──────────────────────────────────────────────────────────

/**
 * Build a period window from { year, quarter? } inputs. Quarter is
 * optional; when absent the window covers the full calendar year.
 * Throws on invalid inputs so the route handler can 400 cleanly.
 */
export function parsePeriod(
  year: number,
  quarter?: PeriodQuarter | null,
): PeriodWindow {
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    throw new Error(`invalid year: ${year}`);
  }
  if (!quarter) {
    return {
      label: String(year),
      windowStart: new Date(Date.UTC(year, 0, 1)),
      windowEnd: new Date(Date.UTC(year + 1, 0, 1)),
    };
  }
  const qMap: Record<PeriodQuarter, { startMonth: number; endMonth: number; endYear: number }> = {
    Q1: { startMonth: 0, endMonth: 3, endYear: year },
    Q2: { startMonth: 3, endMonth: 6, endYear: year },
    Q3: { startMonth: 6, endMonth: 9, endYear: year },
    Q4: { startMonth: 9, endMonth: 12, endYear: year },   // Q4 ends 12 → Jan of year+1
  };
  const q = qMap[quarter];
  if (!q) throw new Error(`invalid quarter: ${quarter}`);
  const endMonth = quarter === "Q4" ? 0 : q.endMonth;
  const endYear = quarter === "Q4" ? year + 1 : q.endYear;
  return {
    label: `${year}-${quarter}`,
    windowStart: new Date(Date.UTC(year, q.startMonth, 1)),
    windowEnd: new Date(Date.UTC(endYear, endMonth, 1)),
  };
}

// ── Row extraction ──────────────────────────────────────────────────────────

interface ExtractedRealizedRow {
  entry: PortfolioLedgerEntry;
  gainPct: number;
  gainUsd: number;
  player: string;
}

function extractRealizedRows(
  ledger: PortfolioLedgerEntry[],
  period: PeriodWindow,
): ExtractedRealizedRow[] {
  const rows: ExtractedRealizedRow[] = [];
  const startMs = period.windowStart.getTime();
  const endMs = period.windowEnd.getTime();
  for (const entry of ledger) {
    if (entry.action === "regrade") continue;
    const soldMs = Date.parse(entry.soldAt ?? "");
    if (!Number.isFinite(soldMs)) continue;
    if (soldMs < startMs || soldMs >= endMs) continue;
    const gainUsd = Number(entry.realizedProfitLoss ?? 0);
    const basis = Number(entry.costBasisSold ?? 0);
    // Fallback: recompute gainPct when the stored value is missing.
    let gainPct = Number(entry.realizedProfitLossPct ?? NaN);
    if (!Number.isFinite(gainPct)) {
      gainPct = basis > 0 ? (gainUsd / basis) * 100 : 0;
    }
    rows.push({
      entry,
      gainPct,
      gainUsd,
      player: String(entry.playerName ?? "").trim() || "Unknown Player",
    });
  }
  return rows;
}

interface ExtractedUnrealizedRow {
  holding: PortfolioHolding;
  gainPct: number;
  gainUsd: number;
  player: string;
  costBasis: number;
  currentValue: number;
}

function currentUnitValueOf(h: PortfolioHolding): number | null {
  const fmv = (h as { fairMarketValue?: number | null }).fairMarketValue;
  if (typeof fmv === "number" && Number.isFinite(fmv) && fmv > 0) return fmv;
  const est = (h as { estimatedValue?: number | null }).estimatedValue;
  if (typeof est === "number" && Number.isFinite(est) && est > 0) return est;
  return null;
}

function extractUnrealizedRows(
  holdings: PortfolioHolding[],
  period: PeriodWindow,
): ExtractedUnrealizedRow[] {
  const rows: ExtractedUnrealizedRow[] = [];
  const endMs = period.windowEnd.getTime();
  for (const h of holdings) {
    // Include if the user owned it during any part of the window. Absent
    // purchaseDate → treat as long-held (owned throughout).
    if (h.purchaseDate != null) {
      const buyMs = Date.parse(String(h.purchaseDate));
      if (Number.isFinite(buyMs) && buyMs >= endMs) continue;
    }
    const perUnit = currentUnitValueOf(h);
    if (perUnit == null) continue;
    const qty = Math.max(1, Number(h.quantity ?? 1));
    const currentValue = perUnit * qty;
    const basis = Number(
      h.totalCostBasis ??
        (Number.isFinite(Number(h.purchasePrice)) ? Number(h.purchasePrice) * qty : 0),
    );
    if (basis <= 0) continue;
    const gainUsd = currentValue - basis;
    const gainPct = (gainUsd / basis) * 100;
    rows.push({
      holding: h,
      gainPct,
      gainUsd,
      player: String(h.playerName ?? "").trim() || "Unknown Card",
      costBasis: basis,
      currentValue,
    });
  }
  return rows;
}

// ── Rankings ────────────────────────────────────────────────────────────────

function toRankedRow(
  input:
    | { source: "realized"; row: ExtractedRealizedRow }
    | { source: "unrealized"; row: ExtractedUnrealizedRow },
): YearbookRankedRow {
  const rowType = input.source;
  return {
    player: input.row.player,
    gainPct: r2(input.row.gainPct),
    gainUsd: r2(input.row.gainUsd),
    rowType,
  };
}

function selectTopAndMisses(
  realized: ExtractedRealizedRow[],
  unrealized: ExtractedUnrealizedRow[],
  n: number,
): { top: YearbookRankedRow[]; misses: YearbookRankedRow[] } {
  const pool: Array<
    | { source: "realized"; row: ExtractedRealizedRow }
    | { source: "unrealized"; row: ExtractedUnrealizedRow }
  > = [
    ...realized.map((r) => ({ source: "realized" as const, row: r })),
    ...unrealized.map((r) => ({ source: "unrealized" as const, row: r })),
  ];

  const sortedByGainDesc = [...pool].sort((a, b) => {
    if (b.row.gainPct !== a.row.gainPct) return b.row.gainPct - a.row.gainPct;
    return Math.abs(b.row.gainUsd) - Math.abs(a.row.gainUsd);
  });

  const top = sortedByGainDesc.slice(0, n).map(toRankedRow);

  const losers = pool.filter((p) => p.row.gainPct < 0);
  const sortedLosersAsc = [...losers].sort((a, b) => {
    if (a.row.gainPct !== b.row.gainPct) return a.row.gainPct - b.row.gainPct;
    return Math.abs(b.row.gainUsd) - Math.abs(a.row.gainUsd);
  });
  const misses = sortedLosersAsc.slice(0, n).map(toRankedRow);

  return { top, misses };
}

// ── Counterfactual ──────────────────────────────────────────────────────────

interface CounterfactualBits {
  totalCurrentValue: number;
  totalCostBasis: number;
  grossSalesProceeds: number;
  counterfactualSoldValue: number;
}

function computeCounterfactualBits(
  holdings: PortfolioHolding[],
  realized: ExtractedRealizedRow[],
): CounterfactualBits {
  let totalCurrentValue = 0;
  let totalCostBasis = 0;
  for (const h of holdings) {
    const qty = Math.max(1, Number(h.quantity ?? 1));
    const perUnit = currentUnitValueOf(h);
    if (perUnit != null) totalCurrentValue += perUnit * qty;
    const basis = Number(
      h.totalCostBasis ??
        (Number.isFinite(Number(h.purchasePrice)) ? Number(h.purchasePrice) * qty : 0),
    );
    if (basis > 0) totalCostBasis += basis;
  }

  const grossSalesProceeds = realized.reduce(
    (acc, r) => acc + Number(r.entry.grossProceeds ?? 0),
    0,
  );

  const rawMultiplier =
    totalCostBasis > 0 ? totalCurrentValue / totalCostBasis : 1;
  const clamped = Math.min(
    YEARBOOK_MAX_HELD_MULTIPLIER,
    Math.max(YEARBOOK_MIN_HELD_MULTIPLIER, rawMultiplier),
  );

  const counterfactualSoldValue = grossSalesProceeds * clamped;

  return {
    totalCurrentValue,
    totalCostBasis,
    grossSalesProceeds,
    counterfactualSoldValue,
  };
}

function noteFor(
  counterfactualCurrentValue: number,
  totalCurrentValue: number,
  soldCount: number,
): string {
  if (soldCount === 0) {
    return "No sales in this period — nothing to counterfactual against.";
  }
  const cf = Math.round(counterfactualCurrentValue);
  const cur = Math.round(totalCurrentValue);
  if (cf === cur) {
    return "Held vs sold nets out — you priced your exits right.";
  }
  const dir = cf > cur ? "worth" : "smaller at";
  return `If you had held every card you sold, portfolio would be ${dir} ~$${cf.toLocaleString("en-US")} instead of $${cur.toLocaleString("en-US")}`;
}

// ── Main compute ────────────────────────────────────────────────────────────

/**
 * Pure yearbook computation. All I/O happens in generateUserYearbook
 * above this — this function is fully deterministic given its inputs.
 */
export function computeYearbook(inputs: YearbookInputs): YearbookResult {
  const { period, holdings, ledger } = inputs;

  const realized = extractRealizedRows(ledger, period);
  const unrealized = extractUnrealizedRows(holdings, period);

  const totalRealizedGainUsd = realized.reduce((a, r) => a + r.gainUsd, 0);
  const totalUnrealizedGainUsd = unrealized.reduce((a, r) => a + r.gainUsd, 0);

  const { top, misses } = selectTopAndMisses(realized, unrealized, YEARBOOK_TOP_N);

  const cf = computeCounterfactualBits(holdings, realized);

  const counterfactualCurrentValue = cf.totalCurrentValue + cf.counterfactualSoldValue;
  const opportunityCostUsd = cf.counterfactualSoldValue - cf.grossSalesProceeds;

  const cardsBought = countCardsBought(holdings, period);
  const cardsSold = realized.length;
  const cardsHeld = holdings.filter((h) => currentUnitValueOf(h) != null || Number(h.purchasePrice) > 0).length;

  return {
    period: period.label,
    generatedAt: new Date().toISOString(),
    totalRealizedGainUsd: r2(totalRealizedGainUsd),
    totalUnrealizedGainUsd: r2(totalUnrealizedGainUsd),
    totalCostBasis: r2(cf.totalCostBasis),
    totalCurrentValue: r2(cf.totalCurrentValue),
    cardsBought,
    cardsSold,
    cardsHeld,
    topPerformers: top,
    biggestMisses: misses,
    whatIfHeldAll: {
      counterfactualCurrentValue: r2(counterfactualCurrentValue),
      opportunityCostUsd: r2(opportunityCostUsd),
      note: noteFor(counterfactualCurrentValue, cf.totalCurrentValue, cardsSold),
    },
  };
}

function countCardsBought(holdings: PortfolioHolding[], period: PeriodWindow): number {
  const startMs = period.windowStart.getTime();
  const endMs = period.windowEnd.getTime();
  let n = 0;
  for (const h of holdings) {
    if (h.purchaseDate == null) continue;
    const ms = Date.parse(String(h.purchaseDate));
    if (!Number.isFinite(ms)) continue;
    if (ms >= startMs && ms < endMs) n += 1;
  }
  return n;
}

// ── I/O wrapper ─────────────────────────────────────────────────────────────

/**
 * Read the user's Cosmos doc + compute the yearbook. Route-facing entry.
 */
export async function generateUserYearbook(
  userId: string,
  opts: { year: number; quarter?: PeriodQuarter | null } = { year: new Date().getUTCFullYear() },
): Promise<YearbookResult> {
  const period = parsePeriod(opts.year, opts.quarter ?? undefined);
  const doc = await readUserDoc(userId);
  const holdings = Object.values(doc.holdings ?? {}) as PortfolioHolding[];
  const ledger = (doc.ledger ?? []) as PortfolioLedgerEntry[];
  return computeYearbook({ period, holdings, ledger });
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
