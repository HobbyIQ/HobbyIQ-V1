// CF-EXACT-POOL-GRADE-INDEX (RULING, Drew 2026-09-13).
//
//   "A graded tier must be priced from the WHOLE card's trend across grades,
//    recency-weighted, not frozen on the tier's own last sale."
//
// These pin the rung at its BOUNDARIES, because a pricing rung's bugs live
// at its edges: which pools it claims, which it must leave alone, and what
// it does with evidence it cannot index. The fixtures are the real Witt pool
// the ruling came from, the same identity's ACTUAL 26-row shape as of
// 2026-09-13, and a real
// thin cross-tier card pulled read-only from prod.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { hobbyiqCardId: string | null; windowDays: number; nowMs?: number }) => {
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    return h.rows.filter((r) => Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));

const { computeUnifiedPrice } = await import("../src/services/compiq/unifiedPricing.service.js");
const { isExactPoolRung } = await import("../src/services/compiq/fmvRung.js");
const { EXACT_POOL_INDEX_MIN_POOL, EXACT_POOL_INDEX_TIER_OWN_OLS, EXACT_POOL_INDEX_HALF_LIFE_DAYS } =
  await import("../src/services/compiq/gradeIndexProjection.js");

/** 2026-09-13, the day of the ruling — the clock every expectation reckons from. */
const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const WITT = "hiq:baseball:2020:bowman-chrome:cpa-bwj:base:auto";

function row(soldAt: string, price: number, company: string | null, value: number | null, extra: Record<string, unknown> = {}) {
  return {
    id: `${soldAt}-${price}-${company ?? "raw"}`,
    cardId: WITT, hobbyiqCardId: WITT,
    price, soldAt,
    gradeCompany: company, gradeValue: value,
    source: "tca-ebay", contributorUserId: null,
    ...extra,
  };
}

/** The pool the ruling was written against: 3 Raw, 2 PSA 10, 1 BGS 9.5 —
 *  plus the 2-week-old SGC 9 at $1,300 Drew asked about. */
const WITT_SIX_PLUS_SGC9 = [
  row("2026-09-05T00:00:00.000Z", 950, null, null),
  row("2026-08-30T00:00:00.000Z", 1300, "SGC", 9),     // the sale in question
  row("2026-08-16T00:00:00.000Z", 1250, "PSA", 10),
  row("2026-08-10T00:00:00.000Z", 780, null, null),
  row("2026-08-01T00:00:00.000Z", 1250, "BGS", 9.5),
  row("2026-07-23T00:00:00.000Z", 531.77, null, null),
];

const price = (grade: { company: string | null; value: number | null } | null, rows = h.rows) => {
  h.rows = rows as typeof h.rows;
  return computeUnifiedPrice(WITT, { hobbyiqCardId: WITT, grade, perTierWindows: true, asOfMs: NOW });
};

beforeEach(() => { h.rows = []; });
afterEach(() => { vi.clearAllMocks(); });

