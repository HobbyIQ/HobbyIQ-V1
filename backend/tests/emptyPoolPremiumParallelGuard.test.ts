// CF-UNKNOWN-TIER-IS-NOT-A-DENOMINATOR (2026-08-31).
//
// The case: a platform user holds
//   hiq:baseball:2025:bowman-chrome:cpa-dt:black-refractor:auto
// (Devin Taylor 2025 Bowman Draft Chrome Prospect Auto, Black), holding
// 60a7cfcc, user-5e1a90ea. The app showed ~$3 for a card whose own ladder
// trades $15-$45 at base auto and $37-$135 at refractor /499.
//
// Verified prod facts:
//   - NO catalog row exists for the black auto under bowman-chrome OR
//     bowman-draft, so the identity never resolves;
//   - the exact pool for that slug is 0 rows;
//   - ZERO black-titled CPA-DT sales exist anywhere;
//   - junk neighbours: bdc-135 NON-AUTO rows at $0.79-$2.
//
// WHERE THE $3 CAME FROM — measured, not assumed. Both engine paths are
// already honest here: oneValuationPath.valueIdentity returns
// fmv=null/reason="identity-not-in-catalog", and hobbyIqFmv's ladder
// returns no-basis (its CF-CATALOG-GAP-NO-BASIS guard names this very
// card). The number is produced further out, in the /price-by-id and
// /search response decorator applyAutoProjectionFallbacks
// (routes/compiq.routes.ts), at Layer 4's parallel-tier ratio:
//
//     projected = anchorLatestSale × trendFactor × (targetTier / anchorTier)
//
// autoProjectVariantTier collapses two different facts onto the number 1:
// "this is a base card" and "we could not read this parallel". With no
// catalog row the black auto's variant arrives EMPTY, so targetTier = 1
// (unmatched), while a legitimate same-player auto sibling anchors at a
// real tier — Black Refractor 21, Superfractor 35. The ratio then DIVIDES
// a premium anchor by its own tier:
//
//     $37 × 1.0 × (1/21) = $1.76
//     $45 × 1.0 × (1/21) = $2.14
//     $60 × 1.0 × (1/21) = $2.86
//     $96 × 1.0 × (1/35) = $2.74      ← the ~$3 the user saw
//
// Safe as a numerator, catastrophic as a denominator. The fix refuses the
// rung when the target's parallel could not be classified, on both Layer 4
// and the Layer 2 base × flat-auto-premium rung beneath it (which crosses
// the auto AND cardNumber boundaries with no parallel term at all).
//
// Pinned here: the collapse cannot happen, the healthy direction still
// prices and is still labelled, and the arithmetic itself is nailed down.
import { describe, it, expect } from "vitest";
import {
  autoProjectVariantTier,
  isClassifiedVariantTier,
  UNKNOWN_VARIANT_TIER,
} from "../src/routes/compiq.routes.js";

describe("autoProjectVariantTier: unmatched 1x is not a reading", () => {
  it("classifies the real premium parallels the CPA-DT ladder contains", () => {
    expect(autoProjectVariantTier("Black Refractor")).toBe(21);
    expect(autoProjectVariantTier("Black")).toBe(19);
    expect(autoProjectVariantTier("Superfractor")).toBe(35);
    expect(autoProjectVariantTier("Refractor")).toBeGreaterThan(0);
    for (const v of ["Black Refractor", "Black", "Superfractor", "Gold Refractor"]) {
      expect(isClassifiedVariantTier(v), v).toBe(true);
    }
  });

  it("an EMPTY / absent / unreadable variant is NOT classified", () => {
    // This is the CPA-DT black auto's state: no catalog row, so no variant.
    for (const v of ["", "   ", null, undefined, 42, {}]) {
      expect(isClassifiedVariantTier(v as unknown), String(v)).toBe(false);
    }
    // ...even though the tier function hands back a usable-looking 1.
    expect(autoProjectVariantTier("")).toBe(UNKNOWN_VARIANT_TIER);
    expect(autoProjectVariantTier(null)).toBe(UNKNOWN_VARIANT_TIER);
  });

  it("an explicit Base IS classified — tier 1 is a real reading there", () => {
    for (const v of ["Base", "base", "  Base  ", "Base Set", "none"]) {
      expect(isClassifiedVariantTier(v), v).toBe(true);
    }
    expect(autoProjectVariantTier("Base")).toBe(UNKNOWN_VARIANT_TIER);
  });

  it("a parallel the map has never seen is NOT classified", () => {
    // Unknown colour words must fail closed, not masquerade as Base.
    expect(isClassifiedVariantTier("Vaporfractor Ultra")).toBe(false);
  });
});

