// R-CENSUS-2026-09-20. Two products with strict checklist rows already
// sitting in card_catalog under their own exact key strings, neither ever
// registered in productSetKeys.ts:
//
//   topps-flagship (football)      -- Topps' own standalone 2026 NFL
//                                      flagship product name (topps.com/
//                                      pages/topps-flagship-football), own
//                                      family, own numbered subsets.
//   panini-select-wnba (basketball) -- mirrors the already-registered
//                                      panini-prizm-wnba precedent: WNBA
//                                      lines are their own family and never
//                                      borrow the NBA ladder.
//
// Both already resolve as normalizeSetKey fixed points today (measured via
// the compiled dist before this PR); this pins that registering them changes
// nothing about what the deriver answers, only makes the keys addressable
// through productSetKeyForName / isProductSetKey.
import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey, resolveSetKeyForSlug } from "../src/services/portfolioiq/hobbyIqCardId.service";

describe("topps-flagship (football) is registered", () => {
  it("is a known product set key", () => {
    expect(isProductSetKey("topps-flagship")).toBe(true);
  });

  it("nests under topps", () => {
    expect(productParentOf("topps-flagship")).toBe("topps");
  });

  it("is its own pricing family (not folded into topps)", () => {
    expect(productFamilyOf("topps-flagship")).toBe("topps-flagship");
  });

  it("is a normalizeSetKey fixed point", () => {
    expect(normalizeSetKey("topps-flagship", "football")).toBe("topps-flagship");
  });

  it("resolveSetKeyForSlug still answers topps-flagship for the 2026 title text", () => {
    expect(resolveSetKeyForSlug("football", "Topps Flagship", 2026)).toBe("topps-flagship");
  });

  it("does not disturb the bare topps sibling", () => {
    expect(resolveSetKeyForSlug("football", "Topps", 2026)).toBe("topps");
    expect(normalizeSetKey("topps", "football")).toBe("topps");
  });
});

describe("panini-select-wnba (basketball) is registered", () => {
  it("is a known product set key", () => {
    expect(isProductSetKey("panini-select-wnba")).toBe(true);
  });

  it("nests under panini-select, same shape as panini-prizm-wnba nests under panini-prizm", () => {
    expect(productParentOf("panini-select-wnba")).toBe("panini-select");
    expect(productParentOf("panini-prizm-wnba")).toBe("panini-prizm");
  });

  it("shares the panini-select pricing family (WNBA rides its own product, not its own price family override)", () => {
    expect(productFamilyOf("panini-select-wnba")).toBe("panini-select");
  });

  it("is a normalizeSetKey fixed point", () => {
    expect(normalizeSetKey("panini-select-wnba", "basketball")).toBe("panini-select-wnba");
  });

  it("resolveSetKeyForSlug still answers panini-select-wnba for both measured years", () => {
    expect(resolveSetKeyForSlug("basketball", "Panini Select WNBA", 2024)).toBe("panini-select-wnba");
    expect(resolveSetKeyForSlug("basketball", "Panini Select WNBA", 2025)).toBe("panini-select-wnba");
  });

  it("does not disturb the NBA panini-select sibling", () => {
    expect(resolveSetKeyForSlug("basketball", "Panini Select", 2024)).toBe("panini-select");
    expect(normalizeSetKey("panini-select", "basketball")).toBe("panini-select");
  });
});