describe("CF-EXACT-POOL-GRADE-INDEX — the Witt SGC 9 case the ruling names", () => {
  it("a 2-week-old $1,300 SGC 9 no longer IS the price: the card's whole pool, indexed, says ~$1,399", async () => {
    const u = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);

    expect(u.rungLabel).toBe("exact-pool-grade-index");
    // Not $1,300 — and notably HIGHER, not lower. The index over the same six
    // in-window sales, on the bowman-chrome/baseball byTier multipliers
    // (Raw 1x, SGC 9 1.29x, PSA 10 3.01x, BGS 9.5 1.55x), puts the grade-free
    // level at ~$1,084 and the SGC 9 tier at ~$1,398.70. The direction is the
    // point: this card's raw tier is trending up ~26%/month, and the old rung
    // held SGC 9 at a two-week-old sale while the rest of the card moved.
    // Tolerance is a dollar — this is arithmetic over a fixed pool at a fixed
    // instant, not an estimate.
    expect(u.marketValue).toBeGreaterThan(1398);
    expect(u.marketValue).toBeLessThan(1400);
    expect(u.marketValue).not.toBe(1300);

    const tier = u.gradeCurve.find((e) => e.grade === "SGC 9")!;
    expect(tier.rungLabel).toBe("exact-pool-grade-index");
    // The tier's OWN pool is still one sale — the rung does not pretend the
    // tier has more evidence than it has.
    expect(tier.sampleCount).toBe(1);
    // But the number was read from every index point.
    expect(tier.compsUsed).toBe(6);
  });

  it("the $1,300 sale is still IN the fit, at its own date — not discarded", async () => {
    const u = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);
    const meta = u.gradeCurve.find((e) => e.grade === "SGC 9")!.gradeIndexMeta!;

    expect(meta.ownTierPoints).toBe(1);
    expect(meta.contributions.find((c) => c.tier === "SGC 9")).toEqual({ tier: "SGC 9", sampleCount: 1, multiplier: 1.29 });

    // Removing it MOVES the answer. If the rung were ignoring the tier's own
    // sale, these two would be identical — that is the assertion, not the
    // direction of the move.
    const without = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9.filter((r) => r.gradeCompany !== "SGC"));
    expect(without.marketValue).not.toBe(u.marketValue);
  });

  it("every contributing tier is named on the wire, with the multiplier it was divided by", async () => {
    const u = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);
    const meta = u.gradeCurve.find((e) => e.grade === "SGC 9")!.gradeIndexMeta!;

    expect(meta.requestedMultiplier).toBe(1.29);
    expect(meta.halfLifeDays).toBe(EXACT_POOL_INDEX_HALF_LIFE_DAYS);
    expect(meta.contributions.map((c) => c.tier).sort()).toEqual(["BGS 9.5", "PSA 10", "Raw", "SGC 9"]);
    // The empirical bowman-chrome/baseball byTier table, not a hardcoded matrix.
    expect(Object.fromEntries(meta.contributions.map((c) => [c.tier, c.multiplier]))).toEqual({
      "Raw": 1, "SGC 9": 1.29, "PSA 10": 3.01, "BGS 9.5": 1.55,
    });
    expect(meta.indexAtNow).toBeGreaterThan(1084);
    expect(meta.indexAtNow).toBeLessThan(1085);
    // Index x multiplier IS the tier value — one computation, stated twice.
    expect(Math.round(meta.indexAtNow * meta.requestedMultiplier * 100) / 100).toBe(u.marketValue);
  });

  it("the projection note explains the rung in prose — the tier it priced, the tiers it read, the index and the multiplier", async () => {
    const u = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);
    const note = u.gradeCurve.find((e) => e.grade === "SGC 9")!.projectionNote!;

    expect(note).toContain("too few to fit this tier's own trend");
    expect(note).toContain("grade-free index");
    expect(note).toContain("1.29x");
    expect(note).toMatch(/PSA 10 n=1 @3\.01x/);
    // Never a median or a mean — the doctrine word must not appear as the method.
    expect(note).not.toMatch(/\bmedian of\b/);
  });

  it("it is an EXACT-POOL rung, so R24's cost floor exempts it", async () => {
    const u = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);
    expect(isExactPoolRung(u.rungLabel)).toBe(true);

    // The floor reads the rung through the same allowlist. Pin it at the
    // floor's own seam so a future rename cannot quietly re-expose the rung.
    const { costBasisFloor } = await import("../src/services/portfolioiq/holdingValuation.js");
    const holding = { id: "h1", quantity: 1, totalCostBasis: 20000 } as never;
    expect(costBasisFloor(holding, 1233, "exact-pool-grade-index").rejects).toBe(false);
    // Contrast: a FALLBACK rung at the same ratio is still refused.
    expect(costBasisFloor(holding, 1233, "sibling-estimate").rejects).toBe(true);
  });

  it("no monotonicity clamp across tiers: each tier is index x ITS multiplier, inversions and all", async () => {
    const sgc9 = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);
    const bgs95 = await price({ company: "BGS", value: 9.5 }, WITT_SIX_PLUS_SGC9);
    const raw = await price(null, WITT_SIX_PLUS_SGC9);

    // One index, three multipliers — the ratios between the tiers are exactly
    // the ratios of their empirical multipliers, never a clamp or a reorder.
    expect(bgs95.marketValue! / raw.marketValue!).toBeCloseTo(1.55, 2);
    expect(sgc9.marketValue! / raw.marketValue!).toBeCloseTo(1.29, 2);
  });
});

