import { describe, it, expect } from "vitest";
import { computePortfolioMomentum, _DEFAULTS } from "../src/services/portfolioiq/portfolioMomentumCompute.service.js";
import type { PortfolioMomentumHoldingInput, PortfolioMomentumPlayerTrend } from "../src/types/portfolioMomentum.types.js";

const NOW = new Date("2026-07-17T12:00:00Z");

function mkHolding(id: string, player: string | null, value: number | null, qty = 1): PortfolioMomentumHoldingInput {
  return { holdingId: id, playerName: player, currentValue: value, quantity: qty };
}
function mkTrend(player: string, momentum: number, dir: "up" | "flat" | "down" = "flat", vel = 10): PortfolioMomentumPlayerTrend {
  return { playerName: player, momentum, direction: dir, velocityPerWeek: vel };
}

describe("computePortfolioMomentum — empty & untracked paths", () => {
  it("empty holdings → momentum 1, all counts 0", () => {
    const r = computePortfolioMomentum([], new Map(), {}, NOW);
    expect(r.portfolioMomentum).toBe(1);
    expect(r.direction).toBe("flat");
    expect(r.scannedHoldings).toBe(0);
    expect(r.holdingsWithTrend).toBe(0);
    expect(r.cardsUp + r.cardsFlat + r.cardsDown + r.cardsUntracked).toBe(0);
    expect(r.impliedPortfolioDelta).toBeNull();
  });

  it("holding without a matching trend counts as untracked, not down", () => {
    const holdings = [mkHolding("h1", "Nobody Special", 100)];
    const trends = new Map<string, PortfolioMomentumPlayerTrend>();
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    expect(r.cardsUntracked).toBe(1);
    expect(r.cardsDown).toBe(0);
    expect(r.portfolioMomentum).toBe(1);
    expect(r.direction).toBe("flat");
  });
});

