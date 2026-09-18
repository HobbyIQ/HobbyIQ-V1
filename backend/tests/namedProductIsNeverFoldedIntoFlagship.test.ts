/**
 * R26-FLAGSHIP-SWALLOWED-NAMED-PRODUCT, ON THE AGREE SIDE
 * (post-wave audit, 2026-09-15).
 *
 * The audit's top sports AGREE error pattern -- 48 of 500 sampled rows -- is
 * "a named, checklist-distinct product collapsed into its flagship on BOTH
 * sides, so the census can never surface it". A product fold that both sides
 * share is invisible to a stored-vs-derived comparison by construction: the
 * rematch only ever looks at rows where the two disagree.
 *
 * Every title here is a REAL pool row from `audit-postwave-sample-2026-09-15
 * .jsonl`, and every "before" value was reproduced verbatim against the live
 * parser on 2ac329a9.
 *
 * -- WHAT THIS COMMIT FIXES, AND WHAT IT DELIBERATELY DOES NOT --------------
 *
 * The audit names three families. Only ONE of them can be fixed by a title
 * rule, and the doctrine `feedback_a_missing_checklist_is_usually_a_wrong_key`
 * plus R29's `resolveProductByChecklist` decide the other two:
 *
 *   FIXED -- Topps Gold Label. `isProductSetKey("topps-gold-label")` is true
 *     and its parent is `topps`, so the ladder edge already existed and the
 *     derivation simply could not reach it. A brand-gated rule in
 *     LADDER_SPECIALIZATION_PRODUCTS pays down that dead edge. This is the
 *     whole of the code change.
 *
 *   REPORTED, NOT INVENTED -- Fleer Greats of the Game.
 *     `isProductSetKey("fleer-greats-of-the-game")` is FALSE: the key is not a
 *     registered checklist product. Minting a destination key for it here
 *     would be exactly the synthetic-parallel failure
 *     `feedback_no_synthetic_parallels_only_actuals` rules out, one level up
 *     at the product. The rows stay on `fleer` and the PR reports the key as
 *     needing acquisition. The control below PINS that they stay -- so the
 *     day the checklist lands, this test is what says the fold is still open.
 *
 *   REFUSED ON EVIDENCE -- Bowman BCP-/BP- card numbers.
 *     The brief proposed BCP- -> `bowman-chrome` as a prefix rule. The repo's
 *     own measured evidence refuses it, and it is worth stating because the
 *     rule looks obviously right:
 *
 *       a) `cpaProductRule.ts` records Drew's D29/R2 ruling ("the checklist
 *          that names the product wins") together with the measurement that
 *          of 3,459 CPA identities carrying two dedicated setKeys, 1,879 --
 *          the MAJORITY -- are genuinely `bowman`, not `bowman-chrome`.
 *       b) `applySiblingChecklistOverride` already decides this axis from
 *          hand-verified per-number checklist lists (CPA_2026_BOWMAN_ONLY has
 *          81 numbers), not from the prefix. A prefix rule would overrule 81
 *          numbers a human checked against the CSV.
 *       c) `2026-bowman-auto-checklist.csv` files the SAME CPA- prefix under
 *          three different subsets (chrome_prospect_autographs, gold_ink_
 *          autographs, packfractor_autographs), so the prefix does not
 *          determine the product even within one release.
 *       d) `BP-` is Bowman PROSPECTS (paper), not Chrome at all, and
 *          `bowman-prospects` is not a registered product either.
 *       e) All 9 BCP-/BP- rows in the audit are CardHedge-RENDERED titles
 *          ("2026 Bowman Baseball #BCP-150 Base") that state no product word
 *          whatsoever. There is nothing in the title for a title rule to read.
 *
 *     The right mechanism already exists and is async: R29
 *     `resolveProductByChecklist`, which asks whether a candidate product's
 *     checklist actually holds this card. That is a Cosmos read, out of scope
 *     for this PR, and the PR body carries it as the follow-up.
 */
