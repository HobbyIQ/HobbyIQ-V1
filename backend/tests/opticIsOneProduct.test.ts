/**
 * CF-OPTIC-IS-ONE-PRODUCT (D31; Drew, 2026-08-31).
 *
 * "panini-optic and donruss-optic are ONE product, canonical key
 * donruss-optic." One card, one row, one pool — and Optic was split across two
 * spellings in the worst possible arrangement: the CHECKLISTS all say
 * donruss-optic, the MINTER all said panini-optic.
 *
 * Measured read-only against prod, 2026-08-31:
 *
 *   checklist rows, un-graded, by sport-year   donruss-optic   panini-optic
 *     football 2023                                   16,055              1
 *     football 2024                                   15,988              -
 *     football 2025                                   19,466              -
 *     basketball 2024                                 30,998              -
 *   catalog sources                            checklistcenter 28,939 + 2,155,
 *     checklistinsider 2,054 + 420, beckett-checklist 206 — all donruss-optic
 *   un-graded catalog rows on a :panini-optic: id STEM               142,352
 *   sold_comps rows on a :panini-optic: id stem                      344,978
 *     of them football 2023                                           54,873
 *   sold_comps rows on a :donruss-optic: id stem                           0
 *
 * So the pool sits entirely on the spelling no checklist uses, which is a
 * split pool by construction: every Optic FMV is computed from a comp set
 * that can never reach its own checklist row.
 *
 * THE OPPOSITE OF FINEST. D36 (#1566) had the id already right (topps-finest)
 * and 58,442 rows whose FIELD lagged on `finest`. Optic is the mirror: the
 * field is right on the checklist rows and the ID lags on 142,352. Same table
 * entry shape, same fleet, opposite column — which is why the fold is a
 * `spelled` row here and not a new mechanism.
 *
 * NO ERA RULE, and that is a measurement not an assumption. Donruss carries
 * spellForEra because the line spans two owners across a 2009 boundary. Optic
 * launched 2016, wholly inside the Panini era: donruss-optic spans 2016-2025
 * with ZERO rows before 2016, and the only two pre-2016 panini-optic rows are
 * a sales-attested mis-parse of "2003 Panini Optic Basketball", a product that
 * never existed. An era switch would have no boundary to sit on.
 *
 * These pins are the mutation checks:
 *   - point the vocabulary back at panini-optic                        → red
 *   - drop `panini-optic` from the table's names (the fleet stops moving) → red
 *   - widen the optic rules until they eat panini-contenders-optic or
 *     leaf-optichrome                                                  → red
 */
import { describe, it, expect } from "vitest";
import {
  computeHobbyIqCardId,
  deriveParentSetKey,
  normalizeSetKey,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  productAncestry,
  productEntry,
  productFamilyOf,
  productSetKeyForName,
  spellForEra,
} from "../src/services/catalog/productSetKeys.js";
import { productFamilyKey, sameProductFamily } from "../src/services/portfolioiq/productFamily.service.js";

const seg = (slug: string) => slug.split(":")[3];
const id = (setKey: string, year = 2023, cardNumber = "244", sport = "football") =>
  computeHobbyIqCardId({ sport, year, setKey, cardNumber, parallel: "Base", isAuto: false, printRun: null });

describe("Optic is ONE product, spelled donruss-optic (D31)", () => {
  it.each([
    // [checklist / seller text, the one spelling]
    ["2023 Donruss Optic Football", "donruss-optic"],
    ["Donruss Optic", "donruss-optic"],
    ["donruss-optic", "donruss-optic"],
    ["2023 Panini Donruss Optic", "donruss-optic"],
    ["panini-donruss-optic", "donruss-optic"],
    ["2024 Panini Optic Basketball", "donruss-optic"],
    ["panini-optic", "donruss-optic"],
    ["Optic", "donruss-optic"],
  ])("%s -> %s, in the id and in normalizeSetKey", (text, want) => {
    expect(normalizeSetKey(text)).toBe(want);
    expect(seg(id(text))).toBe(want);
  });

  it("BOTH directions: the old spelling resolves to the new key, and the new key is stable", () => {
    // the direction the rename fleet reads — a stored panini-optic row knows
    // where it is going
    expect(productSetKeyForName("panini-optic")).toBe("donruss-optic");
    expect(productSetKeyForName("panini-donruss-optic")).toBe("donruss-optic");
    // ...and the canonical spelling answers as itself, so a second pass is a
    // no-op rather than a churn
    expect(productSetKeyForName("donruss-optic")).toBe("donruss-optic");
    expect(productEntry("panini-optic")!.setKey).toBe("donruss-optic");
    expect(productEntry("donruss-optic")!.setKey).toBe("donruss-optic");
  });

  it("one pool: the legacy spelling prices within the product while the fleet runs", () => {
    expect(productFamilyOf("panini-optic")).toBe("donruss-optic");
    expect(productFamilyOf("donruss-optic")).toBe("donruss-optic");
    expect(sameProductFamily("panini-optic", "donruss-optic")).toBe(true);
    expect(productFamilyKey("panini-optic")).toBe("donruss-optic");
    // the walk reaches the maker, so the reference ladder still widens
    expect(productAncestry("panini-optic")).toContain("donruss-optic");
    expect(productAncestry("donruss-optic")).toContain("panini");
    expect(deriveParentSetKey("donruss-optic")).toBe("panini");
  });

  it("no era rule: Optic is Panini-era-only, so the spelling is the same in every year", () => {
    // Donruss spans two owners and needs the boundary...
    expect(spellForEra("donruss", 1990)).toBe("donruss");
    expect(spellForEra("donruss", 2025)).toBe("panini-donruss");
    // ...Optic launched 2016 and never had a pre-Panini era to spell.
    expect(spellForEra("donruss-optic", 1990)).toBe("donruss-optic");
    expect(spellForEra("donruss-optic", 2016)).toBe("donruss-optic");
    expect(spellForEra("donruss-optic", 2025)).toBe("donruss-optic");
    expect(spellForEra("panini-optic", 2025)).toBe("panini-optic"); // untouched; the TABLE renames it, not the era
    for (const y of [2016, 2019, 2023, 2024, 2025]) {
      expect(resolveSetKeyForSlug("football", "Donruss Optic", y)).toBe("donruss-optic");
      expect(resolveSetKeyForSlug("football", "Panini Optic", y)).toBe("donruss-optic");
    }
  });

  it("the FB2023 lane the dry run measured mints one id for both spellings", () => {
    const fromChecklist = id("2023 Donruss Optic Football", 2023, "244");
    const fromVendor = id("2023 Panini Optic Football", 2023, "244");
    expect(fromChecklist).toBe("hiq:football:2023:donruss-optic:244:base:no-auto");
    expect(fromVendor).toBe(fromChecklist);
  });
});

