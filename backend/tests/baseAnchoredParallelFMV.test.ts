// CF-BUILD-B (2026-06-21) — base-anchored parallel FMV unit tests.
//
// Locks the seven design choices from
// docs/build-b-off-sample-tier-handling.md:
//   §1+2  sampleBaseRange detection (strict-set min/max, boolean above-max)
//   §3    off-sample low-end (observed bucket vs flagged haircut)
//   §4    off-sample emission shape (distinct basis + tier-extrapolated flag)
//   §5    in-sample emission shape (relaxed-IQR band, no flag)
//   §6    provenance gate (empirical-only firing — the dormancy guarantee)
//   §7    schema fields (sampleBaseRange + topBaseBucketRatio optional)
//
// All tests use synthetic curated rows + synthetic comp pools. No live
// table mutation; no Cardsight HTTP.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeBaseAnchoredParallelFMV,
  ROUND_HAIRCUT_FRACTION,
  MIN_BASE_AUTO_COMPS,
  type BaseAnchoredFmvComp,
} from "../src/agents/baseAnchoredParallelFMV.js";
import type { BaseRelativePremium } from "../src/services/compiq/chromeDraftMultipliers.js";

// ─── Curated-row mocking shim ────────────────────────────────────────────

// Mock lookupBowmanFamilyEntry so we can synthesize rows per test rather
// than depending on the live table (which by design is empty of CF-BUILD-B
// fields at ship — dormancy guarantee).
vi.mock("../src/services/compiq/chromeDraftMultipliers.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    lookupBowmanFamilyEntry: vi.fn(),
  };
});

import { lookupBowmanFamilyEntry } from "../src/services/compiq/chromeDraftMultipliers.js";

const mockLookup = lookupBowmanFamilyEntry as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockLookup.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Fixtures ────────────────────────────────────────────────────────────

function syntheticBaseAutos(count: number, base: number): BaseAnchoredFmvComp[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `2026 Bowman Test Player Auto Base CPA-X #${i}`,
    price: base + i,
  }));
}

function syntheticPremium(opts: {
  value: number;
  range: [number, number];
  n: number;
  provenance: "empirical" | "sibling_provisional";
  sampleBaseRange?: [number, number];
  topBaseBucketRatio?: number | null;
}): BaseRelativePremium {
  return {
    value: opts.value,
    range: opts.range,
    n: opts.n,
    basis: "base_auto_paired",
    provenance: opts.provenance,
    calibratedAt: "2026-06-21T00:00:00Z",
    sampleBaseRange: opts.sampleBaseRange,
    topBaseBucketRatio: opts.topBaseBucketRatio,
  };
}

function mockRowWith(premium: BaseRelativePremium | undefined) {
  mockLookup.mockReturnValue({
    year: 2026, product: "Bowman", subset: "Chrome Prospect Autographs",
    parallelName: "Blue X-Fractor", printRun: "/150",
    baselineMultiplier: 1.6, range: { low: 1.08, high: 2.03 },
    directCompOnly: false, tierQualifier: null, isAutograph: true,
    provenance: "empirical",
    baseRelativePremium: premium,
  });
}

const SUBJECT = {
  playerName: "Eric Hartman",
  year: 2026,
  product: "Bowman" as const,
  subset: "Chrome Prospect Autographs" as const,
  parallelName: "Blue X-Fractor",
};

// ─── §6 — Provenance gate (the dormancy guarantee) ──────────────────────

describe("CF-BUILD-B §6 — provenance gate (dormancy)", () => {
  it("returns null when no curated row exists", () => {
    mockLookup.mockReturnValue(null);
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80),
    });
    expect(r.isEstimate).toBe(false);
    expect(r.internalReason).toBe("no-curated-row");
    expect(r.estimatedValue).toBeNull();
  });

  it("returns null when row carries no baseRelativePremium", () => {
    mockRowWith(undefined);
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80),
    });
    expect(r.isEstimate).toBe(false);
    expect(r.internalReason).toBe("no-curated-row");
  });

  it("returns null when provenance is sibling_provisional (BLOCKS Hartman's BXF/150 today)", () => {
    mockRowWith(syntheticPremium({
      value: 2.974, range: [2.214, 3.795], n: 9,
      provenance: "sibling_provisional", // ← the gate
      sampleBaseRange: [5, 61],
      topBaseBucketRatio: 3.119,
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80),
    });
    expect(r.isEstimate).toBe(false);
    expect(r.internalReason).toBe("provenance-not-empirical");
  });

  it("returns null when sampleBaseRange field is MISSING (back-compat with CF-CAT-ENGINE Track-a rows)", () => {
    mockRowWith(syntheticPremium({
      value: 2.974, range: [2.214, 3.795], n: 9,
      provenance: "empirical",
      sampleBaseRange: undefined, // ← Track-a row without the new field
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80),
    });
    expect(r.isEstimate).toBe(false);
    expect(r.internalReason).toBe("missing-sample-base-range");
  });
});

