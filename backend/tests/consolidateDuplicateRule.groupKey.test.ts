/**
 * THE D30 GROUPING KEY -- the blocker the first build shipped with.
 *
 * The fleet grouped rows with D29's `identityKeyOf`, whose key embeds the RAW
 * `setKey` field. That is right for R1 (it compares a target and a twin that
 * already sit in one product) and is pinned by
 * `foldTwinRuleChecklistNumbered.test.ts:330`, so it must not change. But it
 * makes D30's own job impossible: D30 exists to join rows that disagree about
 * the product's SPELLING, so `MODE=setkey` was a no-op over the largest
 * measured population and `cross-product-cpa` was never emitted at all.
 *
 * `groupKeyOf` normalizes the PRODUCT and only the product's spelling. Both
 * directions are pinned here, because the failure modes are not symmetric:
 * under-grouping leaves a split pool (recoverable by a re-run), while
 * OVER-grouping merges two different real cards onto one row and destroys both
 * pools. Every "DIFFERENT" case below is the catastrophic direction.
 */
import { describe, expect, it } from "vitest";
import {
  groupKeyOf,
  groupProductKeyOf,
  productKeyOf,
  isCpaCollapseRow,
  decideDuplicateGroup,
} from "../src/services/catalog/duplicateWinnerRule.js";
import { identityKeyOf } from "../src/services/catalog/foldTwinRuleChecklistNumbered.js";

const row = (o: Record<string, unknown> = {}) => ({
  id: "hiq:x",
  sport: "baseball",
  year: 2024,
  setKey: "bowman",
  cardNumber: "1",
  parallelSlug: "base",
  isAuto: false,
  ...o,
}) as never;

describe("SAME PRODUCT, DIFFERENT SPELLING -> one group", () => {
  it("donruss and panini-donruss are ONE group (Drew's ruling (b), panini-era)", () => {
    const a = row({ setKey: "donruss", year: 2024 });
    const b = row({ setKey: "panini-donruss", year: 2024 });
    expect(groupKeyOf(a)).toBe(groupKeyOf(b));
    // and this is exactly what the old key could not do:
    expect(identityKeyOf(a)).not.toBe(identityKeyOf(b));
  });

  it("the Donruss era boundary is respected: 1990 groups as donruss, 2024 as panini-donruss", () => {
    expect(productKeyOf({ setKey: "donruss", year: 1990 })).toBe("donruss");
    expect(productKeyOf({ setKey: "panini-donruss", year: 1990 })).toBe("donruss");
    expect(productKeyOf({ setKey: "donruss", year: 2024 })).toBe("panini-donruss");
    // ...and 1990 never groups with 2024 (the year is its own half of the key)
    expect(groupKeyOf(row({ setKey: "donruss", year: 1990 })))
      .not.toBe(groupKeyOf(row({ setKey: "donruss", year: 2024 })));
  });

  it("a KNOWN ALIAS resolves to the product's one spelling (live: finest -> topps-finest)", () => {
    // Measured 2026-08-30 on prod: `hiq:baseball:2024:finest:93-19:base:no-auto`
    // [baseballcardpedia] and `...:topps-finest:93-19:...` [checklistcenter],
    // one Andrew McCutchen card, two rows the old key never compared.
    const a = row({ setKey: "finest", cardNumber: "93-19" });
    const b = row({ setKey: "topps-finest", cardNumber: "93-19" });
    expect(groupKeyOf(a)).toBe(groupKeyOf(b));
    expect(identityKeyOf(a)).not.toBe(identityKeyOf(b));
  });

  it("bowman and bowman-chrome are ONE group for a CPA-style auto number", () => {
    const a = row({ setKey: "bowman", cardNumber: "CPA-AN", isAuto: true });
    const b = row({ setKey: "bowman-chrome", cardNumber: "CPA-AN", isAuto: true });
    expect(isCpaCollapseRow(a)).toBe(true);
    expect(groupProductKeyOf(a)).toBe("bowman|bowman-chrome");
    expect(groupKeyOf(a)).toBe(groupKeyOf(b));
    expect(identityKeyOf(a)).not.toBe(identityKeyOf(b));
  });
});

