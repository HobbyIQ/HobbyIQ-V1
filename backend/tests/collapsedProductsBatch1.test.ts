// CF-COLLAPSED-SETKEY-AUDIT batch 1 (Drew, 2026-08-17).
//
// The audit measured 1,634,282 sales (15.2% of the index) sitting on a setKey
// their own setName contradicts. This batch takes the products where
// card_catalog ALREADY carries a canonical key — so the fix is matching the
// catalog, not inventing vocabulary:
//
//     Topps Cosmic Chrome        65,366 sales    34,184 catalog rows
//     Panini Prizm Draft Picks   65,582 sales    36,108 catalog rows
//     Donruss Elite              31,403 sales   236,976 catalog rows
//     Topps Now                  23,247 sales    14,226 catalog rows
//     Bowman Platinum            12,748 sales   111,878 catalog rows
//     Collector's Choice         11,277 sales   184,716 catalog rows
//     Upper Deck MVP              4,541 sales     3,117 catalog rows
//
// The sales and the checklist for one product were filed under different keys,
// so each pool could never meet its own catalog.

import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("CF-COLLAPSED-SETKEY-AUDIT batch 1 — products get their own key", () => {
  it("routes each collapsed product to the key its catalog already uses", () => {
    const cases: Array<[string, string]> = [
      ["Topps Cosmic Chrome", "topps-cosmic-chrome"],
      ["2024 Topps Cosmic Chrome Baseball", "topps-cosmic-chrome"],
      ["Topps Now", "topps-now"],
      ["Panini Prizm Draft Picks", "panini-prizm-draft-picks"],
      ["Donruss Elite", "donruss-elite"],
      ["Bowman Platinum", "bowman-platinum"],
      ["Collector's Choice", "collectors-choice"],
      ["Upper Deck Collector's Choice", "collectors-choice"],
      ["Upper Deck MVP", "upper-deck-mvp"],
    ];
    for (const [name, want] of cases) {
      expect(normalizeSetKey(name), `"${name}"`).toBe(want);
    }
  });

  it("does not let the new plain-Elite rule swallow Elite Extra Edition", () => {
    // Extra Edition already had rules pinning panini-elite-extra-edition, and
    // the first cut of the plain-Elite pattern hijacked them. The negative
    // lookahead is the fix — a new rule in front of a catch-all must not eat
    // something that was already correct.
    expect(normalizeSetKey("Elite Extra Edition")).toBe("panini-elite-extra-edition");
    expect(normalizeSetKey("Panini Elite Extra Edition")).toBe("panini-elite-extra-edition");
    expect(normalizeSetKey("Donruss Elite")).toBe("donruss-elite");
  });

  it("leaves Flair Showcase pooling into Flair — that collapse is DELIBERATE", () => {
    // The audit flagged this because it compares words, not intent. It is
    // pinned by hobbyIqCardId.test.ts as "both variants pool", the same class
    // as Bowman Chrome Prospects folding into bowman-chrome. Read the audit
    // report; do not sweep it.
    expect(normalizeSetKey("Flair Showcase")).toBe("flair");
  });

  /**
   * The regression half. Every one of these rules sits in front of a catch-all,
   * so the risk is not that the new product fails to match — it is that the new
   * pattern eats something that was already correct.
   */
  it("leaves every neighbouring product exactly where it was", () => {
    const unchanged: Array<[string, string]> = [
      ["Topps", "topps"],
      ["2024 Topps Chrome", "topps-chrome"],
      ["Topps Stadium Club", "topps-stadium-club"],
      ["Topps Heritage", "topps-heritage"],
      ["Panini Prizm", "panini-prizm"],
      ["Panini Select", "panini-select"],
      ["Donruss", "panini-donruss"],
      ["Donruss Optic", "panini-optic"],
      ["Bowman", "bowman"],
      ["Bowman Chrome", "bowman-chrome"],
      ["Bowman's Best", "bowmans-best"],
      ["Bowman Draft", "bowman-draft"],
      ["Upper Deck", "upper-deck"],
      ["Fleer Ultra", "ultra"],
      ["Fleer", "fleer"],
    ];
    for (const [name, want] of unchanged) {
      expect(normalizeSetKey(name), `"${name}" moved`).toBe(want);
    }
  });
});