// ─── Gate 5: holding-side base-auto threshold ───────────────────────────

describe("CF-BUILD-B — holding-side base-auto threshold", () => {
  it(`returns null when holding has < ${MIN_BASE_AUTO_COMPS} base-auto comps`, () => {
    mockRowWith(syntheticPremium({
      value: 2.974, range: [2.214, 3.795], n: 9,
      provenance: "empirical",
      sampleBaseRange: [5, 61],
      topBaseBucketRatio: 3.119,
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(MIN_BASE_AUTO_COMPS - 1, 80),
    });
    expect(r.isEstimate).toBe(false);
    expect(r.internalReason).toBe("insufficient-base-autos");
    expect(r.baseAutoCount).toBe(MIN_BASE_AUTO_COMPS - 1);
  });

  it(`fires at exactly ${MIN_BASE_AUTO_COMPS} base autos`, () => {
    mockRowWith(syntheticPremium({
      value: 2.974, range: [2.214, 3.795], n: 9,
      provenance: "empirical",
      sampleBaseRange: [5, 200], // wide range — keeps the test in-sample
      topBaseBucketRatio: 3.119,
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(MIN_BASE_AUTO_COMPS, 80),
    });
    expect(r.isEstimate).toBe(true);
  });
});

// ─── §5 — In-sample emission ────────────────────────────────────────────

describe("CF-BUILD-B §5 — in-sample emission (relaxed-IQR band, no extrapolation)", () => {
  it("Hartman-like holding INSIDE sampleBaseRange → in-sample band, NO tier-extrapolated flag", () => {
    mockRowWith(syntheticPremium({
      value: 3.0,
      range: [2.0, 4.0],
      n: 9,
      provenance: "empirical",
      sampleBaseRange: [50, 100], // ← $80 holding sits inside
      topBaseBucketRatio: 2.5,
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80), // median ~$84.5
    });
    expect(r.isEstimate).toBe(true);
    expect(r.tierExtrapolated).toBe(false);
    expect(r.estimateBasis).toBe("base_anchored_paired_premium");
    expect(r.confidence).toBe("rough");
    expect(r.internalReason).toBe("fired-in-sample");
    expect(r.estimateLow).toBeCloseTo(r.baseAutoMedian! * 2.0, 1);
    expect(r.estimateHigh).toBeCloseTo(r.baseAutoMedian! * 4.0, 1);
    expect(r.estimatedValue).toBeCloseTo(r.baseAutoMedian! * 3.0, 1);
  });
});

// ─── §3+§4 — Off-sample emission ────────────────────────────────────────

describe("CF-BUILD-B §3+§4 — off-sample emission", () => {
  it("Hartman-like holding ABOVE sampleBaseRange[1] with observed topBaseBucketRatio → off-sample observed-bucket band", () => {
    mockRowWith(syntheticPremium({
      value: 2.974,
      range: [2.214, 3.795],
      n: 9,
      provenance: "empirical",
      sampleBaseRange: [5, 61], // Hartman $80 > $61 → off-sample
      topBaseBucketRatio: 2.0, // observed top-base-bucket = 2.0×
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80), // ~$84.5 median
    });
    expect(r.isEstimate).toBe(true);
    expect(r.tierExtrapolated).toBe(true);
    expect(r.estimateBasis).toBe("base_anchored_off_sample_paired_premium");
    expect(r.confidence).toBe("ballpark");
    expect(r.internalReason).toBe("fired-off-sample-observed-bucket");
    // Low end anchors on topBaseBucketRatio (2.0×), high end on flat premium (2.974×)
    expect(r.estimateLow).toBeCloseTo(r.baseAutoMedian! * 2.0, 1);
    expect(r.estimateHigh).toBeCloseTo(r.baseAutoMedian! * 2.974, 1);
    expect(r.estimatedValue).toBeCloseTo((r.estimateLow! + r.estimateHigh!) / 2, 1);
  });

  it("Off-sample with topBaseBucketRatio > flat premium (tier-INFLATE direction, the live BXF/150 case) → band uses min/max, not inverted", () => {
    // Real data from the first CF-CAT-ENGINE run on 2026 Bowman CPA:
    // BXF/150's top-base-bucket ratio (3.254×) came in ABOVE the flat
    // premium (2.974×). Drew's original spec assumed tier-shrink; the
    // data showed inflate for that scope. Build B handles both
    // directions via min/max so the band is never inverted.
    mockRowWith(syntheticPremium({
      value: 2.974,
      range: [2.214, 3.795],
      n: 9,
      provenance: "empirical",
      sampleBaseRange: [6.38, 56.5],   // strict-set base medians (real)
      topBaseBucketRatio: 3.254,        // > flat premium — the inflate case
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(64, 70), // Hartman shape, median ~$101
    });
    expect(r.isEstimate).toBe(true);
    expect(r.tierExtrapolated).toBe(true);
    expect(r.internalReason).toBe("fired-off-sample-observed-bucket");
    // Band: low = min(2.974, 3.254) × base; high = max(...) × base
    expect(r.estimateLow).toBeCloseTo(r.baseAutoMedian! * 2.974, 1);
    expect(r.estimateHigh).toBeCloseTo(r.baseAutoMedian! * 3.254, 1);
    // Anti-regression: estimateLow MUST be ≤ estimateHigh (no inverted band)
    expect(r.estimateLow!).toBeLessThanOrEqual(r.estimateHigh!);
  });

  it("Off-sample holding with topBaseBucketRatio=null → flagged round-haircut fallback", () => {
    mockRowWith(syntheticPremium({
      value: 3.0,
      range: [2.0, 4.0],
      n: 5, // ← n=5 floor tier
      provenance: "empirical",
      sampleBaseRange: [5, 50],
      topBaseBucketRatio: null, // ← top-bucket has <3 cards
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80),
    });
    expect(r.isEstimate).toBe(true);
    expect(r.tierExtrapolated).toBe(true);
    expect(r.internalReason).toBe("fired-off-sample-haircut-fallback");
    // Low end = 0.7 × flat-premium = 0.7 × 3.0 = 2.1
    expect(r.estimateLow).toBeCloseTo(r.baseAutoMedian! * ROUND_HAIRCUT_FRACTION * 3.0, 1);
    expect(r.estimateHigh).toBeCloseTo(r.baseAutoMedian! * 3.0, 1);
  });

  it("Off-sample holding with topBaseBucketRatio UNDEFINED → also falls to haircut path", () => {
    mockRowWith(syntheticPremium({
      value: 3.0,
      range: [2.0, 4.0],
      n: 5,
      provenance: "empirical",
      sampleBaseRange: [5, 50],
      topBaseBucketRatio: undefined,
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(10, 80),
    });
    expect(r.isEstimate).toBe(true);
    expect(r.internalReason).toBe("fired-off-sample-haircut-fallback");
  });
});

// ─── §1+§2 — Detection boundary ─────────────────────────────────────────

describe("CF-BUILD-B §1+§2 — strict above-max boundary", () => {
  it("base exactly AT sampleBaseRange[1] → in-sample (boolean above-max, equality is in)", () => {
    mockRowWith(syntheticPremium({
      value: 3.0,
      range: [2.0, 4.0],
      n: 9,
      provenance: "empirical",
      sampleBaseRange: [50, 80], // exactly Hartman's median
      topBaseBucketRatio: 2.5,
    }));
    // Synthesize 1 base-auto comp at exactly $80 → median = $80
    // Plus 2 more at the same price so we clear MIN_BASE_AUTO_COMPS.
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: [
        { title: "Auto Base CPA-A", price: 80 },
        { title: "Auto Base CPA-A", price: 80 },
        { title: "Auto Base CPA-A", price: 80 },
      ],
    });
    expect(r.baseAutoMedian).toBe(80);
    expect(r.tierExtrapolated).toBe(false); // 80 > 80 is FALSE → in-sample
    expect(r.internalReason).toBe("fired-in-sample");
  });

  it("base just above sampleBaseRange[1] → off-sample", () => {
    mockRowWith(syntheticPremium({
      value: 3.0,
      range: [2.0, 4.0],
      n: 9,
      provenance: "empirical",
      sampleBaseRange: [50, 79], // $80 > $79 → off-sample
      topBaseBucketRatio: 2.5,
    }));
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: [
        { title: "Auto Base CPA-A", price: 80 },
        { title: "Auto Base CPA-A", price: 80 },
        { title: "Auto Base CPA-A", price: 80 },
      ],
    });
    expect(r.tierExtrapolated).toBe(true);
  });
});

