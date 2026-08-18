// CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). Pins the judgements in
// portfolioAnalytics that would otherwise drift silently.
//
// This service exists server-side specifically so web and iOS cannot disagree,
// so these tests are the contract both clients render.

import { describe, it, expect } from "vitest";
import {
  analyzePortfolio, parsePrintRun, scarcityBand, categoryFor, allocationStatus,
  type AnalyzableHolding,
} from "../src/services/portfolioiq/portfolioAnalytics.service.js";

function card(over: Partial<AnalyzableHolding> = {}): AnalyzableHolding {
  return {
    playerName: "Test Player", cardName: "Base", setName: "Topps Chrome",
    parallel: "Base", year: "2024", cost: 100, currentValue: 200,
    status: "owned", ...over,
  };
}

describe("print-run parsing — the whole scarcity spine hangs off text", () => {
  it("reads explicit serials and conventional named parallels", () => {
    expect(parsePrintRun("Gold Refractor /50", "")).toBe(50);
    expect(parsePrintRun("Orange", "Orange Refractor /25")).toBe(25);
    expect(parsePrintRun("", "Superfractor 1/1")).toBe(1);
    expect(parsePrintRun("True Gold", "")).toBe(50);
    expect(parsePrintRun("Black Refractor", "")).toBe(10);
  });

  it("returns null — NOT zero, NOT unnumbered — when the text never said", () => {
    // Folding unknown into unnumbered would silently mark every tersely
    // described card as non-scarce, which flatters the portfolio.
    expect(parsePrintRun("Base", "Base Card")).toBeNull();
    expect(scarcityBand(null)).toBe("unknown");
    expect(scarcityBand(null)).not.toBe("unnumbered");
  });
});

describe("category precedence — supply first, then player", () => {
  it("treats vintage as constrained supply whoever is on it", () => {
    expect(categoryFor(card({ year: "1955", setName: "Bowman" }))).toBe("trueScarcity");
  });

  it("treats a low-numbered card as scarcity regardless of player", () => {
    expect(categoryFor(card({ playerName: "Nobody", parallel: "Black /10" }))).toBe("trueScarcity");
  });

  it("does NOT let a known name launder a plain modern card into scarcity", () => {
    expect(categoryFor(card({ playerName: "Shohei Ohtani", parallel: "Base" })))
      .toBe("establishedGreatness");
  });

  it("splits prospects on whether the card is actually scarce", () => {
    expect(categoryFor(card({ setName: "Bowman Chrome Prospects", parallel: "Gold /50" })))
      .toBe("eliteProspects");
    expect(categoryFor(card({ setName: "Bowman Chrome Prospects", parallel: "Base" })))
      .toBe("speculation");
  });
});

describe("allocation maths is value-weighted", () => {
  it("does not treat one grail plus nine commons as mostly commons", () => {
    const holdings = [
      card({ playerName: "Shohei Ohtani", currentValue: 9000 }),
      ...Array.from({ length: 9 }, () =>
        card({ playerName: "Filler", setName: "Bowman Chrome Prospects", currentValue: 100 })),
    ];
    const r = analyzePortfolio(holdings);
    const est = r.allocations.find((a) => a.category === "establishedGreatness")!;
    // 9000 / (9000 + 9×100) = 0.909 — one card is 91% of the portfolio while
    // being 10% of the card count, which is the whole point.
    expect(est.currentShare).toBeCloseTo(0.909, 3);
    expect(est.cardCount).toBe(1);
  });

  it("sums shares to exactly 1", () => {
    const r = analyzePortfolio([
      card({ playerName: "Shohei Ohtani", currentValue: 500 }),
      card({ year: "1955", currentValue: 300 }),
      card({ setName: "Bowman Chrome Prospects", parallel: "Gold /50", currentValue: 150 }),
      card({ setName: "Bowman Chrome Prospects", currentValue: 50 }),
    ]);
    expect(r.allocations.reduce((s, a) => s + a.currentShare, 0)).toBeCloseTo(1, 6);
  });

  it("multiplies exposure by quantity", () => {
    // Four copies of a $50 card is $200. Treating it as $50 understates
    // concentration in exactly the case that matters.
    expect(analyzePortfolio([card({ currentValue: 50, quantity: 4 })]).totalValue).toBe(200);
  });

  it("excludes sold and pending-review holdings", () => {
    const r = analyzePortfolio([
      card({ currentValue: 100 }),
      card({ currentValue: 999, status: "sold" }),
      card({ currentValue: 888, status: "pending-review" }),
    ]);
    expect(r.totalValue).toBe(100);
    expect(r.cardCount).toBe(1);
  });

  it("prefers canonical FMV over currentValue", () => {
    expect(analyzePortfolio([card({ currentValue: 100, fairMarketValue: 250 })]).totalValue).toBe(250);
  });
});

