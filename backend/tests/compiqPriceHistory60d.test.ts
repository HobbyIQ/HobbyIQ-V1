// CF-PRICEHISTORY-60D (2026-06-10): unit coverage for evenlyDownsample.
//
// The original file also locked the value path and exercised the 60-day
// priceHistory[] series end-to-end through computeEstimate via a mocked
// Cardsight getPricing() response. That data path was removed in
// CF-CARDSIGHT-REMOVAL (Phase 3 Wave 3): the pinned cardsightCardId branch
// no longer calls Cardsight getPricing/getCardDetail — comps are sourced
// solely from CardHedge via the router, and on a CardHedge miss the branch
// returns 0 comps. With no getPricing-fed pool reaching the engine, the
// value-path lock and the positive 21-60d priceHistory assertions tested
// removed behavior and were dropped. The pure evenlyDownsample helper is
// unaffected and retains full coverage below.

import { describe, it, expect } from "vitest";

import { evenlyDownsample } from "../src/services/compiq/compiqEstimate.service";

// ───────────────────────────────────────────────────────────────────────────
// evenlyDownsample unit. Exercised in isolation so the 150-cap behavior is
// testable without spinning up the full pipeline.
// ───────────────────────────────────────────────────────────────────────────

describe("CF-PRICEHISTORY-60D — evenlyDownsample", () => {
  it("returns items unchanged when n <= target", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = evenlyDownsample(items, 150);
    expect(out).toEqual(items);
  });

  it("downsamples 300 → 150 with preserved endpoints and even spread", () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    const out = evenlyDownsample(items, 150);
    expect(out.length).toBe(150);
    // Endpoints preserved.
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(299);
    // Strictly increasing (deduped + sorted by source index).
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(out[i - 1]);
    }
    // Even spread: no gap should exceed ~2× the average gap. Average
    // gap on 300→150 is 299/149 ≈ 2.007, so a gap >5 indicates a bug.
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBeLessThanOrEqual(5);
    }
  });

  it("returns empty array when target is 0", () => {
    expect(evenlyDownsample([1, 2, 3], 0)).toEqual([]);
  });

  it("handles target == 1 without crashing (picks first element)", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = evenlyDownsample(items, 1);
    expect(out).toEqual([0]);
  });
});