describe("CF-EXACT-POOL-GRADE-INDEX — rung selection boundaries", () => {
  it(`a tier with >= ${EXACT_POOL_INDEX_TIER_OWN_OLS} sales IN ITS CHOSEN WINDOW keeps its own OLS — the rung stands aside`, async () => {
    // The REAL Witt PSA 10 sales from prod, as of 2026-09-13. Read this
    // fixture carefully, because it encodes a boundary that is easy to get
    // wrong: the "< 8" test is against the rows the tier's CASCADE selected,
    // not against its 180-day total. The live pool holds 14 PSA 10 sales in
    // 180 days, but only 6 of them fall inside the 90-day window the cascade
    // stops at (60d has 4, below the minDirect of 5) — so the live PSA 10
    // tier CANNOT fit its own OLS and this rung legitimately prices it.
    //
    // To pin the stand-aside behaviour we need a tier that genuinely reaches
    // the OLS, so this fixture packs the same real sales into the 60-day
    // window where 8+ of them are selected together.
    const dense = [
      row("2026-07-25T01:59:00.000Z", 2550, "PSA", 10),
      row("2026-07-31T23:13:00.000Z", 2200, "PSA", 10),
      row("2026-08-05T00:00:00.000Z", 2400, "PSA", 10),
      row("2026-08-10T00:00:00.000Z", 2300, "PSA", 10),
      row("2026-08-16T01:15:40.000Z", 2475, "PSA", 10),
      row("2026-08-22T00:00:00.000Z", 2400, "PSA", 10),
      row("2026-08-28T00:00:00.000Z", 2832, "PSA", 10),
      row("2026-09-01T00:00:00.000Z", 2450, "PSA", 10),
      // …alongside thin sibling tiers, which is what makes this a real test:
      // the index COULD be built here, and must not be used for PSA 10.
      row("2026-09-05T22:28:48.000Z", 950, null, null),
      row("2026-08-10T02:20:00.000Z", 780, null, null),
      row("2026-08-01T20:34:52.167Z", 1250, "BGS", 9.5),
    ];
    const u = await price({ company: "PSA", value: 10 }, dense);

    expect(u.rungLabel).toBe("exact-pool-projection");
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.sampleCount).toBe(8);
    expect(tier.gradeIndexMeta ?? null).toBeNull();
    expect(tier.compsUsed ?? null).toBeNull();
    // The dense tier's number is its own pool's projection — in its own
    // $2,200-$2,832 band, nowhere near the index's raw-equivalent level x 3.01.
    expect(u.marketValue).toBeGreaterThan(2000);
    expect(u.marketValue).toBeLessThan(3200);

    // The THIN tiers of the very same card still take the index. One pool,
    // two rungs, each chosen by whether the tier can carry its own trend.
    const bgs = u.gradeCurve.find((e) => e.grade === "BGS 9.5")!;
    expect(bgs.rungLabel).toBe("exact-pool-grade-index");
  });

  it("the OLS gate and the index read the SAME window — a tier dense at 180d keeps its own rung even when its cascade stopped early", async () => {
    // The live Witt pool, exactly as prod held it on 2026-09-13. The PSA 10
    // tier has 14 sales in 180 days but only 4 inside 60d, so the density
    // cascade stops at 90d with 6 rows. A gate reading the SELECTED rows
    // would call a 14-sale tier too thin to fit its own trend and hand it to
    // the index — while the index beside it was reading all 14. The tier has
    // the evidence either way; a window chosen for density must not decide
    // which rung it gets.
    const live = [
      row("2026-03-30T02:30:00.000Z", 2100, "PSA", 10), row("2026-04-06T02:19:00.000Z", 2640, "PSA", 10),
      row("2026-04-11T03:14:00.000Z", 2300, "PSA", 10), row("2026-04-17T14:05:00.000Z", 380, "PSA", 10),
      row("2026-04-26T15:16:00.000Z", 2400, "PSA", 10), row("2026-05-14T21:20:00.000Z", 2475, "PSA", 10),
      row("2026-05-26T04:20:00.000Z", 2832, "PSA", 10), row("2026-05-30T14:37:00.000Z", 2400, "PSA", 10),
      row("2026-06-23T04:39:00.000Z", 2300, "PSA", 10), row("2026-06-25T03:08:00.000Z", 2024, "PSA", 10),
      row("2026-07-25T01:59:00.000Z", 2550, "PSA", 10), row("2026-07-31T23:13:00.000Z", 2200, "PSA", 10),
      row("2026-08-16T01:15:40.000Z", 1250, "PSA", 10), row("2026-06-25T02:32:00.000Z", 150, "PSA", 10),
      row("2026-05-08T08:49:00.000Z", 4000, "PSA", 9), row("2026-05-10T02:11:00.000Z", 1200, "PSA", 9),
      row("2026-05-27T11:42:00.000Z", 1013.98, "PSA", 9),
      row("2026-08-01T20:34:52.167Z", 1250, "BGS", 9.5),
      row("2026-07-23T12:00:01.000Z", 531.77, null, null), row("2026-08-10T02:20:00.000Z", 780, null, null),
      row("2026-09-05T22:28:48.000Z", 950, null, null),
    ];

    const psa10 = await price({ company: "PSA", value: 10 }, live);
    expect(psa10.rungLabel).not.toBe("exact-pool-grade-index");
    expect(psa10.gradeCurve.find((e) => e.grade === "PSA 10")!.gradeIndexMeta ?? null).toBeNull();

    // Its thin siblings on the SAME card do take the index.
    const psa9 = await price({ company: "PSA", value: 9 }, live);
    expect(psa9.rungLabel).toBe("exact-pool-grade-index");
  });

  it("the index is the CARD's, not the request's: every tier of one pool sees the same index level", async () => {
    const live = [
      ...Array.from({ length: 14 }, (_, i) =>
        row(new Date(NOW - (i + 1) * 12 * 86_400_000).toISOString(), 2000 + i * 10, "PSA", 10)),
      row("2026-05-08T08:49:00.000Z", 4000, "PSA", 9), row("2026-05-10T02:11:00.000Z", 1200, "PSA", 9),
      row("2026-05-27T11:42:00.000Z", 1013.98, "PSA", 9),
      row("2026-07-23T12:00:01.000Z", 531.77, null, null), row("2026-08-10T02:20:00.000Z", 780, null, null),
      row("2026-09-05T22:28:48.000Z", 950, null, null),
    ];
    const psa9 = await price({ company: "PSA", value: 9 }, live);
    const raw = await price(null, live);

    // Different tiers cascade to different windows; the index must not follow
    // them, or the same card would carry two index levels at one instant.
    expect(psa9.gradeCurve.find((e) => e.grade === "PSA 9")!.gradeIndexMeta!.indexAtNow)
      .toBe(raw.gradeCurve.find((e) => e.grade === "Raw")!.gradeIndexMeta!.indexAtNow);
  });

  it(`a tier at ${EXACT_POOL_INDEX_TIER_OWN_OLS - 1} own sales still takes the index; at ${EXACT_POOL_INDEX_TIER_OWN_OLS} it does not`, async () => {
    const psa10 = (n: number) => Array.from({ length: n }, (_, i) =>
      row(new Date(NOW - (i + 1) * 3 * 86_400_000).toISOString(), 2000 + i, "PSA", 10));
    const siblings = [
      row("2026-09-05T00:00:00.000Z", 950, null, null),
      row("2026-08-10T00:00:00.000Z", 780, null, null),
      row("2026-08-01T00:00:00.000Z", 1250, "BGS", 9.5),
    ];

    const at7 = await price({ company: "PSA", value: 10 }, [...psa10(7), ...siblings]);
    expect(at7.rungLabel).toBe("exact-pool-grade-index");

    const at8 = await price({ company: "PSA", value: 10 }, [...psa10(8), ...siblings]);
    expect(at8.rungLabel).toBe("exact-pool-projection");
  });

  it(`below N=${EXACT_POOL_INDEX_MIN_POOL} indexable sales the card has no trend to lend: R25 stands, unchanged`, async () => {
    // Three sales card-wide, across two tiers. The pool is as thin as the
    // tier, so "the most recent sale is the market" is still the honest read.
    const u = await price({ company: "SGC", value: 9 }, [
      row("2026-08-30T00:00:00.000Z", 1300, "SGC", 9),
      row("2026-08-16T00:00:00.000Z", 1250, "PSA", 10),
      row("2026-09-05T00:00:00.000Z", 950, null, null),
    ]);

    expect(u.rungLabel).toBe("exact-pool-last-sale");
    expect(u.marketValue).toBe(1300);   // R25: untouched
    expect(u.gradeCurve.find((e) => e.grade === "SGC 9")!.gradeIndexMeta ?? null).toBeNull();
  });

  it(`at exactly N=${EXACT_POOL_INDEX_MIN_POOL} the index fires — the boundary is inclusive`, async () => {
    const u = await price({ company: "SGC", value: 9 }, [
      row("2026-08-30T00:00:00.000Z", 1300, "SGC", 9),
      row("2026-08-16T00:00:00.000Z", 1250, "PSA", 10),
      row("2026-09-05T00:00:00.000Z", 950, null, null),
      row("2026-08-10T00:00:00.000Z", 780, null, null),
    ]);

    expect(u.rungLabel).toBe("exact-pool-grade-index");
    expect(u.gradeCurve.find((e) => e.grade === "SGC 9")!.gradeIndexMeta!.contributions).toHaveLength(3);
  });

  it("a tier ALONE on its card takes no index: there is no other grade to learn from", async () => {
    // Five PSA 10 sales and nothing else. Dividing them by 3.01 and
    // multiplying the answer back by 3.01 returns the same level, so the only
    // effect of firing here would be to relabel a price the rung did not
    // change — claiming a cross-tier basis that does not exist. The tier
    // keeps its own aggregation.
    const u = await price({ company: "PSA", value: 10 }, [
      row("2026-09-12T00:00:00.000Z", 2000, "PSA", 10),
      row("2026-09-11T00:00:00.000Z", 2040, "PSA", 10),
      row("2026-09-10T00:00:00.000Z", 1980, "PSA", 10),
      row("2026-09-09T00:00:00.000Z", 2010, "PSA", 10),
      row("2026-09-08T00:00:00.000Z", 1970, "PSA", 10),
    ]);

    expect(u.rungLabel).toBe("exact-pool-leading-edge");
    expect(u.gradeCurve.find((e) => e.grade === "PSA 10")!.gradeIndexMeta ?? null).toBeNull();
  });

  it("a second tier is enough to change that — the same five sales plus one raw sale take the index", async () => {
    const psa = [
      row("2026-09-12T00:00:00.000Z", 2000, "PSA", 10),
      row("2026-09-11T00:00:00.000Z", 2040, "PSA", 10),
      row("2026-09-10T00:00:00.000Z", 1980, "PSA", 10),
      row("2026-09-09T00:00:00.000Z", 2010, "PSA", 10),
      row("2026-09-08T00:00:00.000Z", 1970, "PSA", 10),
    ];
    const u = await price({ company: "PSA", value: 10 }, [...psa, row("2026-09-12T00:00:00.000Z", 900, null, null)]);
    expect(u.rungLabel).toBe("exact-pool-grade-index");
    expect(u.gradeCurve.find((e) => e.grade === "PSA 10")!.gradeIndexMeta!.contributions).toHaveLength(2);
  });

  it("a tier with NO sales of its own is still the cross-grade fallback's business, not the index's", async () => {
    // The index prices a tier that HAS evidence but too little of it. A tier
    // with nothing at all never enters the curve, so the existing empty-tier
    // rescale keeps that case — this rung changes no behaviour there.
    const u = await price({ company: "SGC", value: 8 }, WITT_SIX_PLUS_SGC9);
    expect(u.rungLabel).toBe("cross-grade-fallback");
  });
});

