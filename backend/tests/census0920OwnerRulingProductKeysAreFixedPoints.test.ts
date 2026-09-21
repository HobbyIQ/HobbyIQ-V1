// R-CENSUS-2026-09-20 (owner widget rulings, Drew). One registration:
//
//   panini-prizm-black (basketball, 2024-25) -- R-A: its own standalone
//   premium Prizm-family product, mirroring the already-registered
//   panini-prizm-wnba / panini-prizm-draft-picks / panini-prizm-monopoly-wnba
//   precedents (P(...) with family/parent, nested under panini-prizm). 19,425
//   unbacked sold_comps sales, 10,792 STRICT catalog rows already resident
//   under this exact key.
//
// It already resolves as a normalizeSetKey / resolveSetKeyForSlug fixed
// point TODAY, before this registration (setkey-reconciliation.json already
// carries it as a census-ruled "distinct" fixed point, and the title parser
// already routes "Prizm Black ..." / "... Black Prizm" title text to this
// key independent of productSetKeys.ts). This pins that registering it
// changes nothing about what the deriver answers, only makes the key
// addressable through productSetKeyForName / isProductSetKey — same shape as
// the topps-flagship / panini-select-wnba registrations.
//
// Registered with P(), not S() (not `spelled`) -- mirrors `topps-chrome-black`
// (productSetKeys.ts:557), the existing precedent for a product name that
// collides with a common finish/parallel word ("Black") inside its own
// parent family. S()'s contiguous-segment-run name matcher would fire on
// any title slug containing the run `prizm-black` in ANY context; P() relies
// on the existing reconciliation fixed point + the parser's own regex
// instead, so no new name-matching surface is introduced by this PR.
//
// RETRACTED 2026-09-20 (owner ruling, later the same day, this batch): this
// note used to say the title parser's Prizm/Black regex routing BOTH
// orderings -- "Prizm Black ..." (a standalone product mention) AND "...
// Black Prizm 1/1" (a plain Prizm card whose only distinguishing feature is
// the Black 1-of-1 finish) -- to "Panini Prizm Black" was PRE-EXISTING, OUT
// OF SCOPE, deliberately ruled behavior. It is not: Drew ruled the second
// ordering wrong. "Black" is part of the PRODUCT phrase only when it sits
// adjacent to "Prizm" BEFORE the player/number ("Prizm Black" -- Prizm
// first); a plain Prizm title that merely STATES a Black finish ("... Black
// Prizm 1/1", "Black Finite", "Black Gold") names a parallel of the
// ordinary Prizm card, the same way "Silver Prizm" or "Blue Prizm 1/1"
// would, and must stay `panini-prizm`. Fixed by
// CF-BLACK-PRIZM-IS-A-PARALLEL-NOT-A-PRODUCT in parseTitleIdentity.service
// .ts; the pin in deriverStatedParallelAndNamedProduct.test.ts is updated to
// match. The "Prizm Black ..." PRODUCT ordering (this file's next test) is
// UNCHANGED by that ruling and still derives to panini-prizm-black.
import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey, resolveSetKeyForSlug } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service";

describe("panini-prizm-black (basketball) is registered", () => {
  it("is a known product set key", () => {
    expect(isProductSetKey("panini-prizm-black")).toBe(true);
  });

  it("nests under panini-prizm, same shape as panini-prizm-wnba / panini-prizm-draft-picks", () => {
    expect(productParentOf("panini-prizm-black")).toBe("panini-prizm");
    expect(productParentOf("panini-prizm-wnba")).toBe("panini-prizm");
    expect(productParentOf("panini-prizm-draft-picks")).toBe("panini-prizm");
  });

  it("shares the panini-prizm pricing family (same shape as panini-prizm-wnba)", () => {
    expect(productFamilyOf("panini-prizm-black")).toBe("panini-prizm");
    expect(productFamilyOf("panini-prizm-wnba")).toBe("panini-prizm");
  });

  it("is a normalizeSetKey fixed point", () => {
    expect(normalizeSetKey("panini-prizm-black", "basketball")).toBe("panini-prizm-black");
  });

  it("resolveSetKeyForSlug still answers panini-prizm-black for the 2024/2025 title text", () => {
    expect(resolveSetKeyForSlug("basketball", "Panini Prizm Black", 2024)).toBe("panini-prizm-black");
    expect(resolveSetKeyForSlug("basketball", "Panini Prizm Black", 2025)).toBe("panini-prizm-black");
  });

  it("a title naming the Prizm Black product still derives to panini-prizm-black (unchanged by this PR)", () => {
    const family = inferSetKeyFromTitle("2024-25 Panini Prizm Black Victor Wembanyama #1", "1");
    expect(normalizeSetKey(family, "basketball")).toBe("panini-prizm-black");
  });

  it(
    "FIXED 2026-09-20: a plain Prizm title whose only Black mention is the trailing 1-of-1 " +
      "parallel derives to panini-prizm, not panini-prizm-black (CF-BLACK-PRIZM-IS-A-PARALLEL-" +
      "NOT-A-PRODUCT; see deriverStatedParallelAndNamedProduct.test.ts for the full class)",
    () => {
      const family = inferSetKeyFromTitle(
        "2024-25 Panini Prizm Basketball Victor Wembanyama Black Prizm 1/1",
        "1",
      );
      expect(normalizeSetKey(family, "basketball")).toBe("panini-prizm");
    },
  );

  it("does not disturb the bare panini-prizm sibling for other colour parallels", () => {
    expect(resolveSetKeyForSlug("basketball", "Panini Prizm", 2024)).toBe("panini-prizm");
    expect(normalizeSetKey("panini-prizm", "basketball")).toBe("panini-prizm");

    const silverFamily = inferSetKeyFromTitle(
      "2024-25 Panini Prizm Basketball Victor Wembanyama Silver Prizm #1",
      "1",
    );
    expect(normalizeSetKey(silverFamily, "basketball")).toBe("panini-prizm");

    const blueFamily = inferSetKeyFromTitle(
      "2024-25 Panini Prizm Basketball Victor Wembanyama Blue Prizm 1/1",
      "1",
    );
    expect(normalizeSetKey(blueFamily, "basketball")).toBe("panini-prizm");
  });

  it("does not disturb the panini-prizm-wnba sibling", () => {
    expect(resolveSetKeyForSlug("basketball", "Panini Prizm WNBA", 2024)).toBe("panini-prizm-wnba");
    expect(normalizeSetKey("panini-prizm-wnba", "basketball")).toBe("panini-prizm-wnba");
  });
});