describe("DIFFERENT PRODUCTS STAY APART -- the catastrophic direction", () => {
  it("bowman vs bowman-chrome at a NON-CPA number are two cards", () => {
    const a = row({ setKey: "bowman", cardNumber: "220" });
    const b = row({ setKey: "bowman-chrome", cardNumber: "220" });
    expect(isCpaCollapseRow(a)).toBe(false);
    expect(groupKeyOf(a)).not.toBe(groupKeyOf(b));
  });

  it("bowman-chrome vs bowman-chrome-sapphire are two cards -- CPA number or not", () => {
    expect(groupKeyOf(row({ setKey: "bowman-chrome", cardNumber: "BCP-1" })))
      .not.toBe(groupKeyOf(row({ setKey: "bowman-chrome-sapphire", cardNumber: "BCP-1" })));
    // the CPA collapse names TWO products explicitly; sapphire is not one
    expect(groupKeyOf(row({ setKey: "bowman-chrome", cardNumber: "CPA-AN", isAuto: true })))
      .not.toBe(groupKeyOf(row({ setKey: "bowman-chrome-sapphire", cardNumber: "CPA-AN", isAuto: true })));
  });

  it("bowman-draft vs bowman-chrome stay apart (draft-vs-chrome is a real distinction)", () => {
    expect(groupKeyOf(row({ setKey: "bowman-draft", cardNumber: "BD-1" })))
      .not.toBe(groupKeyOf(row({ setKey: "bowman-chrome", cardNumber: "BD-1" })));
  });

  it("bowman vs bowman-paper stay apart (two legitimate products, per the 08-30 re-measure)", () => {
    expect(groupKeyOf(row({ setKey: "bowman" }))).not.toBe(groupKeyOf(row({ setKey: "bowman-paper" })));
  });

  it("THE FAMILY LADDER IS NOT THE KEY: productFamilyOf merges products this key keeps apart", async () => {
    // The mutation check on the key's DESIGN, and the reason the dead
    // `productFamilyOf` import in the first build was the WRONG function for
    // the grouping step rather than the missing one.
    //
    // The family ladder is a PRICING relation: it answers "what should this
    // card price within", and it deliberately collapses a refinement onto its
    // flagship. Identity is not the family. `bowman-paper` and `bowman` share
    // family `bowman` -- and the 08-30 re-measure sized that pair at 7,293
    // groups, which the ladder would have folded into one card each.
    const { productFamilyOf } = await import("../src/services/catalog/productSetKeys.js");
    expect(productFamilyOf("bowman-paper")).toBe(productFamilyOf("bowman"));
    expect(productFamilyOf("bowman-draft-picks-and-prospects")).toBe(productFamilyOf("bowman-draft"));

    // ...and the grouping key keeps every one of them a separate card.
    const products = ["bowman", "bowman-chrome", "bowman-paper", "bowman-draft", "bowman-draft-picks-and-prospects"];
    const keys = new Set(products.map((setKey) => groupKeyOf(row({ setKey }))));
    expect(keys.size).toBe(products.length);
  });

  it("two unrelated products sharing a card number never group (panini-mosaic vs panini-optic #13)", () => {
    expect(groupKeyOf(row({ sport: "football", year: 2025, setKey: "panini-mosaic", cardNumber: "13" })))
      .not.toBe(groupKeyOf(row({ sport: "football", year: 2025, setKey: "panini-optic", cardNumber: "13" })));
  });

  it("an UNKNOWN product passes through unchanged -- never guessed into a neighbour", () => {
    expect(productKeyOf({ setKey: "some-product-the-table-never-heard-of", year: 2024 }))
      .toBe("some-product-the-table-never-heard-of");
    expect(groupKeyOf(row({ setKey: "unknown-a" }))).not.toBe(groupKeyOf(row({ setKey: "unknown-b" })));
  });
});

describe("the key agrees with D29 wherever the product spelling agrees", () => {
  it("every half except the product is identityKeyOf's, byte for byte", () => {
    const r = row({ setKey: "topps-chrome", cardNumber: "BCP-100", parallelSlug: "base-refractor", isAuto: true });
    expect(groupKeyOf(r)).toBe(identityKeyOf(r));
  });

  it("the auto-by-card-number gate still merges a CPA no-auto ghost onto the auto row", () => {
    const ghost = row({ setKey: "bowman-chrome", cardNumber: "CPA-MH", isAuto: false });
    const real = row({ setKey: "bowman-chrome", cardNumber: "CPA-MH", isAuto: true });
    expect(groupKeyOf(ghost)).toBe(groupKeyOf(real));
    expect(groupKeyOf(ghost).endsWith("|auto")).toBe(true);
  });
});

describe("the player gate still refuses across a widened group", () => {
  it("a CPA collapse that joins two DIFFERENT players is not a group", () => {
    // Live shape from the 08-30 probe: cpa-ete is Enmanuel Tejeda on beckett
    // and Emiliano Teodo on checklistcenter. The wider key brings them into one
    // group; gate 1 must still refuse to fold them.
    const a = row({ id: "hiq:a", setKey: "bowman", cardNumber: "CPA-ETE", isAuto: true, playerName: "Enmanuel Tejeda", source: "beckett-checklist" });
    const b = row({ id: "hiq:b", setKey: "bowman-chrome", cardNumber: "CPA-ETE", isAuto: true, playerName: "Emiliano Teodo", source: "checklistcenter-2026-08-29" });
    expect(groupKeyOf(a)).toBe(groupKeyOf(b));
    const d = decideDuplicateGroup({ rows: [a, b] });
    expect(d.kind).toBe("not-a-group");
    expect(d.kind === "not-a-group" && d.why).toBe("player-differs");
  });
});