describe("CF-EXACT-POOL-GRADE-INDEX — what the trend actually does", () => {
  it("a stale own-tier sale does NOT freeze the tier: sibling tiers moving since it sold move the number", async () => {
    // One PSA 9 sale 80 days ago at $1,000, and a raw market that has since
    // climbed steeply. Before this rung the PSA 9 tier read exactly $1,000
    // under exact-pool-last-sale and nothing could move it.
    const staleTier = row("2026-06-25T00:00:00.000Z", 1000, "PSA", 9);
    const flat = [
      row("2026-09-10T00:00:00.000Z", 500, null, null),
      row("2026-09-04T00:00:00.000Z", 500, null, null),
      row("2026-08-28T00:00:00.000Z", 500, null, null),
    ];
    const surging = [
      row("2026-09-10T00:00:00.000Z", 900, null, null),
      row("2026-09-04T00:00:00.000Z", 700, null, null),
      row("2026-08-28T00:00:00.000Z", 500, null, null),
    ];

    const onFlat = await price({ company: "PSA", value: 9 }, [staleTier, ...flat]);
    const onSurge = await price({ company: "PSA", value: 9 }, [staleTier, ...surging]);

    expect(onFlat.rungLabel).toBe("exact-pool-grade-index");
    expect(onSurge.rungLabel).toBe("exact-pool-grade-index");
    // The tier's own evidence is identical in both runs. Only the SIBLINGS
    // differ — and the answer differs with them. That is the whole ruling.
    expect(onSurge.marketValue!).toBeGreaterThan(onFlat.marketValue!);
    // And neither is the frozen $1,000 the old rung would have served.
    expect(onFlat.marketValue).not.toBe(1000);
    expect(onSurge.marketValue).not.toBe(1000);
  });

  it("recency weighting is real: an old sale counts for less than a new one at the same price", async () => {
    const base = [
      row("2026-09-10T00:00:00.000Z", 600, null, null),
      row("2026-09-08T00:00:00.000Z", 600, null, null),
      row("2026-09-06T00:00:00.000Z", 600, null, null),
    ];
    // The SAME $3,010 PSA 10 sale (index point $1,000), once fresh and once
    // four months stale. Fresh, it drags the index up; stale, it barely does.
    const fresh = await price(null, [...base, row("2026-09-11T00:00:00.000Z", 3010, "PSA", 10)]);
    const stale = await price(null, [...base, row("2026-05-11T00:00:00.000Z", 3010, "PSA", 10)]);

    expect(fresh.rungLabel).toBe("exact-pool-grade-index");
    expect(stale.rungLabel).toBe("exact-pool-grade-index");
    expect(fresh.marketValue!).toBeGreaterThan(stale.marketValue!);
  });

  it("a tier with no empirical multiplier contributes NOTHING — never a 1x guess", async () => {
    // HGA is a real grader in the Witt pool with no bowman-chrome calibration
    // cell. Entering its $727 slab at face value would read as a raw sale and
    // pull the whole card's index up.
    const withHga = [...WITT_SIX_PLUS_SGC9, row("2026-08-20T00:00:00.000Z", 727, "HGA", 9)];
    const u = await price({ company: "SGC", value: 9 }, withHga);
    const meta = u.gradeCurve.find((e) => e.grade === "SGC 9")!.gradeIndexMeta!;

    expect(meta.contributions.map((c) => c.tier)).not.toContain("HGA 9");
    expect(meta.skipped).toContainEqual({ tier: "HGA 9", sampleCount: 1 });
    expect(u.gradeCurve.find((e) => e.grade === "SGC 9")!.projectionNote).toContain("could not be indexed");

    // The number is the same as without the HGA row at all — proof it
    // contributed nothing rather than contributing quietly.
    const without = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);
    expect(u.marketValue).toBe(without.marketValue);
  });

  it("a requested tier with no multiplier of its own refuses the rung rather than guessing one back", async () => {
    // Without HGA 9's multiplier there is no way back from the index to a
    // price at HGA 9. The tier keeps the rung it had.
    const u = await price({ company: "HGA", value: 9 }, [...WITT_SIX_PLUS_SGC9, row("2026-08-20T00:00:00.000Z", 727, "HGA", 9)]);
    expect(u.rungLabel).not.toBe("exact-pool-grade-index");
    expect(u.rungLabel).toBe("exact-pool-last-sale");
    expect(u.marketValue).toBe(727);
  });
});

