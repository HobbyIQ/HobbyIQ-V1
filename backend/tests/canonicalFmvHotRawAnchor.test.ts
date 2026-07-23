// CF-HOT-RAW-SAME-CARD-ANCHOR (Drew, 2026-07-22, issue #690).
// Pins the hot-Raw same-card anchor rung in canonicalFmv.service:
//   - Happy path (fresh Raw × 2+, calibrated family, low dispersion)
//     → returns method="hot-raw-same-card-anchor", confidence ≤ 0.5
//   - 4 reject conditions must fall through to no-basis:
//       * stale (all Raw > 30d old)
//       * single-sample (only 1 Raw in 60d)
//       * uncalibrated family (no ratio for family+grader)
//       * high dispersion (CoV > 0.6)
//   - Guardrails: raw request → direct-comp handles it; graded request
//     with direct comps → direct-comp handles it (rung is bypassed).

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock everything the canonicalFmv service reads.
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", () => ({
  readCompsByCardId: vi.fn(async () => []),
  readCompsByIdentity: vi.fn(async () => []),
  recordSoldComp: vi.fn(async () => undefined),
  inferSportFromContext: vi.fn(() => "baseball"),
}));

vi.mock("../src/services/compiq/playerInSetMomentum.service.js", () => ({
  fetchPlayerInSetMomentum: vi.fn(async () => null),
  momentumMultiplierToPctPerMonth: vi.fn(() => 0),
}));

vi.mock("../src/services/compiq/neighborMultipliers.js", () => ({
  lookupParallelMultiplier: vi.fn(() => 1),
}));

vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheDel: vi.fn(async () => undefined),
  cacheWrap: vi.fn(async (_key, factory) => factory()),
}));

vi.mock("../src/services/compiq/guestimatePricing.js", () => ({
  computeGuestimate: vi.fn(() => null),
}));

vi.mock("../src/services/ebay/ebayListingSearch.service.js", () => ({
  fetchCardActiveListings: vi.fn(async () => []),
}));

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    database() { return { container: () => null }; }
  },
}));

