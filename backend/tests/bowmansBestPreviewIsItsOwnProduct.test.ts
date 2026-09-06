/**
 * BOWMAN'S BEST PREVIEW IS ITS OWN PRODUCT (Drew, 2026-09-06).
 *
 * A twenty-card insert, BBP1-BBP20, packed out in 1997 Bowman (baseball) and
 * in 1997-98 Topps Stadium Club (basketball). ONE product key for both sports
 * -- `bowmans-best-preview` -- because it is ONE insert, and the sport segment
 * of the id already keeps the two rosters apart:
 *
 *   hiq:baseball:1997:bowmans-best-preview:bbp4:atomic-refractor:no-auto
 *   hiq:basketball:1997:bowmans-best-preview:bbp1:refractor:no-auto
 *
 * WHY THE RULING EXISTS, and it is not an abstract taxonomy point. #1846
 * reparented the Preview off flagship Bowman and onto `bowmans-best`. That was
 * the right DIRECTION and the wrong ADDRESS, and the 2026-09-06 ingest is what
 * the wrong address cost: the insert kept the source page's own 1-20 numbering
 * and 60 catalog rows landed at
 *
 *   hiq:baseball:1997:bowmans-best:<1..20>:{base,refractor,atomic-refractor}
 *
 * -- inside the parent's number space, on top of Bowman's Best #1-#20, which
 * are TWENTY DIFFERENT CARDS. One address holding two cards is the mirror of
 * one card at two addresses and is harder to see, because nothing refuses: the
 * rows write cleanly and then price each other.
 *
 * THE MARKET ALREADY NUMBERS THESE CARDS BBP<n>. Measured read-only in
 * sold_comps on 2026-09-06, every 1997 Preview sale on an identity slug --
 * 12 across 11 `:bowman:` keys and 4 across 3 `:bowmans-best:` keys -- carries
 * a BBP number, and no Bowman's Best card has one. A product whose cards the
 * market addresses by their own prefix is a product.
 *
 * WHAT IS PINNED HERE, in the three places the key has to hold:
 *
 *   1. `normalizeSetKey` -- the ruled key is a FIXED POINT. Two unanchored
 *      patterns, `/bowmans?-best/` and `/^bowman/`, both match it on its own
 *      prefix, and the first would win: without the ruling the key normalizes
 *      to `bowmans-best` and is not a key at all.
 *   2. `inferSetKeyFromTitle` -- the market's PHRASE reaches it, in every
 *      spelling the pool actually carries, from BOTH hosts.
 *   3. `normalizeHoldingFields` -- a holding whose setName has the rung jammed
 *      into it still names the PRODUCT.
 */
import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeHoldingFields } from "../src/services/portfolioiq/holdingFieldNormalizer.service.js";
import { reconciledFixedPoints, ruledDistinct } from "../src/services/catalog/setKeyReconciliation.js";
import { productEntry } from "../src/services/catalog/productSetKeys.js";

const KEY = "bowmans-best-preview";

// -- 1. the ruled key is a fixed point ---------------------------------------

describe("a ruled key MUST be a normalizeSetKey fixed point", () => {
  it("normalizeSetKey leaves it alone", () => {
    expect(normalizeSetKey(KEY)).toBe(KEY);
  });

  it("it is DECLARED, not merely incidental -- the reconciliation carries it", () => {
    // A key that happens to survive today's rule order is not ruled. The
    // declaration is what makes it survive a rule someone adds tomorrow.
    expect(reconciledFixedPoints()).toContain(KEY);
    const ruled = ruledDistinct().find((r) => r.setKey === KEY);
    expect(ruled, "the ruling must carry its reason").toBeTruthy();
    expect(String(ruled?.why)).toMatch(/2026-09-06/);
  });

  it("the product table declares it, so this invents no vocabulary", () => {
    const entry = productEntry(KEY);
    expect(entry, `${KEY} must be a declared product`).toBeTruthy();
    // Its PARENT is the product it previews -- that is the family ladder --
    // but it is not a rung of it, which is what its own key says.
    expect(entry?.parent).toBe("bowmans-best");
  });

  it("THE PARENT IS UNTOUCHED -- one ruling, not two", () => {
    // The whole risk of a prefix-shaped key is that the rule written for it
    // swallows the product it is a prefix of.
    expect(normalizeSetKey("bowmans-best")).toBe("bowmans-best");
    expect(normalizeSetKey("Bowman's Best")).toBe("bowmans-best");
    expect(normalizeSetKey("bowman-best-university")).toBe("bowman-best-university");
    expect(normalizeSetKey("bowman")).toBe("bowman");
  });

  it("every spelling the pool carries lands on the ONE key", () => {
    for (const spelling of [
      "Bowman's Best Preview",
      "Bowmans Best Preview",
      "bowmans-best-preview",
      "1997 Bowman's Best Previews",
      "Bowman's Best Preview Atomic Refractor",
    ]) {
      expect(normalizeSetKey(spelling), `${spelling} must reach ${KEY}`).toBe(KEY);
    }
  });
});

// -- 2. the market phrase reaches it, from both hosts -------------------------

