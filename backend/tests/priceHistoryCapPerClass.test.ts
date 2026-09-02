/**
 * CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK / CAP-EVICTION (2026-09-01).
 *
 * The adversarial verify on #1627 found the blocker: appendPriceHistory capped
 * with `existing.slice(-PORTFOLIO_PRICE_HISTORY_MAX)` over ONE array. Once
 * estimated points started appending (the 6h cron writes up to 4/day for a
 * holding sitting on the grade-curve rail) they walked the single window
 * forward and evicted the OBSERVED trail completely — ~91 days to a window
 * holding nothing but estimates. observedPricePoints() would then return [],
 * and getHoldingPriceHistory / buildCalibrationReport / buildWeeklyNarrative
 * would each see an empty observed series for a holding whose comp-anchored
 * history was real. The feature meant to make estimate-drift visible would
 * have silently eaten the observations that drift is measured against.
 *
 * Retention is now PER CLASS. These pins hold both halves of that:
 *   1. an estimated flood NEVER evicts an observation;
 *   2. an all-observed series caps at 365 exactly as it did before — no
 *      behavior change for every holding that exists today.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  capPriceHistoryByClass,
  observedPricePoints,
  observedHistoryMax,
  estimatedHistoryMax,
  DEFAULT_PORTFOLIO_PRICE_HISTORY_MAX,
  DEFAULT_PORTFOLIO_ESTIMATED_HISTORY_MAX,
} from "../src/services/portfolioiq/portfolioStore.service.js";

type Point = { at: string; value: number; valuationStatus?: "observed" | "estimated" };

const day = (n: number) => new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString();

afterEach(() => {
  delete process.env.PORTFOLIO_PRICE_HISTORY_MAX;
  delete process.env.PORTFOLIO_ESTIMATED_HISTORY_MAX;
});

describe("capPriceHistoryByClass — an estimate never evicts an observation", () => {
  it("THE MEASURED SHAPE: 100 observed + 365+ estimated appends -> all 100 observed survive", () => {
    // The verifier's shape: a real holding with a 100-point comp-anchored
    // trail, then the 6h cron flipping it onto the grade-curve rail and
    // appending estimates for a year (4/day * 91 days is what killed it;
    // 400 here is past that and past the 365 window besides).
    const observed: Point[] = Array.from({ length: 100 }, (_, i) => ({
      at: day(i),
      value: 100 + i,
    }));
    const estimated: Point[] = Array.from({ length: 400 }, (_, i) => ({
      at: day(100 + i),
      value: 50 + i,
      valuationStatus: "estimated",
    }));

    const capped = capPriceHistoryByClass<Point>([...observed, ...estimated]);

    // THE BLOCKER ASSERTION: every observation is still there, by value and
    // in order. Under the old single-window slice this was [] — the whole
    // observed trail fell off the front.
    const survivingObserved = observedPricePoints(capped);
    expect(survivingObserved).toHaveLength(100);
    expect(survivingObserved.map((p) => p.value)).toEqual(observed.map((p) => p.value));

    // ...and the readers that matter see a non-empty observed series.
    expect(observedPricePoints(capped).length).toBeGreaterThan(0);

    // The estimated series IS capped — it is the unbounded one.
    const survivingEstimated = capped.filter((p) => p.valuationStatus === "estimated");
    expect(survivingEstimated).toHaveLength(DEFAULT_PORTFOLIO_ESTIMATED_HISTORY_MAX);
    // and it keeps the NEWEST estimates, not the oldest.
    expect(survivingEstimated[survivingEstimated.length - 1].value).toBe(50 + 399);

    // Storage stays chronological across both classes.
    const ats = capped.map((p) => p.at);
    expect([...ats].sort()).toEqual(ats);
  });

  it("NO BEHAVIOR CHANGE: an all-observed series still caps at 365 exactly", () => {
    const points: Point[] = Array.from({ length: 500 }, (_, i) => ({
      at: day(i),
      value: i,
    }));

    const capped = capPriceHistoryByClass<Point>(points);

    expect(capped).toHaveLength(DEFAULT_PORTFOLIO_PRICE_HISTORY_MAX);
    expect(capped).toHaveLength(365);
    // The newest 365 — identical to the old `slice(-365)` on an all-observed
    // array, which is every holding that exists today.
    expect(capped).toEqual(points.slice(-365));
  });

  it("legacy untagged points are observed, and are protected as observations", () => {
    // Absence of valuationStatus IS the old observed-only guarantee.
    const legacy: Point[] = Array.from({ length: 40 }, (_, i) => ({ at: day(i), value: i }));
    const flood: Point[] = Array.from({ length: 600 }, (_, i) => ({
      at: day(40 + i),
      value: i,
      valuationStatus: "estimated",
    }));

    const capped = capPriceHistoryByClass<Point>([...legacy, ...flood]);
    expect(observedPricePoints(capped)).toHaveLength(40);
  });

  it("an explicit observed tag is protected the same as an absent one", () => {
    const tagged: Point[] = Array.from({ length: 20 }, (_, i) => ({
      at: day(i),
      value: i,
      valuationStatus: "observed",
    }));
    const flood: Point[] = Array.from({ length: 500 }, (_, i) => ({
      at: day(20 + i),
      value: i,
      valuationStatus: "estimated",
    }));
    expect(observedPricePoints(capPriceHistoryByClass<Point>([...tagged, ...flood]))).toHaveLength(20);
  });

  it("an observed series past its own cap still evicts its own oldest", () => {
    // Per-class retention is not "observed is unbounded" — observed keeps its
    // own 365 window, it just no longer shares it with the estimates.
    const observed: Point[] = Array.from({ length: 400 }, (_, i) => ({ at: day(i), value: i }));
    const estimated: Point[] = Array.from({ length: 50 }, (_, i) => ({
      at: day(400 + i),
      value: i,
      valuationStatus: "estimated",
    }));

    const capped = capPriceHistoryByClass<Point>([...observed, ...estimated]);
    const obs = observedPricePoints(capped);
    expect(obs).toHaveLength(365);
    expect(obs[0].value).toBe(35);          // oldest 35 observations evicted
    expect(obs[obs.length - 1].value).toBe(399);
    expect(capped.filter((p) => p.valuationStatus === "estimated")).toHaveLength(50);
  });

  it("both caps are env-overridable, with the documented defaults and a 30 floor", () => {
    expect(observedHistoryMax()).toBe(365);
    expect(estimatedHistoryMax()).toBe(180);

    process.env.PORTFOLIO_PRICE_HISTORY_MAX = "50";
    process.env.PORTFOLIO_ESTIMATED_HISTORY_MAX = "40";
    expect(observedHistoryMax()).toBe(50);
    expect(estimatedHistoryMax()).toBe(40);

    const observed: Point[] = Array.from({ length: 80 }, (_, i) => ({ at: day(i), value: i }));
    const estimated: Point[] = Array.from({ length: 80 }, (_, i) => ({
      at: day(80 + i),
      value: i,
      valuationStatus: "estimated",
    }));
    const capped = capPriceHistoryByClass<Point>([...observed, ...estimated]);
    expect(observedPricePoints(capped)).toHaveLength(50);
    expect(capped.filter((p) => p.valuationStatus === "estimated")).toHaveLength(40);

    // Floor: a nonsense override cannot shrink the window below 30.
    process.env.PORTFOLIO_PRICE_HISTORY_MAX = "5";
    expect(observedHistoryMax()).toBe(30);
  });
});