// Calibration data — will be swapped per-test via vi.doMock. Default
// value-band baseline is empty so tests fall through to the hardcoded
// value-tier cap. Override the third arg to test empirical band behavior.
function loadCanonicalFmv(
  calibration: unknown,
  bySport: unknown = {},
  valueBandBaseline: unknown = {},
) {
  vi.resetModules();
  vi.doMock("../src/services/compiq/gradeCalibrationData.js", () => ({
    GRADE_CALIBRATION: calibration,
    GRADE_CALIBRATION_BY_SPORT: bySport,
    GRADE_MULTIPLIER_BY_VALUE_BAND: { baseline: valueBandBaseline },
  }));
  return import("../src/services/compiq/canonicalFmv.service.js");
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** Install a filter-aware readCompsByCardId mock. Returns `rawPool` when
 *  the caller asks for Raw (gradeCompany=null,gradeValue=null); returns
 *  `gradedPool` when the caller asks for any graded combo. This matches
 *  the shape of readCompsByCardId's grade filter so tryDirectComp gets
 *  what it should on the graded read but the hot-Raw rung sees the Raw
 *  pool. */
async function installReadCompsMock(rawPool: unknown[], gradedPool: unknown[] = []) {
  const { readCompsByCardId } = await import("../src/services/portfolioiq/soldCompsStore.service.js");
  vi.mocked(readCompsByCardId).mockImplementation(async (args: {
    gradeCompany?: string | null;
    gradeValue?: number | null;
  }) => {
    const wantsRaw = (args.gradeCompany ?? null) === null && (args.gradeValue ?? null) === null;
    return (wantsRaw ? rawPool : gradedPool) as never;
  });
}

// Baseline calibration fixture — bowman-chrome-draft with byTier PSA 10 = 4.0×.
const CALIB_HAPPY = {
  "bowman-chrome-draft": {
    PSA: {
      medianRatio: 3.5, p25: 2, p75: 5, sampleSize: 100,
      byTier: { "10": { medianRatio: 4.0, sampleSize: 60 } },
    },
  },
};

// Fixture without byTier — forces the company × subtier fallback path.
const CALIB_COMPANY_ONLY = {
  "bowman-chrome-draft": {
    PSA: { medianRatio: 3.5, p25: 2, p75: 5, sampleSize: 100 },
  },
};

// Fixture with no family match at all — no multiplier available.
const CALIB_UNCOVERED: Record<string, never> = {};

const HARTMAN_INPUT_PSA_10 = {
  cardId: "1778542131154x443622612761809900",
  parallel: "Orange Shimmer Refractor",
  gradeCompany: "PSA",
  gradeValue: 10,
  cardYear: 2026,
  product: "2026 Bowman Draft Chrome",   // classifies → "bowman-chrome-draft"
  player: "Eric Hartman",
  cardNumber: "CPA-EH",
};

function rawComp(price: number, ageDays: number) {
  return {
    cardId: HARTMAN_INPUT_PSA_10.cardId,
    price,
    soldAt: daysAgo(ageDays),
    source: "cardhedge",
    parallel: "Orange Shimmer Refractor",
    gradeCompany: null,
    gradeValue: null,
  };
}

describe("hot-Raw same-card anchor — happy path", () => {
  beforeEach(() => vi.resetModules());

  it("2 fresh Raw same-card comps + calibrated byTier → hot-raw-same-card-anchor", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_HAPPY);
    await installReadCompsMock([rawComp(1185, 15), rawComp(1531, 8)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("hot-raw-same-card-anchor");
    expect(result.fmv).not.toBeNull();
    // Raw > $500 → value-tier ceiling of 2.5 caps the 4.0 byTier ratio.
    // Trend cap holds Raw anchor at newest × 1.15 = ~$1,760.
    // FMV ≈ $1,760 × 2.5 ≈ $4,400.
    expect(result.fmv!).toBeGreaterThan(3500);
    expect(result.fmv!).toBeLessThan(5000);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
    expect(result.provenance.summary).toContain("hot-Raw anchor");
    expect(result.provenance.multipliers.gradeMultiplier).toBe(2.5);        // capped
    expect(result.provenance.multipliers.gradeMultiplierUncapped).toBe(4.0);
    expect(result.provenance.multipliers.multiplierCapFired).toBe(1);
  });

  it("byTier absent → falls back to company × subTierScaling", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_COMPANY_ONLY);
    await installReadCompsMock([rawComp(1000, 20), rawComp(1100, 10)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("hot-raw-same-card-anchor");
    // Company ratio 3.5 × subTierScaling(10) = 1.0 → 3.5 uncapped.
    // Raw > $500 → value-tier ceiling of 2.5 for PSA 10.
    expect(result.provenance.multipliers.gradeMultiplierUncapped).toBeCloseTo(3.5, 2);
    expect(result.provenance.multipliers.gradeMultiplier).toBe(2.5);
    expect(result.provenance.summary).toContain("company × subtier");
  });
});

describe("hot-Raw same-card anchor — conservative-projection caps", () => {
  beforeEach(() => vi.resetModules());

  it("trend cap: rawAnchor never exceeds newest × 1.15", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_HAPPY);
    await installReadCompsMock([rawComp(500, 20), rawComp(800, 12), rawComp(1500, 3)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("hot-raw-same-card-anchor");
    // Whether or not the regression itself extrapolated above 1725, the
    // cap invariant holds: rawAnchor MUST NOT exceed newest × 1.15.
    expect(result.provenance.multipliers.rawAnchor).toBeLessThanOrEqual(1500 * 1.15 + 0.01);
  });

  it("value-tier cap PSA 10: Raw > $500 caps multiplier at 2.5×", async () => {
    // Fixture with abusive byTier 8.0× — cap must clamp to 2.5.
    const abusive = {
      "bowman-chrome-draft": {
        PSA: { medianRatio: 5, p25: 3, p75: 8, sampleSize: 50,
               byTier: { "10": { medianRatio: 8.0, sampleSize: 30 } } },
      },
    };
    const { computeCanonicalFmv } = await loadCanonicalFmv(abusive);
    await installReadCompsMock([rawComp(800, 15), rawComp(900, 5)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.provenance.multipliers.gradeMultiplier).toBe(2.5);
    expect(result.provenance.multipliers.multiplierCapFired).toBe(1);
  });

  it("value-tier cap PSA 10: Raw $50-$500 caps multiplier at 4.0×", async () => {
    const abusive = {
      "bowman-chrome-draft": {
        PSA: { medianRatio: 5, p25: 3, p75: 8, sampleSize: 50,
               byTier: { "10": { medianRatio: 8.0, sampleSize: 30 } } },
      },
    };
    const { computeCanonicalFmv } = await loadCanonicalFmv(abusive);
    await installReadCompsMock([rawComp(200, 15), rawComp(220, 5)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.provenance.multipliers.gradeMultiplier).toBe(4.0);
    expect(result.provenance.multipliers.multiplierCapFired).toBe(1);
  });

  it("value-tier cap PSA 10: Raw ≤ $50 lets byTier through unchanged", async () => {
    const cheap = {
      "bowman-chrome-draft": {
        PSA: { medianRatio: 5, p25: 3, p75: 8, sampleSize: 50,
               byTier: { "10": { medianRatio: 8.0, sampleSize: 30 } } },
      },
    };
    const { computeCanonicalFmv } = await loadCanonicalFmv(cheap);
    await installReadCompsMock([rawComp(10, 15), rawComp(12, 5)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.provenance.multipliers.gradeMultiplier).toBe(8.0);
    expect(result.provenance.multipliers.multiplierCapFired).toBe(0);
  });

  it("empirical value-band takes precedence over hardcoded value-tier cap when populated", async () => {
    // Real prod fixture shape + populated value-band for the $1,000-2,499 bucket.
    // The empirical PSA 10 = 2.4× should be preferred over the hardcoded 2.5× cap.
    const realBowman = {
      "bowman-chrome-draft": {
        PSA: { medianRatio: 4.07, p25: 2.28, p75: 8.66, sampleSize: 2065,
               byTier: { "10": { medianRatio: 5.30, sampleSize: 800 } } },
      },
    };
    const empiricalBand = {
      "$1,000-2,499": {
        "PSA 10": { medianRatio: 2.4, p25: 1.9, p75: 3.1, sampleSize: 187, rawMedian: 1450, gradedMedian: 3500 },
      },
    };
    const { computeCanonicalFmv } = await loadCanonicalFmv(realBowman, {}, empiricalBand);
    await installReadCompsMock([
      rawComp(1185, 28), rawComp(1250, 20), rawComp(1400, 12),
      rawComp(1450, 6),  rawComp(1531, 3),
    ]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("hot-raw-same-card-anchor");
    // Empirical 2.4× (band) preferred over hardcoded 2.5× cap.
    expect(result.provenance.multipliers.gradeMultiplier).toBe(2.4);
    expect(result.provenance.multipliers.calibrationBand).toBe(1);   // empirical fired
  });

  it("Hartman-shape parity: 5 Raw $1,185-1,531 hot trend + 5.30× byTier → $3,500-$5,000", async () => {
    // Real prod fixture shape. Trend-uncapped Raw ≈ $3,450 (regression on
    // hot slope); Raw > $500 → 2.5× cap on PSA 10; trend cap → $1,761;
    // final ≈ $4,400. Must land in Drew's actionable range.
    const realBowman = {
      "bowman-chrome-draft": {
        PSA: { medianRatio: 4.07, p25: 2.28, p75: 8.66, sampleSize: 2065,
               byTier: { "10": { medianRatio: 5.30, sampleSize: 800 } } },
      },
    };
    const { computeCanonicalFmv } = await loadCanonicalFmv(realBowman);
    await installReadCompsMock([
      rawComp(1185, 28), rawComp(1250, 20), rawComp(1400, 12),
      rawComp(1450, 6),  rawComp(1531, 3),
    ]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("hot-raw-same-card-anchor");
    // The cap invariant guarantees FMV ≤ newest × 1.15 × 2.5 = ~$4,401.
    expect(result.fmv!).toBeLessThan(5000);
    expect(result.fmv!).toBeGreaterThan(3000);
    // At minimum the multiplier cap must have fired (empirical 5.30 >> 2.5).
    expect(result.provenance.multipliers.multiplierCapFired).toBe(1);
    expect(result.provenance.multipliers.gradeMultiplier).toBe(2.5);
  });
});

describe("hot-Raw same-card anchor — reject conditions fall through to no-basis", () => {
  beforeEach(() => vi.resetModules());

  it("stale: all Raw sales > 30 days old → no-basis", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_HAPPY);
    await installReadCompsMock([rawComp(1000, 45), rawComp(1100, 50)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBeNull();
  });

  it("single-sample: only 1 Raw sale in 60d → no-basis", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_HAPPY);
    await installReadCompsMock([rawComp(1200, 10)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBeNull();
  });

  it("uncalibrated family: no calibration data for family+grader → no-basis", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_UNCOVERED);
    await installReadCompsMock([rawComp(1000, 15), rawComp(1100, 5)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBeNull();
  });

  it("high dispersion: CoV > 0.6 → no-basis (market undecided)", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_HAPPY);
    // $100 vs $2000: CoV ≈ 0.9 → rejected.
    await installReadCompsMock([rawComp(100, 15), rawComp(2000, 5)]);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBeNull();
  });
});

describe("hot-Raw same-card anchor — guardrails", () => {
  beforeEach(() => vi.resetModules());

  it("raw request (no grade) → direct-comp handles it, this rung does not fire", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_HAPPY);
    await installReadCompsMock([rawComp(1200, 10), rawComp(1300, 5)]);
    const rawRequest = { ...HARTMAN_INPUT_PSA_10, gradeCompany: null, gradeValue: null };
    const result = await computeCanonicalFmv(rawRequest);
    expect(result.method).toBe("direct-comp");
  });

  it("graded request with direct PSA 10 comps → direct-comp wins over hot-raw", async () => {
    const { computeCanonicalFmv } = await loadCanonicalFmv(CALIB_HAPPY);
    const psa10 = [
      { cardId: HARTMAN_INPUT_PSA_10.cardId, price: 5000, soldAt: daysAgo(5), source: "manual-user-entry", parallel: "Orange Shimmer Refractor", gradeCompany: "PSA", gradeValue: 10 },
      { cardId: HARTMAN_INPUT_PSA_10.cardId, price: 5500, soldAt: daysAgo(2), source: "manual-user-entry", parallel: "Orange Shimmer Refractor", gradeCompany: "PSA", gradeValue: 10 },
    ];
    await installReadCompsMock([rawComp(1000, 15), rawComp(1100, 5)], psa10);
    const result = await computeCanonicalFmv(HARTMAN_INPUT_PSA_10);
    expect(result.method).toBe("direct-comp");
  });
});
