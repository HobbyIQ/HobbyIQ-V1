// CF-GRADED-POOL-INVERSE (Drew, 2026-08-31) — the graded→raw rung.
//
// Drew's ruling, stated generally on the Figueroa Red Ink: "we should be able
// to price from graded cards to raw if it is unavailable with empirical data."
//
// The rung: when an identity's RAW pool is empty but its OWN graded children
// hold sales, the raw is that tier's PROJECTION ÷ the empirical
// GRADE_CALIBRATION multiplier for (family, sport, tier) — the exact inverse
// of the raw→graded direction, on the same tables, never a hardcoded or
// vendor-keyed number.
//
// Placement: BELOW exact-pool-projection (an observed raw pool always wins),
// ABOVE any cross-card sibling estimate (the gated ladder is never reached
// while this identity's own graded sales can answer). Same identity ONLY.
//
// The Cosmos read is mocked at the engine's own seam (exactPoolReader) so the
// REAL engine prices the fixture, exactly as oneValuationPath.test.ts does.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
  ladder: null as null | ((input: Record<string, unknown>) => unknown),
  ladderCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; hobbyiqCardIds?: readonly string[] | null; windowDays: number; nowMs?: number }) => {
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    const keys = new Set([input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])].filter(Boolean));
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || keys.has(r.hobbyiqCardId as string))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/catalog/catalogIdentityResolver.js")>();
  return { ...actual, resolveIdentityToCatalogRow: vi.fn(async (slug: string) => actual.pickCatalogRow(slug, [...h.catalog.keys()])) };
});
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    catalogSlugIfExists: vi.fn(async (slug: string) => (h.catalog.has(slug) ? slug : null)),
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => h.catalog.get(slug) ?? null),
    lookupCatalogPlayerName: vi.fn(async () => null),
  };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, lookupHobbyIqCardIdForVendorCardId: vi.fn(async (id: string) => (id.startsWith("hiq:") ? id : null)) };
});
vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/portfolioiq/hobbyIqFmv.service.js")>();
  return {
    ...actual,
    computeHobbyIqFmv: vi.fn(async (input: Record<string, unknown>) => {
      h.ladderCalls.push(input);
      return h.ladder
        ? h.ladder(input)
        : {
            slug: String(input.hobbyiqCardId ?? ""), fmv: null, method: "no-basis", rungLabel: "no-basis",
            compCount: 0, confidence: 0, basisNote: "", recentComps: [], min: null, max: null,
            breakdown: { bySource: {}, byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 }, byGradeQualifier: {} },
            trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
            population: null, quality: { score: 0, flaggedCompCount: 0, sources: [] },
            computedAt: new Date().toISOString(), cachedFrom: "sold_comps",
          };
    }),
  };
});
delete process.env.COSMOS_CONNECTION_STRING;

import { valueIdentity } from "../src/services/compiq/oneValuationPath.service.js";
import { gradeCurveEntryLabel } from "../src/services/compiq/gradeCurveEntry.js";
import { isExactPoolRung } from "../src/services/compiq/fmvRung.js";
import { empiricalGradeMultiplier } from "../src/services/compiq/canonicalFmv.service.js";
import { gradedPoolInverseAnchor } from "../src/services/compiq/observedGradeCurve.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// A bowman-chrome baseball identity: the family has real empirical
// GRADE_CALIBRATION coverage, so the rung has a denominator to divide by.
const SLUG = "hiq:baseball:2018:bowman-chrome:49:gold-refractor:no-auto:num-50";
// The Devin Taylor Black auto (#1601's card): no graded children either, so
// the rung must refuse — there is nothing of THIS card to invert.
const BLACK_AUTO = "hiq:baseball:2025:bowman-chrome:cpa-dt:black-refractor:auto";

const identityRow = (over: Record<string, unknown> = {}) => ({
  playerName: "Test Player", year: 2018, setKey: "bowman-chrome", setName: "2018 Bowman Chrome",
  cardNumber: "49", parallel: "Gold Refractor", isAuto: false, sport: "baseball", printRun: 50,
  ...over,
});
const sale = (slug: string, price: number, d: number, g: { c: string; v: number } | null = null) => ({
  cardId: "vendor-row", hobbyiqCardId: slug, price, soldAt: daysAgo(d),
  gradeCompany: g?.c ?? null, gradeValue: g?.v ?? null, source: "tca-ebay",
});

beforeEach(() => { h.rows = []; h.catalog = new Map(); h.ladder = null; h.ladderCalls = []; });

