import { describe, it, expect } from "vitest";
import {
  spellForEra,
  FLEER_TIFFANY_IS_GLOSSY_BEFORE_YEAR,
  productEntry,
  isSameNumberParallelSet,
} from "../src/services/catalog/productSetKeys";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";

/**
 * CF-THERE-IS-NO-FLEER-TIFFANY (Drew, 2026-09-05).
 *
 * "Tiffany" is a Topps line. Fleer's 1980s coated product is FLEER GLOSSY --
 * the 1987-1989 Glossy Tin and Fleer Update Glossy 1987-1988. There is no
 * 1980s Fleer Tiffany and there never was.
 *
 * The ruling is scoped BY YEAR, and the data is why. Measured on prod
 * 2026-09-04:
 *
 *   - ZERO `fleer-tiffany` catalog rows exist for 1984-1991.
 *   - 848 `fleer-tiffany` pool rows exist, every one of them 1996/1997/2002,
 *     and ALL 848 have titles that say "Tiffany" -- because the source
 *     (sportscardchecklist.com) serves "1996 Fleer Tiffany", "1997 Fleer
 *     Tiffany", "1997-98 Fleer Tiffany" and "2002 Fleer Tiffany" at their own
 *     set pages. Those are real products; a blanket rewrite would destroy a
 *     real pool to fix a misnomer that lives in another decade.
 *   - Nine 1987 sales say BOTH words ("1987 Fleer **GLOSSY** #369 Bo Jackson
 *     ROOKIE TIFFANY"). Those already resolve right -- `glossy` wins when both
 *     appear. The gap this pins is the title that says Tiffany and nothing
 *     else.
 */
describe("there is no Fleer Tiffany (1980s)", () => {
  it("a pre-1996 Fleer Tiffany key IS the Glossy product", () => {
    expect(spellForEra("fleer-tiffany", 1987)).toBe("fleer-glossy");
    expect(spellForEra("fleer-tiffany", 1988)).toBe("fleer-glossy");
    expect(spellForEra("fleer-tiffany", 1989)).toBe("fleer-glossy");
    expect(spellForEra("fleer-update-tiffany", 1987)).toBe("fleer-update-glossy");
    expect(spellForEra("fleer-update-tiffany", 1988)).toBe("fleer-update-glossy");
  });

  it("the parser never MINTS a 1980s fleer-tiffany identity -- it lands on Glossy", () => {
    // The whole point: a seller title saying "Fleer Tiffany" for a 1987 card
    // still reaches the Glossy card's pool rather than opening an empty one.
    expect(computeHobbyIqCardId({ sport: "baseball", year: 1987, setKey: "1987 Fleer Tiffany", cardNumber: "369" }))
      .toBe("hiq:baseball:1987:fleer-glossy:369:base:no-auto");
    expect(computeHobbyIqCardId({ sport: "baseball", year: 1987, setKey: "1987 Fleer Update Tiffany", cardNumber: "U68" }))
      .toBe("hiq:baseball:1987:fleer-update-glossy:u68:base:no-auto");
    // ...which is the SAME id the honest Glossy title produces. One card, one
    // row, one pool.
    expect(computeHobbyIqCardId({ sport: "baseball", year: 1987, setKey: "1987 Fleer Glossy", cardNumber: "369" }))
      .toBe("hiq:baseball:1987:fleer-glossy:369:base:no-auto");
  });

  it("a title carrying BOTH words already resolves to Glossy, and still does", () => {
    // Nine real 1987 sales look like this. Regression guard, not a new rule.
    expect(normalizeSetKey("1987 Fleer Glossy Tiffany")).toBe("fleer-glossy");
    expect(normalizeSetKey("1987 Fleer Update Glossy (Tiffany)")).toBe("fleer-update-glossy");
  });

  it("1996+ Fleer Tiffany is a REAL product and is left alone", () => {
    // 848 pool rows and 2,715 catalog rows depend on this passing through.
    for (const year of [1996, 1997, 2002, 2003]) {
      expect(spellForEra("fleer-tiffany", year)).toBe("fleer-tiffany");
    }
    expect(spellForEra("fleer-update-tiffany", 1996)).toBe("fleer-update-tiffany");
    expect(computeHobbyIqCardId({ sport: "baseball", year: 1997, setKey: "1997 Fleer Tiffany", cardNumber: "160" }))
      .toBe("hiq:baseball:1997:fleer-tiffany:160:base:no-auto");
    expect(computeHobbyIqCardId({ sport: "basketball", year: 1997, setKey: "1997-98 Fleer Tiffany", cardNumber: "275" }))
      .toBe("hiq:basketball:1997:fleer-tiffany:275:base:no-auto");
  });

  it("a year we do not have cannot decide -- the key is left alone", () => {
    // Refuse rather than guess: an absent year must not silently rewrite a
    // real product's key into a different product's.
    for (const y of [null, undefined, 0, NaN]) {
      expect(spellForEra("fleer-tiffany", y as number | null | undefined)).toBe("fleer-tiffany");
    }
  });

  it("every key stays a normalizeSetKey fixed point (#1748's ruling holds)", () => {
    for (const k of ["fleer-tiffany", "fleer-glossy", "fleer-update-tiffany", "fleer-update-glossy", "fleer-tradition-tiffany"]) {
      expect(normalizeSetKey(k)).toBe(k);
    }
  });

  it("the era rule touches Fleer only -- Donruss and every other key are unharmed", () => {
    expect(spellForEra("donruss", 1987)).toBe("donruss");
    expect(spellForEra("donruss", 2010)).toBe("panini-donruss");
    expect(spellForEra("topps-tiffany", 1987)).toBe("topps-tiffany");
    expect(spellForEra("topps-traded-tiffany", 1987)).toBe("topps-traded-tiffany");
    expect(spellForEra("bowman-tiffany", 1989)).toBe("bowman-tiffany");
    expect(spellForEra("fleer-glossy", 1987)).toBe("fleer-glossy");
    expect(spellForEra("fleer", 1987)).toBe("fleer");
  });

  it("the Glossy destinations are declared products that reprint their parent", () => {
    // A rewrite target that is not a real product would send the sale nowhere.
    expect(productEntry("fleer-glossy")?.setKey).toBe("fleer-glossy");
    expect(productEntry("fleer-update-glossy")?.setKey).toBe("fleer-update-glossy");
    expect(isSameNumberParallelSet("fleer-glossy", "fleer")).toBe(true);
    expect(isSameNumberParallelSet("fleer-update-glossy", "fleer-update")).toBe(true);
  });

  it("the boundary is 1996, the first year the source names a Fleer Tiffany", () => {
    expect(FLEER_TIFFANY_IS_GLOSSY_BEFORE_YEAR).toBe(1996);
    expect(spellForEra("fleer-tiffany", FLEER_TIFFANY_IS_GLOSSY_BEFORE_YEAR - 1)).toBe("fleer-glossy");
    expect(spellForEra("fleer-tiffany", FLEER_TIFFANY_IS_GLOSSY_BEFORE_YEAR)).toBe("fleer-tiffany");
  });
});
