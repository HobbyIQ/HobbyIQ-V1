import { describe, it, expect } from "vitest";
import {
  computeTierAnchoredRange,
  type TierAnchoredPeerComp,
} from "../src/services/compiq/predictedRangeTierAnchored";
import type { Regime } from "../src/services/compiq/regimeClassifier";

// Issue #25 Phase 3 — tier-anchored predicted-range fallback tests.
// Pure function; no I/O.

function peer(price: number, tier: number): TierAnchoredPeerComp {
  return { price, tier };
}

// Reusable mid-quality peer pool for the Skenes-style worked example
// from the Phase 3 prompt. Base ~ $300 implied baseline.
//   Base (tier 1) at $300            → baseline 300
//   Refractor (tier 2) at $450       → baseline 300
//   Blue Refractor (tier 4) at $1200 → baseline 300
const SKENES_LIKE_POOL: TierAnchoredPeerComp[] = [
  peer(300, 1),
  peer(450, 2),
  peer(1200, 4),
];

describe("computeTierAnchoredRange — happy paths", () => {
  it("tier 1 subject anchors to the implied baseline itself", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 1,
      subjectRegime: "stable",
      peerPool: SKENES_LIKE_POOL,
    });
    expect(r.predictedRange).not.toBeNull();
    // midpoint = baseline 300 * mult 1.0 = 300
    expect(r.diagnostics.midpoint).toBe(300);
    // stable ±15%
    expect(r.predictedRange!.low).toBe(255);
    expect(r.predictedRange!.high).toBe(345);
    expect(r.source).toBe("tier-anchored");
    expect(r.diagnostics.spreadModel).toBe("stable");
  });

  it("tier 4 subject scales midpoint by 4.0 (Skenes Blue Refractor case)", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 4,
      subjectRegime: "stable",
      peerPool: SKENES_LIKE_POOL,
    });
    // midpoint = 300 * 4 = 1200 → stable spread 1020..1380
    expect(r.diagnostics.midpoint).toBe(1200);
    expect(r.predictedRange!.low).toBe(1020);
    expect(r.predictedRange!.high).toBe(1380);
  });

  it("tier 6 subject scales midpoint by 12.0 (Gold /50 case)", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 6,
      subjectRegime: "stable",
      peerPool: SKENES_LIKE_POOL,
    });
    expect(r.diagnostics.midpoint).toBe(3600);
    expect(r.predictedRange!.low).toBeCloseTo(3060, 2);
    expect(r.predictedRange!.high).toBeCloseTo(4140, 2);
  });

  it("tier 7 subject (Red /5) — large multiplier path", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 7,
      subjectRegime: "stable",
      peerPool: SKENES_LIKE_POOL,
    });
    // midpoint = 300 * 25 = 7500
    expect(r.diagnostics.midpoint).toBe(7500);
    expect(r.predictedRange!.low).toBeCloseTo(6375, 2);
    expect(r.predictedRange!.high).toBeCloseTo(8625, 2);
  });

  it("tier 8 (1/1) — top-tier multiplier 80", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 8,
      subjectRegime: "stable",
      peerPool: SKENES_LIKE_POOL,
    });
    expect(r.diagnostics.midpoint).toBe(24000);
    expect(r.predictedRange!.low).toBeCloseTo(20400, 2);
    expect(r.predictedRange!.high).toBeCloseTo(27600, 2);
  });
});