describe("the title deriver reads the Preview out of a title that also names its host", () => {
  // Real titles, quoted from sold_comps and from Drew's own holdings, measured
  // 2026-09-06. Each one names the HOST BRAND in the same breath as the
  // insert, which is exactly why the rule has to be ordered above both the
  // Bowman rules and the Stadium Club rule.
  const TITLES: Array<[string, string]> = [
    ["1997 Bowman Bowman's Best Prev Derek Jeter Atomic #BBP4", "Drew's holding 437f010d -- the market's 'Prev' abbreviation"],
    ["1997 Bowman Bowman's Best Refractor Derek Jeter Preview Atomic #BBP4", "Drew's holding 5979f485 -- the words are out of order"],
    ["1997 BOWMAN'S BEST PREVIEW ATOMIC REFRACTOR #BBP2 KEN GRIFFEY JR. PSA 8", "tca-ebay::128017210073, all caps"],
    ["1997 Bowman's Best Preview Mark Mcgwire #BBP6", "tca-ebay::157333744919"],
    ["MARK MCGWIRE 1997 BOWMAN'S BEST PREVIEW REFRACTOR BASEBALL PSA 9 CRACKED CASE", "tca-ebay::287513422385, player first"],
    ["1997-98 Topps Stadium Club Bowman's Best Previews Refractor #BBP1 Allen Iverson - Raw 10", "the BASKETBALL host, plural"],
    ["1997-98 Stadium Club #BBP1 Allen Iverson Bowman's Best Preview Refractor - Raw 10", "basketball, bare Stadium Club"],
  ];

  it.each(TITLES)("%s", (title) => {
    expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe(KEY);
  });

  it("STATED PLAINLY: a title that never says Preview is NOT reached, and must not be", () => {
    // Six of the sixteen 1997 Preview sales measured on 2026-09-06 are
    // CardHedge titles reading "1997 1997 Bowman's Best Baseball #BBP2 Atomic
    // Refractor" -- the BBP number is the only evidence they carry, and a
    // title deriver that inferred the product from a card NUMBER would be
    // guessing about identity from a field the checklist owns.
    //
    // Those rows are moved by the POOL LIST in this PR, where each entry
    // quotes the evidence and a human read it. This test exists so the gap is
    // recorded rather than discovered later as a surprise.
    const t = "1997 1997 Bowman's Best Baseball #BBP2 Atomic Refractor";
    expect(normalizeSetKey(inferSetKeyFromTitle(t))).not.toBe(KEY);
  });

  it("THE GAP IS BOUNDED -- Preview must be near the product, not merely present", () => {
    // An unbounded gap is how a rule like this starts claiming products it was
    // never about. Five intervening words is what the measured titles need;
    // a Preview word further away than that does not pair.
    const near = "1997 Bowman's Best Refractor Derek Jeter Preview Atomic #BBP4";
    const far = "1997 Bowman's Best Baseball #100 Jeter Refractor PSA 9 mint slab pop 2 Preview of the auction";
    expect(normalizeSetKey(inferSetKeyFromTitle(near))).toBe(KEY);
    expect(normalizeSetKey(inferSetKeyFromTitle(far))).not.toBe(KEY);
  });

  it("THE COUNTER-CASE: a title that names Bowman's Best and NOT the Preview is untouched", () => {
    // The rule must read the word PREVIEW, never infer it from a BBP number or
    // from the parent's name. A real Bowman's Best sale keeps its own product.
    const t = "1997 Bowman's Best Baseball #100 Derek Jeter Refractor";
    expect(normalizeSetKey(inferSetKeyFromTitle(t))).not.toBe(KEY);
  });

  it("THE COUNTER-CASE: an ordinary Stadium Club title keeps topps-stadium-club", () => {
    const t = "1997-98 Topps Stadium Club #118 Michael Jordan";
    expect(inferSetKeyFromTitle(t)).toBe("Topps Stadium Club");
    expect(normalizeSetKey(inferSetKeyFromTitle(t))).toBe("topps-stadium-club");
  });
});

// -- 3. a holding's own field reaches the key --------------------------------

describe("the holding normalizer: the Preview is the product, the rung is not part of it", () => {
  it("strips the rung the importer jammed into setName", () => {
    // Drew's holding 437f010d, verbatim: setName says the rung, and the
    // parallel field says it again.
    const r = normalizeHoldingFields({
      setName: "Bowmans Best Preview Atomic Refractor",
      parallel: "Atomic Refractor",
      cardYear: 1997,
    } as never);
    expect(r.fields.setName).toBe("Bowman's Best Preview");
    expect(normalizeSetKey(String(r.fields.setName))).toBe(KEY);
    // The rung is untouched where it belongs.
    expect(r.fields.parallel).toBe("Atomic Refractor");
    // The change is auditable, like every other rule in that file.
    expect(r.changes.some((c) => c.rule === "setName_bowmans_best_preview_is_the_product")).toBe(true);
  });

  it("is idempotent -- normalize(normalize(x)) === normalize(x)", () => {
    const once = normalizeHoldingFields({ setName: "Bowmans Best Preview Refractor", cardYear: 1997 } as never);
    const twice = normalizeHoldingFields(once.fields);
    expect(twice.fields.setName).toBe(once.fields.setName);
    expect(twice.changes.some((c) => c.rule === "setName_bowmans_best_preview_is_the_product")).toBe(false);
  });

  it("NEVER INVENTS THE PREVIEW: a bare Bowman's Best setName is left exactly as it is", () => {
    // Drew's OTHER holding (5979f485) reads setName "1997 Bowman's Best" and
    // names the Preview only in its title. A field-level normalizer does not
    // read titles, and guessing here would move a genuine Bowman's Best
    // holding off its own pool. That row is repaired by the ruling dispatch,
    // which is the sanctioned path for a stored row.
    const r = normalizeHoldingFields({ setName: "1997 Bowman's Best", parallel: "Atomic Refractor", cardYear: 1997 } as never);
    expect(normalizeSetKey(String(r.fields.setName))).toBe("bowmans-best");
    expect(r.changes.some((c) => c.rule === "setName_bowmans_best_preview_is_the_product")).toBe(false);
  });
});
