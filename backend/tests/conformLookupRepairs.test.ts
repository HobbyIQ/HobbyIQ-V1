/**
 * D35 — the three narrow lookup repairs in conform-holdings-to-catalog.cjs,
 * plus the base/plain rung equivalence. All four are pure functions, so this
 * is a fixture table, not an integration test.
 *
 * Each case is anchored to a REAL holding of Drew's that reported unresolved
 * against a catalog row that already existed and was already checklist-backed.
 *
 * THE GUARD-SCOPE RULE (the #1177-#1180 shape, "right guard, wrong scope"):
 * every relaxation below is pinned by a NEGATIVE case as hard as its positive
 * one. A widened guard that cannot be shown to still refuse the thing it was
 * written to refuse is not a fix.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const conform = require_("../scripts/conform-holdings-to-catalog.cjs") as {
  cardNumberVariants: (num: string) => string[];
  setAgrees: (text: string, setKey: string, setName: string, holding?: { parallel?: string }) => boolean;
  playerAgreement: (
    rows: Array<{ playerSlug?: string; playerName?: string }>,
    player: string,
  ) => { rows: Array<{ playerSlug?: string; playerName?: string }>; nearMiss: boolean };
  resolveRung: (parallel: string, rungs: Set<string>) => { seg: string; conf: number } | null;
};

describe("RC3a — a card number is the same number spaced or not", () => {
  // Holding b2ea5dac: 1996 Bowman's Best #BBP 14 Atomic Refractor, PSA 9.
  // The checklist row hiq:baseball:1996:bowmans-best:bbp14:atomic-refractor:no-auto
  // (baseballcardpedia, playerSlug greg-maddux) stores cardNumber "BBP14".
  // The old variant list was as-is/upper/lower, all of which keep the space,
  // so the row was never fetched and the holding reported
  // "only vendor-minted rows" against its own self-seed.
  it("generates the unspaced and hyphenated forms of a spaced number", () => {
    const v = conform.cardNumberVariants("BBP 14");
    expect(v).toContain("BBP 14"); // the original spelling still queried
    expect(v).toContain("BBP14"); // the checklist's spelling — the repair
    expect(v).toContain("bbp14");
    expect(v).toContain("BBP-14");
  });

  it("leaves an already-unspaced number alone and does not duplicate", () => {
    const v = conform.cardNumberVariants("CPA-MH");
    expect(v).toEqual(["CPA-MH", "cpa-mh"]);
    expect(new Set(v).size).toBe(v.length);
  });

  // NEGATIVE, the load-bearing one. Beckett initials already collide
  // (CPA-AN is BOTH Angel Nunez and Alejandro Nunez), so the NUMBER test is
  // the guard that must never widen. Hyphens are NOT stripped: BBP-14 and
  // BBP14 are the same number spelled two ways, but 238 and 23-8 are not.
  it("never strips a hyphen — a hyphen can be part of the number", () => {
    expect(conform.cardNumberVariants("CPA-AN")).not.toContain("CPAAN");
    expect(conform.cardNumberVariants("BBP-14")).not.toContain("BBP14");
  });

  it("returns nothing for a blank number", () => {
    expect(conform.cardNumberVariants("")).toEqual([]);
    expect(conform.cardNumberVariants("   ")).toEqual([]);
  });
});

describe("RC3b — setAgrees ignores tokens the holding accounts for elsewhere", () => {
  /**
   * DREW RULED "PREVIEW" A PRODUCT (2026-09-06), so this pin flipped — and the
   * flip is the ruling working, not a regression.
   *
   * Holding 437f010d is Derek Jeter 1997 Bowman's Best Preview #BBP4 Atomic
   * Refractor PSA 7. Its setName and product both read "Bowmans Best Preview
   * Atomic Refractor": the eBay parse glued the insert name AND the parallel
   * name into the set field. This test used to assert that such a holding
   * AGREES with a plain `bowmans-best` row, because "preview" sat on
   * SUBSET_WORDS — a checklist section, excusable as set text.
   *
   * It is not a section. It is a twenty-card product with its own BBP
   * numbering, and `productSetKeys` now declares `bowmans-best-preview`, which
   * puts "preview" into PRODUCT_WORDS — the set that is NEVER excused. So the
   * holding no longer agrees with the parent's row, which is exactly the
   * outcome the ruling exists to produce: a Preview holding must not conform
   * onto a Bowman's Best row and price off the wrong pool. It conforms onto
   * its own product's row instead, once the SCC re-mint creates it.
   *
   * This is the same guard-scope line the negative below already draws:
   * "Sapphire", "Draft" and "Chrome" name products and are never excused. As
   * of the ruling, "preview" is one of them.
   */
  it("a Preview holding no longer agrees with the PARENT product's row", () => {
    expect(
      conform.setAgrees(
        "Bowmans Best Preview Atomic Refractor",
        "bowmans-best",
        "1997 Bowmans Best Baseball",
        { parallel: "Atomic Refractor" },
      ),
    ).toBe(false);
  });

  it("...and DOES agree with its own product's row, parallel word excused as before", () => {
    // The relaxation this describe block is about is untouched: "atomic" and
    // "refractor" are still explained by the holding's own parallel field, so
    // the only reason the case above fails is the PRODUCT word.
    expect(
      conform.setAgrees(
        "Bowmans Best Preview Atomic Refractor",
        "bowmans-best-preview",
        "1997 Bowman Bowmans Best Preview Baseball",
        { parallel: "Atomic Refractor" },
      ),
    ).toBe(true);
  });

  it("still requires the set to agree when nothing accounts for the extra word", () => {
    // Same text against its own product, but the holding's parallel does NOT
    // say atomic/refractor, so those words are unexplained product text and
    // must still fail.
    expect(
      conform.setAgrees(
        "Bowmans Best Preview Atomic Refractor",
        "bowmans-best-preview",
        "1997 Bowman Bowmans Best Preview Baseball",
        { parallel: "" },
      ),
    ).toBe(false);
  });

  // NEGATIVE, the guard-scope pin. A genuine PRODUCT disagreement must stay a
  // disagreement — a plain Bowman Draft is not a Sapphire, and the
  // exact-set-wins branch downstream depends on this staying false.
  it("a real product difference still returns false", () => {
    expect(
      conform.setAgrees("2024 Bowman Draft Sapphire", "bowman-draft", "2024 Bowman Draft Baseball", {
        parallel: "Refractor",
      }),
    ).toBe(false);
    expect(conform.setAgrees("2020 Bowman Chrome", "bowman", "2020 Bowman Baseball", {})).toBe(false);
    // and a parallel field may not be used to smuggle a product word through
    expect(
      conform.setAgrees("2024 Bowman Draft Sapphire", "bowman-draft", "2024 Bowman Draft Baseball", {
        parallel: "Sapphire Draft",
      }),
    ).toBe(false);
  });

  // Holding b2ea5dac again: after the whitespace repair fetched the checklist
  // row, the LAST thing standing between it and its identity was an
  // apostrophe. slug() splits "Bowman's" into {bowman, s} and the stray "s"
  // appears in no setKey or setName, so every candidate failed.
  it("a possessive apostrophe is not a token", () => {
    expect(
      conform.setAgrees("1996 Bowman's Best", "bowmans-best", "1996 Bowmans Best Baseball", {
        parallel: "Atomic Refractor",
      }),
    ).toBe(true);
    // the curly apostrophe too — eBay titles carry both
    expect(conform.setAgrees("1996 Bowman’s Best", "bowmans-best", "1996 Bowmans Best Baseball", {})).toBe(true);
  });

  it("folding the apostrophe does not excuse a product difference", () => {
    expect(conform.setAgrees("1996 Bowman's Best Sapphire", "bowmans-best", "1996 Bowmans Best Baseball", {})).toBe(false);
  });

  it("blank holding set text never agrees", () => {
    expect(conform.setAgrees("", "bowmans-best", "1997 Bowmans Best Baseball", {})).toBe(false);
  });
});

