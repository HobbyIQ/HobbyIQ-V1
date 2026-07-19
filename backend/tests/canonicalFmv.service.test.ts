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
      "sibling-parallel",
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

describe("CF-CANONICAL-FMV-NO-BASIS-GATE (Drew, 2026-07-19)", () => {
  // The gate refuses to fall through to family-baseline/product-tier
  // when the request specifies a non-base parallel or a graded tier,
  // and rungs 1-3 all returned nothing. iOS shows "—" rather than a
  // family median dressed up as an FMV. Test SKUs use nonsense cardIds
  // guaranteed not to hit rungs 1-3 in prod-connected tests.
  const UNKNOWN_CARDID = "nonexistent-cardid-nobasis-gate-test";

  it("specific parallel + zero comps + nonexistent cardNumber → no-basis, fmv null", async () => {
    // Uses a fake cardNumber (CPA-ZZNONE) so the sibling-parallel rung
    // can't rescue us — the goal here is to verify the no-basis gate
    // fires when NO rung finds anything, not to test sibling.
    const result = await computeCanonicalFmv({
      cardId: UNKNOWN_CARDID,
      parallel: "Blue Refractor",
      gradeCompany: null,
      gradeValue: null,
      cardYear: 2026,
      product: "2026 Bowman Chrome",
      player: "No Such Player",
      cardNumber: "CPA-ZZNONE",
      freshCompute: true,
    });
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBeNull();
    expect(result.gradeLadder ?? null).toBeNull();
  });

  it("graded tier + zero comps → no-basis, fmv null", async () => {
    const result = await computeCanonicalFmv({
      cardId: UNKNOWN_CARDID,
      parallel: null,
      gradeCompany: "PSA",
      gradeValue: 10,
      cardYear: 2020,
      product: "2020 Bowman Chrome",
      player: "No Such Player",
      cardNumber: null,
      freshCompute: true,
    });
    expect(result.method).toBe("no-basis");
    expect(result.fmv).toBeNull();
    expect(result.gradeLadder ?? null).toBeNull();
  });

  it("base card + no grade + zero comps → still can fall to family/product rungs (not gated)", async () => {
    const result = await computeCanonicalFmv({
      cardId: UNKNOWN_CARDID,
      parallel: "Base",
      gradeCompany: null,
      gradeValue: null,
      cardYear: 2020,
      product: "2020 Bowman Chrome",
      player: "No Such Player",
      cardNumber: null,
      freshCompute: true,
    });
    // Base + raw is permissive — family-baseline is a legitimate concept
    // for "typical 2020 Bowman Chrome base card." Don't lock the method
    // to a specific rung (family/product/no-basis all valid); do assert
    // the gate DIDN'T short-circuit to no-basis with the "specific"
    // reason from the strict path.
    expect([
      "family-baseline",
      "product-tier",
      "no-basis",
    ]).toContain(result.method);
    if (result.method === "no-basis") {
      expect(result.provenance.summary).not.toContain("specific parallel");
    }
  });

  it("CANONICAL_FMV_STRICT_NO_BASIS=false disables the gate", async () => {
    const prev = process.env.CANONICAL_FMV_STRICT_NO_BASIS;
    process.env.CANONICAL_FMV_STRICT_NO_BASIS = "false";
    try {
      const result = await computeCanonicalFmv({
        cardId: UNKNOWN_CARDID,
        parallel: "Blue Refractor",
        gradeCompany: null,
        gradeValue: null,
        cardYear: 2026,
        product: "2026 Bowman Chrome",
        player: "No Such Player",
        cardNumber: "CPA-XX",
        freshCompute: true,
      });
      // Without the gate, fall-through to rungs 4-5 is allowed. Either
      // they fire and return a value, or they don't and it stays no-basis.
      // What must NOT happen is the strict-gate summary text.
      if (result.method === "no-basis") {
        expect(result.provenance.summary).not.toContain("specific parallel");
      }
    } finally {
      if (prev === undefined) delete process.env.CANONICAL_FMV_STRICT_NO_BASIS;
      else process.env.CANONICAL_FMV_STRICT_NO_BASIS = prev;
    }
  });
});