import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service";
import {
  normalizeSetKey,
  CPA_2026_BOWMAN_ONLY,
  applySiblingChecklistOverride,
} from "../src/services/portfolioiq/hobbyIqCardId.service";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";

/** The setKey the deriver lands on: the parser's read, spoken through the one
 *  vocabulary that rules on product names -- the pair `deriveIdentity` itself
 *  composes, so a pin here is a pin on the derivation. */
const setKeyOf = (title: string, cardNumber: string | null = null): string =>
  normalizeSetKey(inferSetKeyFromTitle(title, cardNumber));

// ---------------------------------------------------------------------------
// FIXED: TOPPS GOLD LABEL
// ---------------------------------------------------------------------------
describe("Topps Gold Label is its own product", () => {
  it("is a registered checklist product, which is what licenses the rule", () => {
    // The gate the brief sets and this test enforces: a rule may only point at
    // a key the product table already carries. If this ever goes false the
    // rule below is minting a product, and that is the defect, not the fix.
    expect(isProductSetKey("topps-gold-label")).toBe(true);
    expect(productParentOf("topps-gold-label")).toBe("topps");
  });

  it.each([
    // [title, what the parser derived BEFORE]
    ["2000 Topps Gold Label - Barry Bonds #85 Class 2", "topps"],
    ["1999 Topps Gold Label Football #61 Base", "topps"],
    ["2000 Topps Gold Label Class 3 Ken Griffey Jr #1", "topps"],
  ])("%s", (title, before) => {
    const got = setKeyOf(title);
    expect(got).toBe("topps-gold-label");
    // MUTATION CHECK: fails if the rule is removed, rather than passing on a
    // coincidence about some other key.
    expect(got).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// THE CONTROLS: A BRAND-GATED RULE MUST NOT WIDEN THE BRAND
// ---------------------------------------------------------------------------
describe("plain Topps is still plain Topps", () => {
  it.each([
    ["2026 Topps Baseball #282 Wood", "topps"],
    ["1975 Topps #370 Tom Seaver", "topps"],
    ["2025 Topps Chrome - Jordan Love #109 Aqua Refractor #/199", "topps-chrome"],
    ["2025 Topps Allen & Ginter Baseball #8 Base", "topps-allen-ginter"],
  ])("%s stays %s", (title, want) => {
    expect(setKeyOf(title)).toBe(want);
  });

  it("does not read a gold-coloured anything as Gold Label", () => {
    // "gold" is a colour and "label" an ordinary noun. The two-word adjacency
    // plus the brand gate are what keep this from swallowing the colour rungs.
    expect(setKeyOf("2025 Topps Baseball #100 Gold Foil")).toBe("topps");
    expect(setKeyOf("2025 Topps Chrome Baseball #50 Gold Refractor")).toBe("topps-chrome");
  });
});

// ---------------------------------------------------------------------------
// REPORTED, NOT INVENTED: FLEER GREATS OF THE GAME
// ---------------------------------------------------------------------------
describe("Fleer Greats of the Game — the checklist landed, the fold is closed", () => {
  // THE DAY THIS TEST PREDICTED (2026-09-18). The block below used to pin
  // `isProductSetKey("fleer-greats-of-the-game")` as FALSE and the three real
  // sales as staying on `fleer`, and it said why: inventing a destination key
  // for a product no checklist backed would be the synthetic-parallel failure
  // one level up. It also said what would end that:
  //
  //   "When the checklist is acquired and the key registered, this expectation
  //    flips and the next test's `toBe("fleer")` is what will fail -- which is
  //    the signal to add the rule, not a regression."
  //
  // Both happened. #2234 landed the 237-row checklist (137 for 2001, 100 for
  // 2002, baseballcardpedia with sportscardchecklist corroborating) and this
  // PR registers the key with an explicit pattern ahead of the /fleer/
  // catch-all. So the rule was added, and these assertions now state the new
  // truth rather than the old debt.
  it("is a registered product the table carries", () => {
    expect(isProductSetKey("fleer-greats-of-the-game")).toBe(true);
    // `fleer-greats` is still NOT a product: the phrase the sources print is
    // "Greats of the Game", and Fleer separately prints "Fleer Greats". A key
    // for that has no checklist, so it stays unregistered.
    expect(isProductSetKey("fleer-greats")).toBe(false);
  });

  it("nests under its flagship, so the ladder edge exists", () => {
    expect(productParentOf("fleer-greats-of-the-game")).toBe("fleer");
  });

  it.each([
    "2002 Fleer Greats of the Game Kirby Puckett / Don Mattingly Dueling Duos #6 DD - Raw",
    "Bill Dickey 2002 Fleer Greats of the Game #78  Baseball Card - Raw 10",
    "2002 2002 Fleer Greats of the Game Baseball #75 Base",
  ])("%s reaches its own product", (title) => {
    // Every one of these is a REAL pool row from the post-wave audit sample.
    // 2,961 rows like them sat on bare `fleer` (1,518 in 2001, 1,443 in 2002)
    // because no other destination resolved.
    expect(setKeyOf(title)).toBe("fleer-greats-of-the-game");
  });

  it("the rule is anchored on the PHRASE, so it does not reach past its product", () => {
    // A bare /greats/ would swallow 2005 Donruss Greats (1,302 checklist-backed
    // rows, its own registered key) and any "Fleer Greats" title. The mutation
    // check that the gate is a specialisation and not a hole.
    expect(setKeyOf("2005 Donruss Greats Baseball #18 Gold HoloFoil")).toBe("panini-donruss");
    expect(setKeyOf("2002 Fleer Baseball #75 Base")).toBe("fleer");
    expect(setKeyOf("1987 Fleer Glossy Tin #12")).toBe("fleer-glossy");
    expect(setKeyOf("1996 Fleer Tiffany #5")).toBe("fleer-tiffany");
  });
});

// ---------------------------------------------------------------------------
// REFUSED ON EVIDENCE: THE BOWMAN PREFIX RULE
// ---------------------------------------------------------------------------
describe("a Bowman card number prefix does not decide the product", () => {
  it("leaves the hand-verified per-number override in charge", () => {
    // CPA-DP is in CPA_2026_BOWMAN_ONLY -- a human checked it against
    // 2026-bowman-full.csv. A blanket "CPA- means bowman-chrome" rule would
    // overrule that, and 80 others like it.
    expect(CPA_2026_BOWMAN_ONLY).toContain("CPA-DP");
    expect(applySiblingChecklistOverride("bowman-chrome", "CPA-DP", 2026)).toBe("bowman");
  });

  it("neither bowman-prospects nor fleer-greats is a registered product", () => {
    // `BP-` is Bowman Prospects (PAPER), not Chrome -- so the proposed
    // BCP/BP -> bowman-chrome rule would have mis-filed these rows into a
    // product they are not in, and there is no registered paper-prospects key
    // to send them to either.
    expect(isProductSetKey("bowman-prospects")).toBe(false);
  });

  it("the audit's BCP-/BP- titles state no product word to read", () => {
    // Every one of the 9 is a CardHedge-rendered title. A title rule has
    // nothing to anchor on; only a checklist lookup (R29) can answer, and that
    // is async. Pinned so the next person does not re-derive the prefix rule
    // from the report's prose.
    for (const title of [
      "2026 Bowman Baseball #BCP-150 Base",
      "2026 Bowman Baseball #BP-31 Base",
      "2026 Bowman Baseball #BCP-117 Purple Geometric",
    ]) {
      expect(/chrome/i.test(title)).toBe(false);
      expect(setKeyOf(title)).toBe("bowman");
    }
  });
});
