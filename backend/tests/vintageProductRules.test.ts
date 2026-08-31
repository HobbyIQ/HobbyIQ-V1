// CF-VINTAGE-PRODUCT-RULES (Drew, 2026-08-17).
//
// Vintage and oddball products had NO vocabulary rule, so they slugified
// year-prefixed and slugGuard correctly refused every one. Measured over the
// 6.2h after the ingest fix deployed: ~17,300 sports rows land unkeyed per day
// for exactly this reason, and the SAME handful of products recur daily — so
// each rule here pays forever rather than once.
//
// Vintage products also never change, which is why this is worth pinning: the
// 1915 Cracker Jack checklist will not be revised.

import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";

describe("CF-VINTAGE-PRODUCT-RULES", () => {
  it("gives each vintage product a clean key the guard accepts", () => {
    const cases: Array<[string, string]> = [
      ["1909-11 T206 Baseball", "t206"],
      ["1940 Play Ball Baseball", "play-ball"],
      ["1941 Play Ball Baseball", "play-ball"],
      ["1970 Kellogg's Baseball", "kelloggs"],
      ["1962 Post Cereal Baseball", "post-cereal"],
      ["1961 Golden Press Hall of Fame Baseball", "golden-press"],
      ["1915 Cracker Jack Baseball", "cracker-jack"],
      ["1933 Goudey Baseball", "goudey"],
    ];
    for (const [name, want] of cases) {
      const key = normalizeSetKey(name);
      expect(key, `"${name}"`).toBe(want);
      // The point is not the key — it is that the guard now ACCEPTS it. A
      // year-prefixed key is refused as a raw vendor string, which is why these
      // products produced no slug at all.
      const guard = guardSlugInputs({
        sport: "baseball", year: 1970, normalizedSetKey: key, cardNumber: "1",
      });
      expect(guard.ok, `"${name}" still refused: ${guard.reasons.join(",")}`).toBe(true);
    }
  });

  it("keeps the modern namesakes distinct from the vintage lines", () => {
    // Topps Cracker Jack (2,848 catalog rows) is a MODERN product, not the 1915
    // line. Panini Diamond Kings and All-Time Diamond Kings are likewise
    // separate from the base diamond-kings key (38,183 rows).
    expect(normalizeSetKey("Topps Cracker Jack")).toBe("topps-cracker-jack");
    expect(normalizeSetKey("1915 Cracker Jack Baseball")).toBe("cracker-jack");
    expect(normalizeSetKey("2018 Panini Diamond Kings Baseball")).toBe("panini-diamond-kings");
    expect(normalizeSetKey("All-Time Diamond Kings")).toBe("all-time-diamond-kings");
  });

  /** These rules sit near several catch-alls, so the risk is eating a neighbour. */
  it("leaves every neighbouring product where it was", () => {
    const unchanged: Array<[string, string]> = [
      ["Topps", "topps"],
      ["2024 Topps Chrome", "topps-chrome"],
      ["Topps Cosmic Chrome", "topps-cosmic-chrome"],
      ["Topps Now", "topps-now"],
      ["Topps Heritage", "topps-heritage"],
      ["Topps Stadium Club", "topps-stadium-club"],
      ["Bowman", "bowman"],
      ["Bowman's Best", "bowmans-best"],
      ["Donruss", "panini-donruss"],
      // D31 (Drew 2026-08-31): Optic is ONE product, spelled donruss-optic.
      ["Donruss Optic", "donruss-optic"],
      ["Donruss Elite", "donruss-elite"],
      ["Donruss Studio", "donruss-studio"],
      ["Fleer", "fleer"],
      ["Fleer Ultra", "ultra"],
      ["Fleer Tradition", "fleer-tradition"],
      ["Panini Prizm", "panini-prizm"],
      ["Panini Prizm WNBA", "panini-prizm-wnba"],
      ["Flair Showcase", "flair"],
      ["Upper Deck", "upper-deck"],
      ["Collector's Choice", "collectors-choice"],
    ];
    for (const [name, want] of unchanged) {
      expect(normalizeSetKey(name), `"${name}" moved`).toBe(want);
    }
  });
});