describe("CF-EXACT-POOL-GRADE-INDEX — a real thin cross-tier pool from prod", () => {
  // hiq:baseball:2022:bowman-chrome:cpa-em:base:auto (Estiven Machado), the
  // 5 sales it held in the 180d window on 2026-09-13. Three tiers, none
  // dense, no flagged rows. The PSA 9 sale is 86 days old and $6.50 while
  // the card now trades near $1-2 raw: exactly the staleness the ruling is
  // about, on a card nobody picked to make a point.
  const MACHADO = [
    row("2026-06-19T01:26:00.000Z", 6.5, "PSA", 9),
    row("2026-06-19T02:32:00.000Z", 6.5, null, null),
    row("2026-06-22T02:16:00.000Z", 1.34, "PSA", 8),
    row("2026-08-19T03:19:17.000Z", 1.04, null, null),
    row("2026-08-27T21:35:21.000Z", 1.95, null, null),
  ];

  it("the stale $6.50 PSA 9 reprices to ~$1.97 — the card's own current level, scaled to PSA 9", async () => {
    const u = await price({ company: "PSA", value: 9 }, MACHADO);
    expect(u.rungLabel).toBe("exact-pool-grade-index");
    expect(u.marketValue).toBeCloseTo(1.97, 1);
    // Before: R25 served the 86-day-old sale unchanged.
    expect(u.marketValue).not.toBe(6.5);
  });

  it("PSA 8 and Raw of the same card come off the SAME index, differing only by multiplier", async () => {
    const psa8 = await price({ company: "PSA", value: 8 }, MACHADO);
    const raw = await price(null, MACHADO);
    expect(psa8.rungLabel).toBe("exact-pool-grade-index");
    expect(raw.rungLabel).toBe("exact-pool-grade-index");
    expect(psa8.marketValue! / raw.marketValue!).toBeCloseTo(1.09, 2);
  });
});

