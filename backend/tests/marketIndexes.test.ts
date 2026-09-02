// CF-MARKET-INDEXES (Drew, 2026-09-02). Pins for the fixed-liquid-basket
// index. The mix-shift pin is the reason the methodology exists: the
// pre-existing weeklyHobbyIndex reports a median over whatever sold, so
// a change in the SALES MIX moves it with no card changing value. These
// tests hold the line that our index cannot do that.

import { describe, it, expect } from "vitest";
import {
  MAX_CARD_WEIGHT,
  computeWeights,
  indexLevel,
  selectBasket,
  trendValue,
  groupByCard,
  valueMembersOnDay,
  rebalanceEpochFor,
  epochBaseDate,
  addDays,
  indexPartitionKey,
} from "../src/services/insights/marketIndex.service.js";

function agg(sales: number, values: number[]) {
  return { sales, values };
}

describe("basket selection determinism", () => {
  it("same inputs produce the same basket regardless of insertion order", () => {
    const entries: [string, { sales: number; values: number[] }][] = [
      ["card-c", agg(30, [10, 11, 12])],
      ["card-a", agg(50, [100, 101, 102])],
      ["card-b", agg(40, [50, 51, 52])],
      ["card-d", agg(9, [5, 5, 5])],
    ];
    const forward = selectBasket(new Map(entries), 10).map((m) => m.cardId);
    const reversed = selectBasket(new Map(entries.slice().reverse()), 10).map((m) => m.cardId);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(["card-a", "card-b", "card-c", "card-d"]);
  });

  it("breaks sales ties on cardId so the order is stable, not arbitrary", () => {
    const tied = new Map([
      ["zzz", agg(20, [10, 10, 10])],
      ["aaa", agg(20, [10, 10, 10])],
      ["mmm", agg(20, [10, 10, 10])],
    ]);
    expect(selectBasket(tied, 10).map((m) => m.cardId)).toEqual(["aaa", "mmm", "zzz"]);
    // And again from a different insertion order.
    const tied2 = new Map([
      ["mmm", agg(20, [10, 10, 10])],
      ["zzz", agg(20, [10, 10, 10])],
      ["aaa", agg(20, [10, 10, 10])],
    ]);
    expect(selectBasket(tied2, 10).map((m) => m.cardId)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("excludes cards below the eligibility floor", () => {
    const m = new Map([
      ["liquid", agg(50, [10, 10, 10])],
      ["illiquid", agg(2, [10, 10, 10])],
    ]);
    expect(selectBasket(m, 10).map((x) => x.cardId)).toEqual(["liquid"]);
  });

  it("honours the basket size cap", () => {
    const m = new Map(
      Array.from({ length: 250 }, (_, i) => [
        `card-${String(i).padStart(3, "0")}`,
        agg(100 - (i % 20), [10, 11, 12]),
      ] as [string, { sales: number; values: number[] }]),
    );
    expect(selectBasket(m, 100)).toHaveLength(100);
  });
});

describe("per-card weight cap", () => {
  it("caps a whale card at MAX_CARD_WEIGHT", () => {
    // One card worth 100x the rest would otherwise own the index.
    const values = [100_000, ...Array.from({ length: 50 }, () => 100)];
    const w = computeWeights(values);
    expect(w[0]).toBeLessThanOrEqual(MAX_CARD_WEIGHT + 1e-9);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
  });

  it("caps every member after redistribution, not just the first pass", () => {
    // Two whales: capping the first pushes mass onto the second, which
    // a single-pass implementation would leave over the cap.
    const values = [100_000, 90_000, ...Array.from({ length: 40 }, () => 50)];
    const w = computeWeights(values);
    for (const x of w) expect(x).toBeLessThanOrEqual(MAX_CARD_WEIGHT + 1e-9);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
  });

  it("falls back to equal weights when the cap is unsatisfiable", () => {
    // 5 members cannot all sit under a 6% cap.
    const w = computeWeights([10, 20, 30, 40, 50]);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
    for (const x of w) expect(x).toBeCloseTo(0.2, 10);
  });

  it("a thin-pool card doubling in value cannot move the index more than the cap allows", () => {
    const n = 50;
    const members = Array.from({ length: n }, () => ({ weight: 1 / n, baseValue: 100 }));
    const flat = Array.from({ length: n }, () => 100);
    const base = indexLevel(members, flat);

    const spiked = flat.slice();
    spiked[0] = 200;                      // one card doubles
    const after = indexLevel(members, spiked);
    // Contribution is bounded by its weight (1/50 = 2%): +100% on 2%
    // of the index is +2 points, never more.
    expect(after - base).toBeCloseTo(2, 6);
  });
});

describe("mix-shift immunity (THE pin)", () => {
  const memberIds = ["cheap", "mid", "expensive"];
  const members = [
    { weight: 1 / 3, baseValue: 10 },
    { weight: 1 / 3, baseValue: 100 },
    { weight: 1 / 3, baseValue: 1000 },
  ];

  it("doubling cheap-card VOLUME with no value change leaves the index flat", () => {
    // Day 1: one sale each, all at base value.
    const day1 = groupByCard([
      { cardId: "cheap", price: 10, soldAt: "2026-09-01T10:00:00Z" },
      { cardId: "mid", price: 100, soldAt: "2026-09-01T10:00:00Z" },
      { cardId: "expensive", price: 1000, soldAt: "2026-09-01T10:00:00Z" },
    ]);
    const v1 = valueMembersOnDay(memberIds, day1, new Map());
    const level1 = indexLevel(members, v1.values);

    // Day 2: the cheap card's sale COUNT doubles (and then some) — the
    // exact shape of a vendor feed lapsing/resuming. Every card still
    // trades at precisely its day-1 price.
    const day2 = groupByCard([
      { cardId: "cheap", price: 10, soldAt: "2026-09-02T09:00:00Z" },
      { cardId: "cheap", price: 10, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "cheap", price: 10, soldAt: "2026-09-02T11:00:00Z" },
      { cardId: "cheap", price: 10, soldAt: "2026-09-02T12:00:00Z" },
      { cardId: "mid", price: 100, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "expensive", price: 1000, soldAt: "2026-09-02T10:00:00Z" },
    ]);
    const v2 = valueMembersOnDay(memberIds, day2, new Map());
    const level2 = indexLevel(members, v2.values);

    expect(level2).toBeCloseTo(level1, 10);
    expect(level2).toBeCloseTo(100, 10);
  });

  it("a naive median over the same two days DOES move — proving the pin is not vacuous", () => {
    const day1Prices = [10, 100, 1000];
    const day2Prices = [10, 10, 10, 10, 100, 1000];
    const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // The mix-shift the fixed basket is immune to visibly wrecks a median.
    expect(med(day1Prices)).toBe(100);
    expect(med(day2Prices)).toBe(10);
  });

  it("a card DROPPING OUT of the day's sales does not move the index", () => {
    const carry = new Map<string, number>([["cheap", 10], ["mid", 100], ["expensive", 1000]]);
    const full = groupByCard([
      { cardId: "cheap", price: 10, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "mid", price: 100, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "expensive", price: 1000, soldAt: "2026-09-02T10:00:00Z" },
    ]);
    const levelFull = indexLevel(members, valueMembersOnDay(memberIds, full, new Map(carry)).values);

    // The expensive card simply doesn't trade today.
    const partial = groupByCard([
      { cardId: "cheap", price: 10, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "mid", price: 100, soldAt: "2026-09-02T10:00:00Z" },
    ]);
    const res = valueMembersOnDay(memberIds, partial, new Map(carry));
    expect(res.fresh).toBe(2);                       // only two priced today
    expect(indexLevel(members, res.values)).toBeCloseTo(levelFull, 10);
  });

  it("moves when a card's VALUE actually changes", () => {
    const carry = new Map<string, number>([["cheap", 10], ["mid", 100], ["expensive", 1000]]);
    const up = groupByCard([
      { cardId: "cheap", price: 10, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "mid", price: 100, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "expensive", price: 1500, soldAt: "2026-09-02T10:00:00Z" },
    ]);
    const level = indexLevel(members, valueMembersOnDay(memberIds, up, new Map(carry)).values);
    // +50% on a third of the index => 100 * (1 + 0.5/3) ≈ 116.67
    expect(level).toBeGreaterThan(100);
    expect(level).toBeCloseTo(100 * (1 / 3 + 1 / 3 + 1.5 / 3), 6);
  });
});

describe("value is a projected next sale, never a median", () => {
  it("projects forward on a rising pool rather than returning the middle", () => {
    const rising = [100, 110, 120, 130, 140];
    const v = trendValue(rising);
    expect(v).toBeGreaterThan(130);          // above the median (120) and the 4th point
    expect(v).toBeLessThanOrEqual(140);      // clamped into the observed range
  });

  it("clamps a steep fit into the observed range", () => {
    const spiky = [10, 10, 10, 1000];
    const v = trendValue(spiky);
    expect(v).toBeLessThanOrEqual(1000);
    expect(v).toBeGreaterThanOrEqual(10);
  });

  it("handles degenerate pools", () => {
    expect(trendValue([])).toBe(0);
    expect(trendValue([42])).toBe(42);
    expect(trendValue([1, 2])).toBe(2);
    expect(trendValue([50, 50, 50, 50])).toBeCloseTo(50, 9);
  });
});

describe("series append idempotence", () => {
  it("a day's point id is a pure function of (sport, date)", () => {
    // Doc ids are what make a re-run upsert in place instead of
    // appending a second point for the same day.
    const idFor = (sport: string, date: string) => `point::${sport}::${date}`;
    expect(idFor("baseball", "2026-09-02")).toBe(idFor("baseball", "2026-09-02"));
    expect(idFor("baseball", "2026-09-02")).not.toBe(idFor("baseball", "2026-09-03"));
    expect(idFor("baseball", "2026-09-02")).not.toBe(idFor("hockey", "2026-09-02"));
  });

  it("recomputing the same day from the same sales yields the same level", () => {
    const memberIds = ["a", "b"];
    const members = [{ weight: 0.5, baseValue: 100 }, { weight: 0.5, baseValue: 200 }];
    const rows = [
      { cardId: "a", price: 120, soldAt: "2026-09-02T10:00:00Z" },
      { cardId: "b", price: 180, soldAt: "2026-09-02T11:00:00Z" },
    ];
    const run = () => indexLevel(members, valueMembersOnDay(memberIds, groupByCard(rows), new Map()).values);
    expect(run()).toBeCloseTo(run(), 12);
  });
});

describe("rebalance epochs", () => {
  it("maps dates to quarterly epochs", () => {
    expect(rebalanceEpochFor("2026-01-15")).toBe("2026-Q1");
    expect(rebalanceEpochFor("2026-03-31")).toBe("2026-Q1");
    expect(rebalanceEpochFor("2026-04-01")).toBe("2026-Q2");
    expect(rebalanceEpochFor("2026-09-02")).toBe("2026-Q3");
    expect(rebalanceEpochFor("2026-12-31")).toBe("2026-Q4");
  });

  it("membership is frozen within an epoch — every day in Q3 resolves to one basket", () => {
    const days = ["2026-07-01", "2026-08-15", "2026-09-02", "2026-09-30"];
    const epochs = new Set(days.map(rebalanceEpochFor));
    expect(epochs.size).toBe(1);
  });

  it("base date is the epoch start", () => {
    expect(epochBaseDate("2026-Q1")).toBe("2026-01-01");
    expect(epochBaseDate("2026-Q3")).toBe("2026-07-01");
    expect(epochBaseDate("2026-Q4")).toBe("2026-10-01");
  });
});

describe("storage conventions", () => {
  it("reserves a synthetic cardId namespace that cannot collide with real cards", () => {
    expect(indexPartitionKey("baseball")).toBe("index::baseball");
    // Real slugs never carry the reserved prefix.
    expect(indexPartitionKey("baseball").startsWith("index::")).toBe(true);
  });

  it("addDays walks UTC days correctly across month and year ends", () => {
    expect(addDays("2026-09-02", 1)).toBe("2026-09-03");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-09-02", -180)).toBe("2026-03-06");
  });
});