describe("RC3c — player agreement falls back to playerName, and widens by one letter at most", () => {
  // Holding 338c83bd: the 1997 setKey="finest" checklist rows carry
  // playerName "Ken Griffey, Jr." with playerSlug UNDEFINED (only 254 of 605
  // have one), so step 2 dropped the authoritative rows before authority was
  // even considered.
  it("agrees on playerName when playerSlug is absent", () => {
    const out = conform.playerAgreement([{ playerName: "Ken Griffey, Jr." }], "ken-griffey-jr");
    expect(out.rows).toHaveLength(1);
    expect(out.nearMiss).toBe(false);
  });

  // Holding ca820b08: catalog "justin-gonzales" vs holding "justin-gonzalez"
  // differ in the FINAL letter, so neither contains the other.
  it("accepts a single trailing-character variant, and flags it as a near miss", () => {
    const out = conform.playerAgreement([{ playerSlug: "justin-gonzales" }], "justin-gonzalez");
    expect(out.rows).toHaveLength(1);
    expect(out.nearMiss).toBe(true); // reported, not silently equal
  });

  // NEGATIVE, the collision pin. CPA-AN is both Angel Nunez and Alejandro
  // Nunez. The near-miss rule is last-resort only, so an exact agreement must
  // never pull the other player in alongside it.
  it("two different players at one card number still split", () => {
    const rows = [{ playerSlug: "angel-nunez" }, { playerSlug: "alejandro-nunez" }];
    const out = conform.playerAgreement(rows, "angel-nunez");
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].playerSlug).toBe("angel-nunez");
    expect(out.nearMiss).toBe(false);
  });

  it("a genuinely different player agrees with nothing", () => {
    expect(conform.playerAgreement([{ playerSlug: "derek-jeter" }], "greg-maddux").rows).toHaveLength(0);
  });
});

