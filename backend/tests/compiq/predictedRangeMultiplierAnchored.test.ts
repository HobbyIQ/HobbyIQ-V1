import { describe, it, expect } from "vitest";
import {
  computeMultiplierAnchoredRange,
  type MultiplierAnchoredPeerComp,
} from "../../src/services/compiq/predictedRangeMultiplierAnchored.js";

// Helper — build a simple peer comp.
const peer = (parallelName: string, price: number): MultiplierAnchoredPeerComp => ({
  parallelName,
  price,
});

describe("computeMultiplierAnchoredRange — happy paths", () => {
  it("subject = Blue, three Refractor peers @ $220 → midpoint ≈ baseline × 3.12 (CF-WORKSHEET-CALIBRATION 2026-06-29)", () => {
    // impliedBaseline_i = 220 / 2.2 = 100; midBaseline = 100; midpoint = 100 × 3.12 = 312 (was 570 under pre-CF-WORKSHEET-CALIBRATION Blue=5.7)
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.subjectMultiplier).toBe(3.12);
    expect(r.diagnostics.playerBaseline).toBe(100);
    expect(r.diagnostics.midpoint).toBe(312);
    // stable spread: ±15%
    expect(r.predictedRange!.low).toBeCloseTo(312 * 0.85, 2);
    expect(r.predictedRange!.high).toBeCloseTo(312 * 1.15, 2);
  });

  it("subject = Gold (14.5x), four mixed-tier peers, regime=gradually_rising", () => {
    // peers: Refractor $220 (base=100), Blue $312 (base=100), Atomic $420 (base=100), Speckle $270 (base=100)
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Gold",
      subjectRegime: "gradually_rising",
      peerComps: [peer("Refractor", 220), peer("Blue", 312), peer("Atomic", 420), peer("Speckle", 270)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.curatedPeerCount).toBe(4);
    expect(r.diagnostics.subjectMultiplier).toBe(14.5);
    expect(r.diagnostics.playerBaseline).toBe(100);
    expect(r.diagnostics.midpoint).toBe(1450);
    expect(r.predictedRange!.low).toBeCloseTo(1450 * 0.95, 1);
    expect(r.predictedRange!.high).toBeCloseTo(1450 * 1.15, 1);
  });

  it("subject = Red (22.79x, CF-WORKSHEET-CALIBRATION 2026-06-29), regime=sharply_breaking_out", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Red",
      subjectRegime: "sharply_breaking_out",
      peerComps: [peer("Gold", 1450), peer("Gold", 1450), peer("Gold", 1450)],
    });
    expect(r.predictedRange).not.toBeNull();
    // 1450 / 14.5 = 100; midpoint = 100 × 22.79 = 2279
    expect(r.diagnostics.midpoint).toBe(2279);
    expect(r.predictedRange!.low).toBeCloseTo(2279 * 1.0, 2);
    expect(r.predictedRange!.high).toBeCloseTo(2279 * 1.3, 2);
  });

  it("subject = Superfractor (125x), regime=volatile", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Superfractor",
      subjectRegime: "volatile",
      peerComps: [peer("Refractor", 220), peer("Blue", 312), peer("Gold", 1450)],
    });
    expect(r.predictedRange).not.toBeNull();
    // all imply baseline 100; midpoint = 100 × 125 = 12500
    expect(r.diagnostics.midpoint).toBe(12500);
    expect(r.predictedRange!.low).toBeCloseTo(12500 * 0.75, 1);
    expect(r.predictedRange!.high).toBeCloseTo(12500 * 1.25, 1);
  });

  it("median over odd count chooses middle baseline", () => {
    // baselines: 80, 100, 120 → median 100; midpoint 100 × 3.12 = 312
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 176), peer("Refractor", 220), peer("Refractor", 264)],
    });
    expect(r.diagnostics.playerBaseline).toBe(100);
    expect(r.diagnostics.midpoint).toBe(312);
  });

  it("median over even count averages middle two", () => {
    // baselines: 80, 100, 120, 140 → median (100+120)/2 = 110; midpoint 110 × 3.12 = 343.2
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 176), peer("Refractor", 220), peer("Refractor", 264), peer("Refractor", 308)],
    });
    expect(r.diagnostics.playerBaseline).toBe(110);
    expect(r.diagnostics.midpoint).toBe(343.2);
  });

  it("accepts 'Blue Refractor' as alias for 'Blue'", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue Refractor",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.subjectParallelName).toBe("Blue");
  });

  it("accepts 'Gold Auto' as alias for 'Gold'", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Gold Auto",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.subjectParallelName).toBe("Gold");
  });
});

