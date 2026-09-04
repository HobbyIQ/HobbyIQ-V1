import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/**
 * CF-THE-YEAR-DOES-NOT-SPLIT-THE-PRODUCT (Drew, 2026-08-31).
 *
 * Every product rule in inferSetKeyFromTitle is written as adjacent words
 * (/topps\s+chrome/), but sellers and CardHedge's own slab-derived titles
 * routinely write brand, then year, then the rest of the product. The
 * interposed year defeated the adjacency and the row collapsed to the bare
 * brand:
 *
 *   "2024 Topps Chrome Update ... X-Fractor"  -> Topps Chrome   (correct)
 *   "Topps 2024 Chrome Update ... X-Fractor"  -> Topps          (the SAME card)
 *
 * Measured on the 2026-08-31 setKey-misfile slice: 60 of 153 rows, the single
 * largest bucket, and the reason those rows looked like "the title's product
 * IS the slug's product" when the title plainly said Chrome Update.
 */
describe("an interposed year does not split a product name", () => {
  it("reads the product when the year sits between brand and product", () => {
    expect(inferSetKeyFromTitle("Topps 2024 Chrome Yamamoto X-Fractor RC #18"))
      .toBe("Topps Chrome");
    // CF-COLLAPSE-IS-FORBIDDEN (Drew, 2026-09-03, ruling V1). This line used
    // to expect "Topps Chrome": the year-lifting worked, but the product it
    // then read was the FLAGSHIP, because Topps Chrome Update Series had no
    // rule of its own. That is the ruled collapse -- 186 rows sampled by the
    // census, 199,838 catalog rows on topps-chrome-update-series.
    //
    // The rule this file pins is UNCHANGED and is what makes the assertion
    // possible: "Topps 2024 Chrome Update" still reads as one product name
    // across the interposed year. It now reads as the RIGHT one.
    expect(inferSetKeyFromTitle("Topps 2024 Chrome Update Paul Skenes X-Fractor #USC88"))
      .toBe("Topps Chrome Update Series");
    expect(inferSetKeyFromTitle("Topps 2024 Finest Aaron Judge X-Fractor"))
      .toBe("Topps Finest");
    expect(inferSetKeyFromTitle("Bowman 2024 Chrome Prospects BCP-102 Refractor"))
      .toBe("Bowman Chrome");
    expect(inferSetKeyFromTitle("Panini 2023 Prizm Silver")).toBe("Panini Prizm");
  });

  it("reads the conventional word order identically", () => {
    // The whole point is that the two spellings are ONE product.
    for (const [a, b] of [
      ["2024 Topps Chrome Yamamoto X-Fractor", "Topps 2024 Chrome Yamamoto X-Fractor"],
      ["2024 Topps Pro Debut #PDC-171 X-Fractor", "Topps 2024 Pro Debut #PDC-171 X-Fractor"],
    ]) {
      expect(inferSetKeyFromTitle(a), a).toBe(inferSetKeyFromTitle(b));
    }
  });

  it("leaves a title with no interposed year exactly as it was", () => {
    expect(inferSetKeyFromTitle("2024 Topps Series 1 - BOBBY WITT JR - X-Fractor")).toBe("Topps");
    expect(inferSetKeyFromTitle("1989 Topps Ken Griffey Jr RC")).toBe("Topps");
    expect(inferSetKeyFromTitle("2024 Topps Allen Ginter Julio Rodriguez")).toBe("Topps Allen Ginter");
  });

  it("only lifts a year that follows a brand word", () => {
    // A bare leading year is the set year and was never in the way; a number
    // that is not a year is not touched at all.
    expect(inferSetKeyFromTitle("2024 Topps Chrome #44 X-Fractor")).toBe("Topps Chrome");
    expect(inferSetKeyFromTitle("Topps Chrome 44 X-Fractor")).toBe("Topps Chrome");
  });
});