describe("computeTierAnchoredRange — edge cases", () => {
  it("returns null when peer pool has fewer than 3 usable comps", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 4,
      subjectRegime: "stable",
      peerPool: [peer(300, 1), peer(450, 2)],
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("peer_pool_too_small");
  });

  it("returns null when subjectTier is null", () => {
    const r = computeTierAnchoredRange({
      subjectTier: null,
      subjectRegime: "stable",
      peerPool: SKENES_LIKE_POOL,
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("subject_tier_missing");
  });

  it("returns null when subjectTier has no curated multiplier", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 99,
      subjectRegime: "stable",
      peerPool: SKENES_LIKE_POOL,
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("subject_tier_unknown_multiplier");
  });

  it("filters out peers with invalid tier or non-positive price", () => {
    // Two valid (tier 1 @ 300, tier 2 @ 450) + 3 invalid → only 2 usable → null.
    const r = computeTierAnchoredRange({
      subjectTier: 4,
      subjectRegime: "stable",
      peerPool: [
        peer(300, 1),
        peer(450, 2),
        peer(100, 99), // unknown tier
        peer(0, 1),    // zero price
        peer(-50, 2),  // negative price
      ],
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("peer_pool_too_small");
    expect(r.diagnostics.usablePeerCount).toBe(2);
    expect(r.diagnostics.peerCount).toBe(5);
  });

  it("returns null when peer pool is empty entirely", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 4,
      subjectRegime: "stable",
      peerPool: [],
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("peer_pool_no_usable_comps");
  });

  it("handles a homogeneous peer pool (all same tier)", () => {
    const r = computeTierAnchoredRange({
      subjectTier: 4,
      subjectRegime: "stable",
      // all tier 2 at $450 → implied baseline 300 each
      peerPool: [peer(450, 2), peer(450, 2), peer(450, 2), peer(450, 2)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.impliedBaseline).toBe(300);
    expect(r.diagnostics.midpoint).toBe(1200);
  });
});

describe("computeTierAnchoredRange — regime spread variations", () => {
  const baseInput = {
    subjectTier: 4 as const,
    peerPool: SKENES_LIKE_POOL, // midpoint = 1200
  };

  it("stable: ±15% → [1020, 1380]", () => {
    const r = computeTierAnchoredRange({ ...baseInput, subjectRegime: "stable" });
    expect(r.predictedRange).toEqual({ low: 1020, high: 1380 });
    expect(r.diagnostics.spreadModel).toBe("stable");
  });

  it("gradually_rising: mid * 0.95..1.15 → [1140, 1380]", () => {
    const r = computeTierAnchoredRange({
      ...baseInput,
      subjectRegime: "gradually_rising",
    });
    expect(r.predictedRange).toEqual({ low: 1140, high: 1380 });
    expect(r.predictedRange!.high).toBeGreaterThan(r.predictedRange!.low);
  });

  it("sharply_breaking_out: mid * 1.0..1.3 → [1200, 1560]", () => {
    const r = computeTierAnchoredRange({
      ...baseInput,
      subjectRegime: "sharply_breaking_out",
    });
    expect(r.predictedRange).toEqual({ low: 1200, high: 1560 });
  });

  it("declining: mid * 0.85..0.95 → [1020, 1140] (entire range below midpoint)", () => {
    const r = computeTierAnchoredRange({
      ...baseInput,
      subjectRegime: "declining",
    });
    expect(r.predictedRange).toEqual({ low: 1020, high: 1140 });
    expect(r.predictedRange!.high).toBeLessThan(r.diagnostics.midpoint!);
  });

  it("sharply_crashing: mid * 0.70..0.95 → [840, 1140]", () => {
    const r = computeTierAnchoredRange({
      ...baseInput,
      subjectRegime: "sharply_crashing",
    });
    expect(r.predictedRange).toEqual({ low: 840, high: 1140 });
  });

  it("volatile: mid * 0.75..1.25 → [900, 1500]", () => {
    const r = computeTierAnchoredRange({
      ...baseInput,
      subjectRegime: "volatile",
    });
    expect(r.predictedRange).toEqual({ low: 900, high: 1500 });
  });

  it("insufficient_data regime returns null with regime_insufficient_data reason", () => {
    const r = computeTierAnchoredRange({
      ...baseInput,
      subjectRegime: "insufficient_data" as Regime,
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("regime_insufficient_data");
  });

  it("null regime returns null with regime_insufficient_data reason", () => {
    const r = computeTierAnchoredRange({
      ...baseInput,
      subjectRegime: null,
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("regime_insufficient_data");
  });
});
