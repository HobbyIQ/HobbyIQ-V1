// CF-PORTFOLIO-SUPPLY-DEMAND-SUMMARY (Drew, 2026-07-13, PR #426) — verifies
// the portfolio dashboard aggregation math + verdict fold across holdings.

import { describe, expect, it, vi, afterEach } from "vitest";
import { buildPortfolioSupplyDemandSummary } from "../src/services/portfolioiq/supplyDemandSummary.service.js";
import * as store from "../src/services/portfolioiq/portfolioStore.service.js";
import * as signal from "../src/services/compiq/supplyDemandSignal.service.js";

afterEach(() => vi.restoreAllMocks());

const trendUp = { direction: "up" as const, slopePerMonthPct: 15,
  marketValue: 100, predictedPrice: 115,
  predictedPriceRange: { low: 90, high: 140 }, n: 5, regressionSlope: 0 };
const trendDown = { direction: "down" as const, slopePerMonthPct: -12,
  marketValue: 100, predictedPrice: 88,
  predictedPriceRange: { low: 70, high: 110 }, n: 5, regressionSlope: 0 };
const trendStatic = { direction: "static" as const, slopePerMonthPct: 0.5,
  marketValue: 100, predictedPrice: 100,
  predictedPriceRange: { low: 90, high: 110 }, n: 5, regressionSlope: 0 };

describe("buildPortfolioSupplyDemandSummary", () => {
  it("returns empty state for a user with no holdings", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({ holdings: {} } as any);
    const r = await buildPortfolioSupplyDemandSummary("user-empty");
    expect(r.totalHoldings).toBe(0);
    expect(r.portfolioBias).toBe("unavailable");
    expect(r.fullList).toEqual([]);
  });

  it("fold: sales UP + listings DOWN → strong_bull", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({
      holdings: {
        h1: { id: "h1", playerName: "Hartman", movementDirection: "up" },
      },
    } as any);
    vi.spyOn(signal, "computeListingsTrend").mockResolvedValue(trendDown);
    const r = await buildPortfolioSupplyDemandSummary("u");
    expect(r.fullList[0].verdict).toBe("strong_bull");
    expect(r.portfolioBias).toBe("strong_bull");
    expect(r.breakdown.strong_bull).toBe(1);
  });

  it("fold: sales DOWN + listings UP → bear", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({
      holdings: {
        h1: { id: "h1", playerName: "Trout", movementDirection: "down" },
      },
    } as any);
    vi.spyOn(signal, "computeListingsTrend").mockResolvedValue(trendUp);
    const r = await buildPortfolioSupplyDemandSummary("u");
    expect(r.fullList[0].verdict).toBe("bear");
    expect(r.portfolioBias).toBe("bear");
  });

  it("holdings missing movementDirection or player name → unavailable", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({
      holdings: {
        h1: { id: "h1", playerName: null, movementDirection: "up" },
        h2: { id: "h2", playerName: "Betts" },   // no direction
      },
    } as any);
    vi.spyOn(signal, "computeListingsTrend").mockResolvedValue(trendUp);
    const r = await buildPortfolioSupplyDemandSummary("u");
    expect(r.fullList.every((row) => row.verdict === "unavailable")).toBe(true);
    expect(r.breakdown.unavailable).toBe(2);
  });

  it("portfolio bias excludes 'unavailable' rows when picking majority", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({
      holdings: {
        h1: { id: "h1", playerName: "A", movementDirection: "up" },
        h2: { id: "h2", playerName: null },   // unavailable
        h3: { id: "h3", playerName: null },   // unavailable
        h4: { id: "h4", playerName: null },   // unavailable
      },
    } as any);
    vi.spyOn(signal, "computeListingsTrend").mockResolvedValue(trendDown);
    const r = await buildPortfolioSupplyDemandSummary("u");
    expect(r.portfolioBias).toBe("strong_bull");
  });

  it("mixed portfolio: strong_bull + bear + static folds to correct majority", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({
      holdings: {
        h1: { id: "h1", playerName: "A", movementDirection: "up" },
        h2: { id: "h2", playerName: "A", movementDirection: "up" },
        h3: { id: "h3", playerName: "B", movementDirection: "up" },
        h4: { id: "h4", playerName: "C", movementDirection: "down" },
      },
    } as any);
    vi.spyOn(signal, "computeListingsTrend").mockImplementation(async (player) => {
      if (player === "A") return trendDown;   // A: up + down = strong_bull
      if (player === "B") return trendUp;     // B: up + up = mixed
      if (player === "C") return trendUp;     // C: down + up = bear
      return null;
    });
    const r = await buildPortfolioSupplyDemandSummary("u");
    expect(r.breakdown.strong_bull).toBe(2);   // 2 A holdings
    expect(r.breakdown.mixed).toBe(1);
    expect(r.breakdown.bear).toBe(1);
    expect(r.portfolioBias).toBe("strong_bull");
  });

  it("caches listings trend per player (no double fetch for multi-Hartman)", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({
      holdings: {
        h1: { id: "h1", playerName: "Hartman", movementDirection: "up" },
        h2: { id: "h2", playerName: "Hartman", movementDirection: "up" },
        h3: { id: "h3", playerName: "Hartman", movementDirection: "up" },
      },
    } as any);
    const trendSpy = vi.spyOn(signal, "computeListingsTrend").mockResolvedValue(trendDown);
    await buildPortfolioSupplyDemandSummary("u");
    expect(trendSpy).toHaveBeenCalledTimes(1);   // cache hit for h2, h3
  });

  it("top movers ordered by absolute listings slope magnitude", async () => {
    vi.spyOn(store, "readUserDoc").mockResolvedValue({
      holdings: {
        h1: { id: "h1", playerName: "Big Mover", movementDirection: "up" },
        h2: { id: "h2", playerName: "Small Mover", movementDirection: "up" },
        h3: { id: "h3", playerName: "Flat", movementDirection: "up" },
      },
    } as any);
    vi.spyOn(signal, "computeListingsTrend").mockImplementation(async (p) => {
      if (p === "Big Mover")   return { ...trendDown, slopePerMonthPct: -40 };
      if (p === "Small Mover") return { ...trendUp,   slopePerMonthPct: +5 };
      if (p === "Flat")        return trendStatic;
      return null;
    });
    const r = await buildPortfolioSupplyDemandSummary("u");
    expect(r.topMovers[0].playerName).toBe("Big Mover");
    expect(r.topMovers[1].playerName).toBe("Small Mover");
  });
});
