/**
 * Three rulings that each turn on the same mistake: a name being read as the
 * wrong KIND of thing.
 *
 * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-PRODUCT — "metal-universe-heavy-metal" read
 * as a rung of "metal-universe". The 1996 Heavy Metal ruling file ingested 10
 * rows and wrote ZERO under its own key: every row resolved onto a base-set
 * address held at higher authority and was absorbed as `keptExisting`, so the
 * run counted "10 written" while the catalog gained nothing. Heavy Metal #2 is
 * Barry Bonds and BASE #2 is Brady Anderson, so the collapse pointed Bonds's
 * card at Brady Anderson's row.
 *
 * CF-A-DECLARED-PARALLEL-IS-NOT-A-CARD-LINE — "Class 1 Blue" read as a card
 * line ("BD 154 Adley Rutschman"). 1,200 of 1,500 Gold Label rows were skipped
 * while the 300 bare "Class N" rows passed.
 *
 * CF-A-FINEST-TIER-IS-THE-NUMBER — a plain "Refractor" on a 1997 Finest sale
 * read as a complete parallel when the card number already fixes the tier.
 */
import { describe, it, expect } from "vitest";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isCardLineParallel, declaredParallels } = require("../scripts/ingest-checklist-csv-to-catalog.cjs");

describe("a named insert set is its own product", () => {
  it("keeps metal-universe-heavy-metal off its parent's key", () => {
    expect(normalizeSetKey("metal-universe-heavy-metal")).toBe("metal-universe-heavy-metal");
    expect(normalizeSetKey("1996-metal-universe-heavy-metal")).toBe("metal-universe-heavy-metal");
    expect(normalizeSetKey("1996 Metal Universe Heavy Metal")).toBe("metal-universe-heavy-metal");
  });

  it("is a fixed point — a ruled key must normalize to itself", () => {
    expect(normalizeSetKey(normalizeSetKey("metal-universe-heavy-metal"))).toBe("metal-universe-heavy-metal");
  });

  it("leaves the parent and its siblings exactly as they were", () => {
    expect(normalizeSetKey("metal-universe")).toBe("metal-universe");
    expect(normalizeSetKey("fleer-metal-universe")).toBe("fleer-metal-universe");
    expect(normalizeSetKey("skybox-metal-universe")).toBe("skybox-metal-universe");
    // Deliberately still collapsing: the other named inserts are for Drew to
    // rule on (census-collapsed-insert-keys.cjs lists them). Not changed here.
    expect(normalizeSetKey("metal-universe-titanium")).toBe("metal-universe");
  });

  it("puts Bonds on the insert row, not on Brady Anderson's base row", () => {
    const insert = computeHobbyIqCardId({
      sport: "baseball", year: 1996, setKey: "metal-universe-heavy-metal",
      cardNumber: "2", parallel: "Base", isAuto: false,
    } as never);
    const base = computeHobbyIqCardId({
      sport: "baseball", year: 1996, setKey: "metal-universe",
      cardNumber: "2", parallel: "Base", isAuto: false,
    } as never);
    expect(insert).not.toBe(base);
    expect(insert).toContain("metal-universe-heavy-metal");
  });
});

