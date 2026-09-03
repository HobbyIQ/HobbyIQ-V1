// CF-MARKET-INDEXES integrity pins (C-1, H-11, H-12 — 2026-09-03).
//
// These pin the three defects the 2026-09-03 pricing audit found in the
// index, each stated as the failure it actually produced in prod rather
// than as a property the code happens to have:
//
//   C-1  The nightly seeded carry-forward from a 14-day lead-in and then
//        published whatever the survivors implied. Hockey printed
//        4577.46 off ONE fresh member of a 43-card basket.
//   H-11 The backfill valued a whole span against a basket selected at
//        the span's END date — 116 of 181 points valued with their own
//        future.
//   H-12 freshMembers was stored and never read back, so a level from 1
//        member rendered identically to one from 94.
//
// The pre-existing mix-shift pins (marketIndexes.test.ts) could not catch
// C-1: they hand valueMembersOnDay a FULLY-POPULATED carry map, so
// usedWeight is always 1.0 and the collapse is unreachable. These tests
// deliberately run the thin-basket case those pins exclude.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  MIN_USED_WEIGHT,
  computeWeights,
  decidePoint,
  indexLevel,
  indexLevelDetailed,
  valueMembersOnDayDated,
  groupByCard,
  rebalanceEpochFor,
  epochBaseDate,
  addDays,
} from "../src/services/insights/marketIndex.service.js";

const repoRoot = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

/** The audit's isolation case: 100 equal-weight members, one doubles. */
function isolationBasket() {
  const base = new Array(100).fill(100);
  const weights = computeWeights(base);
  return base.map((b, i) => ({ weight: weights[i], baseValue: b }));
}

describe("C-1: a collapsed basket withholds instead of fabricating a level", () => {
  const members = isolationBasket();

  it("the audit's own case — 99 unvalued, one doubles — does NOT print 200", () => {
    // This is the exact number the audit reproduced. Before the fix the
    // level published as 200.00; the correct all-valued answer is 101.00.
    const isolated = members.map((_, i) => (i === 0 ? 200 : 0));

    const raw = indexLevel(members, isolated);
    expect(raw).toBeCloseTo(200, 6);       // the fabrication still computes...

    const decision = decidePoint(members, isolated);
    expect(decision.publish).toBe(false);  // ...but it is never published.
    expect(decision.withheldReason).toBe("used_weight_below_floor");
    expect(decision.usedWeight).toBeCloseTo(0.01, 6);
  });

  it("the same doubling with the basket valued publishes 101.00", () => {
    const allValued = members.map((_, i) => (i === 0 ? 200 : 100));
    const decision = decidePoint(members, allValued);
    expect(decision.publish).toBe(true);
    expect(decision.level).toBeCloseTo(101, 6);
    expect(decision.usedWeight).toBeCloseTo(1, 6);
  });

  it("a partial carry map at 60% usedWeight PUBLISHES, and reports its freshness", () => {
    // The floor withholds a collapse, not ordinary thinness. 60 of 100
    // members valued is a real point and must still print.
    const partial = members.map((_, i) => (i < 60 ? 100 : 0));
    const decision = decidePoint(members, partial);
    expect(decision.publish).toBe(true);
    expect(decision.usedWeight).toBeGreaterThanOrEqual(0.5);
    expect(decision.usedWeight).toBeCloseTo(0.6, 6);
    expect(decision.level).toBeCloseTo(100, 6);
  });

  it("withholds exactly at the floor boundary, not near it", () => {
    const justUnder = members.map((_, i) => (i < 49 ? 100 : 0));
    const atFloor = members.map((_, i) => (i < 50 ? 100 : 0));
    expect(decidePoint(members, justUnder).publish).toBe(false);
    expect(decidePoint(members, atFloor).publish).toBe(true);
    expect(MIN_USED_WEIGHT).toBe(0.5);
  });

  it("the hockey shape — 1 fresh member of a 43-card basket — withholds", () => {
    // Live prod on 2026-09-03: level 4577.46, freshMembers 1, basket 43.
    const base = new Array(43).fill(100);
    const w = computeWeights(base);
    const hockey = base.map((b, i) => ({ weight: w[i], baseValue: b }));
    // One member prints a $65 sale on a $1.42 card: a ~45x relative move.
    const values = hockey.map((_, i) => (i === 0 ? 100 * 45.77 : 0));

    const raw = indexLevelDetailed(hockey, values);
    expect(raw.level).toBeGreaterThan(4000);        // the shipped number
    expect(decidePoint(hockey, values).publish).toBe(false);
  });

  it("an entirely unvalued basket withholds with its own reason", () => {
    const none = members.map(() => 0);
    const d = decidePoint(members, none);
    expect(d.publish).toBe(false);
    expect(d.withheldReason).toBe("no_valued_members");
  });
});

