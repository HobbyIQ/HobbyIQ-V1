/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM — pins the daily → weekly rollup.
 *
 * Covers: ISO week bucketing, partial-edge dropping, median-of-daily-
 * medians, saleCount = day count, invalid-input tolerance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  rollupDailyToWeekly,
  mondayOf,
  type DailyPricePoint,
} from "../src/services/playerTrend/dailyToWeekly.rollup";

// Fix "today" to a known ISO date so the "drop in-progress week" logic
// is deterministic across CI runs.
const FIXED_TODAY = "2026-07-01"; // Wednesday

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_TODAY + "T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mondayOf", () => {
  it.each([
    ["2026-06-22", "2026-06-22"], // Monday → itself
    ["2026-06-23", "2026-06-22"], // Tuesday
    ["2026-06-25", "2026-06-22"], // Thursday
    ["2026-06-28", "2026-06-22"], // Sunday (offset back 6)
    ["2026-06-29", "2026-06-29"], // Next Monday
    ["2026-01-01", "2025-12-29"], // Cross year boundary
  ])("mondayOf(%s) === %s", (input, expected) => {
    expect(mondayOf(input)).toBe(expected);
  });

  it("returns null on invalid input", () => {
    expect(mondayOf("not-a-date")).toBeNull();
  });
});

describe("rollupDailyToWeekly", () => {
  it("empty input → empty output", () => {
    expect(rollupDailyToWeekly([])).toEqual([]);
  });

  it("single complete week of 3 days → one bucket", () => {
    const points: DailyPricePoint[] = [
      { closingDate: "2026-06-22", price: 100 }, // Monday
      { closingDate: "2026-06-24", price: 110 }, // Wednesday
      { closingDate: "2026-06-28", price: 105 }, // Sunday
    ];
    const buckets = rollupDailyToWeekly(points);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].weekStart).toBe("2026-06-22");
    expect(buckets[0].weekEnd).toBe("2026-06-28");
    expect(buckets[0].saleCount).toBe(3);
    expect(buckets[0].medianPrice).toBe(105); // sorted [100, 105, 110], median = 105
    expect(buckets[0].meanPrice).toBe(105);
  });

  it("drops the CURRENT in-progress week (weekEnd >= today)", () => {
    // Fixed today = 2026-07-01 (Wednesday). Current week = Mon 2026-06-29 → Sun 2026-07-05.
    // weekEnd = 2026-07-05 which is >= today, so it's dropped.
    const points: DailyPricePoint[] = [
      { closingDate: "2026-06-22", price: 100 }, // last week — kept
      { closingDate: "2026-06-30", price: 200 }, // current in-progress — dropped
    ];
    const buckets = rollupDailyToWeekly(points);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].weekStart).toBe("2026-06-22");
  });

  it("median-of-daily-medians uses standard median (not weighted)", () => {
    const points: DailyPricePoint[] = [
      { closingDate: "2026-06-22", price: 10 },
      { closingDate: "2026-06-23", price: 100 },
      { closingDate: "2026-06-24", price: 200 },
      { closingDate: "2026-06-25", price: 300 },
    ];
    const buckets = rollupDailyToWeekly(points);
    expect(buckets[0].medianPrice).toBe(150); // (100 + 200) / 2 — even count
    expect(buckets[0].meanPrice).toBe(152.5); // (10 + 100 + 200 + 300) / 4
  });

  it("drops entries with non-positive prices", () => {
    const points: DailyPricePoint[] = [
      { closingDate: "2026-06-22", price: 0 }, // dropped
      { closingDate: "2026-06-23", price: -5 }, // dropped
      { closingDate: "2026-06-24", price: 100 }, // kept
    ];
    const buckets = rollupDailyToWeekly(points);
    expect(buckets[0].saleCount).toBe(1);
    expect(buckets[0].medianPrice).toBe(100);
  });

  it("drops entries with invalid dates", () => {
    const points: DailyPricePoint[] = [
      { closingDate: "not-a-date", price: 100 },
      { closingDate: "2026-06-22", price: 200 },
    ];
    const buckets = rollupDailyToWeekly(points);
    expect(buckets[0].saleCount).toBe(1);
    expect(buckets[0].medianPrice).toBe(200);
  });

  it("multiple complete weeks are returned in ascending order", () => {
    const points: DailyPricePoint[] = [
      { closingDate: "2026-06-08", price: 50 },  // week 2026-06-08
      { closingDate: "2026-06-15", price: 60 },  // week 2026-06-15
      { closingDate: "2026-06-22", price: 70 },  // week 2026-06-22
    ];
    const buckets = rollupDailyToWeekly(points);
    expect(buckets).toHaveLength(3);
    expect(buckets.map((b) => b.weekStart)).toEqual([
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
    ]);
  });

  it("empty week not included", () => {
    // Nothing in 2026-06-15, but data in 2026-06-08 and 2026-06-22.
    const points: DailyPricePoint[] = [
      { closingDate: "2026-06-08", price: 50 },
      { closingDate: "2026-06-22", price: 70 },
    ];
    const buckets = rollupDailyToWeekly(points);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.weekStart)).toEqual([
      "2026-06-08",
      "2026-06-22",
    ]);
  });
});
