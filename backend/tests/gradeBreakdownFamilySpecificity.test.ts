// CF-FAMILY-FROM-THE-MOST-SPECIFIC-NAME (2026-09-01).
//
// computeGradeBreakdownSingleScan resolved its calibration family from the
// slug's setKey — the LEAST specific of the answers available to it — and the
// setKey is a normalized bucket that cannot express a sub-product.
//
// Justin Verlander's 2005 Bowman Chrome Draft Picks & Prospects BDP129 slugs
// to setKey `bowman-chrome`, so the ladder asked for "bowman-chrome" while the
// product's own NAME resolves to "bowman-chrome-draft" — a family that exists
// in the calibration table with its own, better, PSA 10 cell:
//
//     bowman-chrome-draft  PSA 10 = 5.23   (from the setName)
//     bowman-chrome        PSA 10 = 4.43   (from the setKey)
//     company-level               3.14     (what it actually used)
//
// The fix asks the setName's family FIRST and falls back to the setKey's, so
// the most specific ANSWERED family wins. The fallback is not optional: a
// specific family with no cell for the requested tier must not shadow a
// general one that has it, or specificity would cost coverage — the exact
// trade CF-A-THIN-SPECIFIC-CELL-IS-WORSE-THAN-A-COARSE-ONE refuses.
//
// These tests drive the REAL computeGradeBreakdownSingleScan (Cosmos mocked)
// and read the answer off the PROJECTED tiers, whose values are
// rawAnchor x the multiplier the family lookup returned. They pin the
// SELECTION; the multipliers themselves are mocked so the weekly Grade
// Calibration Refresh can never turn them red.

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Stand-in calibration: only these (family, tier) pairs are populated. */
const TABLE: Record<string, Record<string, number>> = {
  "bowman-chrome-draft": { "10": 5.23 },            // specific, has PSA 10 only
  "bowman-chrome": { "10": 4.43, "9": 1.68 },       // general, has 10 AND 9
  "topps-gold-label": {},                            // specific, EMPTY (too thin to ship)
  topps: { "9": 2.94, "10": 8.5 },                   // general, populated
};

const askedFamilies: string[] = [];

vi.mock("../src/services/compiq/canonicalFmv.service.js", () => ({
  empiricalGradeMultiplier: (
    _company: string | null,
    value: number | null,
    family: string | null,
    _sport?: string | null,
  ) => {
    askedFamilies.push(String(family));
    if (!family || value === null) return null;
    return TABLE[family]?.[String(value)] ?? null;
  },
}));

vi.mock("../src/services/compiq/gradeCalibrationConfig.js", () => ({
  classifyFamily: (setName: string | null | undefined) => {
    const s = String(setName ?? "").toLowerCase().replace(/[-_]+/g, " ");
    if (s.includes("bowman chrome draft") || s.includes("bowman draft chrome")) return "bowman-chrome-draft";
    if (s.includes("bowman chrome")) return "bowman-chrome";
    if (s.includes("gold label")) return "topps-gold-label";
    if (s.includes("topps")) return "topps";
    return "other";
  },
}));

/** Three raw sales, no graded ones — so every graded tier is PROJECTED from
 *  the raw anchor, and its value is anchor x whichever multiplier won. */
const RAW_ROWS = [
  { price: 100, soldAt: "2026-08-22T00:00:00.000Z", source: "tca-ebay", gradeCompany: null, gradeValue: null, qualityFlags: [] },
  { price: 100, soldAt: "2026-08-20T00:00:00.000Z", source: "tca-ebay", gradeCompany: null, gradeValue: null, qualityFlags: [] },
  { price: 100, soldAt: "2026-08-18T00:00:00.000Z", source: "tca-ebay", gradeCompany: null, gradeValue: null, qualityFlags: [] },
];

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    database() {
      return {
        container: () => ({
          items: { query: () => ({ fetchAll: async () => ({ resources: RAW_ROWS }) }) },
        }),
      };
    }
  },
}));

async function breakdown(slug: string, setName?: string | null) {
  const mod = await import("../src/services/portfolioiq/hobbyIqFmv.service.js");
  // Clear AFTER the import so module-load lookups never land in the log.
  askedFamilies.length = 0;
  return mod.computeGradeBreakdownSingleScan(slug, { setName: setName ?? null });
}

const tierValue = (r: { tiers: Array<{ gradeLabel: string; fmv: number }> }, label: string) =>
  r.tiers.find((t) => t.gradeLabel === label)?.fmv ?? null;

const VERLANDER = "hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto";

describe("grade-breakdown family specificity", () => {
  beforeEach(() => {
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=y==;";
    askedFamilies.length = 0;
    vi.resetModules();
  });

  it("the three-multiplier case selects the MOST specific family that answers", async () => {
    // Verlander: three answers were available and the least specific won.
    const r = await breakdown(VERLANDER, "2005 Bowman Chrome Draft Picks & Prospects");
    // raw anchor 100 x bowman-chrome-draft PSA 10 (5.23)
    expect(tierValue(r, "PSA 10")).toBe(523);
    expect(askedFamilies).toContain("bowman-chrome-draft");
  });

  it("MUTATION GUARD: reading only the setKey would price PSA 10 at 443", async () => {
    // With no setName the function has only the setKey — this is exactly the
    // pre-fix behaviour, and it is a DIFFERENT number. If someone reverts the
    // call site to classifyFamily(seg[3]), the test above flips to this value.
    const r = await breakdown(VERLANDER);
    expect(tierValue(r, "PSA 10")).toBe(443);
    expect(askedFamilies).not.toContain("bowman-chrome-draft");
  });

  it("falls back to the setKey family when the specific one has no cell for the tier", async () => {
    // bowman-chrome-draft has PSA 10 but NOT PSA 9. Specificity must not cost
    // coverage: the general family's 1.68 is the right answer here.
    const r = await breakdown(VERLANDER, "2005 Bowman Chrome Draft Picks & Prospects");
    expect(tierValue(r, "PSA 9")).toBe(168);
    // It asked the specific family first, and only then the general one.
    expect(askedFamilies.indexOf("bowman-chrome-draft")).toBeLessThan(askedFamilies.indexOf("bowman-chrome"));
  });

  it("an entirely uncalibrated specific family never shadows a calibrated general one", async () => {
    // topps-gold-label is deliberately EMPTY (see
    // CF-A-THIN-SPECIFIC-CELL-IS-WORSE-THAN-A-COARSE-ONE). Judge must still
    // get a number rather than a hole in the ladder.
    const r = await breakdown("hiq:baseball:2017:topps:86:class-1-blue:no-auto", "2017 Topps Gold Label");
    expect(askedFamilies).toContain("topps-gold-label");
    expect(tierValue(r, "PSA 9")).toBe(294);
  });

  it("setName and setKey agreeing asks one family, not two", async () => {
    const r = await breakdown(VERLANDER, "Bowman Chrome");
    expect(tierValue(r, "PSA 10")).toBe(443);
    expect(askedFamilies).not.toContain("bowman-chrome-draft");
  });
});
