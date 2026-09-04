// CF-EXQUISITE-IS-ITS-OWN-PRODUCT (Drew 2026-09-04).
//
// Upper Deck Exquisite Collection is a DISTINCT PRODUCT with its own pool and
// must never fold into `upper-deck`. Exquisite is the 2003-04 rookie-patch-auto
// product — LeBron, Wade, Carmelo, Kobe, /99 and tighter — so a fused pool does
// not merely blur a brand: it prices a four-figure RPA off UD base-set comps.
//
// WHAT THE DEFECT LOOKED LIKE, measured read-only against prod 2026-09-04 over
// the 3,670 Exquisite-product pool rows. One product had FOUR fates, because
// which key a sale got depended on how the seller spelled the title:
//     unknown                2,669    no rule named Exquisite at all
//     bowman                   707    and NONE of those titles says "Bowman"
//     upper-deck               270    the bare catch-all ate the maker word
//     exquisite-collection /
//       exquisite                4    the only forms with a key of their own
// Catalog side: 705 rows under `upper-deck-exquisite` (hobbymonitor, 2003) and
// 439 under `exquisite-collection` (baseballcardpedia, 2006) — one product,
// two checklists, two names.
//
// The canonical is `upper-deck-exquisite`: it carries the checklist weight and
// is the maker-prefixed house style, which wins where a checklist backs it.
import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { setKeyAliases } from "../src/services/catalog/setKeyReconciliation.js";
import { productEntry } from "../src/services/catalog/productSetKeys.js";

const CANONICAL = "upper-deck-exquisite";

describe("Exquisite Collection is its own product", () => {
  it("routes every observed Exquisite name form to the one canonical key", () => {
    for (const name of [
      // maker spelled out, the form the checklist uses
      "2003-04 Upper Deck Exquisite Collection",
      "2003 Upper Deck Exquisite Collection Basketball",
      "Upper Deck Exquisite",
      // maker abbreviated, the form vendors write in sale titles
      "2003-04 UD Exquisite Collection Rookie Patch Autograph",
      "2005 Ud Exquisite Collection Football",
      "2012-13 UD Exquisite Black",
      // maker elided entirely
      "Exquisite Collection",
      "2006 Exquisite Basketball",
      // the stored key spellings
      "exquisite",
      "exquisite-collection",
      "upper-deck-exquisite",
      "upper-deck-exquisite-collection",
      "ud-exquisite-collection",
    ]) {
      expect(normalizeSetKey(name), `${name} must reach ${CANONICAL}`).toBe(CANONICAL);
    }
  });

  it("makes the canonical a FIXED POINT", () => {
    // The load-bearing half of "a ruled key MUST be a normalizeSetKey fixed
    // point": if the canonical did not survive the deriver unchanged, the pool
    // could never name the checklist it already has.
    expect(normalizeSetKey(CANONICAL)).toBe(CANONICAL);
    expect(normalizeSetKey(normalizeSetKey("exquisite-collection"))).toBe(CANONICAL);
  });

  it("declares every losing spelling an alias with no chains", () => {
    const aliases = new Map(setKeyAliases());
    for (const k of ["exquisite-collection", "upper-deck-exquisite-collection"]) {
      expect(aliases.get(k), `${k} must be a declared alias`).toBe(CANONICAL);
    }
    // No alias may point at another alias.
    expect(aliases.has(CANONICAL)).toBe(false);
  });

  // ---- THE OTHER DIRECTION. The rule above is unanchored on the maker word,
  // so the pin that matters is the one proving it did NOT widen: a plain Upper
  // Deck insert line with no Exquisite in its name must still fold to
  // `upper-deck`, and CF-UD-INSERT-LINES must still own its own products.
  it("still folds a genuine plain-UD line to `upper-deck` (CF-UD-INSERT-LINES intact)", () => {
    for (const name of ["Upper Deck", "1989 Upper Deck Baseball", "2008 Upper Deck Sweet Spot Baseball"]) {
      expect(normalizeSetKey(name), `${name} must stay upper-deck`).toBe("upper-deck");
    }
  });

  it("leaves the other Upper Deck product lines on their own keys", () => {
    expect(normalizeSetKey("1999 Upper Deck Black Diamond")).toBe("upper-deck-black-diamond");
    expect(normalizeSetKey("Upper Deck MVP")).toBe("upper-deck-mvp");
    expect(normalizeSetKey("Upper Deck Collector's Choice")).toBe("collectors-choice");
    expect(normalizeSetKey("Upper Deck SPx Finite")).toBe("spx-finite");
    expect(normalizeSetKey("upper-deck-retro")).toBe("upper-deck-retro");
    expect(normalizeSetKey("upper-deck-choice")).toBe("upper-deck-choice");
  });

  it("is its own family and refines NOTHING", () => {
    // Exquisite must never widen into the Upper Deck base pool. `refines` is
    // for VERIFIED refinements (a series split); a /99 patch auto and a base
    // set do not share a price curve, so the matcher must not walk up.
    const e = productEntry(CANONICAL);
    expect(e, `${CANONICAL} must be a known product`).toBeTruthy();
    expect(e?.refines ?? null).toBeNull();
    expect(e?.family ?? null).not.toBe("upper-deck");
  });

  // ---- THE MUTATION. If the Exquisite rule is deleted or moved BELOW the bare
  // /upper-deck/ catch-all, the maker-spelled titles fall back into the parent
  // and this goes red — which is exactly the 270 rows the census found there.
  it("MUTATION: a maker-spelled Exquisite title must not land on the parent", () => {
    expect(normalizeSetKey("2003 Upper Deck Exquisite Collection Basketball")).not.toBe("upper-deck");
    // and the elided form must not fall back to a key of its own
    expect(normalizeSetKey("2006 Exquisite Basketball")).not.toBe("exquisite");
  });
});
