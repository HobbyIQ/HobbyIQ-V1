import { describe, it, expect } from "vitest";
import { narrowToNamedProduct, scoreCatalogRow, PRODUCT_WORDS } from "../src/services/catalog/catalogSearch.service.js";

// CF-A-SPORT-IS-NOT-A-PRODUCT (2026-08-29). Real shapes from the identity
// triangulation re-run: the top-scored row was dropped by the product
// narrowing because the query said "Baseball" and the row's setName did not.
const tok = (q: string) => q.toLowerCase().replace(/[^a-z0-9#-]+/g, " ").replace(/#/g, "").trim().split(/\s+/).filter(Boolean);

describe("a sport is not a product", () => {
  it("BD-143 Base: the Beckett Base row (setName without the sport word) survives the narrowing and wins", () => {
    const tokens = tok("2025 Bowman Draft Baseball #BD-143 Base");
    const base = { slug: "hiq:baseball:2025:bowman-draft:bd-143:base:no-auto", setKey: "bowman-draft", setName: "Bowman Draft", cardNumber: "BD-143", year: 2025, parallel: "Base", parallelSlug: "base", playerName: "Brody Brecht" };
    const baseCards = { slug: "hiq:baseball:2025:bowman-draft:bd-143:base-cards:no-auto", setKey: "bowman-draft", setName: "2025 Bowman Draft Baseball", cardNumber: "BD-143", year: 2025, parallel: "Base Cards", parallelSlug: "base-cards", playerName: "Brody Brecht" };
    const scored = [base, baseCards].map((h) => ({ ...h, score: scoreCatalogRow(tokens, h)!.score })).sort((a, b) => b.score - a.score);
    expect(scored[0].slug).toBe(base.slug);
    const kept = narrowToNamedProduct(tokens, scored);
    expect(kept.map((h) => h.slug)).toContain(base.slug);
    expect(kept[0].slug).toBe(base.slug);
  });

  it("TCA-ARU Base: topps-chrome (setName 'Topps Chrome') is not dropped in favour of topps-chrome-black ('... Black Baseball')", () => {
    const tokens = tok("2023 Topps Chrome Baseball #TCA-ARU Base");
    const right = { slug: "hiq:baseball:2023:topps-chrome:tca-aru:base:no-auto", setKey: "topps-chrome", setName: "Topps Chrome", cardNumber: "TCA-ARU", year: 2023, parallel: "Base", parallelSlug: "base", playerName: "Adley Rutschman" };
    const wrong = { slug: "hiq:baseball:2023:topps-chrome-black:cba-mr:base:auto", setKey: "topps-chrome-black", setName: "2023 Topps Chrome Black Baseball", cardNumber: "CBA-MR", year: 2023, parallel: "Base", parallelSlug: "base", playerName: "Someone Else", isAuto: true };
    const scored = [right, wrong].map((h) => ({ ...h, score: scoreCatalogRow(tokens, h)!.score })).sort((a, b) => b.score - a.score);
    const kept = narrowToNamedProduct(tokens, scored);
    expect(kept[0].slug).toBe(right.slug);
  });

  it("the narrowing still narrows on real product words: 2018 bowman chrome ohtani keeps bowman-chrome only", () => {
    const tokens = tok("2018 bowman chrome ohtani");
    const hits = [
      { slug: "a", setKey: "topps", setName: "Topps" },
      { slug: "b", setKey: "bowman-chrome", setName: "Bowman Chrome" },
      { slug: "c", setKey: "bowman", setName: "Bowman" },
      { slug: "d", setKey: "bowman-chrome-sapphire", setName: "Bowman Chrome Sapphire Edition" },
      { slug: "e", setKey: "topps-chrome", setName: "Topps Chrome" },
    ];
    expect(narrowToNamedProduct(tokens, hits).map((h) => h.slug).sort()).toEqual(["b", "d"]);
  });

  it("sport and finish words are not product words", () => {
    for (const w of ["baseball", "basketball", "football", "hockey", "soccer", "base", "refractor", "auto", "rookie", "card", "cards", "insert", "parallel", "numbered"]) {
      expect(PRODUCT_WORDS.has(w), w).toBe(false);
    }
  });
});