// ─── Hartman dormancy assertion ─────────────────────────────────────────

describe("CF-BUILD-B — Hartman dormancy at ship", () => {
  it("Hartman holding TODAY (Blue X-Fractor /150 still sibling_provisional after CF-XMULT) → Build B returns null", () => {
    // This mocks the LIVE Blue X-Fractor /150 row shape that ships today:
    // CF-XMULT set Ref-axis value = 1.6 + provenance = sibling_provisional.
    // CF-CAT-ENGINE Track-a added the schema field but no row was populated.
    // Result: Build B can't fire on Hartman until the worksheet PR lands.
    mockLookup.mockReturnValue({
      year: 2026, product: "Bowman", subset: "Chrome Prospect Autographs",
      parallelName: "Blue X-Fractor", printRun: "/150",
      baselineMultiplier: 1.6, range: { low: 1.08, high: 2.03 },
      directCompOnly: false, tierQualifier: null, isAutograph: true,
      provenance: "sibling_provisional",
      // No baseRelativePremium populated (Track-a value-empty + worksheet not merged).
    });
    const r = computeBaseAnchoredParallelFMV({
      subject: SUBJECT,
      comps: syntheticBaseAutos(64, 70), // Hartman's actual ~64 base autos
    });
    expect(r.isEstimate).toBe(false);
    expect(r.internalReason).toBe("no-curated-row");
  });
});
