// CF-SIGNAL-WEIGHTED-TOTALS (Drew, 2026-07-13, PR #430): three portfolio
// valuations side-by-side instead of just one FMV total.
//
//   gross           = sum of Market Values across all holdings (current)
//   trendAdjusted   = sum of Predicted Prices (where the market's heading)
//   feesAdjusted    = trendAdjusted minus expected eBay fees minus total
//                     cost basis (true gain if sold at predicted price)
//
// Also splits by verdict class so users see the BULL slice of the
// portfolio separately from the BEAR slice — "$4,200 of your holdings
// are trending up; $850 are trending down."

import { readUserDoc } from "./portfolioStore.service.js";
import { computeListingsTrend } from "../compiq/supplyDemandSignal.service.js";

// eBay's fee schedule for Sports Trading Cards (as of 2026-07): ~13.25%
// on the sale price + $0.30 fixed. This is a coarse estimate — actual
// varies by seller tier + payment method. Good enough for a portfolio-
// level valuation heuristic.
const EBAY_FEE_RATE = 0.1325;
const EBAY_FEE_FIXED = 0.30;

type Verdict =
  | "strong_bull" | "bull" | "mixed" | "supply_tight" | "static"
  | "oversupply" | "bear" | "soft" | "weak" | "unavailable";

interface HoldingRow {
  holdingId: string;
  playerName: string | null;
  marketValue: number;
  predictedPrice: number;
  totalCostBasis: number;
  quantity: number;
  verdict: Verdict;
}

interface TotalsBlock {
  gross: number;               // sum of marketValue × quantity
  trendAdjusted: number;       // sum of predictedPrice × quantity
  feesAdjusted: number;        // trendAdjusted − fees − totalCostBasis
  totalCostBasis: number;
  holdingCount: number;
}

export interface SignalWeightedTotals {
  userId: string;
  totals: TotalsBlock;
  byVerdictClass: {
    bull: TotalsBlock;     // strong_bull, bull, supply_tight
    static: TotalsBlock;   // mixed, static
    bear: TotalsBlock;     // oversupply, bear, soft, weak
    unavailable: TotalsBlock;
  };
  computedAt: string;
}

function ebayFeesOn(salePrice: number): number {
  if (!Number.isFinite(salePrice) || salePrice <= 0) return 0;
  return salePrice * EBAY_FEE_RATE + EBAY_FEE_FIXED;
}

function verdictClass(v: Verdict): keyof SignalWeightedTotals["byVerdictClass"] {
  if (v === "strong_bull" || v === "bull" || v === "supply_tight") return "bull";
  if (v === "mixed" || v === "static") return "static";
  if (v === "oversupply" || v === "bear" || v === "soft" || v === "weak") return "bear";
  return "unavailable";
}

function foldVerdict(
  sales: "up" | "down" | "static" | null,
  listings: "up" | "down" | "static" | null,
): Verdict {
  if (sales === null || listings === null) return "unavailable";
  if (sales === "up" && listings === "down") return "strong_bull";
  if (sales === "up" && listings === "up") return "mixed";
  if (sales === "up" && listings === "static") return "bull";
  if (sales === "static" && listings === "down") return "supply_tight";
  if (sales === "static" && listings === "up") return "oversupply";
  if (sales === "static" && listings === "static") return "static";
  if (sales === "down" && listings === "up") return "bear";
  if (sales === "down" && listings === "static") return "soft";
  if (sales === "down" && listings === "down") return "weak";
  return "unavailable";
}

function emptyBlock(): TotalsBlock {
  return { gross: 0, trendAdjusted: 0, feesAdjusted: 0, totalCostBasis: 0, holdingCount: 0 };
}

function addToBlock(block: TotalsBlock, row: HoldingRow): void {
  const gross = row.marketValue * row.quantity;
  const trendAdjusted = row.predictedPrice * row.quantity;
  const fees = ebayFeesOn(row.predictedPrice) * row.quantity;
  const feesAdjusted = trendAdjusted - fees - row.totalCostBasis;
  block.gross += gross;
  block.trendAdjusted += trendAdjusted;
  block.feesAdjusted += feesAdjusted;
  block.totalCostBasis += row.totalCostBasis;
  block.holdingCount += 1;
}

function roundBlock(b: TotalsBlock): TotalsBlock {
  return {
    gross: Math.round(b.gross * 100) / 100,
    trendAdjusted: Math.round(b.trendAdjusted * 100) / 100,
    feesAdjusted: Math.round(b.feesAdjusted * 100) / 100,
    totalCostBasis: Math.round(b.totalCostBasis * 100) / 100,
    holdingCount: b.holdingCount,
  };
}

export async function buildSignalWeightedTotals(
  userId: string,
): Promise<SignalWeightedTotals> {
  const doc = await readUserDoc(userId);
  const holdings = Object.values(doc?.holdings ?? {}) as any[];
  const computedAt = new Date().toISOString();

  // Cache listings direction per player (12 Hartmans = 1 read).
  const listingsCache = new Map<string, "up" | "down" | "static" | null>();
  async function listingsFor(player: string | null): Promise<"up" | "down" | "static" | null> {
    if (!player) return null;
    if (listingsCache.has(player)) return listingsCache.get(player)!;
    const trend = await computeListingsTrend(player, 30).catch(() => null);
    const dir = trend?.direction ?? null;
    listingsCache.set(player, dir);
    return dir;
  }

  const totals = emptyBlock();
  const byVerdictClass: SignalWeightedTotals["byVerdictClass"] = {
    bull: emptyBlock(),
    static: emptyBlock(),
    bear: emptyBlock(),
    unavailable: emptyBlock(),
  };

  for (const h of holdings) {
    const mv = typeof h.fairMarketValue === "number" && h.fairMarketValue > 0
      ? h.fairMarketValue
      : 0;
    const pp = typeof h.predictedPrice === "number" && h.predictedPrice > 0
      ? h.predictedPrice
      : mv;   // fall back so trend-adjusted total stays coherent
    const cost = typeof h.totalCostBasis === "number" ? h.totalCostBasis :
      typeof h.purchasePrice === "number" ? h.purchasePrice : 0;
    const qty = typeof h.quantity === "number" && h.quantity > 0 ? h.quantity : 1;
    const player = typeof h.playerName === "string" ? h.playerName : null;
    const sales = (() => {
      const raw = String(h.movementDirection ?? "").toLowerCase();
      return raw === "up" || raw === "down" || raw === "static" ? raw : null;
    })();
    const listings = await listingsFor(player);
    const verdict = foldVerdict(sales as any, listings);

    const row: HoldingRow = {
      holdingId: String(h.id ?? ""),
      playerName: player,
      marketValue: mv,
      predictedPrice: pp,
      totalCostBasis: cost,
      quantity: qty,
      verdict,
    };
    addToBlock(totals, row);
    addToBlock(byVerdictClass[verdictClass(verdict)], row);
  }

  return {
    userId,
    totals: roundBlock(totals),
    byVerdictClass: {
      bull: roundBlock(byVerdictClass.bull),
      static: roundBlock(byVerdictClass.static),
      bear: roundBlock(byVerdictClass.bear),
      unavailable: roundBlock(byVerdictClass.unavailable),
    },
    computedAt,
  };
}