describe("status bands are percentage points, not ratios", () => {
  it("calls 3 points off a 10% target on target", () => {
    // A ratio test would call this a 30% miss and scream about the smallest
    // bucket forever.
    expect(allocationStatus(0.13, 0.10)).toBe("onTarget");
    expect(allocationStatus(0.25, 0.40)).toBe("underweight");
    expect(allocationStatus(0.40, 0.40)).toBe("onTarget");
  });
});

describe("score", () => {
  it("is bounded and its weights sum to 1", () => {
    const r = analyzePortfolio([
      card({ playerName: "Shohei Ohtani", currentValue: 500 }),
      card({ year: "1955", currentValue: 300 }),
    ]);
    expect(r.score.value).toBeGreaterThanOrEqual(0);
    expect(r.score.value).toBeLessThanOrEqual(100);
    expect(r.score.components.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 6);
  });

  it("ranks a scarce graded portfolio above a speculative one", () => {
    const strong = analyzePortfolio([
      card({ playerName: "Shohei Ohtani", parallel: "Gold /50", currentValue: 400, gradeCompany: "PSA", gradeValue: 10 }),
      card({ playerName: "Aaron Judge", year: "1968", currentValue: 300, gradeCompany: "PSA", gradeValue: 8 }),
      card({ playerName: "Bobby Witt", parallel: "Orange /25", currentValue: 300, gradeCompany: "PSA", gradeValue: 10 }),
    ]);
    const weak = analyzePortfolio(Array.from({ length: 3 }, (_, i) =>
      card({ playerName: `Prospect ${i}`, setName: "Bowman Chrome Prospects", currentValue: 333 })));
    expect(strong.score.value).toBeGreaterThan(weak.score.value);
  });
});

describe("concentration + honesty rails", () => {
  it("flags a dominant single player", () => {
    const r = analyzePortfolio([
      card({ playerName: "Shohei Ohtani", currentValue: 800 }),
      ...Array.from({ length: 4 }, (_, i) => card({ playerName: `Other ${i}`, currentValue: 50 })),
    ]);
    const player = r.concentrations.find((c) => c.dimension === "player")!;
    expect(player.label).toBe("Shohei Ohtani");
    expect(player.isWarning).toBe(true);
    expect(player.share).toBeCloseTo(0.8, 2);
  });

  it("reports how much value has no readable print run", () => {
    const r = analyzePortfolio([card({ currentValue: 100 }), card({ currentValue: 100 })]);
    expect(r.unknownScarcityValueShare).toBeCloseTo(1, 6);
  });

  it("returns an empty result rather than throwing on no holdings", () => {
    const r = analyzePortfolio([]);
    expect(r.cardCount).toBe(0);
    expect(r.totalValue).toBe(0);
    expect(r.allocations).toEqual([]);
  });

  it("does not divide by zero on a zero-cost portfolio", () => {
    const r = analyzePortfolio([card({ cost: 0, currentValue: 100 })]);
    expect(r.roi).toBe(0);
    expect(Number.isFinite(r.score.value)).toBe(true);
  });
});