describe("computePortfolioMomentum — aggregation math", () => {
  it("value-weighted mean prefers high-value holdings", () => {
    const holdings = [
      mkHolding("h1", "Hartman", 1000),      // $1000 × +50% = $500 delta
      mkHolding("h2", "Kurtz", 100),         // $100  ×  -30% = -$30 delta
    ];
    const trends = new Map([
      ["Hartman", mkTrend("Hartman", 1.50, "up")],
      ["Kurtz", mkTrend("Kurtz", 0.70, "down")],
    ]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    // Weighted: (1000*1.5 + 100*0.7) / 1100 = (1500+70)/1100 = 1.4272...
    expect(r.portfolioMomentum).toBeCloseTo(1.4273, 3);
    expect(r.direction).toBe("up");
    expect(r.impliedPortfolioDelta).toBeCloseTo(470, 0);  // 500 - 30
  });

  it("falls back to unweighted mean when no holdings have currentValue", () => {
    const holdings = [
      mkHolding("h1", "Hartman", null),
      mkHolding("h2", "Kurtz", null),
    ];
    const trends = new Map([
      ["Hartman", mkTrend("Hartman", 1.50, "up")],
      ["Kurtz", mkTrend("Kurtz", 0.70, "down")],
    ]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    // Unweighted: (1.5 + 0.7) / 2 = 1.1
    expect(r.portfolioMomentum).toBeCloseTo(1.1, 3);
    expect(r.impliedPortfolioDelta).toBeNull();
  });

  it("bucket counts respect up/down thresholds", () => {
    const holdings = [
      mkHolding("h1", "Up1", 100),
      mkHolding("h2", "Up2", 100),
      mkHolding("h3", "Flat", 100),
      mkHolding("h4", "Down", 100),
    ];
    const trends = new Map([
      ["Up1", mkTrend("Up1", 1.10, "up")],
      ["Up2", mkTrend("Up2", 1.06, "up")],
      ["Flat", mkTrend("Flat", 1.02, "flat")],
      ["Down", mkTrend("Down", 0.90, "down")],
    ]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    expect(r.cardsUp).toBe(2);
    expect(r.cardsFlat).toBe(1);
    expect(r.cardsDown).toBe(1);
    expect(r.cardsUntracked).toBe(0);
  });

  it("quantity multiplies weight", () => {
    const holdings = [
      mkHolding("h1", "Hartman", 100, 5),   // effective weight 500
      mkHolding("h2", "Kurtz", 500, 1),     // effective weight 500
    ];
    const trends = new Map([
      ["Hartman", mkTrend("Hartman", 1.50, "up")],
      ["Kurtz", mkTrend("Kurtz", 0.70, "down")],
    ]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    // Weights equal → simple mean: (1.5 + 0.7) / 2 = 1.1
    expect(r.portfolioMomentum).toBeCloseTo(1.1, 3);
  });
});

describe("computePortfolioMomentum — movers", () => {
  it("topMovers sorted by momentum DESC, worstMovers by momentum ASC", () => {
    const holdings = [
      mkHolding("h1", "A", 100),
      mkHolding("h2", "B", 100),
      mkHolding("h3", "C", 100),
      mkHolding("h4", "D", 100),
      mkHolding("h5", "E", 100),
    ];
    const trends = new Map([
      ["A", mkTrend("A", 1.60, "up")],
      ["B", mkTrend("B", 1.10, "up")],
      ["C", mkTrend("C", 1.30, "up")],
      ["D", mkTrend("D", 0.80, "down")],
      ["E", mkTrend("E", 0.65, "down")],
    ]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    expect(r.topMovers.map((m) => m.playerName)).toEqual(["A", "C", "B"]);
    expect(r.worstMovers.map((m) => m.playerName)).toEqual(["E", "D"]);
  });

  it("topMovers capped by topMoversCount", () => {
    const holdings: PortfolioMomentumHoldingInput[] = [];
    const trends = new Map<string, PortfolioMomentumPlayerTrend>();
    for (let i = 0; i < 10; i++) {
      holdings.push(mkHolding(`h${i}`, `P${i}`, 100));
      trends.set(`P${i}`, mkTrend(`P${i}`, 1.10 + i * 0.02, "up"));
    }
    const r = computePortfolioMomentum(holdings, trends, { topMoversCount: 2 }, NOW);
    expect(r.topMovers).toHaveLength(2);
  });

  it("contributionUsd = weight × (momentum - 1)", () => {
    const holdings = [mkHolding("h1", "Hartman", 200)];
    const trends = new Map([["Hartman", mkTrend("Hartman", 1.30, "up")]]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    expect(r.topMovers[0].contributionUsd).toBeCloseTo(60, 1);   // 200 × 0.3
  });

  it("contributionUsd is null when currentValue is null", () => {
    const holdings = [mkHolding("h1", "Hartman", null)];
    const trends = new Map([["Hartman", mkTrend("Hartman", 1.30, "up")]]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    expect(r.topMovers[0].contributionUsd).toBeNull();
  });
});

describe("computePortfolioMomentum — realistic pin", () => {
  it("Drew-like 4-holding case", () => {
    const holdings = [
      mkHolding("d1", "Eric Hartman", 155),
      mkHolding("d2", "Shohei Ohtani", 8000),
      mkHolding("d3", "Aaron Judge", 340),
      mkHolding("d4", "Ken Griffey Jr.", 1200),
    ];
    const trends = new Map([
      ["Eric Hartman",    mkTrend("Eric Hartman", 1.48, "up")],
      ["Shohei Ohtani",   mkTrend("Shohei Ohtani", 1.03, "flat")],
      ["Aaron Judge",     mkTrend("Aaron Judge", 1.08, "up")],
      ["Ken Griffey Jr.", mkTrend("Ken Griffey Jr.", 0.94, "down")],
    ]);
    const r = computePortfolioMomentum(holdings, trends, {}, NOW);
    expect(r.holdingsWithTrend).toBe(4);
    expect(r.scannedHoldings).toBe(4);
    expect(r.cardsUp).toBe(2);
    expect(r.cardsFlat).toBe(1);
    expect(r.cardsDown).toBe(1);
    expect(r.direction).toBe("flat"); // Ohtani's $8k weight dominates
    expect(r.topMovers[0].playerName).toBe("Eric Hartman");
    expect(r.worstMovers[0].playerName).toBe("Ken Griffey Jr.");
    // impliedDelta ≈ 155*0.48 + 8000*0.03 + 340*0.08 + 1200*(-0.06)
    //             ≈ 74.4 + 240 + 27.2 - 72 = 269.6
    expect(r.impliedPortfolioDelta).toBeCloseTo(269.6, 1);
  });

  it("pins defaults", () => {
    expect(_DEFAULTS.upThreshold).toBe(1.05);
    expect(_DEFAULTS.downThreshold).toBe(0.95);
    expect(_DEFAULTS.topMoversCount).toBe(3);
  });
});