describe("computeMultiplierAnchoredRange — null reason cases", () => {
  it("returns null when subject parallel is uncurated", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Rainbow Foil",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220)],
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("uncurated_subject_parallel");
  });

  it("returns null when all peers are uncurated", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Pink Diamond", 200), peer("Cosmic Foil", 250), peer("Wave Variant", 300)],
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("insufficient_curated_peers");
    expect(r.diagnostics.curatedPeerCount).toBe(0);
  });

  it("returns null when curated peer count is exactly 2", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Unknown", 999)],
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("insufficient_curated_peers");
    expect(r.diagnostics.curatedPeerCount).toBe(2);
  });

  it("succeeds with exactly 3 curated peers", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220), peer("Unknown", 999)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.curatedPeerCount).toBe(3);
  });

  it("returns null with subject_parallel_missing on empty subject", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220)],
    });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("subject_parallel_missing");
  });
});

describe("computeMultiplierAnchoredRange — regime spreads", () => {
  const baseInput = {
    subjectParallelName: "Blue",
    peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220)],
  };
  // midpoint = 312 for all regimes
  it("stable: 0.85 to 1.15", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "stable" });
    expect(r.predictedRange!.low).toBeCloseTo(265.2, 1);
    expect(r.predictedRange!.high).toBeCloseTo(358.8, 1);
  });
  it("gradually_rising: 0.95 to 1.15", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "gradually_rising" });
    expect(r.predictedRange!.low).toBeCloseTo(296.4, 1);
    expect(r.predictedRange!.high).toBeCloseTo(358.8, 1);
  });
  it("sharply_breaking_out: 1.0 to 1.3", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "sharply_breaking_out" });
    expect(r.predictedRange!.low).toBeCloseTo(312, 1);
    expect(r.predictedRange!.high).toBeCloseTo(405.6, 1);  // 312 * 1.3 (was 741 = 570 * 1.3 pre-CF-WORKSHEET-CALIBRATION)
  });
  it("declining: 0.85 to 0.95", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "declining" });
    expect(r.predictedRange!.low).toBeCloseTo(265.2, 1);
    expect(r.predictedRange!.high).toBeCloseTo(296.4, 1);
  });
  it("sharply_crashing: 0.7 to 0.95", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "sharply_crashing" });
    expect(r.predictedRange!.low).toBeCloseTo(218.4, 1);
    expect(r.predictedRange!.high).toBeCloseTo(296.4, 1);
  });
  it("insufficient_data → null", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "insufficient_data" });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("regime_insufficient_data");
  });
});

describe("computeMultiplierAnchoredRange — De Vries worked example", () => {
  // De Vries Blue Refractor /150 Auto. Subject parallel: "Blue" (mult 3.12,
  // CF-WORKSHEET-CALIBRATION 2026-06-29 — was 5.7 pre-CF).
  // Peer prices RESCALED so each implies baseline ≈ 290 — needed to land
  // back in a usable target band. With Blue now 3.12 (vs old 5.7) the
  // pre-CF baseline ≈ 188.8 hit $900-$1,500; under the new mult we need
  // a higher baseline for the same dollar band. Three peers also use
  // updated multipliers (Purple 3.721, Green 7.433 — Blue Wave/Atomic/
  // Gold/Refractor/Speckle unchanged).
  //   • Refractor /499:    $638   → baseline 638  / 2.2     ≈ 290.0
  //   • Speckle  /299:     $783   → baseline 783  / 2.7     ≈ 290.0
  //   • Purple   /250:     $1080  → baseline 1080 / 3.721   ≈ 290.2
  //   • Atomic   /100:     $1218  → baseline 1218 / 4.2     ≈ 290.0
  //   • Blue Wave /150:    $1421  → baseline 1421 / 4.9     ≈ 290.0
  //   • Green    /99:      $2156  → baseline 2156 / 7.433   ≈ 290.1
  //   • Gold     /50:      $4205  → baseline 4205 / 14.5    ≈ 290.0
  // → median baseline ≈ 290; subject midpoint ≈ 290 × 3.12 ≈ 905
  // Stable regime spread ±15%: low ≈ $769, high ≈ $1041
  it("produces predictedRange in the $700-$1,100 target range with stable regime", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [
        peer("Refractor", 638),
        peer("Speckle", 783),
        peer("Purple", 1080),
        peer("Atomic", 1218),
        peer("Blue Wave", 1421),
        peer("Green", 2156),
        peer("Gold", 4205),
      ],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.predictedRange!.low).toBeGreaterThanOrEqual(700);
    expect(r.predictedRange!.high).toBeLessThanOrEqual(1100);
    expect(r.diagnostics.curatedPeerCount).toBe(7);
    expect(r.diagnostics.subjectMultiplier).toBe(3.12);
  });
});