describe("the CPA-DT collapse: the arithmetic that produced ~$3", () => {
  // The ratio Layer 4 would compute, reproduced exactly.
  const ratio = (anchor: string, target: string): number =>
    autoProjectVariantTier(target) / autoProjectVariantTier(anchor);

  it("dividing a premium anchor by its own tier lands in the junk band", () => {
    // Black Refractor anchor (21), target unreadable (1).
    for (const [sale, expected] of [[37, 1.76], [45, 2.14], [60, 2.86]] as const) {
      const projected = sale * 1.0 * ratio("Black Refractor", "");
      expect(Math.round(projected * 100) / 100).toBeCloseTo(expected, 2);
      // Every one of these is BELOW the cheapest real CPA-DT sale ($15).
      expect(projected).toBeLessThan(15);
    }
    // Superfractor anchor (35) — the ~$3 exactly.
    expect(96 * ratio("Superfractor", "")).toBeCloseTo(2.74, 2);
  });

  it("the guard predicate refuses precisely these pairings", () => {
    const refuses = (anchor: string, target: string): boolean =>
      !isClassifiedVariantTier(target)
      && autoProjectVariantTier(anchor) > UNKNOWN_VARIANT_TIER;

    // The failure: premium anchor, unreadable target → refuse.
    expect(refuses("Black Refractor", "")).toBe(true);
    expect(refuses("Superfractor", "")).toBe(true);
    expect(refuses("Gold Refractor", "   ")).toBe(true);

    // The healthy directions stay open.
    expect(refuses("Base", "")).toBe(false);              // no premium to collapse
    expect(refuses("Base", "Black Refractor")).toBe(false); // scaling UP is fine
    expect(refuses("Refractor", "Black")).toBe(false);      // both classified
    expect(refuses("Black Refractor", "Superfractor")).toBe(false);
  });

  it("scaling UP from a base anchor to a premium target is untouched", () => {
    // The rung's original purpose — a Base-auto anchor projecting a rarer
    // parallel — must keep working, and must move the price UP not down.
    const projected = 20 * ratio("Base", "Black Refractor");
    expect(projected).toBe(20 * 21);
    expect(projected).toBeGreaterThan(20);
  });
});

describe("guard behaviour table", () => {
  const cases: Array<{
    name: string; anchor: string; target: string; refuse: boolean;
  }> = [
    { name: "premium anchor → unreadable target (the CPA-DT bug)", anchor: "Black Refractor", target: "", refuse: true },
    { name: "superfractor anchor → unreadable target", anchor: "Superfractor", target: "", refuse: true },
    { name: "base anchor → unreadable target", anchor: "Base", target: "", refuse: false },
    { name: "base anchor → premium target (scale up)", anchor: "Base", target: "Black Refractor", refuse: false },
    { name: "premium anchor → premium target", anchor: "Gold Refractor", target: "Black Refractor", refuse: false },
    { name: "premium anchor → explicit base target", anchor: "Black Refractor", target: "Base", refuse: false },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.refuse ? "REFUSE" : "price"}`, () => {
      const refused =
        !isClassifiedVariantTier(c.target)
        && autoProjectVariantTier(c.anchor) > UNKNOWN_VARIANT_TIER;
      expect(refused).toBe(c.refuse);
    });
  }
});