describe("RC5 — base-<family> is the plain <family> rung", () => {
  // Holding af962529: Michael Harris II 2020 Bowman Chrome #CPA-MH Refractor.
  // The checklist spells the plain auto parallel "base-refractor"; the old
  // long-form probe only appended a family, so it looked for
  // "refractor-refractor" and reported the rung as absent.
  it("a holding parallel of Refractor resolves to base-refractor", () => {
    expect(conform.resolveRung("Refractor", new Set(["base-refractor", "blue-refractor", "gold-refractor"]))).toEqual({
      seg: "base-refractor",
      conf: 0.8,
    });
  });

  it("an exact rung still wins over the base form", () => {
    expect(conform.resolveRung("Refractor", new Set(["refractor", "base-refractor"]))).toEqual({
      seg: "refractor",
      conf: 0.98,
    });
  });

  // NEGATIVE, the D31 boundary. No colour vocabulary rule is added: a bare
  // colour against a set holding both forms must still take the exact one.
  it("a bare colour keeps its exact rung — no colour vocabulary is introduced", () => {
    expect(conform.resolveRung("Blue", new Set(["blue-refractor", "blue"]))).toEqual({ seg: "blue", conf: 0.98 });
  });

  it("a bare colour with no exact rung is still not resolved by this rule", () => {
    // "blue" is not a FAMILY, so base-blue is never reached for it.
    expect(conform.resolveRung("Blue", new Set(["base-blue", "gold-refractor"]))).toBeNull();
  });

  it("ambiguity still returns null", () => {
    expect(conform.resolveRung("Gold", new Set(["gold-refractor", "gold-prizm"]))).toBeNull();
  });

  it("a blank parallel still requires a real base row", () => {
    expect(conform.resolveRung("", new Set(["blue-refractor"]))).toBeNull();
    expect(conform.resolveRung("", new Set(["base", "blue-refractor"]))).toEqual({ seg: "base", conf: 0.95 });
  });
});
