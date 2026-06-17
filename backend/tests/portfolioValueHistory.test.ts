// CF-PHASE-5-COLLECTION-VALUE (2026-06-17): unit + idempotency tests for the
// daily portfolio-value-history snapshot service.
//
// Pure-aggregator tests use computeSnapshotFromHoldings directly (no Cosmos).
// Snapshot idempotency test uses an in-memory fake container injected via
// __portfolioValueHistoryInternals so we don't hit Cosmos in CI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSnapshotFromHoldings,
  computeChange30d,
  computeTopHoldings,
  snapshotPortfolioValueForUser,
  __portfolioValueHistoryInternals,
  type PortfolioValueSnapshot,
} from "../src/services/portfolioiq/portfolioValueHistory.service.js";

// Holding helpers — type-loose since PortfolioHolding has 40+ fields we don't
// need for the snapshot math.
function observed(
  id: string,
  fmv: number,
  qty = 1,
  extras: Record<string, unknown> = {},
): any {
  return {
    id,
    valuationStatus: "observed",
    fairMarketValue: fmv,
    quantity: qty,
    playerName: extras.playerName ?? "Player",
    cardTitle: extras.cardTitle ?? "Card",
    ...extras,
  };
}

function estimated(
  id: string,
  est: number,
  low: number,
  high: number,
  qty = 1,
  extras: Record<string, unknown> = {},
): any {
  return {
    id,
    valuationStatus: "estimated",
    estimatedValue: est,
    estimateLow: low,
    estimateHigh: high,
    quantity: qty,
    playerName: extras.playerName ?? "Player",
    cardTitle: extras.cardTitle ?? "Card",
    ...extras,
  };
}

function pending(id: string, extras: Record<string, unknown> = {}): any {
  return {
    id,
    valuationStatus: "pending",
    quantity: 1,
    playerName: extras.playerName ?? "Player",
    cardTitle: extras.cardTitle ?? "Card",
    ...extras,
  };
}

describe("computeSnapshotFromHoldings — value bucketing", () => {
  it("buckets 3 observed + 2 estimated + 1 pending correctly", () => {
    const items = [
      observed("o1", 100),                    // 100
      observed("o2", 200, 2),                 // 400 (qty=2)
      observed("o3", 50),                     // 50
      estimated("e1", 300, 250, 400),         // est 300, lo 250, hi 400
      estimated("e2", 100, 80, 150, 3),       // est 300, lo 240, hi 450 (qty=3)
      pending("p1"),                          // excluded from value+range
    ];
    const s = computeSnapshotFromHoldings(items);

    expect(s.observedValue).toBe(100 + 400 + 50);          // 550
    expect(s.estimatedValue).toBe(300 + 100 * 3);          // 600
    expect(s.displayableTotal).toBe(550 + 600);             // 1150
    expect(s.observedCount).toBe(3);
    expect(s.estimatedCount).toBe(2);
    expect(s.pendingCount).toBe(1);
    expect(s.holdingCount).toBe(6);
  });

  it("banding rule: observed contributes FMV×qty to both bounds; estimated contributes low/high×qty", () => {
    const items = [
      observed("o1", 100),               // both bounds += 100
      observed("o2", 50, 4),             // both bounds += 200
      estimated("e1", 200, 150, 300),    // lo += 150, hi += 300
      estimated("e2", 80, 60, 100, 2),   // lo += 120, hi += 200
    ];
    const s = computeSnapshotFromHoldings(items);

    expect(s.rangeLow).toBe(100 + 200 + 150 + 120);   // 570
    expect(s.rangeHigh).toBe(100 + 200 + 300 + 200);  // 800
    // Range invariant must hold.
    expect(s.rangeLow).toBeLessThanOrEqual(s.displayableTotal);
    expect(s.displayableTotal).toBeLessThanOrEqual(s.rangeHigh);
  });

  it("pending and EXCLUDED_STATUS holdings contribute zero to value and range", () => {
    const items = [
      observed("o1", 100),
      pending("p1"),
      observed("sold", 999, 1, { cardStatus: "sold" }),
      observed("archived", 999, 1, { cardStatus: "archived" }),
      observed("watchlist", 999, 1, { cardStatus: "watchlist" }),
      observed("trade", 999, 1, { cardStatus: "trade pending" }),
    ];
    const s = computeSnapshotFromHoldings(items);

    expect(s.observedValue).toBe(100);
    expect(s.estimatedValue).toBe(0);
    expect(s.rangeLow).toBe(100);
    expect(s.rangeHigh).toBe(100);
    expect(s.observedCount).toBe(1);
    expect(s.pendingCount).toBe(1);
    expect(s.holdingCount).toBe(2);   // sold/archived/watchlist/trade NOT counted
  });

  it("observed with no FMV is reclassified as pending (clean four-bucket arithmetic)", () => {
    const items = [
      observed("o1", 100),
      { id: "o2", valuationStatus: "observed", fairMarketValue: null, quantity: 1, playerName: "X", cardTitle: "Y" },
    ];
    const s = computeSnapshotFromHoldings(items);
    expect(s.observedCount).toBe(1);
    expect(s.pendingCount).toBe(1);   // the FMV-null observed lands here
    expect(s.observedValue).toBe(100);
    expect(s.holdingCount).toBe(2);
  });
});