describe("CF-GRADED-POOL-INVERSE — graded children price the raw", () => {
  it("empty raw pool + a PSA 10 child pool: raw = the tier's projection ÷ the empirical multiplier", async () => {
    h.catalog.set(SLUG, identityRow());
    h.rows = [
      sale(SLUG, 900, 20, { c: "PSA", v: 10 }),
      sale(SLUG, 950, 10, { c: "PSA", v: 10 }),
      sale(SLUG, 920, 5, { c: "PSA", v: 10 }),
    ];
    const v = await valueIdentity({ id: SLUG });   // Raw requested

    expect(v.rungLabel).toBe("graded-pool-inverse");
    expect(v.valueSource).toBe("estimated");
    expect(v.reason).toBeNull();
    expect(v.fairMarketValue).toBeGreaterThan(0);

    // The number IS projection ÷ multiplier, on the same table the raw→graded
    // direction reads. Nothing hardcoded, nothing vendor-keyed.
    const mult = empiricalGradeMultiplier("PSA", 10, "bowman-chrome", "baseball")!;
    expect(mult).toBeGreaterThan(0);
    const psa10 = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 10")!;
    expect(psa10.valueSource).toBe("observed");
    const projected = psa10.trendAdjustedValue ?? psa10.value!;
    expect(v.fairMarketValue!).toBeCloseTo(Math.round((projected / mult) * 100) / 100, 2);

    // It is a fallback rung, not an exact-pool one — the digest must not
    // notify on it.
    expect(isExactPoolRung(v.rungLabel)).toBe(false);

    // The provenance is on the wire: which tier, how many sales, what ratio.
    expect(v.basis).toMatch(/own PSA 10 sales \(n=3/);
    expect(v.basis).toMatch(/÷ the empirical PSA 10 multiplier/);
    const raw = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "Raw")!;
    expect(raw.rungLabel).toBe("graded-pool-inverse");
    expect(raw.estimatedFrom).toBe("graded-pool-inverse");
    expect(raw.estimatedMultiplier).toBeCloseTo(mult, 5);

    // The observed graded tier is never rewritten by the inverse.
    expect(psa10.trendAdjustedValue).toBe(projected);

    // ABOVE any cross-card sibling estimate: the gated ladder is never asked
    // while this identity's own graded sales can answer.
    expect(h.ladderCalls).toEqual([]);
  });

  it("BELOW exact-pool-projection: an observed raw pool always wins, the rung never fires", async () => {
    h.catalog.set(SLUG, identityRow());
    h.rows = [
      ...Array.from({ length: 10 }, (_, i) => sale(SLUG, 100 + i * 4, 45 - i * 4)),
      sale(SLUG, 900, 20, { c: "PSA", v: 10 }),
      sale(SLUG, 950, 10, { c: "PSA", v: 10 }),
    ];
    const v = await valueIdentity({ id: SLUG });
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    expect(v.rungLabel).not.toBe("graded-pool-inverse");
    expect(v.valueSource).toBe("observed");
    expect(v.compsUsed).toBe(10);
  });

  it("picks the BEST-EVIDENCED tier, not the highest and not an average of tiers", async () => {
    h.catalog.set(SLUG, identityRow());
    // PSA 10 at n=3 against PSA 9 at n=1: the denser pool anchors.
    h.rows = [
      sale(SLUG, 900, 20, { c: "PSA", v: 10 }),
      sale(SLUG, 950, 10, { c: "PSA", v: 10 }),
      sale(SLUG, 920, 5, { c: "PSA", v: 10 }),
      sale(SLUG, 400, 8, { c: "PSA", v: 9 }),
    ];
    const v = await valueIdentity({ id: SLUG });
    expect(v.rungLabel).toBe("graded-pool-inverse");
    expect(v.basis).toMatch(/own PSA 10 sales \(n=3/);

    // Derived from PSA 10 alone — NOT the mean of the two tiers' implied raws.
    const m10 = empiricalGradeMultiplier("PSA", 10, "bowman-chrome", "baseball")!;
    const m9 = empiricalGradeMultiplier("PSA", 9, "bowman-chrome", "baseball")!;
    const psa10 = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 10")!;
    const psa9 = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 9")!;
    const from10 = (psa10.trendAdjustedValue ?? psa10.value!) / m10;
    const from9 = (psa9.trendAdjustedValue ?? psa9.value!) / m9;
    expect(v.fairMarketValue!).toBeCloseTo(Math.round(from10 * 100) / 100, 2);
    expect(v.fairMarketValue!).not.toBeCloseTo((from10 + from9) / 2, 2);
  });

  it("evidence, not grade rank: PSA 9 at n=3 anchors over PSA 10 at n=1", async () => {
    h.catalog.set(SLUG, identityRow());
    h.rows = [
      sale(SLUG, 400, 20, { c: "PSA", v: 9 }),
      sale(SLUG, 410, 10, { c: "PSA", v: 9 }),
      sale(SLUG, 405, 5, { c: "PSA", v: 9 }),
      sale(SLUG, 1500, 3, { c: "PSA", v: 10 }),
    ];
    const v = await valueIdentity({ id: SLUG });
    expect(v.rungLabel).toBe("graded-pool-inverse");
    // The basis names the tier that actually anchored it — the provenance is
    // honest even when the denser tier is not the highest grade.
    expect(v.basis).toMatch(/own PSA 9 sales \(n=3/);
    const m9 = empiricalGradeMultiplier("PSA", 9, "bowman-chrome", "baseball")!;
    const psa9 = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 9")!;
    expect(v.fairMarketValue!).toBeCloseTo(
      Math.round(((psa9.trendAdjustedValue ?? psa9.value!) / m9) * 100) / 100, 2,
    );
  });

  it("a single graded sale still prices the raw — n>=1 is the floor, as the ruling says", async () => {
    h.catalog.set(SLUG, identityRow());
    h.rows = [sale(SLUG, 940, 6, { c: "PSA", v: 10 })];
    const v = await valueIdentity({ id: SLUG });
    expect(v.rungLabel).toBe("graded-pool-inverse");
    expect(v.fairMarketValue).toBeGreaterThan(0);
    expect(v.basis).toMatch(/n=1/);
  });
});

describe("CF-GRADED-POOL-INVERSE — the guards", () => {
  it("the Devin Taylor Black auto still refuses: no raw pool AND no graded children", async () => {
    h.catalog.set(BLACK_AUTO, identityRow({
      year: 2025, cardNumber: "CPA-DT", parallel: "Black Refractor", isAuto: true,
      setName: "2025 Bowman Chrome", printRun: null, playerName: "Devin Taylor",
    }));
    h.rows = [];
    const v = await valueIdentity({ id: BLACK_AUTO });
    expect(v.fairMarketValue).toBeNull();
    expect(v.rungLabel).toBe("no-basis");
    expect(v.valueSource).toBe("unavailable");
    expect(v.reason).toBe("no-exact-pool");
    // Blank beats invented — nothing of this card at any grade to invert.
    expect(v.gradeCurve.every((e) => e.valueSource === "unavailable")).toBe(true);
  });

  it("no empirical multiplier for the tier: the rung does not fire", () => {
    // The anchor helper is the rung's decision point. With a ratio function
    // that has no empirical answer, it returns null rather than inventing one.
    const entries = [
      {
        grade: "PSA 10", grader: "PSA", sampleCount: 5, valueSource: "observed",
        value: 900, trendAdjustedValue: 900, newestSaleDate: daysAgo(3),
      },
    ] as unknown as Parameters<typeof gradedPoolInverseAnchor>[0];
    expect(gradedPoolInverseAnchor(entries, () => null)).toBeNull();
    // And with one, it fires and reports its provenance.
    const got = gradedPoolInverseAnchor(entries, () => 3);
    expect(got).not.toBeNull();
    expect(got!.rawValue).toBeCloseTo(300, 6);
    expect(got!.fromGrade).toBe("PSA 10");
    expect(got!.fromSampleCount).toBe(5);
    expect(got!.multiplier).toBe(3);
  });

  it("same identity only: a graded tier of ANOTHER card can never anchor this one", async () => {
    const OTHER = "hiq:baseball:2018:bowman-chrome:50:gold-refractor:no-auto:num-50";
    h.catalog.set(SLUG, identityRow());
    h.catalog.set(OTHER, identityRow({ cardNumber: "50" }));
    // Every graded sale belongs to the OTHER card number.
    h.rows = [
      sale(OTHER, 900, 20, { c: "PSA", v: 10 }),
      sale(OTHER, 950, 10, { c: "PSA", v: 10 }),
    ];
    const v = await valueIdentity({ id: SLUG });
    expect(v.rungLabel).not.toBe("graded-pool-inverse");
    expect(v.fairMarketValue).toBeNull();
    expect(v.reason).toBe("no-exact-pool");
  });

  it("a sub-raw inversion is observed, never clamped", async () => {
    h.catalog.set(SLUG, identityRow());
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
    try {
      // A tiny graded price with a large multiplier implies a raw ABOVE the
      // graded sale that produced it. The data says so; the engine reports it.
      h.rows = [sale(SLUG, 10, 5, { c: "PSA", v: 10 })];
      const v = await valueIdentity({ id: SLUG });
      expect(v.rungLabel).toBe("graded-pool-inverse");
      const psa10 = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 10")!;
      const graded = psa10.trendAdjustedValue ?? psa10.value!;
      // The raw is NOT floored to the graded value — no clamp.
      expect(v.fairMarketValue!).toBeLessThan(graded);
      expect(logs.some((l) => l.includes("graded_pool_inverse_priced"))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("a graded tier with no pool is still filled the OTHER way — the rung is raw-only", async () => {
    h.catalog.set(SLUG, identityRow());
    h.rows = Array.from({ length: 10 }, (_, i) => sale(SLUG, 100 + i * 4, 45 - i * 4));
    const v = await valueIdentity({ id: SLUG, grade: { company: "PSA", value: 10 } });
    // raw × ratio, the direction that already existed — not the inverse.
    expect(v.rungLabel).toBe("grade-curve-estimate");
    expect(v.basis).toMatch(/× the empirical PSA 10 ratio/);
  });
});
