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
  it("subject = Blue, three Refractor peers @ $220 → midpoint ≈ baseline × 5.7", () => {
    // impliedBaseline_i = 220 / 2.2 = 100; midBaseline = 100; midpoint = 100 × 5.7 = 570
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 220), peer("Refractor", 220), peer("Refractor", 220)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.subjectMultiplier).toBe(5.7);
    expect(r.diagnostics.playerBaseline).toBe(100);
    expect(r.diagnostics.midpoint).toBe(570);
    // stable spread: ±15%
    expect(r.predictedRange!.low).toBeCloseTo(570 * 0.85, 2);
    expect(r.predictedRange!.high).toBeCloseTo(570 * 1.15, 2);
  });

  it("subject = Gold (14.5x), four mixed-tier peers, regime=gradually_rising", () => {
    // peers: Refractor $220 (base=100), Blue $570 (base=100), Atomic $420 (base=100), Speckle $270 (base=100)
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Gold",
      subjectRegime: "gradually_rising",
      peerComps: [peer("Refractor", 220), peer("Blue", 570), peer("Atomic", 420), peer("Speckle", 270)],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.diagnostics.curatedPeerCount).toBe(4);
    expect(r.diagnostics.subjectMultiplier).toBe(14.5);
    expect(r.diagnostics.playerBaseline).toBe(100);
    expect(r.diagnostics.midpoint).toBe(1450);
    expect(r.predictedRange!.low).toBeCloseTo(1450 * 0.95, 1);
    expect(r.predictedRange!.high).toBeCloseTo(1450 * 1.15, 1);
  });

  it("subject = Red (55x), regime=sharply_breaking_out", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Red",
      subjectRegime: "sharply_breaking_out",
      peerComps: [peer("Gold", 1450), peer("Gold", 1450), peer("Gold", 1450)],
    });
    expect(r.predictedRange).not.toBeNull();
    // 1450 / 14.5 = 100; midpoint = 100 × 55 = 5500
    expect(r.diagnostics.midpoint).toBe(5500);
    expect(r.predictedRange!.low).toBeCloseTo(5500 * 1.0, 2);
    expect(r.predictedRange!.high).toBeCloseTo(5500 * 1.3, 2);
  });

  it("subject = Superfractor (125x), regime=volatile", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Superfractor",
      subjectRegime: "volatile",
      peerComps: [peer("Refractor", 220), peer("Blue", 570), peer("Gold", 1450)],
    });
    expect(r.predictedRange).not.toBeNull();
    // all imply baseline 100; midpoint = 100 × 125 = 12500
    expect(r.diagnostics.midpoint).toBe(12500);
    expect(r.predictedRange!.low).toBeCloseTo(12500 * 0.75, 1);
    expect(r.predictedRange!.high).toBeCloseTo(12500 * 1.25, 1);
  });

  it("median over odd count chooses middle baseline", () => {
    // baselines: 80, 100, 120 → median 100; midpoint 100 × 5.7 = 570
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 176), peer("Refractor", 220), peer("Refractor", 264)],
    });
    expect(r.diagnostics.playerBaseline).toBe(100);
    expect(r.diagnostics.midpoint).toBe(570);
  });

  it("median over even count averages middle two", () => {
    // baselines: 80, 100, 120, 140 → median (100+120)/2 = 110; midpoint 110 × 5.7 = 627
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [peer("Refractor", 176), peer("Refractor", 220), peer("Refractor", 264), peer("Refractor", 308)],
    });
    expect(r.diagnostics.playerBaseline).toBe(110);
    expect(r.diagnostics.midpoint).toBe(627);
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
  // midpoint = 570 for all regimes
  it("stable: 0.85 to 1.15", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "stable" });
    expect(r.predictedRange!.low).toBeCloseTo(484.5, 1);
    expect(r.predictedRange!.high).toBeCloseTo(655.5, 1);
  });
  it("gradually_rising: 0.95 to 1.15", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "gradually_rising" });
    expect(r.predictedRange!.low).toBeCloseTo(541.5, 1);
    expect(r.predictedRange!.high).toBeCloseTo(655.5, 1);
  });
  it("sharply_breaking_out: 1.0 to 1.3", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "sharply_breaking_out" });
    expect(r.predictedRange!.low).toBeCloseTo(570, 1);
    expect(r.predictedRange!.high).toBeCloseTo(741, 1);
  });
  it("declining: 0.85 to 0.95", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "declining" });
    expect(r.predictedRange!.low).toBeCloseTo(484.5, 1);
    expect(r.predictedRange!.high).toBeCloseTo(541.5, 1);
  });
  it("sharply_crashing: 0.7 to 0.95", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "sharply_crashing" });
    expect(r.predictedRange!.low).toBeCloseTo(399, 1);
    expect(r.predictedRange!.high).toBeCloseTo(541.5, 1);
  });
  it("insufficient_data → null", () => {
    const r = computeMultiplierAnchoredRange({ ...baseInput, subjectRegime: "insufficient_data" });
    expect(r.predictedRange).toBeNull();
    expect(r.diagnostics.nullReason).toBe("regime_insufficient_data");
  });
});

describe("computeMultiplierAnchoredRange — De Vries worked example", () => {
  // De Vries Blue Refractor /150 Auto. Subject parallel: "Blue" (mult 5.7).
  // Hypothetical Card Hedge sibling-parallel comps for his auto rainbow:
  //   • Refractor /499:   $415   → baseline 415  / 2.2  ≈ 188.6
  //   • Speckle  /299:    $510   → baseline 510  / 2.7  ≈ 188.9
  //   • Purple   /250:    $510   → baseline 510  / 2.7  ≈ 188.9
  //   • Atomic   /100:    $790   → baseline 790  / 4.2  ≈ 188.1
  //   • Blue Wave /150:   $925   → baseline 925  / 4.9  ≈ 188.8
  //   • Green    /99:     $810   → baseline 810  / 4.3  ≈ 188.4
  //   • Gold     /50:     $2740  → baseline 2740 / 14.5 ≈ 188.9
  // → median baseline ≈ 188.8; subject midpoint ≈ 188.8 × 5.7 ≈ 1076
  // Stable regime spread ±15%: low ≈ $915, high ≈ $1238 — squarely in the
  // $900-$1,500 target range.
  it("produces predictedRange in the $900-$1,500 target range with stable regime", () => {
    const r = computeMultiplierAnchoredRange({
      subjectParallelName: "Blue",
      subjectRegime: "stable",
      peerComps: [
        peer("Refractor", 415),
        peer("Speckle", 510),
        peer("Purple", 510),
        peer("Atomic", 790),
        peer("Blue Wave", 925),
        peer("Green", 810),
        peer("Gold", 2740),
      ],
    });
    expect(r.predictedRange).not.toBeNull();
    expect(r.predictedRange!.low).toBeGreaterThanOrEqual(900);
    expect(r.predictedRange!.high).toBeLessThanOrEqual(1500);
    expect(r.diagnostics.curatedPeerCount).toBe(7);
    expect(r.diagnostics.subjectMultiplier).toBe(5.7);
  });
});
