/**
 * CF-BASE-IS-NOT-A-REFRACTOR (2026-08-23).
 *
 * Drew: "base is a refractor is wrong".
 *
 * CF-CHROME-AUTO-BASE-IS-REFRACTOR upgraded parallel "Base" to "Refractor" for
 * CPA-/TCPA-/CRA- autographs on chrome set keys, to stop the /499 pool being
 * "split in half". It cited Drew's own words as justification — "a base does not
 * equal a refractor" — and then merged them anyway. The rationale was inverted.
 *
 * Measured on 2025 Bowman Draft CPA-MWI (Max Williams), the card that surfaced
 * this: 42 sales on :refractor:auto and 20 on :base:auto. Those 20 are Base
 * autographs, not /499 Refractors, and pooling them drags the Refractor's value
 * toward a different card's price.
 *
 * THE PINS BELOW ARE MOSTLY NEGATIVE, because this change is a REMOVAL and the
 * risk of a removal is that something else quietly starts doing the same merge.
 */
import { describe, expect, it } from "vitest";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const parallelOf = (slug: string) => slug.split(":")[5];

const card = (over: Partial<Parameters<typeof computeHobbyIqCardId>[0]> = {}) =>
  computeHobbyIqCardId({
    sport: "baseball",
    year: 2025,
    setKey: "Bowman Chrome",
    cardNumber: "CPA-MWI",
    parallel: "Base",
    isAuto: true,
    playerName: "Max Williams",
    ...over,
  });

describe("Base and Refractor are different cards", () => {
  it("keeps a Base auto on the base parallel", () => {
    // This is the assertion that fails before the removal: it returned
    // "refractor".
    expect(parallelOf(card())).toBe("base");
    expect(parallelOf(card({ setKey: "Topps Chrome" }))).toBe("base");
  });

  it("keeps a Refractor auto on the refractor parallel", () => {
    expect(parallelOf(card({ parallel: "Refractor" }))).toBe("refractor");
  });

  it("gives Base and Refractor DIFFERENT slugs for the same card number", () => {
    expect(card({ parallel: "Base" })).not.toBe(card({ parallel: "Refractor" }));
  });

  it("holds across the auto prefixes the removed rule covered", () => {
    for (const cardNumber of ["CPA-MWI", "TCPA-XY", "CRA-AB"]) {
      expect(parallelOf(card({ cardNumber })), cardNumber).toBe("base");
    }
  });

  it("holds on bowman-draft too, where the rule never fired anyway", () => {
    expect(parallelOf(card({ setKey: "Bowman Draft" }))).toBe("base");
  });
});

describe("the neighbouring parallel rules still work", () => {
  it("no longer unifies a colour with its refractor at the generator — the catalog decides per card (CF-COLOUR-FOLLOWS-THE-CHECKLIST, Drew 2026-08-30)", () => {
    // CF-CHROME-COLOR-IMPLIES-REFRACTOR was removed: Topps Tribute's checklists
    // name 19,099 bare-colour parallels with no refractor form, and Finest
    // lists "Uncommon" and "Uncommon Refractor" as two cards. "Blue" is blue;
    // the catalog resolver maps it onto "Blue Refractor" only when that is the
    // one blue row the card has.
    expect(parallelOf(card({ parallel: "Blue" }))).toBe("blue");
    expect(parallelOf(card({ parallel: "Blue Refractor" }))).toBe("blue-refractor");
    expect(parallelOf(card({ parallel: "Gold" }))).toBe("gold");
    expect(parallelOf(card({ parallel: "Gold Refractor" }))).toBe("gold-refractor");
  });

  it("does not let the colour rule reach Base", () => {
    expect(parallelOf(card({ parallel: "Base" }))).not.toContain("refractor");
  });

  it("still collapses redundant chrome- prefixes on chrome stock", () => {
    expect(parallelOf(card({ parallel: "Chrome Sky Blue Refractor" })))
      .toBe(parallelOf(card({ parallel: "Sky Blue Refractor" })));
  });
});
