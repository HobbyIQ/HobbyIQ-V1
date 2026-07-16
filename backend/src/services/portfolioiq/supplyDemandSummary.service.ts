// CF-PORTFOLIO-SUPPLY-DEMAND-SUMMARY (Drew, 2026-07-13, PR #426):
// aggregate the supply/demand signal across every holding in a user's
// portfolio into a single dashboard payload. Powers "your portfolio is
// STRONG BULL — 12 up, 3 mixed, 1 bear" + a sortable per-holding list
// on iOS Portfolio Home.
//
// Data source: for each holding, we compute the sales slope from stored
// pricing signals + fold in the listings trend for that player. Uses
// the shared computeListingsTrend + buildSupplyDemandSignal helpers so
// this endpoint stays in-sync with what /price-by-id emits per card.

import { readUserDoc } from "./portfolioStore.service.js";
import { computeListingsTrend } from "../compiq/supplyDemandSignal.service.js";

// Same verdict labels as SupplyDemandVerdict — kept local to avoid a
// circular import through supplyDemandSignal.service.
type Verdict =
  | "strong_bull" | "bull" | "mixed" | "supply_tight" | "static"
  | "oversupply" | "bear" | "soft" | "weak" | "unavailable";

interface HoldingRow {
  holdingId: string;
  cardId: string | null;
  playerName: string | null;
  cardName: string | null;
  parallel: string | null;
  fairMarketValue: number | null;
  predictedPrice: number | null;
  verdict: Verdict;
  salesDirection: "up" | "down" | "static" | null;
  listingsDirection: "up" | "down" | "static" | null;
  listingsSlopePerMonthPct: number | null;
}

interface VerdictBreakdown {
  strong_bull: number;
  bull: number;
  mixed: number;
  supply_tight: number;
  static: number;
  oversupply: number;
  bear: number;
  soft: number;
  weak: number;
  unavailable: number;
}

export interface PortfolioSupplyDemandSummary {
  userId: string;
  totalHoldings: number;
  portfolioBias: Verdict;   // dominant verdict across the portfolio
  breakdown: VerdictBreakdown;
  topMovers: HoldingRow[];  // sorted by |salesSlope| descending
  fullList: HoldingRow[];
  computedAt: string;
}

const EMPTY_BREAKDOWN: VerdictBreakdown = {
  strong_bull: 0, bull: 0, mixed: 0, supply_tight: 0, static: 0,
  oversupply: 0, bear: 0, soft: 0, weak: 0, unavailable: 0,
};

/**
 * Fold a holding's stored trend markers (from previous /price-by-id
 * hits — persisted on the holding as `movementDirection` +
 * `predictedPriceMechanism`) into a canonical supply/demand verdict.
 *
 * Sales direction is derived from the persisted `movementDirection`
 * ("up"/"down"/null → static). Listings direction comes from a fresh
 * computeListingsTrend read of the player's snapshot store.
 */
function verdictFromDirections(
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

/**
 * Pull the last known sales direction off a persisted holding.
 * Uses `movementDirection` as the primary source (populated by the
 * pricing engine on every reprice); falls through to null when the
 * holding was never priced through the trend-aware path.
 */
function salesDirectionFromHolding(h: any): "up" | "down" | "static" | null {
  const raw = String(h?.movementDirection ?? "").toLowerCase();
  if (raw === "up" || raw === "down" || raw === "static") return raw;
  return null;
}

export async function buildPortfolioSupplyDemandSummary(
  userId: string,
): Promise<PortfolioSupplyDemandSummary> {
  const doc = await readUserDoc(userId);
  const holdings = Object.values(doc?.holdings ?? {}) as any[];
  const computedAt = new Date().toISOString();

  if (holdings.length === 0) {
    return {
      userId,
      totalHoldings: 0,
      portfolioBias: "unavailable",
      breakdown: { ...EMPTY_BREAKDOWN },
      topMovers: [],
      fullList: [],
      computedAt,
    };
  }

  // Cache listings trends per player so we don't refetch snapshots for
  // multi-holding-per-player cases (Drew has 12 Hartmans).
  const playerListingsCache = new Map<string, "up" | "down" | "static" | null>();
  const listingsSlopePctCache = new Map<string, number | null>();
  async function listingsDirectionFor(
    player: string | null,
  ): Promise<{ dir: "up" | "down" | "static" | null; slope: number | null }> {
    if (!player) return { dir: null, slope: null };
    if (playerListingsCache.has(player)) {
      return {
        dir: playerListingsCache.get(player)!,
        slope: listingsSlopePctCache.get(player) ?? null,
      };
    }
    const trend = await computeListingsTrend(player, 30).catch(() => null);
    const dir = trend?.direction ?? null;
    const slope = trend?.slopePerMonthPct ?? null;
    playerListingsCache.set(player, dir);
    listingsSlopePctCache.set(player, slope);
    return { dir, slope };
  }

  const rows: HoldingRow[] = [];
  for (const h of holdings) {
    const player = typeof h.playerName === "string" ? h.playerName : null;
    const sales = salesDirectionFromHolding(h);
    const { dir: listings, slope: listingsSlope } = await listingsDirectionFor(player);
    const verdict = verdictFromDirections(sales, listings);
    rows.push({
      holdingId: String(h.id ?? ""),
      cardId: h.cardId ?? null,
      playerName: player,
      cardName: typeof h.cardName === "string" ? h.cardName : null,
      parallel: typeof h.parallel === "string" ? h.parallel : null,
      fairMarketValue:
        typeof h.fairMarketValue === "number" ? h.fairMarketValue : null,
      predictedPrice:
        typeof h.predictedPrice === "number" ? h.predictedPrice : null,
      verdict,
      salesDirection: sales,
      listingsDirection: listings,
      listingsSlopePerMonthPct: listingsSlope,
    });
  }

  const breakdown: VerdictBreakdown = { ...EMPTY_BREAKDOWN };
  for (const r of rows) breakdown[r.verdict]++;

  // Portfolio bias = the majority verdict (excluding "unavailable" so
  // one active bull doesn't get drowned out by 12 unavailables).
  const votingRows = rows.filter((r) => r.verdict !== "unavailable");
  const votingBreakdown: Partial<VerdictBreakdown> = {};
  for (const r of votingRows) {
    votingBreakdown[r.verdict] = (votingBreakdown[r.verdict] ?? 0) + 1;
  }
  let portfolioBias: Verdict = "unavailable";
  let maxCount = 0;
  for (const [v, c] of Object.entries(votingBreakdown)) {
    if (c! > maxCount) {
      maxCount = c!;
      portfolioBias = v as Verdict;
    }
  }

  // Top movers: absolute-value listings slope (proxy for how much the
  // supply side has moved). Sales slope isn't persisted per holding
  // yet, so listings-magnitude is the best available signal.
  const topMovers = [...rows]
    .filter((r) => r.listingsSlopePerMonthPct !== null)
    .sort((a, b) =>
      Math.abs(b.listingsSlopePerMonthPct!) -
      Math.abs(a.listingsSlopePerMonthPct!),
    )
    .slice(0, 10);

  return {
    userId,
    totalHoldings: holdings.length,
    portfolioBias,
    breakdown,
    topMovers,
    fullList: rows,
    computedAt,
  };
}