describe("the fold does not eat its neighbours (sapphire-style non-collapse)", () => {
  // "Optic" names a chrome STOCK that other Panini products borrow. Each of
  // these is a different product with its own checklist and its own prices;
  // counts are un-graded catalog rows measured 2026-08-31.
  // The property that matters for THIS fold: none of them resolve to
  // donruss-optic. Where each one lands otherwise is another lane's ruling and
  // is asserted here only as the measured status quo on origin/main, so a
  // future widening of the optic rules is caught by a red test rather than by
  // a split pool.
  it.each([
    // [text, where it lands today, un-graded catalog rows on the key it NAMES]
    ["2023 Panini Contenders Optic Football", "panini-contenders", 12_133],
    ["2024 Leaf Optichrome Baseball", "leaf-optichrome", 81_298],
  ])("%s does not fold into Optic (lands on %s)", (text, lands) => {
    expect(normalizeSetKey(text)).not.toBe("donruss-optic");
    expect(seg(id(text))).not.toBe("donruss-optic");
    expect(normalizeSetKey(text)).toBe(lands);
  });

  // PRE-EXISTING, NOT THIS FOLD, and pinned so it is not mistaken for one.
  // The qualified spelling is safe because /panini-contenders/ is matched
  // before /panini-optic/ in the strict tier. The BARE spelling is not: the
  // bare /(^|-)optic(-|$)/ rule sits one line above /(^|-)contenders(-|$)/,
  // so "Contenders Optic" reaches the optic rule first. On origin/main that
  // produced panini-optic; after this fold it produces donruss-optic -- the
  // DESTINATION is renamed by this change, the COLLAPSE is not introduced by
  // it. 35 catalog rows sit on a bare contenders-optic key (measured
  // 2026-08-31), and re-ordering those two bare rules is its own lane with
  // its own blast radius. This test states the behaviour so that lane starts
  // from a measured premise rather than a rediscovery.
  it("KNOWN GAP: bare Contenders Optic still collapses into Optic (pre-existing rule order)", () => {
    expect(normalizeSetKey("Contenders Optic")).toBe("donruss-optic");
    // the qualified spelling, which is the one the checklists write, is fine
    expect(normalizeSetKey("Panini Contenders Optic")).toBe("panini-contenders");
  });

  it("the neighbours are not in the same pool as Optic", () => {
    expect(sameProductFamily("panini-contenders-optic", "donruss-optic")).toBe(false);
    expect(sameProductFamily("leaf-optichrome", "donruss-optic")).toBe(false);
    expect(productFamilyOf("leaf-optichrome")).not.toBe("donruss-optic");
  });

  it("the sibling Panini products keep their own keys", () => {
    expect(normalizeSetKey("2024 Donruss")).toBe("panini-donruss");
    expect(normalizeSetKey("2024 Donruss Elite")).toBe("donruss-elite");
    expect(normalizeSetKey("Panini Prizm")).toBe("panini-prizm");
    expect(normalizeSetKey("Panini Select")).toBe("panini-select");
    expect(normalizeSetKey("Panini Mosaic")).toBe("panini-mosaic");
    expect(normalizeSetKey("Panini Contenders")).toBe("panini-contenders");
  });

  it("a single-segment name still matches only exactly — no substring fold", () => {
    // The table must not fold a longer product onto the Optic names. Contenders
    // Optic carries no table entry at all, so it answers null; leaf-optichrome
    // is its own spelled Leaf product and answers as ITSELF -- never as Optic.
    expect(productSetKeyForName("panini-contenders-optic")).toBeNull();
    expect(productSetKeyForName("leaf-optichrome")).toBe("leaf-optichrome");
    // panini-optic is MULTI-segment, so unlike the single-segment `finest`
    // alias it also matches as a contiguous segment run inside a longer slug.
    // That is what the fleet needs: a vendor slug that still carries the year
    // resolves to the product instead of falling through to the regex tier.
    expect(productSetKeyForName("2023-panini-optic")).toBe("donruss-optic");
    expect(productSetKeyForName("panini-optic-football")).toBe("donruss-optic");
    // ...but a run is whole segments only: `optic` alone is not a table name,
    // and a product that merely CONTAINS the word is never folded in.
    expect(productSetKeyForName("optic")).toBeNull();
    expect(productSetKeyForName("panini-opticals")).toBeNull();
  });
});
