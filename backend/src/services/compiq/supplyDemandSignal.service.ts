// CF-SUPPLY-DEMAND-SIGNAL (Drew, 2026-07-13, PR #420): combine the sales
// slope (demand-side, from priced sales pool) with the listings slope
// (supply-side, from daily eBay Browse snapshots) into a single supply-
// demand verdict.
//
// Verdict matrix (both dimensions have static / up / down):
//   Sales up   + Listings down = STRONG_BULL   (rare + wanted)
//   Sales up   + Listings up   = MIXED         (demand + supply both rising)
//   Sales up   + Listings flat = BULL          (demand exceeds supply growth)
//   Sales flat + Listings down = SUPPLY_TIGHT  (nothing available)
//   Sales flat + Listings up   = OVERSUPPLY    (glut, no demand)
//   Sales flat + Listings flat = STATIC        (market at equilibrium)
//   Sales down + Listings up   = BEAR          (glut + weak demand)
//   Sales down + Listings flat = SOFT          (demand fading)
//   Sales down + Listings down = WEAK          (both sides waning)
//   (any + insufficient listings data) → verdict is null (unavailable)

import { computeSlopeValuation, type SlopeValuation } from "./slopeValuation.js";
import { readSnapshots } from "../portfolioiq/listingsSnapshotStore.service.js";

export type MarketDirection = "up" | "down" | "static";
export type SupplyDemandVerdict =
  | "strong_bull"
  | "bull"
  | "mixed"
  | "supply_tight"
  | "static"
  | "oversupply"
  | "bear"
  | "soft"
  | "weak"
  | "unavailable";

export interface SupplyDemandSignal {
  verdict: SupplyDemandVerdict;
  salesDirection: MarketDirection;
  listingsDirection: MarketDirection | null;
  salesSlopePerMonthPct: number;
  listingsSlopePerMonthPct: number | null;
  salesRecordCount: number;
  listingsSnapshotCount: number;
  windowDays: number;
}

/**
 * Daily listings point for the wire — enables iOS' supply-side chart to
 * plot the actual counts alongside the regression line. Same shape iOS
 * already uses for the sales side, just swapping "price" semantics
 * for "count."
 */
export interface ListingsHistoryPoint {
  date: string;              // YYYY-MM-DD
  totalListings: number;
  medianAsk: number | null;  // median asking price that day (for future overlay)
}

/**
 * Fetch listings snapshots for a player and fit a regression on
 * (date, totalListings). Returns the slope valuation shape (same as
 * sales slope) or null when there aren't enough snapshots (need ≥ 2
 * distinct-date snapshots).
 */
export async function computeListingsTrend(
  playerName: string,
  days: number = 30,
): Promise<SlopeValuation | null> {
  const snaps = await readSnapshots(playerName, days);
  if (snaps.length < 2) return null;
  // Feed (date, count) into the SAME regression helper the sales side
  // uses. The math is unit-agnostic; the slope's "$/day" label becomes
  // "listings/day" for this call but that's just a naming convention.
  return computeSlopeValuation(
    snaps.map((s) => ({
      date: `${s.date}T12:00:00Z`,   // anchor at noon UTC so day-boundaries don't collide
      price: s.totalListings,
    })),
  );
}

/**
 * Return the raw daily listings history for iOS' supply-side chart.
 * Oldest → newest, so the caller can render a time series without
 * re-sorting. Empty array when the container is unavailable or the
 * player has no snapshots — same graceful-degrade contract as
 * computeListingsTrend.
 */
export async function fetchListingsHistoryForWire(
  playerName: string | null,
  days: number = 30,
): Promise<ListingsHistoryPoint[]> {
  if (!playerName) return [];
  const snaps = await readSnapshots(playerName, days);
  return snaps
    .map((s) => ({
      date: s.date,
      totalListings: s.totalListings,
      medianAsk: s.medianAsk,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Combined signal — given a computed sales slope and player name, load
 * the listings trend and fold both into a single verdict.
 *
 * Sales slope comes from the caller (already computed by compiqEstimate
 * or cardsightUuidPriceRouter); listings trend is loaded here.
 */
export async function buildSupplyDemandSignal(
  playerName: string | null,
  salesSlope: SlopeValuation | null,
  windowDays: number = 30,
): Promise<SupplyDemandSignal | null> {
  if (!playerName || !salesSlope) return null;
  const listingsSlope = await computeListingsTrend(playerName, windowDays);
  const salesDirection = salesSlope.direction;
  const listingsDirection = listingsSlope?.direction ?? null;
  const verdict = deriveVerdict(salesDirection, listingsDirection);
  return {
    verdict,
    salesDirection,
    listingsDirection,
    salesSlopePerMonthPct: salesSlope.slopePerMonthPct,
    listingsSlopePerMonthPct: listingsSlope?.slopePerMonthPct ?? null,
    salesRecordCount: salesSlope.n,
    listingsSnapshotCount: listingsSlope?.n ?? 0,
    windowDays,
  };
}

export function deriveVerdict(
  sales: MarketDirection,
  listings: MarketDirection | null,
): SupplyDemandVerdict {
  if (listings === null) return "unavailable";
  if (sales === "up" && listings === "down") return "strong_bull";
  if (sales === "up" && listings === "up") return "mixed";
  if (sales === "up" && listings === "static") return "bull";
  if (sales === "static" && listings === "down") return "supply_tight";
  if (sales === "static" && listings === "up") return "oversupply";
  if (sales === "static" && listings === "static") return "static";
  if (sales === "down" && listings === "up") return "bear";
  if (sales === "down" && listings === "static") return "soft";
  if (sales === "down" && listings === "down") return "weak";
  return "static";
}
