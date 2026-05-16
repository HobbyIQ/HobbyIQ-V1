import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyRegime,
  _setRegimeNowOverride,
} from "../src/services/compiq/regimeClassifier";

// Fixed "now" for deterministic tests.
const NOW = Date.parse("2026-05-15T00:00:00Z");
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

beforeEach(() => _setRegimeNowOverride(NOW));
afterEach(() => _setRegimeNowOverride(null));

describe("classifyRegime", () => {
  it("returns insufficient_data when no comps are supplied", () => {
    const res = classifyRegime([]);
    expect(res.regime).toBe("insufficient_data");
    expect(res.confidence).toBe("low");
    expect(res.diagnostics.compsUsedForClassification).toBe(0);
  });

  it("returns insufficient_data when fewer than 5 in-window comps", () => {
    const comps = [
      { price: 100, date: daysAgo(5) },
      { price: 102, date: daysAgo(10) },
      { price: 99, date: daysAgo(20) },
      { price: 101, date: daysAgo(30) },
    ];
    const res = classifyRegime(comps);
    expect(res.regime).toBe("insufficient_data");
    expect(res.diagnostics.compsUsedForClassification).toBe(4);
  });

  it("excludes comps older than 90 days from classification", () => {
    const comps = [
      { price: 100, date: daysAgo(3) },
      { price: 100, date: daysAgo(20) },
      { price: 100, date: daysAgo(40) },
      { price: 100, date: daysAgo(95) }, // out of window
      { price: 100, date: daysAgo(120) }, // out of window
    ];
    const res = classifyRegime(comps);
    // Only 3 in-window comps remain → insufficient
    expect(res.diagnostics.compsUsedForClassification).toBe(3);
    expect(res.regime).toBe("insufficient_data");
  });

  it("classifies a flat noiseless market as stable", () => {
    const comps = Array.from({ length: 12 }, (_, i) => ({
      price: 100,
      date: daysAgo(i * 5 + 1),
    }));
    const res = classifyRegime(comps);
    expect(res.regime).toBe("stable");
    // 12 in-window → medium baseline
    expect(["medium", "low"]).toContain(res.confidence);
  });

  it("classifies a clean +5%/month rising market as gradually_rising", () => {
    // 18 sales evenly spaced across 90 days, price climbs ~5% per month
    const comps = Array.from({ length: 18 }, (_, i) => {
      const daysFromOldest = 90 - i * 5;
      // start at $100 90 days ago, rise to ~$115 today (≈5%/mo)
      const price = 100 + ((90 - daysFromOldest) / 30) * 5;
      return { price, date: daysAgo(daysFromOldest) };
    });
    const res = classifyRegime(comps);
    expect(res.regime).toBe("gradually_rising");
    expect((res.diagnostics.slopePctPerMonth ?? 0)).toBeGreaterThan(2);
  });

  it("classifies a clean -5%/month declining market", () => {
    const comps = Array.from({ length: 18 }, (_, i) => {
      const daysFromOldest = 90 - i * 5;
      const price = 100 - ((90 - daysFromOldest) / 30) * 5;
      return { price, date: daysAgo(daysFromOldest) };
    });
    const res = classifyRegime(comps);
    expect(res.regime).toBe("declining");
    expect((res.diagnostics.slopePctPerMonth ?? 0)).toBeLessThan(-2);
  });

  it("classifies a sharp recent breakout (+>15% in last 14d) as sharply_breaking_out", () => {
    // Older window: 12 comps clustered around $100
    const older = Array.from({ length: 12 }, (_, i) => ({
      price: 100 + (i % 3 === 0 ? 2 : -1),
      date: daysAgo(20 + i * 5),
    }));
    // Recent 14d: 4 comps around $140
    const recent = Array.from({ length: 4 }, (_, i) => ({
      price: 140 + i,
      date: daysAgo(3 + i * 2),
    }));
    const res = classifyRegime([...older, ...recent]);
    expect(res.regime).toBe("sharply_breaking_out");
    expect((res.diagnostics.pctChangeRecentVsOlder ?? 0)).toBeGreaterThan(15);
  });

  it("classifies a sharp recent crash (->15% in last 14d) as sharply_crashing", () => {
    const older = Array.from({ length: 12 }, (_, i) => ({
      price: 100 + (i % 3 === 0 ? 2 : -1),
      date: daysAgo(20 + i * 5),
    }));
    const recent = Array.from({ length: 4 }, (_, i) => ({
      price: 70 + i,
      date: daysAgo(3 + i * 2),
    }));
    const res = classifyRegime([...older, ...recent]);
    expect(res.regime).toBe("sharply_crashing");
    expect((res.diagnostics.pctChangeRecentVsOlder ?? 0)).toBeLessThan(-15);
  });

  it("does NOT trigger breakout when fewer than 3 recent sales", () => {
    const older = Array.from({ length: 12 }, (_, i) => ({
      price: 100,
      date: daysAgo(20 + i * 5),
    }));
    // Only 2 recent comps even though prices are way up
    const recent = [
      { price: 200, date: daysAgo(3) },
      { price: 210, date: daysAgo(8) },
    ];
    const res = classifyRegime([...older, ...recent]);
    expect(res.regime).not.toBe("sharply_breaking_out");
  });

  it("classifies wildly scattered prices with low R² as volatile", () => {
    // 14 alternating prices: $50, $200, $50, $200, …
    const comps = Array.from({ length: 14 }, (_, i) => ({
      price: i % 2 === 0 ? 50 : 200,
      date: daysAgo(85 - i * 6),
    }));
    const res = classifyRegime(comps);
    expect(res.regime).toBe("volatile");
    expect((res.diagnostics.coefficientOfVariation ?? 0)).toBeGreaterThan(0.3);
    expect((res.diagnostics.r2 ?? 0)).toBeLessThan(0.2);
  });

  it("classifies noisy-but-tight prices (low R², low CoV) as stable", () => {
    // Prices jitter inside a ±2% band → CoV well below 0.3, R² near 0
    const comps = Array.from({ length: 14 }, (_, i) => ({
      price: 100 + (i % 2 === 0 ? 1 : -1),
      date: daysAgo(85 - i * 6),
    }));
    const res = classifyRegime(comps);
    expect(res.regime).toBe("stable");
    expect((res.diagnostics.coefficientOfVariation ?? 1)).toBeLessThan(0.3);
  });

  it("assigns high confidence with ≥15 comps and slope clearly away from boundary", () => {
    const comps = Array.from({ length: 20 }, (_, i) => {
      const daysFromOldest = 88 - i * 4;
      // ~+8%/mo trend, well clear of the ±2% boundary
      const price = 100 + ((88 - daysFromOldest) / 30) * 8;
      return { price, date: daysAgo(daysFromOldest) };
    });
    const res = classifyRegime(comps);
    expect(res.regime).toBe("gradually_rising");
    expect(res.confidence).toBe("high");
  });

  it("demotes confidence when slope sits inside the ±25% boundary band", () => {
    // Slope ~2.3%/mo → within 25% of the 2%/mo boundary → demote
    const comps = Array.from({ length: 20 }, (_, i) => {
      const daysFromOldest = 88 - i * 4;
      const price = 100 + ((88 - daysFromOldest) / 30) * 2.3;
      return { price, date: daysAgo(daysFromOldest) };
    });
    const res = classifyRegime(comps);
    expect(res.regime).toBe("gradually_rising");
    // 20 comps → would be "high" without demotion; expect ≤ medium
    expect(res.confidence === "medium" || res.confidence === "low").toBe(true);
  });

  it("skips non-positive prices and undated comps but counts the rest", () => {
    const comps = [
      { price: 100, date: daysAgo(2) },
      { price: 0, date: daysAgo(3) }, // skip
      { price: -50, date: daysAgo(4) }, // skip
      { price: 101, date: daysAgo(10) },
      { price: 99, date: daysAgo(20) },
      { price: 100, date: null }, // skip — no date
      { price: 102, date: daysAgo(30) },
      { price: 100, date: daysAgo(40) },
      { price: 98, date: daysAgo(50) },
    ];
    const res = classifyRegime(comps);
    expect(res.diagnostics.compsUsedForClassification).toBe(6);
    expect(res.regime).not.toBe("insufficient_data");
  });

  it("accepts either `date` or `soldDate` on input comps", () => {
    const comps = [
      { price: 100, soldDate: daysAgo(2) },
      { price: 101, soldDate: daysAgo(8) },
      { price: 100, soldDate: daysAgo(15) },
      { price: 99, soldDate: daysAgo(25) },
      { price: 100, soldDate: daysAgo(35) },
      { price: 101, soldDate: daysAgo(50) },
    ];
    const res = classifyRegime(comps);
    expect(res.diagnostics.compsUsedForClassification).toBe(6);
    expect(res.regime).not.toBe("insufficient_data");
  });
});
