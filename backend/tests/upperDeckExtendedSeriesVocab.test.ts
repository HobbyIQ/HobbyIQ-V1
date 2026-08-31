/**
 * D39 CF-THE-UMBRELLA-FOLDS-ONTO-ITS-SERIES (Drew, 2026-08-31): the hockey
 * umbrella folds onto its SERIES products -- o-pee-chee, upper-deck-series-1,
 * upper-deck-series-2, upper-deck-extended-series.
 *
 * Extended Series was the one named destination the product table did not
 * spell, so "2024-25 Upper Deck Extended Series" resolved to the bare
 * `upper-deck` umbrella -- the D23 defect, on a product with no table row.
 * Measured 2026-08-31: 4,642 hockey 2024 card_catalog rows carry
 * `upper-deck-extended-series` in their setKey FIELD while every one of their
 * ids says `upper-deck`. A fold cannot send a sale to an address the slug
 * generator will not mint, so the vocabulary entry comes first.
 */
import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { productEntry, productFamilyOf, productParentOf, productRefinementsOf } from "../src/services/catalog/productSetKeys";

describe("upper-deck-extended-series is a product the table spells", () => {
  it("resolves the checklist's own spellings", () => {
    expect(normalizeSetKey("2024-25 Upper Deck Extended Series")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("Upper Deck Extended Series")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("2024 upper deck extended series")).toBe("upper-deck-extended-series");
    // The short spelling the sellers use.
    expect(normalizeSetKey("Upper Deck Extended")).toBe("upper-deck-extended-series");
  });

  it("nests under the Upper Deck flagship as a verified refinement", () => {
    expect(productEntry("upper-deck-extended-series")?.setKey).toBe("upper-deck-extended-series");
    expect(productFamilyOf("upper-deck-extended-series")).toBe("upper-deck");
    expect(productParentOf("upper-deck-extended-series")).toBe("upper-deck");
    // It joins Series 1 and 2 as a refinement the matcher may widen to.
    expect(productRefinementsOf("upper-deck")).toEqual(
      expect.arrayContaining(["upper-deck-series-1", "upper-deck-series-2", "upper-deck-extended-series"]),
    );
  });

  it("does not eat the neighbouring Upper Deck products", () => {
    // The new `names` entry is "upper-deck-extended", a multi-segment run. The
    // risk of any new pattern is that it captures something already correct.
    const unchanged: Array<[string, string]> = [
      ["Upper Deck", "upper-deck"],
      ["2024-25 Upper Deck", "upper-deck"],
      ["Upper Deck Series 1", "upper-deck-series-1"],
      ["Upper Deck Series 2", "upper-deck-series-2"],
      ["Upper Deck MVP", "upper-deck-mvp"],
      ["Upper Deck Black Diamond", "upper-deck-black-diamond"],
      ["O-Pee-Chee", "o-pee-chee"],
      ["SP Authentic", "sp-authentic"],
    ];
    for (const [name, want] of unchanged) {
      expect(normalizeSetKey(name), `"${name}" moved`).toBe(want);
    }
  });
});
