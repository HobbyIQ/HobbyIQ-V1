/**
 * CF-A-CARD-NUMBER-SUBSET-IS-NOT-A-WHOLE-PRODUCT (2026-09-25) -- real unit
 * tests for `scripts/lib/card-number-scope.cjs`, the pure helper
 * `rekey-product-setkey`'s CARD_NUMBER_SCOPE option is built on.
 *
 * WHY A SEPARATE LIB MODULE. `rekey-product-setkey.cjs` has no
 * `module.exports` and builds a Cosmos client eagerly in `main()`, called
 * unconditionally at the bottom of the file -- `require`-ing the script
 * itself runs that main() immediately. Pulling the id-parsing piece into its
 * own file (the same shape `market-guard.cjs` / `name-agreement.cjs` already
 * use for this script's other pure decisions) is what makes calling the
 * scope predicate with plain strings possible at all.
 *
 * THE DEFECT THIS PINS. The id shape is `hiq:sport:year:setKey[:sub-{slug}]:
 * number:parallel:auto[:num-N]` (hobbyIqCardId.service.ts's
 * `parseHobbyIqCardId`, ~L3257-3274). A row minted with a subset
 * (`subsetInId`) carries an OPTIONAL `sub-{slug}` segment right after setKey,
 * pushing the card number from index 4 to index 5. A caller reading a
 * literal `[4]` would score `hiq:baseball:2026:bowman-chrome:sub-cards-that-
 * never-were:bma-1:base:no-auto`'s card number as the STRING
 * "sub-cards-that-never-were" -- which fails every scope check silently, so
 * the row is reported as an ordinary out-of-scope skip and stranded at FROM.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { cardNumberSegmentOf, matchesCardNumberScope } = require_("../scripts/lib/card-number-scope.cjs") as {
  cardNumberSegmentOf: (id: unknown) => string;
  matchesCardNumberScope: (id: unknown, scopeList: string[]) => boolean;
};

const PLAIN = "hiq:baseball:2026:bowman-chrome:bma-1:base:no-auto";
const SUBSET = "hiq:baseball:2026:bowman-chrome:sub-cards-that-never-were:bma-1:base:no-auto";
const OTHER_NUMBER = "hiq:baseball:2026:bowman-chrome:bcp-1:base:no-auto";
const SUBSET_OTHER_NUMBER = "hiq:baseball:2026:bowman-chrome:sub-cards-that-never-were:bcp-1:base:no-auto";

describe("cardNumberSegmentOf: the id's own card-number segment", () => {
  it("an ORDINARY id (no subset): the card number is index 4", () => {
    expect(cardNumberSegmentOf(PLAIN)).toBe("bma-1");
  });

  it("a SUBSET id: the card number is index 5, not the sub- segment at index 4", () => {
    expect(cardNumberSegmentOf(SUBSET)).toBe("bma-1");
  });

  it("a subset id's own subset SLUG never leaks through as the card number", () => {
    expect(cardNumberSegmentOf(SUBSET)).not.toBe("sub-cards-that-never-were");
    expect(cardNumberSegmentOf(SUBSET)).not.toContain("sub-");
  });

  it("a malformed or empty id returns \"\", never throws", () => {
    expect(cardNumberSegmentOf("")).toBe("");
    expect(cardNumberSegmentOf(null)).toBe("");
    expect(cardNumberSegmentOf(undefined)).toBe("");
    expect(cardNumberSegmentOf("not-a-hiq-id")).toBe("");
  });

  it("a print-run tail (:num-N) does not shift anything -- it sits after the segment this function reads", () => {
    expect(cardNumberSegmentOf(`${PLAIN}:num-499`)).toBe("bma-1");
    expect(cardNumberSegmentOf(`${SUBSET}:num-499`)).toBe("bma-1");
  });
});

describe("matchesCardNumberScope: prefix-or-exact, case-insensitive, subset-aware", () => {
  it("a plain id's card number matching a prefix is IN scope", () => {
    expect(matchesCardNumberScope(PLAIN, ["bma-"])).toBe(true);
  });

  it("a SUBSET id's card number matching a prefix is IN scope -- the fix under test", () => {
    expect(matchesCardNumberScope(SUBSET, ["bma-"])).toBe(true);
  });

  it("bcp-1 stays OUT of scope for a bma- prefix (plain id)", () => {
    expect(matchesCardNumberScope(OTHER_NUMBER, ["bma-"])).toBe(false);
  });

  it("bcp-1 stays OUT of scope for a bma- prefix EVEN when the id also carries a subset segment", () => {
    // The regression this fix targets: before it, a subset id's mis-read
    // "card number" (the subset slug itself) would ALSO never start with
    // "bma-", so this particular case could look "correct" by accident. The
    // PLAIN-vs-SUBSET pair above is what actually catches the bug; this case
    // just confirms the negative still holds once the read is fixed.
    expect(matchesCardNumberScope(SUBSET_OTHER_NUMBER, ["bma-"])).toBe(false);
  });

  it("case-insensitive: BMA-1 matches a lower-case bma- scope", () => {
    expect(matchesCardNumberScope("hiq:baseball:2026:bowman-chrome:BMA-1:base:no-auto", ["bma-"])).toBe(true);
  });

  it("case-insensitive on a subset id too", () => {
    expect(matchesCardNumberScope("hiq:baseball:2026:bowman-chrome:sub-cards-that-never-were:BMA-1:base:no-auto", ["bma-"])).toBe(true);
  });

  it("exact-number match, not just prefix", () => {
    expect(matchesCardNumberScope("hiq:baseball:2026:score:137:base:no-auto", ["137"])).toBe(true);
    expect(matchesCardNumberScope("hiq:baseball:2026:score:1370:base:no-auto", ["137"])).toBe(true); // prefix arm, by design
    expect(matchesCardNumberScope("hiq:baseball:2026:score:13:base:no-auto", ["137"])).toBe(false);
  });

  it("an empty scope list means everything is in scope -- the no-option-set default", () => {
    expect(matchesCardNumberScope(PLAIN, [])).toBe(true);
    expect(matchesCardNumberScope(SUBSET, [])).toBe(true);
    expect(matchesCardNumberScope("garbage", [])).toBe(true);
  });

  it("a malformed id with a NON-empty scope is OUT of scope, not a crash", () => {
    expect(matchesCardNumberScope("not-a-hiq-id", ["bma-"])).toBe(false);
  });

  it("multiple prefixes: the Mega Box dispatch's own list", () => {
    const scope = ["bma-", "rma-", "bst-", "es-"];
    expect(matchesCardNumberScope("hiq:baseball:2026:bowman-chrome:rma-7:base:no-auto", scope)).toBe(true);
    expect(matchesCardNumberScope("hiq:baseball:2026:bowman-chrome:bst-3:base:no-auto", scope)).toBe(true);
    expect(matchesCardNumberScope("hiq:baseball:2026:bowman-chrome:es-12:base:no-auto", scope)).toBe(true);
    expect(matchesCardNumberScope("hiq:baseball:2026:bowman-chrome:137:base:no-auto", scope)).toBe(false);
  });
});

// ── MUTATION CHECKS ─────────────────────────────────────────────────────────

describe("MUTATION: a regression back to a literal [4] must fail these", () => {
  it("PLAIN vs SUBSET must extract the SAME card number -- a literal [4] would return different strings for the two", () => {
    // This is the mutation-catcher the reviewer asked for: revert
    // cardNumberSegmentOf to `String(id ?? "").split(":")[4]` and PLAIN still
    // returns "bma-1" (accidentally correct) but SUBSET returns
    // "sub-cards-that-never-were" -- this equality breaks immediately.
    expect(cardNumberSegmentOf(SUBSET)).toBe(cardNumberSegmentOf(PLAIN));
  });

  it("a SUBSET id must be scoped IDENTICALLY to its PLAIN twin under every prefix", () => {
    for (const scope of [["bma-"], ["rma-"], ["137"], []]) {
      expect(matchesCardNumberScope(SUBSET, scope)).toBe(matchesCardNumberScope(PLAIN, scope));
    }
  });

  it("the sub- prefix check is on index 4 specifically, not \"any segment\"", () => {
    // A card number that itself happens to start with "sub-" (not a real
    // vendor shape today, but the guard is a PREFIX check on ONE segment,
    // not a scan) is read as a subset marker at index 4 and the true number
    // moves to index 5 -- documenting the boundary this function draws.
    const weird = "hiq:baseball:2026:bowman-chrome:sub-1:base:no-auto";
    expect(cardNumberSegmentOf(weird)).toBe("base"); // index 5 here is "base" (parallel slot), a malformed id in practice
    // The point of this test is the RULE (index 4's prefix decides), not that
    // this particular malformed shape is meaningful -- real ids never put a
    // number-shaped token right after setKey without it being a genuine
    // subset slug.
  });
});
