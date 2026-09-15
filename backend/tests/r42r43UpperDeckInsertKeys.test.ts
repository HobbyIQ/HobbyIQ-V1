// CF-A-REGISTERED-INSERT-SET-KEY-IS-A-FIXED-POINT, R42 and R43 (Drew 2026-09-15).
//
// Two same-numbered subsets in the staged Upper Deck hockey package, each of
// which refused its whole file until it had a key.
//
// R42 `1994-95 Rookie Tribute Die-Cuts` (2019-20 Series 1): restarts at card 1
// with its OWN players — #1 Cale Makar where base #1 is Auston Matthews.
//
// R43 `O-Pee-Chee Retro Update` (2021-22 Series 2): NOT a parallel. It carries
// O-Pee-Chee Update's card numbers and 39 of 40 the same players, so it looks
// like a rung — but it is a distinct retro-design product with its own ladder
// (Black Border /100, Neon Green Border /50) beside Update's (Blue Border,
// Red Border). A named variation is a distinct card.
//
// THE CLASH IS BETWEEN THE ROOKIES SUBSETS, so BOTH sides need a key.
// Registering only the Retro parent leaves the pair still colliding, because
// neither ROOKIES subset is the parent — measured, and the reason this file
// asserts four keys rather than two.

import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const KEYS = [
  { key: "upper-deck-series-1-1994-95-rookie-tribute-die-cuts", parent: "upper-deck-series-1" },
  { key: "upper-deck-series-2-o-pee-chee-retro-update", parent: "upper-deck-series-2" },
  { key: "upper-deck-series-2-o-pee-chee-update-rookies", parent: "upper-deck-series-2" },
  { key: "upper-deck-series-2-o-pee-chee-retro-update-rookies", parent: "upper-deck-series-2" },
];

describe("R42/R43 Upper Deck insert-set keys", () => {
  it("every key is registered", () => {
    expect(KEYS.filter((k) => !isProductSetKey(k.key)).map((k) => k.key)).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT", () => {
    const folded = KEYS
      .map((k) => ({ key: k.key, to: normalizeSetKey(k.key) }))
      .filter((x) => x.to !== x.key);
    expect(folded).toEqual([]);
  });

  it("every key keeps its Upper Deck series parent and family", () => {
    for (const k of KEYS) {
      expect(productParentOf(k.key)).toBe(k.parent);
      expect(productFamilyOf(k.key)).toBe(k.parent);
    }
  });

  it("BOTH rookies subsets are keyed — the parent alone does not resolve the clash", () => {
    // Update's rookies and Retro Update's rookies share card numbers AND
    // players (#611 is William Eklund RC in both); only their ladders differ.
    expect(isProductSetKey("upper-deck-series-2-o-pee-chee-update-rookies")).toBe(true);
    expect(isProductSetKey("upper-deck-series-2-o-pee-chee-retro-update-rookies")).toBe(true);
  });

  it("the bare subset names are NOT keys", () => {
    // A bare name would not say which Upper Deck product it belongs to.
    for (const bare of ["o-pee-chee-retro-update", "1994-95-rookie-tribute-die-cuts", "o-pee-chee-update-rookies"]) {
      expect(isProductSetKey(bare)).toBe(false);
    }
  });
});
