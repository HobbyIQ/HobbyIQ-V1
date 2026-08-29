// CF-ONE-GRADE-CURVE (D4 "one valuation path", PR 4 — 2026-08-29).
//
// iOS resolves a grade tile's headline through a chain of its own
// (HobbyIQ/CompIQCardGrades.swift:184-190):
//
//     resolvedMarketValue = trendAdjustedValue ?? value
//                           ?? weightedMedianPrice ?? plainMedianPrice
//
// so WHICH fields a tier populates decides whether the user sees the
// projection or a median — with no wire-shape change and no failing test.
// This file pins the field-population contract in gradeCurveEntry.ts: for
// every rung the unified engine can name, which fields carry a number, which
// are null, and that the chain — replicated here verbatim — lands on the
// rung's number and would land there even if every median field were gone.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// unifiedPricing reaches Cosmos through `new CosmosClient(conn).database().
// container().items.query().fetchAll()`. Stub exactly that chain and feed
// whatever rows the test sets (same seam as unifiedGradeEntryRungLabel).
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
          items: {
            query: () => ({ fetchAll: async () => ({ resources: h.rows }) }),
          },
        }),
      };
    }
  }
  return { CosmosClient };
});
// The curve's own per-grade read (a different query) answers nothing here, so
// every number on the curve comes from the unified overlay — the producer
// under test.
vi.mock("../src/services/compiq/soldCompsGradeReader.js", () => ({
  readSoldCompsForGrade: vi.fn(async () => []),
}));
vi.mock("../src/services/playerTrend/index.js", () => ({
  getPlayerTrendSnapshot: vi.fn(async () => null),
}));
vi.mock("../src/services/playerTrend/cardHedgeMatchedCohortProvider.js", () => ({
  fetchCardHedgeMatchedCohort: vi.fn(async () => null),
}));
vi.mock("../src/services/playerTrend/matchedCohortCache.js", () => ({
  readMatchedCohortFromCache: vi.fn(async () => null),
  writeMatchedCohortToCache: vi.fn(async () => undefined),
}));
vi.mock("../src/services/playerTrend/parallelTierTrend.service.js", () => ({
  getParallelTierTrend: vi.fn(async () => null),
}));
process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://unit.test/;AccountKey=dW5pdA==;";

import { computeUnifiedPrice, type UnifiedGradeEntry } from "../src/services/compiq/unifiedPricing.service.js";
import {
  applyUnifiedTierToEntry,
  blankGradeCurveEntry,
  UNIFIED_PREDICTED_HORIZON_DAYS,
} from "../src/services/compiq/gradeCurveEntry.js";
import { buildObservedGradeCurve, type ObservedGradeEntry } from "../src/services/compiq/observedGradeCurve.service.js";

// Frozen clock: the projection is evaluated AT NOW, so two calls must see the
// same now to produce the same number.
const FAKE_NOW = new Date("2026-08-29T12:00:00.000Z");
const NOW = FAKE_NOW.getTime();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const sale = (price: number, d: number, grade: { c: string; v: number } | null = { c: "PSA", v: 10 }) => ({
  price,
  soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null,
  gradeValue: grade?.v ?? null,
});

// One pool per rung the unified engine can name for a tier. Each is the
// smallest shape that reaches its branch (see computeTrendAndPrediction).
//   projection      n >= 8 dated sales — a regression fit read at now. Rising,
//                   so the fit at now sits ABOVE the weighted median and the
//                   two are distinguishable.
//   leading-edge    4 <= n < 8 — median of the newest three sales.
//   weighted-median n < 4 — the recency-weighted median, labelled as such.
const POOLS = {
  "exact-pool-projection": Array.from({ length: 10 }, (_, i) => sale(100 + i * 4, 45 - i * 5)),
  "exact-pool-leading-edge": [sale(100, 1), sale(104, 2), sale(98, 3), sale(101, 4), sale(97, 5)],
  "exact-pool-weighted-median": [sale(100, 3), sale(110, 9)],
} as const;
type Rung = keyof typeof POOLS;

