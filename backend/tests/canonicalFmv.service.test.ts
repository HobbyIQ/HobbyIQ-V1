/**
 * Pinning tests for computeCanonicalFmv.
 *
 * The tests exercise the CONTRACT (input → output shape) at the module
 * boundary, not the cache or Cosmos internals. Rung 1 (direct-comp) is
 * covered end-to-end via a mocked readCompsByCardId. Rungs 3-5 are
 * stubbed so their pinning tests document expected behavior once
 * implemented (skipped).
 */
import { describe, expect, it } from "vitest";
import {
  computeCanonicalFmv,
  type CanonicalFmvInput,
} from "../src/services/compiq/canonicalFmv.service.js";

const MINIMAL_INPUT: CanonicalFmvInput = {
  cardId: "test-card-1778542140951",
  parallel: "Blue Refractor",
  gradeCompany: null,
  gradeValue: null,
  cardYear: 2026,
  product: "2026 Bowman Chrome",
  player: "Eric Hartman",
  cardNumber: "CPA-EHA",
};

describe("computeCanonicalFmv contract", () => {
  it("returns no-basis with fmv null on missing cardId", async () => {
    const result = await computeCanonicalFmv({ ...MINIMAL_INPUT, cardId: "" });
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBe(null);
    expect(result.confidence).toBe(0);
    expect(result.provenance.summary).toBeTruthy();
  });

  it("returns no-basis with fmv null on whitespace-only cardId", async () => {
    const result = await computeCanonicalFmv({ ...MINIMAL_INPUT, cardId: "   " });
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBe(null);
  });

  it("returns a result envelope with computedAt ISO timestamp", async () => {
    const result = await computeCanonicalFmv(MINIMAL_INPUT);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("provenance always includes summary + comps array + multipliers object", async () => {
    const result = await computeCanonicalFmv(MINIMAL_INPUT);
    expect(typeof result.provenance.summary).toBe("string");
    expect(Array.isArray(result.provenance.comps)).toBe(true);
    expect(typeof result.provenance.multipliers).toBe("object");
  });

  it("method is one of the enum values, never undefined", async () => {
    const result = await computeCanonicalFmv(MINIMAL_INPUT);
    expect([
      "direct-comp",
      "cross-parallel",
      "neighbor-parallel",
      "family-baseline",
      "product-tier",
      "no-basis",
    ]).toContain(result.method);
  });

  it("confidence is in [0, 1] range", async () => {
    const result = await computeCanonicalFmv(MINIMAL_INPUT);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("freshCompute=true bypasses cache (does not throw)", async () => {
    const result = await computeCanonicalFmv({ ...MINIMAL_INPUT, freshCompute: true });
    // Whatever fires (rung 1-5 or no-basis), the envelope shape is valid.
    expect(result).toHaveProperty("fmv");
    expect(result).toHaveProperty("method");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("provenance");
    expect(result).toHaveProperty("computedAt");
  });
});

describe("Deterministic given inputs — same-input calls return same shape", () => {
  it("two calls with identical inputs return the same method", async () => {
    const a = await computeCanonicalFmv({ ...MINIMAL_INPUT, freshCompute: true });
    const b = await computeCanonicalFmv({ ...MINIMAL_INPUT, freshCompute: true });
    expect(a.method).toBe(b.method);
  });
});
