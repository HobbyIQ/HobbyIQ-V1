import type { EbaySupplySnapshot, EbaySupplyTrend, EbaySupplySignal } from "./types";

// Simulated eBay supply data service
// In production, replace with real eBay API or inventory DB
export async function getEbaySupplySnapshot(
  player: string,
  cardName?: string,
  parallel?: string
): Promise<EbaySupplySnapshot> {
  // Simulate fallback if no data
  if (!player) {
    return {
      currentActiveListings: null,
      twoWeekSupplyChangePercent: null,
      twoWeekSupplyTrend: "Unavailable",
      supplySignal: "Unavailable",
      supplyNote: "No supply data available.",
      fallback: true
    };
  }
  // Simulate supply data
  const baseListings = Math.floor(Math.random() * 30 + 5);
  const change = Math.round((Math.random() * 40 - 20) * 10) / 10; // -20% to +20%
  let trend: EbaySupplyTrend = "Flat";
  if (change > 5) trend = "Rising";
  else if (change < -5) trend = "Falling";
  let signal: EbaySupplySignal = "Stable";
  if (trend === "Falling") signal = "Tightening";
  else if (trend === "Rising" && baseListings > 25) signal = "Flooded";
  else if (trend === "Rising") signal = "Expanding";
  else if (trend === "Flat" && baseListings < 10) signal = "Tightening";
  return {
    currentActiveListings: baseListings,
    twoWeekSupplyChangePercent: change,
    twoWeekSupplyTrend: trend,
    supplySignal: signal,
    supplyNote: `Supply is ${trend.toLowerCase()} (${signal}).`,
  };
}
