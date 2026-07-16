// CF-SUPPLY-DEMAND-SIGNAL (Drew, 2026-07-13, PR #420) — verifies the
// verdict-matrix logic + the listings-trend regression path.

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  deriveVerdict,
  computeListingsTrend,
  buildSupplyDemandSignal,
} from "../src/services/compiq/supplyDemandSignal.service.js";
import * as store from "../src/services/portfolioiq/listingsSnapshotStore.service.js";

afterEach(() => vi.restoreAllMocks());

describe("deriveVerdict — the 3x3 supply/demand matrix", () => {
  it("Sales up + Listings down = strong_bull", () => {
    expect(deriveVerdict("up", "down")).toBe("strong_bull");
  });
  it("Sales up + Listings up = mixed", () => {
    expect(deriveVerdict("up", "up")).toBe("mixed");
  });
  it("Sales up + Listings static = bull", () => {
    expect(deriveVerdict("up", "static")).toBe("bull");
  });
  it("Sales static + Listings down = supply_tight", () => {
    expect(deriveVerdict("static", "down")).toBe("supply_tight");
  });
  it("Sales static + Listings up = oversupply", () => {
    expect(deriveVerdict("static", "up")).toBe("oversupply");
  });
  it("Sales static + Listings static = static", () => {
    expect(deriveVerdict("static", "static")).toBe("static");
  });
  it("Sales down + Listings up = bear", () => {
    expect(deriveVerdict("down", "up")).toBe("bear");
  });
  it("Sales down + Listings static = soft", () => {
    expect(deriveVerdict("down", "static")).toBe("soft");
  });
  it("Sales down + Listings down = weak", () => {
    expect(deriveVerdict("down", "down")).toBe("weak");
  });
  it("Any sales + null listings = unavailable", () => {
    expect(deriveVerdict("up", null)).toBe("unavailable");
    expect(deriveVerdict("down", null)).toBe("unavailable");
    expect(deriveVerdict("static", null)).toBe("unavailable");
  });
});

const BASE_DAY = Date.parse("2026-08-01T00:00:00Z");
const day = (offsetDays: number, count: number) => {
  const ms = BASE_DAY - offsetDays * 86_400_000;
  const iso = new Date(ms).toISOString();
  const dateOnly = iso.slice(0, 10);
  return {
    id: `test::${dateOnly}`,
    player: "test-player",
    playerDisplay: "Test Player",
    date: dateOnly,
    totalListings: count,
    medianAsk: null,
    pricedItemCount: 0,
    effectiveQuery: "Test Player",
    snapshottedAt: iso,
    ttl: 0,
  };
};

describe("computeListingsTrend — regression on stored snapshots", () => {
  it("returns null when fewer than 2 snapshots", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([day(0, 100)]);
    const r = await computeListingsTrend("Test Player", 30);
    expect(r).toBeNull();
  });

  it("returns direction='up' when listings counts are trending up", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([
      day(20, 50), day(15, 60), day(10, 75), day(5, 85), day(0, 100),
    ]);
    const r = await computeListingsTrend("Test Player", 30);
    expect(r).not.toBeNull();
    expect(r!.direction).toBe("up");
    expect(r!.slopePerMonthPct).toBeGreaterThan(3);
    expect(r!.n).toBe(5);
  });

  it("returns direction='down' when listings counts are trending down", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([
      day(20, 200), day(15, 180), day(10, 160), day(5, 140), day(0, 120),
    ]);
    const r = await computeListingsTrend("Test Player", 30);
    expect(r).not.toBeNull();
    expect(r!.direction).toBe("down");
    expect(r!.slopePerMonthPct).toBeLessThan(-3);
  });

  it("returns direction='static' when listings counts hover within the deadband", async () => {
    // Very small oscillation so the fitted slope × 30 days lands
    // inside the ±3% deadband. Exactly-100 samples with a tiny jitter.
    vi.spyOn(store, "readSnapshots").mockResolvedValue([
      day(20, 100), day(15, 100), day(10, 101), day(5, 100), day(0, 100),
    ]);
    const r = await computeListingsTrend("Test Player", 30);
    expect(r).not.toBeNull();
    expect(r!.direction).toBe("static");
  });
});

describe("buildSupplyDemandSignal — end-to-end fold", () => {
  it("returns null when playerName is missing", async () => {
    const salesSlope = {
      marketValue: 100, predictedPrice: 110,
      predictedPriceRange: { low: 90, high: 130 },
      direction: "up" as const,
      slopePerMonthPct: 10, n: 5, regressionSlope: 0,
    };
    const r = await buildSupplyDemandSignal(null, salesSlope);
    expect(r).toBeNull();
  });

  it("returns null when sales slope is missing", async () => {
    const r = await buildSupplyDemandSignal("Test Player", null);
    expect(r).toBeNull();
  });

  it("folds up-sales + down-listings into strong_bull", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([
      day(20, 200), day(10, 150), day(0, 100),
    ]);
    const salesSlope = {
      marketValue: 100, predictedPrice: 110,
      predictedPriceRange: { low: 90, high: 130 },
      direction: "up" as const,
      slopePerMonthPct: 10, n: 5, regressionSlope: 0,
    };
    const r = await buildSupplyDemandSignal("Test Player", salesSlope);
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe("strong_bull");
    expect(r!.salesDirection).toBe("up");
    expect(r!.listingsDirection).toBe("down");
    expect(r!.salesRecordCount).toBe(5);
    expect(r!.listingsSnapshotCount).toBe(3);
  });

  it("returns unavailable verdict when listings data is missing", async () => {
    vi.spyOn(store, "readSnapshots").mockResolvedValue([]);
    const salesSlope = {
      marketValue: 100, predictedPrice: 110,
      predictedPriceRange: { low: 90, high: 130 },
      direction: "up" as const,
      slopePerMonthPct: 10, n: 5, regressionSlope: 0,
    };
    const r = await buildSupplyDemandSignal("Test Player", salesSlope);
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe("unavailable");
    expect(r!.listingsDirection).toBeNull();
    expect(r!.listingsSnapshotCount).toBe(0);
  });
});