describe("CF-EXACT-POOL-GRADE-INDEX — the rung defers where an older ruling already answered", () => {
  const OWNER = "user-199fcbc9";
  const selfRow = (soldAt: string, price: number, company: string | null, value: number | null) =>
    row(soldAt, price, company, value, { source: "ebay-user-purchase", contributorUserId: OWNER });

  // The Verlander shape (holding bba3b7ad): the tier's ONLY sale is the
  // owner's own $251 purchase, kept by the self-comp thin-pool reprieve.
  const VERLANDER = [
    selfRow("2026-08-08T00:00:00.000Z", 251, "PSA", 10),
    row("2026-09-02T00:00:00.000Z", 20, null, null),
    row("2026-09-02T00:00:00.000Z", 30.68, null, null),
    row("2026-08-26T00:00:00.000Z", 199.99, null, null),
    row("2026-08-21T00:00:00.000Z", 22.5, "BGS", 9),
  ];

  it("a tier whose only evidence is a contributed self-comp KEEPS it — the index does not overrule a real purchase", async () => {
    const u = await price({ company: "PSA", value: 10 }, VERLANDER);
    // The owner's own trade of this exact card at this exact grade stands,
    // published labelled, as CF-SELF-COMP-THIN-POOL ruled. The index over a
    // $20-$200 raw pool would have said ~$89 — within a few dollars of the
    // $96.34 grade-curve estimate that reprieve was written to prevent.
    expect(u.rungLabel).toBe("exact-pool-last-sale");
    expect(u.marketValue).toBe(251);
  });

  it("and it defers the same way for the OWNER and the PUBLIC — one card, one number", async () => {
    h.rows = VERLANDER as typeof h.rows;
    const asOwner = await computeUnifiedPrice(WITT, {
      hobbyiqCardId: WITT, grade: { company: "PSA", value: 10 },
      excludeContributorUserId: OWNER, perTierWindows: true, asOfMs: NOW,
    });
    h.rows = VERLANDER as typeof h.rows;
    const asPublic = await computeUnifiedPrice(WITT, {
      hobbyiqCardId: WITT, grade: { company: "PSA", value: 10 },
      perTierWindows: true, asOfMs: NOW,
    });
    // The deferral is decided by the ROWS, not by who asked. Keyed off the
    // caller's userId instead, these two would differ — two valuation paths.
    expect(asOwner.marketValue).toBe(asPublic.marketValue);
    expect(asOwner.rungLabel).toBe(asPublic.rungLabel);
  });

  it("but ONE independent sale in the tier makes it thin-not-self-anchored, and the index prices it", async () => {
    const u = await price({ company: "PSA", value: 10 }, [
      ...VERLANDER,
      row("2026-09-01T00:00:00.000Z", 240, "PSA", 10),   // an open-market sale
    ]);
    expect(u.rungLabel).toBe("exact-pool-grade-index");
  });
});