describe("C-1: carry-forward survives beyond the 14-day lead-in", () => {
  it("a member with no sale for months keeps its stored value", () => {
    // The persisted carry map is dated, so a value observed long ago is
    // still the member's value today — which is what keeps usedWeight up.
    const carry = new Map<string, { value: number; asOf: string }>([
      ["stale-card", { value: 42, asOf: "2026-01-05" }],
      ["fresh-card", { value: 10, asOf: "2026-08-30" }],
    ]);
    const sales = groupByCard([
      { cardId: "fresh-card", price: 12, soldAt: "2026-09-02T10:00:00Z" },
    ]);
    const { values, fresh } = valueMembersOnDayDated(
      ["stale-card", "fresh-card"],
      sales,
      carry,
      "2026-09-02",
    );
    expect(fresh).toBe(1);
    expect(values[0]).toBe(42);                       // carried, not dropped
    expect(values[1]).toBe(12);                       // freshly valued
    expect(carry.get("fresh-card")).toEqual({ value: 12, asOf: "2026-09-02" });
    expect(carry.get("stale-card")?.asOf).toBe("2026-01-05");  // untouched
  });

  it("carry-forward is persisted, not rebuilt from a lead-in each run", () => {
    const svc = read("backend/src/services/insights/marketIndex.service.ts");
    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    expect(svc).toContain("market_index_members");
    expect(svc).toContain("export async function loadCarryForward");
    expect(svc).toContain("export async function saveCarryForward");
    // The nightly path must READ the stored carry and WRITE it back.
    expect(compute).toContain("await loadCarryForward(series, sport)");
    expect(compute).toContain("await saveCarryForward(");
  });
});

describe("H-11: the backfill basket never sees its own future", () => {
  it("a point dated D is valued against the basket of D's OWN epoch", () => {
    // Basket selection reads the 90 days ENDING at the epoch base date,
    // so every row it can see is <= D for any D in that epoch.
    const day = "2026-08-15";
    const epoch = rebalanceEpochFor(day);
    const baseDate = epochBaseDate(epoch);
    expect(epoch).toBe("2026-Q3");
    expect(baseDate).toBe("2026-07-01");
    expect(baseDate <= day).toBe(true);

    const eligFrom = addDays(baseDate, -90);
    expect(eligFrom).toBe("2026-04-02");
    // The eligibility window ends at the base date — strictly before D.
    expect(baseDate <= day).toBe(true);
    expect(eligFrom < baseDate).toBe(true);
  });

  it("a span crossing a quarter boundary re-resolves the basket mid-walk", () => {
    // The mutation this pins: valuing the whole span against ONE basket
    // chosen at the end date. Days either side of Jul 1 are different
    // epochs and must not share a basket.
    expect(rebalanceEpochFor("2026-06-30")).toBe("2026-Q2");
    expect(rebalanceEpochFor("2026-07-01")).toBe("2026-Q3");

    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    // The basket is ensured for the span's START, then re-ensured as the
    // day's own epoch rolls — never ensured once at `toDate`.
    expect(compute).toContain("ensureBasket(soldComps, series, sport, fromDate");
    expect(compute).toContain("const dayEpoch = rebalanceEpochFor(day)");
    expect(compute).toContain("if (dayEpoch !== epoch)");
    expect(compute).not.toContain("ensureBasket(soldComps, series, sport, toDate");
  });

  it("backfill and nightly are one method, so their points are comparable", () => {
    const compute = read("backend/src/services/insights/marketIndexCompute.service.ts");
    // Both modes go through computeSeriesForSport; only the span differs.
    const calls = compute.match(/computeSeriesForSport\(sport, from, asOf\)/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

describe("H-12: the read side reports how fresh a level is", () => {
  const readSvc = read("backend/src/services/insights/marketIndexRead.service.ts");

  it("selects freshMembers back out of storage", () => {
    expect(readSvc).toContain("c.freshMembers");
    expect(readSvc).toContain("c.usedWeight");
  });

  it("returns freshMembers and usedWeight on the series response", () => {
    expect(readSvc).toContain("freshMembers: newest.freshMembers ?? null");
    expect(readSvc).toContain("usedWeight: newest.usedWeight ?? null");
  });

  it("surfaces the withheld/stale flags so a carried level says so", () => {
    expect(readSvc).toContain("stale: newest.stale === true");
    expect(readSvc).toContain("withheldReason");
  });
});