async function unifiedTier(rows: Array<Record<string, unknown>>, label = "PSA 10"): Promise<UnifiedGradeEntry> {
  h.rows = rows;
  const u = await computeUnifiedPrice("card-x", { fixedWindowDays: 180 });
  const tier = u.gradeCurve.find((e) => e.grade === label);
  if (!tier) throw new Error(`no ${label} tier in unified curve`);
  return tier;
}

/** HobbyIQ/CompIQCardGrades.swift:184-190, verbatim. */
function resolvedMarketValue(e: ObservedGradeEntry): number | null {
  for (const v of [e.trendAdjustedValue, e.value, e.weightedMedianPrice, e.plainMedianPrice]) {
    if (v != null && v > 0) return v;
  }
  return null;
}
/** HobbyIQ/CompIQCardGrades.swift:196-201 — the LAST SALE cell's chain. */
function observedSaleValue(e: ObservedGradeEntry): number | null {
  for (const v of [e.weightedMedianPrice, e.plainMedianPrice, e.value]) {
    if (v != null && v > 0) return v;
  }
  return null;
}
const withoutMedians = (e: ObservedGradeEntry): ObservedGradeEntry =>
  ({ ...e, value: null, weightedMedianPrice: null, plainMedianPrice: null });

beforeEach(() => {
  h.rows = [];
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe("gradeCurveEntry — the field-population contract, per rung", () => {
  for (const rung of Object.keys(POOLS) as Rung[]) {
    it(`${rung}: trendAdjustedValue and value both carry the rung's number; the medians are diagnostic`, async () => {
      const tier = await unifiedTier([...POOLS[rung]]);
      expect(tier.rungLabel).toBe(rung);
      expect(tier.marketValue).not.toBeNull();

      const entry = applyUnifiedTierToEntry(blankGradeCurveEntry("PSA 10", "PSA"), tier, { confidenceScore: 0.5, nowMs: NOW });

      // Populated on every unified tier.
      expect(entry.valueSource).toBe("observed");
      expect(entry.rungLabel).toBe(rung);
      expect(entry.trendAdjustedValue).toBe(tier.marketValue);
      expect(entry.trendAdjustedValue).toBeGreaterThan(0);
      expect(entry.value).toBe(entry.trendAdjustedValue);
      expect(entry.weightedMedianPrice).toBe(tier.weightedMedian);
      expect(entry.plainMedianPrice).toBe(tier.plainMedian);
      expect(entry.sampleCount).toBe(tier.sampleCount);
      expect(entry.newestSaleDate).toBe(tier.newestSaleDate);
      expect(typeof entry.daysSinceNewestSale).toBe("number");
      expect(entry.predictedPriceAt30d).toBe(tier.predictedPrice);
      expect(entry.predictedHorizonDays).toBe(UNIFIED_PREDICTED_HORIZON_DAYS);
      expect(entry.predictedPriceRangeLow).toBeLessThan(entry.predictedPriceAt30d as number);
      expect(entry.predictedPriceRangeHigh).toBeGreaterThan(entry.predictedPriceAt30d as number);
      expect(entry.confidenceScore).toBe(0.5);
      expect(typeof entry.trendAdjustmentPct).toBe("number");

      // Null on every unified tier — nothing was estimated.
      expect(entry.estimatedMultiplier).toBeNull();
      expect(entry.estimatedFrom).toBeNull();

      // The range exists only when the pool can support percentiles.
      if (tier.sampleCount >= 4) {
        expect(entry.priceRangeLow).not.toBeNull();
        expect(entry.priceRangeHigh).not.toBeNull();
      } else {
        expect(entry.priceRangeLow).toBeNull();
        expect(entry.priceRangeHigh).toBeNull();
      }

      // The trend scalar iOS renders is the rung's own, or nothing.
      expect(entry.predictedPricePct).toBe(tier.trendPctPerWeek);

      // iOS's chain lands on the rung's number — and would land there with
      // every median field removed. A median is never the headline.
      expect(resolvedMarketValue(entry)).toBe(tier.marketValue);
      expect(resolvedMarketValue(withoutMedians(entry))).toBe(tier.marketValue);
    });
  }

  it("exact-pool-projection: the projection is NOT the median, and the fallback slot does not hold the median", async () => {
    const tier = await unifiedTier([...POOLS["exact-pool-projection"]]);
    // The pool is built rising so these differ; if they ever coincide the
    // assertion below is vacuous, so pin the premise.
    expect(tier.marketValue).not.toBe(tier.weightedMedian);
    const entry = applyUnifiedTierToEntry(blankGradeCurveEntry("PSA 10", "PSA"), tier, { confidenceScore: 0.5, nowMs: NOW });
    expect(entry.value).not.toBe(tier.weightedMedian);
    expect(entry.value).not.toBe(tier.plainMedian);
    expect(resolvedMarketValue(entry)).not.toBe(tier.weightedMedian);
    // The lift the trend contributed over the pool's centre is reported.
    expect(entry.trendAdjustmentPct).not.toBe(0);
    // The medians stay readable where iOS reads them AS medians.
    expect(observedSaleValue(entry)).toBe(tier.weightedMedian);
  });

  it("exact-pool-weighted-median: the one rung whose number IS a median says so, and claims no trend", async () => {
    const tier = await unifiedTier([...POOLS["exact-pool-weighted-median"]]);
    const entry = applyUnifiedTierToEntry(blankGradeCurveEntry("PSA 10", "PSA"), tier, { confidenceScore: 0.3, nowMs: NOW });
    expect(entry.rungLabel).toBe("exact-pool-weighted-median");
    expect(entry.value).toBe(tier.weightedMedian);
    expect(entry.trendAdjustmentPct).toBe(0);
    expect(entry.predictedPricePct).toBeNull();
    expect(entry.predictedPriceAt30d).toBe(entry.value);
  });

  it("a tier with no pool is left untouched — nothing is written from nothing", () => {
    const blank = blankGradeCurveEntry("PSA 9", "PSA");
    const empty: UnifiedGradeEntry = {
      grade: "PSA 9", gradeCompany: "PSA", gradeValue: 9,
      weightedMedian: null, plainMedian: null, sampleCount: 0, p10: null, p90: null,
      newestSaleDate: null, valueSource: "unavailable", confidence: 0,
      predictedPrice: null, trendPctPerWeek: null, trendDirection: "flat", marketValue: null,
      rungLabel: "exact-pool-weighted-median",
    };
    const out = applyUnifiedTierToEntry(blank, empty, { confidenceScore: 0.9, nowMs: NOW });
    expect(out).toEqual(blankGradeCurveEntry("PSA 9", "PSA"));
    expect(out.valueSource).toBe("unavailable");
    expect(out.rungLabel).toBeNull();
    expect(resolvedMarketValue(out)).toBeNull();
  });
});

describe("buildObservedGradeCurve — the unified overlay is the only writer, through the contract", () => {
  // Raw: rising 10-sale pool (projection). PSA 10: 5 sales (leading edge).
  // PSA 7: 4 sales — a tier CANONICAL_GRADES does not list, which the tree
  // enricher used to append from its own engine.
  const POOL = [
    ...Array.from({ length: 10 }, (_, i) => sale(50 + i * 2, 45 - i * 5, null)),
    sale(300, 1), sale(310, 2), sale(295, 3), sale(302, 4), sale(298, 6),
    sale(120, 2, { c: "PSA", v: 7 }), sale(118, 5, { c: "PSA", v: 7 }),
    sale(125, 9, { c: "PSA", v: 7 }), sale(119, 12, { c: "PSA", v: 7 }),
  ];

  it("every tier the pool prices resolves, on iOS's chain, to the unified tier's marketValue", async () => {
    h.rows = POOL;
    const expected = await computeUnifiedPrice("card-y", { fixedWindowDays: 180 });
    const byLabel = new Map(expected.gradeCurve.map((e) => [e.grade, e]));
    expect(byLabel.get("Raw")?.rungLabel).toBe("exact-pool-projection");
    expect(byLabel.get("PSA 10")?.rungLabel).toBe("exact-pool-leading-edge");
    expect(byLabel.get("PSA 7")?.rungLabel).toBe("exact-pool-leading-edge");

    h.rows = POOL;
    const curve = await buildObservedGradeCurve("card-y");
    for (const label of ["Raw", "PSA 10", "PSA 7"]) {
      const um = byLabel.get(label)!;
      const entry = curve.entries.find((e) => (e.grader === "Raw" ? "Raw" : e.grade) === label);
      expect(entry, label).toBeDefined();
      expect(entry!.valueSource, label).toBe("observed");
      expect(entry!.rungLabel, label).toBe(um.rungLabel);
      expect(entry!.value, label).toBe(entry!.trendAdjustedValue);
      expect(resolvedMarketValue(entry!), label).toBe(um.marketValue);
      expect(resolvedMarketValue(withoutMedians(entry!)), label).toBe(um.marketValue);
    }
  });

  it("a tier outside CANONICAL_GRADES is appended from the pool, grouped with its grader", async () => {
    h.rows = POOL;
    const curve = await buildObservedGradeCurve("card-y");
    const labels = curve.entries.map((e) => e.grade);
    const psa7 = labels.indexOf("PSA 7");
    expect(psa7).toBeGreaterThan(0);
    // Right after the last canonical PSA tier, before the BGS block.
    expect(curve.entries[psa7 - 1].grader).toBe("PSA");
    expect(curve.entries[psa7 + 1]?.grader).not.toBe("PSA");
    // Every canonical tier is still present exactly once.
    expect(labels.filter((l) => l === "PSA 10")).toHaveLength(1);
    expect(labels.filter((l) => l === "Raw")).toHaveLength(1);
  });

  it("a tier with no pool is estimated off the observed anchor or unavailable — never a pool median", async () => {
    h.rows = POOL;
    const curve = await buildObservedGradeCurve("card-y");
    // SGC has no sales in the pool. CF-SITE-CURVE-NO-BLANK-TIERS projects
    // each tier off the observed Raw anchor × its empirical ratio; a tier
    // with no calibration cell stays unavailable. Either way there is no
    // pool, so there is no median for iOS to fall through to.
    const sgc = curve.entries.filter((e) => e.grader === "SGC");
    expect(sgc.length).toBeGreaterThan(0);
    expect(sgc.some((e) => e.valueSource === "estimated")).toBe(true);
    for (const e of sgc) {
      expect(e.sampleCount, e.grade).toBe(0);
      expect(e.weightedMedianPrice, e.grade).toBeNull();
      expect(e.plainMedianPrice, e.grade).toBeNull();
      if (e.valueSource === "estimated") {
        // "grade-curve-estimate": value is the estimate; iOS resolves to it.
        expect(e.rungLabel, e.grade).toBe("grade-curve-estimate");
        expect(e.value, e.grade).toBeGreaterThan(0);
        expect(e.estimatedFrom, e.grade).not.toBeNull();
        expect(resolvedMarketValue(e), e.grade).toBe(e.trendAdjustedValue ?? e.value);
      } else {
        // "unavailable": every number null; iOS resolves nil.
        expect(e.valueSource, e.grade).toBe("unavailable");
        expect(e.rungLabel, e.grade).toBeNull();
        expect(e.value, e.grade).toBeNull();
        expect(e.trendAdjustedValue, e.grade).toBeNull();
        expect(resolvedMarketValue(e), e.grade).toBeNull();
      }
    }
  });
});

describe("source pin — routes never write a grade-curve entry's numbers", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routes = fs.readFileSync(path.join(here, "../src/routes/compiq.routes.ts"), "utf8");

  it("compiq.routes.ts has no overlay of its own and no tree enrichment", () => {
    expect(routes).not.toMatch(/\.trendAdjustedValue = /);
    expect(routes).not.toMatch(/\.weightedMedianPrice = /);
    expect(routes).not.toMatch(/\.predictedPriceAt30d = /);
    expect(routes).not.toMatch(/enrichEntriesWithTree/);
  });

  it("the card-panel and observed-grade-curve routes hand the slug to the curve build", () => {
    // Both routes resolve a slug to a vendor id before building; both must
    // pass the slug back in so the overlay unions the same pool the
    // portfolio prices from.
    const builds = routes.match(/buildObservedGradeCurve\([^;]*?\{[\s\S]*?\n\s{4}\}\)/g) ?? [];
    expect(builds.length).toBeGreaterThanOrEqual(2);
    for (const b of builds) expect(b).toMatch(/hobbyiqCardId:/);
  });
});