describe("a declared parallel is not a card line", () => {
  const goldLabel = declaredParallels({
    parallelVocabulary: ["Class 1", "Class 1 Blue", "Class 2 Black", "Class 3 Gold"],
  });
  const none = declaredParallels({});

  it("admits the Gold Label vocabulary the manifest declares", () => {
    expect(isCardLineParallel("Class 1 Blue", goldLabel)).toBe(false);
    expect(isCardLineParallel("Class 2 Black", goldLabel)).toBe(false);
    expect(isCardLineParallel("Class 1", goldLabel)).toBe(false);
  });

  it("is case- and whitespace-insensitive but never a pattern", () => {
    expect(isCardLineParallel("class 1 blue", goldLabel)).toBe(false);
    expect(isCardLineParallel("Class  1   Blue", goldLabel)).toBe(false);
    // Declared "Class 1 Blue" must NOT admit an undeclared sibling.
    expect(isCardLineParallel("Class 1 Purple", goldLabel)).toBe(true);
  });

  // THE MUTATION CHECK. The exemption must not widen the guard for anyone
  // else: real card lines stay card lines, with and without a vocabulary.
  it("still reads real card lines as card lines — even with a vocabulary loaded", () => {
    for (const vocab of [none, goldLabel]) {
      expect(isCardLineParallel("Level 3 Aaron Judge", vocab)).toBe(true);
      expect(isCardLineParallel("BD 154 Adley Rutschman", vocab)).toBe(true);
      expect(isCardLineParallel("100 Mike Trout", vocab)).toBe(true);
    }
  });

  /**
   * PRE-EXISTING GAP, pinned rather than silently widened.
   *
   * CARD_LINE_PARALLEL's prefix is `[A-Za-z]{0,5}`, so a SIX-letter lead word
   * never matches at all: "Series 2 Mike Trout" is not seen as a card line
   * today, on main, and was not before this change either ("Class" and
   * "Level" are five letters and do match). Widening the cap to admit it is a
   * change to a guard shared by every product and belongs in its own PR with
   * its own blast-radius measurement — this PR only scopes an EXEMPTION and
   * must not quietly alter what the guard catches. Pinned so the day someone
   * does widen it, this expectation fails and the decision is made on purpose.
   */
  it("does NOT catch a six-letter lead word (pre-existing, unchanged here)", () => {
    expect(isCardLineParallel("Series 2 Mike Trout", none)).toBe(false);
    expect(isCardLineParallel("Series 2 Mike Trout", goldLabel)).toBe(false);
  });

  it("gives no product an exemption it did not declare", () => {
    expect(isCardLineParallel("Class 1 Blue", none)).toBe(true);
  });

  it("keeps the pre-existing non-card-line exceptions working", () => {
    expect(isCardLineParallel("1990 Bowman", none)).toBe(false);
    expect(isCardLineParallel("20 in '20", none)).toBe(false);
    expect(isCardLineParallel("3 Color Patch", none)).toBe(false);
  });
});

describe("1997 Finest: the tier comes from the card number", () => {
  const id = (cardNumber: string, parallel: string, sport = "baseball", year = 1997) =>
    computeHobbyIqCardId({ sport, year, setKey: "topps-finest", cardNumber, parallel, isAuto: false } as never);

  it("derives the tier for a plain Refractor, per BCP's ranges", () => {
    expect(id("238", "Refractor")).toContain(":238:bronze-refractor:");   // Series Two Bronze
    expect(id("342", "Refractor")).toContain(":342:gold-refractor:");     // BCP's own example
    expect(id("101", "Refractor")).toContain(":101:silver-refractor:");
    expect(id("1", "Refractor")).toContain(":1:bronze-refractor:");
    expect(id("350", "Refractor")).toContain(":350:gold-refractor:");
  });

  it("never rewrites a tier the source already stated", () => {
    expect(id("238", "Bronze Refractor")).toContain(":238:bronze-refractor:");
    expect(id("151", "Gold Refractor")).toContain(":151:gold-refractor:");
  });

  it("touches no other rung of the product", () => {
    expect(id("238", "Embossed")).toContain(":238:embossed:");
    expect(id("287", "Embossed Refractor")).toContain(":287:embossed-refractor:");
  });

  it("is scoped to 1997 baseball Finest and to numbers in the set", () => {
    expect(id("101", "Refractor", "basketball")).toContain(":101:refractor:");  // 1997-98 Finest Basketball
    expect(id("101", "Refractor", "baseball", 1996)).toContain(":101:refractor:");
    expect(id("400", "Refractor")).toContain(":400:refractor:");                // outside 1-350
  });
});