describe("CF-EXACT-POOL-GRADE-INDEX — the wire shape is unchanged", () => {
  it("no new required field: every pre-existing entry key is still present and typed as before", async () => {
    const u = await price({ company: "SGC", value: 9 }, WITT_SIX_PLUS_SGC9);
    const tier = u.gradeCurve.find((e) => e.grade === "SGC 9")!;

    for (const k of ["grade", "gradeCompany", "gradeValue", "weightedMedian", "plainMedian",
      "sampleCount", "p10", "p90", "newestSaleDate", "valueSource", "confidence",
      "predictedPrice", "trendPctPerWeek", "trendDirection", "marketValue",
      "rungLabel", "projectionNote", "windowNote", "sales"]) {
      expect(Object.keys(tier)).toContain(k);
    }
    expect(tier.valueSource).toBe("observed");
    expect(typeof tier.confidence).toBe("number");
    expect(Array.isArray(tier.sales)).toBe(true);
  });

  it("the new fields are ABSENT-as-null on every other rung, so no consumer must branch on the rung to read them", async () => {
    const u = await price(null, [
      row("2026-09-05T00:00:00.000Z", 950, null, null),
      row("2026-08-10T00:00:00.000Z", 780, null, null),
    ]);
    const raw = u.gradeCurve.find((e) => e.grade === "Raw")!;
    expect(raw.rungLabel).toBe("exact-pool-last-sale");
    expect(raw.gradeIndexMeta ?? null).toBeNull();
    expect(raw.compsUsed ?? null).toBeNull();
  });

  it("the rung is in the closed vocabulary, in all of its statements", async () => {
    const { FMV_RUNG_LABELS } = await import("../src/services/compiq/fmvRung.js");
    expect(FMV_RUNG_LABELS).toContain("exact-pool-grade-index");
    expect(isExactPoolRung("exact-pool-grade-index")).toBe(true);

    // The persist gate accepts it by asking the vocabulary, not a list.
    const { isPricingRung } = await import("../src/services/compiq/fmvRung.js");
    expect(isPricingRung("exact-pool-grade-index")).toBe(true);

    // The pool-migration gate treats it as an own-pool rung (prefix rule).
    const { shouldGateRung } = await import("../src/services/compiq/poolMigrationGate.js");
    expect(shouldGateRung("exact-pool-grade-index")).toBe(true);
  });
});