describe("computeChange30d — historical only, range-weak fallback", () => {
  function snap(date: string, total: number): PortfolioValueSnapshot {
    return {
      id: `u:${date}`,
      userId: "u",
      date,
      asOf: `${date}T00:00:00.000Z`,
      displayableTotal: total,
      observedValue: total,
      estimatedValue: 0,
      rangeLow: total,
      rangeHigh: total,
      observedCount: 1,
      estimatedCount: 0,
      pendingCount: 0,
      holdingCount: 1,
    };
  }

  it("returns null on empty history", () => {
    expect(computeChange30d([])).toBeNull();
  });

  it("rangeWeak=true when history is shorter than 30 days", () => {
    const today = new Date("2026-06-17T12:00:00Z");
    const history = [snap("2026-06-01", 1000), snap("2026-06-17", 1100)];
    const r = computeChange30d(history, today);
    expect(r).not.toBeNull();
    expect(r!.rangeWeak).toBe(true);
    expect(r!.absolute).toBe(100);
    expect(r!.percent).toBe(10);
    expect(r!.asOfDate).toBe("2026-06-01");
  });

  it("rangeWeak=false when history reaches back ≥ 30 days", () => {
    const today = new Date("2026-06-17T12:00:00Z");
    const history: PortfolioValueSnapshot[] = [];
    // 35 days of history ending today
    for (let i = 35; i >= 0; i--) {
      const d = new Date("2026-06-17T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - i);
      history.push(snap(d.toISOString().slice(0, 10), 1000 + (35 - i) * 10));
    }
    const r = computeChange30d(history, today);
    expect(r).not.toBeNull();
    expect(r!.rangeWeak).toBe(false);
    // Baseline = first snapshot whose date ≥ today-30d = 2026-05-18.
    // 2026-05-18 in our series is i=30 → total = 1000 + 5*10 = 1050.
    // Latest = 2026-06-17 → total = 1000 + 35*10 = 1350. delta = 300.
    expect(r!.absolute).toBe(300);
    expect(r!.percent).toBeCloseTo((300 / 1050) * 100, 2);
    expect(r!.asOfDate).toBe("2026-05-18");
  });

  it("single-row history → rangeWeak=true, baseline==latest, zero delta", () => {
    const r = computeChange30d([snap("2026-06-17", 500)], new Date("2026-06-17T12:00:00Z"));
    expect(r).not.toBeNull();
    expect(r!.rangeWeak).toBe(true);
    expect(r!.absolute).toBe(0);
    expect(r!.percent).toBe(0);
    expect(r!.asOfDate).toBe("2026-06-17");
  });

  it("percent is null when baseline displayableTotal is 0", () => {
    const r = computeChange30d(
      [snap("2026-05-15", 0), snap("2026-06-17", 100)],
      new Date("2026-06-17T12:00:00Z"),
    );
    expect(r).not.toBeNull();
    expect(r!.absolute).toBe(100);
    expect(r!.percent).toBeNull();
  });
});

describe("computeTopHoldings", () => {
  it("ranks by per-holding displayable value, drops pending, returns source flag", () => {
    const items = [
      observed("a", 100, 1, { playerName: "Alpha", cardTitle: "A1" }),    // 100
      observed("b", 500, 2, { playerName: "Beta",  cardTitle: "B2" }),    // 1000
      estimated("c", 300, 200, 400, 1, { playerName: "Gamma", cardTitle: "C3" }),  // 300 (estimated)
      estimated("d", 50, 30, 80, 5, { playerName: "Delta", cardTitle: "D4" }),     // 250 (estimated)
      pending("p1"),
      observed("sold", 9999, 1, { cardStatus: "sold" }),
    ];
    const top = computeTopHoldings(items, 5);
    expect(top.length).toBe(4);
    expect(top[0]).toMatchObject({ holdingId: "b", estValue: 1000, source: "observed" });
    expect(top[1]).toMatchObject({ holdingId: "c", estValue: 300, source: "estimated" });
    expect(top[2]).toMatchObject({ holdingId: "d", estValue: 250, source: "estimated" });
    expect(top[3]).toMatchObject({ holdingId: "a", estValue: 100, source: "observed" });
  });

  it("caps to N", () => {
    const items = Array.from({ length: 12 }, (_, i) => observed(`h${i}`, (i + 1) * 10));
    expect(computeTopHoldings(items, 5).length).toBe(5);
  });
});

describe("snapshotPortfolioValueForUser — idempotency", () => {
  // In-memory fake container that mimics @azure/cosmos surface used by the
  // service: container.items.upsert + container.items.query (not used here).
  function makeFakeContainer() {
    const rows = new Map<string, any>();
    const container = {
      items: {
        upsert: vi.fn(async (doc: any) => {
          rows.set(doc.id, { ...doc });
          return { resource: doc } as any;
        }),
        query: vi.fn(),
      },
    };
    return { container, rows };
  }

  // The service reads via readUserDoc — we mock the whole module so the
  // snapshot path can run without touching Cosmos for the user doc either.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    __portfolioValueHistoryInternals.resetForTests();
    vi.restoreAllMocks();
  });

  it("same-day re-runs upsert into ONE row (idempotency key = userId:YYYY-MM-DD)", async () => {
    const { container, rows } = makeFakeContainer();

    // Inject the fake container so getContainer() short-circuits.
    __portfolioValueHistoryInternals.setContainerForTests(container as any);

    // Mock readUserDoc to return a deterministic holdings snapshot.
    vi.doMock("../src/services/portfolioiq/portfolioStore.service.js", async () => {
      return {
        readUserDoc: vi.fn(async () => ({
          holdings: {
            o1: observed("o1", 100),
            e1: estimated("e1", 200, 150, 300),
          },
        })),
      };
    });

    // Re-import to pick up the mock.
    const fresh = await import(
      "../src/services/portfolioiq/portfolioValueHistory.service.js"
    );
    fresh.__portfolioValueHistoryInternals.setContainerForTests(container as any);

    const r1 = await fresh.snapshotPortfolioValueForUser("test-user");
    const r2 = await fresh.snapshotPortfolioValueForUser("test-user");
    const r3 = await fresh.snapshotPortfolioValueForUser("test-user");

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r3).not.toBeNull();
    // All three runs share the same id (`test-user:${todayUTC}`).
    expect(r1!.id).toBe(r2!.id);
    expect(r2!.id).toBe(r3!.id);
    expect(rows.size).toBe(1);
    expect(rows.get(r1!.id)).toMatchObject({
      userId: "test-user",
      observedValue: 100,
      estimatedValue: 200,
      displayableTotal: 300,
      rangeLow: 250,
      rangeHigh: 400,
      observedCount: 1,
      estimatedCount: 1,
      pendingCount: 0,
      holdingCount: 2,
    });
    expect(container.items.upsert).toHaveBeenCalledTimes(3);
  });
});
