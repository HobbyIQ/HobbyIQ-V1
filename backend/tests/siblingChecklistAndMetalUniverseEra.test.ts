// CF-SIBLING-CHECKLIST-DECIDES-THE-PRODUCT + CF-METAL-UNIVERSE-NAME-WAS-REVIVED
// (Drew, 2026-09-12, #2060 follow-on).
//
// Two identity-derivation defects found on Drew's holdings:
//
//   DEFECT 1: `inferSetKeyFromTitle`'s bare /bowman\s+chrome/ rule pins any
//   title containing those two words to bowman-chrome, even when the card
//   number's OWN checklist says it belongs to a sibling product. CPA-MG
//   (Marconi German) is a 2026 Bowman (paper) number — its checklist
//   (2026-bowman-full.csv) carries three CPA-MG rows; 2026 Bowman Chrome's
//   own checklist (2026-bowman-chrome.csv) carries zero. Fixed by an
//   exact-card-number, year-scoped override table
//   (SIBLING_CHECKLIST_OVERRIDES / applySiblingChecklistOverride in
//   hobbyIqCardId.service.ts), deliberately NOT a prefix rule: measured
//   2026-09-12, 8 of the 179 CPA- numbers shared by the two 2026 checklists
//   (AG, BC, DF, EM, HL, JS, LA, WA) name DIFFERENT PEOPLE in each product, so
//   a blanket "CPA- => bowman" rule would collide two real cards.
//
//   DEFECT 2: titles/stored fields reading "Skybox Metal Universe" normalize
//   to `skybox-metal-universe`, but 1996-1999 baseball checklists for this
//   product are filed bare (`metal-universe`). Read-only census against prod
//   card_catalog (2026-09-12) found this is NOT a simple key-spelling twin
//   (R22): `skybox-metal-universe` is also a REAL, currently-produced
//   (2020-2025) Upper Deck hockey/multi-sport revival with 19,700+ genuine
//   checklist-backed rows. A blanket alias would fuse that pool into the
//   1990s baseball pool. The correct shape is CF-THERE-IS-NO-FLEER-TIFFANY's
//   era-misnomer pattern: before the revival (year < 2000) the text is a
//   misnomer for the one vintage product that existed, `metal-universe`;
//   from the revival year it passes through untouched. Fixed via
//   METAL_UNIVERSE_ERA_MISNOMERS / spellForEra in productSetKeys.ts, the same
//   seam FLEER_TIFFANY_ERA_MISNOMERS already uses.
//
// Both fixes sit at the ONE seam every deriver already calls
// (computeHobbyIqCardId / resolveSetKeyForSlug / spellForEra), so the live
// title parser, slugRederivation's rederive lane and the rematch lane's
// rematch-derive-identity.cjs agree by construction.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeHobbyIqCardId,
  normalizeSetKey,
  applySiblingChecklistOverride,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { spellForEra, METAL_UNIVERSE_REVIVAL_FROM_YEAR } from "../src/services/catalog/productSetKeys.js";
import { rederiveRow } from "../src/services/portfolioiq/slugRederivation.service.js";

const setKeyOf = (id: string) => id.split(":")[3];

describe("DEFECT 1 — CF-SIBLING-CHECKLIST-DECIDES-THE-PRODUCT", () => {
  describe("applySiblingChecklistOverride", () => {
    it("moves 2026 bowman-chrome CPA-MG to bowman (Marconi German's own checklist)", () => {
      expect(applySiblingChecklistOverride("bowman-chrome", "CPA-MG", 2026)).toBe("bowman");
      expect(applySiblingChecklistOverride("bowman-chrome", "cpa-mg", 2026)).toBe("bowman"); // case-insensitive
    });

    it("does not fire for an unrelated setKey, number, or year", () => {
      expect(applySiblingChecklistOverride("bowman", "CPA-MG", 2026)).toBe("bowman"); // wrong fromSetKey
      expect(applySiblingChecklistOverride("bowman-chrome", "CPA-AG", 2026)).toBe("bowman-chrome"); // ambiguous number, not listed
      expect(applySiblingChecklistOverride("bowman-chrome", "CPA-MG", 2025)).toBe("bowman-chrome"); // wrong year
      expect(applySiblingChecklistOverride("bowman-chrome", "CPA-MG", 2027)).toBe("bowman-chrome"); // wrong year
    });

    it("never moves a number known to exist in BOTH 2026 checklists (CPA-AG: Adrian Gil in bowman, Angeibel Gomez in bowman-chrome)", () => {
      for (const cn of ["CPA-AG", "CPA-BC", "CPA-DF", "CPA-EM", "CPA-HL", "CPA-JS", "CPA-LA", "CPA-WA"]) {
        expect(applySiblingChecklistOverride("bowman-chrome", cn, 2026), cn).toBe("bowman-chrome");
      }
    });
  });

  describe("computeHobbyIqCardId — the Marconi title lands on bowman", () => {
    it("2026 Bowman Chrome Gold Refractor Marconi German #CPA-MG derives the checklist address", () => {
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "Bowman Chrome", cardNumber: "CPA-MG",
        parallel: "Gold Refractor", isAuto: true, printRun: 50, playerName: "Marconi German",
      });
      expect(setKeyOf(id)).toBe("bowman");
      expect(id).toBe("hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50");
    });

    it("a genuine 2026 Bowman Chrome title with a number present ONLY in bowman-chrome stays bowman-chrome", () => {
      // CPA-EW is not in the 2026-bowman-full.csv full-only or both lists per
      // the read census — use a chrome-only number the override table does
      // not name, which must pass through unchanged.
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "Bowman Chrome", cardNumber: "CPA-EW",
        parallel: "Refractor", isAuto: true, printRun: 499, playerName: "Eli Willits",
      });
      expect(setKeyOf(id)).toBe("bowman-chrome");
    });

    it("a number present in both checklists (CPA-AG) is untouched — stays whatever the title said", () => {
      const chrome = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "Bowman Chrome", cardNumber: "CPA-AG",
        parallel: "Refractor", isAuto: true, printRun: 499, playerName: "Angeibel Gomez",
      });
      expect(setKeyOf(chrome)).toBe("bowman-chrome");

      const bowman = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "Bowman", cardNumber: "CPA-AG",
        parallel: null, isAuto: true, playerName: "Adrian Gil",
      });
      expect(setKeyOf(bowman)).toBe("bowman");
    });

    it("checklist ingest (authoritativeSetKey) is never touched by the override", () => {
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "Bowman Chrome", cardNumber: "CPA-MG",
        parallel: "Gold Refractor", isAuto: true, printRun: 50, playerName: "Marconi German",
        authoritativeSetKey: true,
      });
      // A caller that KNOWS the product keeps it verbatim, even if (hypothetically)
      // wrong — the override exists to repair untrusted vendor text only.
      expect(setKeyOf(id)).toBe("bowman-chrome");
    });
  });

  describe("slugRederivation.rederiveRow — the guard-pass branch now catches this", () => {
    it("MODE=rederive now moves Marconi German's holding off bowman-chrome onto bowman", () => {
      // RederiveRow carries no printRun field (pre-existing shape, shared with
      // the sport-normalized branch above), so the corrected slug carries the
      // parallel but not the /50 -- the same limitation "sport-normalized"
      // already has. The setKey correction is what this test pins.
      const res = rederiveRow({
        hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50",
        sport: "baseball",
        cardYear: 2026,
        setName: "Bowman Chrome",
        cardNumber: "CPA-MG",
        parallel: "Gold Refractor",
        isAuto: true,
        title: "2026 Bowman Chrome Gold Refractor Marconi German Auto /50 #CPA-MG",
      });
      expect(res.action).toBe("sibling-corrected");
      expect(res.setName).toBe("bowman");
      expect(res.hobbyiqCardId).toBe("hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto");
      expect(setKeyOf(res.hobbyiqCardId as string)).toBe("bowman");
    });

    it("a genuinely bowman-chrome row (chrome-only number) is still ok-untouched", () => {
      const res = rederiveRow({
        sport: "baseball",
        cardYear: 2026,
        setName: "Bowman Chrome",
        cardNumber: "CPA-EW",
        parallel: "Refractor",
        isAuto: true,
        title: "2026 Bowman Chrome Refractor Eli Willits Auto /499 #CPA-EW",
      });
      expect(res.action).toBe("ok-untouched");
    });

    it("a colliding number (CPA-AG) already stored as bowman-chrome is left untouched, not moved onto Adrian Gil's card", () => {
      const res = rederiveRow({
        sport: "baseball",
        cardYear: 2026,
        setName: "Bowman Chrome",
        cardNumber: "CPA-AG",
        parallel: "Refractor",
        isAuto: true,
        title: "2026 Bowman Chrome Refractor Angeibel Gomez Auto /499 #CPA-AG",
      });
      expect(res.action).toBe("ok-untouched");
    });
  });
});

describe("DEFECT 2 — CF-METAL-UNIVERSE-NAME-WAS-REVIVED", () => {
  describe("spellForEra", () => {
    it("a vintage 'Skybox Metal Universe' text (pre-2000) is a misnomer for metal-universe", () => {
      expect(spellForEra("skybox-metal-universe", 1997)).toBe("metal-universe");
      expect(spellForEra("skybox-metal-universe", 1996)).toBe("metal-universe");
      expect(spellForEra("skybox-metal-universe", 1999)).toBe("metal-universe");
    });

    it("the revival era (>= 2000, in practice 2020+) passes through untouched", () => {
      expect(spellForEra("skybox-metal-universe", 2000)).toBe("skybox-metal-universe");
      expect(spellForEra("skybox-metal-universe", 2021)).toBe("skybox-metal-universe");
      expect(spellForEra("skybox-metal-universe", METAL_UNIVERSE_REVIVAL_FROM_YEAR)).toBe("skybox-metal-universe");
    });

    it("an absent/invalid year cannot decide, so the key is left alone", () => {
      expect(spellForEra("skybox-metal-universe", null)).toBe("skybox-metal-universe");
      expect(spellForEra("skybox-metal-universe", undefined)).toBe("skybox-metal-universe");
      expect(spellForEra("skybox-metal-universe", 0)).toBe("skybox-metal-universe");
      expect(spellForEra("skybox-metal-universe", NaN)).toBe("skybox-metal-universe");
    });

    it("metal-universe itself is unaffected — it is the fixed point, not a rewrite source", () => {
      expect(spellForEra("metal-universe", 1997)).toBe("metal-universe");
      expect(spellForEra("metal-universe", 2021)).toBe("metal-universe");
    });

    it("fleer-metal-universe is NOT aliased — no measured collision to rule on (one user-verified row, zero checklist rows either side)", () => {
      expect(spellForEra("fleer-metal-universe", 1996)).toBe("fleer-metal-universe");
    });

    it("does not disturb the existing Fleer-Tiffany era rule alongside it", () => {
      expect(spellForEra("fleer-tiffany", 1987)).toBe("fleer-glossy");
      expect(spellForEra("fleer-tiffany", 1996)).toBe("fleer-tiffany");
    });
  });

  describe("metal-universe is a normalizeSetKey fixed point", () => {
    it("normalizing it again returns itself", () => {
      expect(normalizeSetKey(normalizeSetKey("Metal Universe"))).toBe("metal-universe");
      expect(normalizeSetKey("metal-universe")).toBe("metal-universe");
    });
  });

  describe("computeHobbyIqCardId — the Chipper Jones title lands on the checklist row", () => {
    it("1997 Skybox Metal Universe #31 Chipper Jones derives metal-universe, not skybox-metal-universe", () => {
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 1997, setKey: "Skybox Metal Universe", cardNumber: "31",
        parallel: "Base", isAuto: false, playerName: "Chipper Jones",
      });
      expect(setKeyOf(id)).toBe("metal-universe");
      expect(id).toBe("hiq:baseball:1997:metal-universe:31:base:no-auto");
    });

    it("a 2021 Skybox Metal Universe hockey card is untouched — the real modern product", () => {
      const id = computeHobbyIqCardId({
        sport: "hockey", year: 2021, setKey: "Skybox Metal Universe", cardNumber: "P-20",
        parallel: "Base", isAuto: false, playerName: "Test Player",
      });
      expect(setKeyOf(id)).toBe("skybox-metal-universe");
    });

    it("authoritativeSetKey skips the CHROME/SIBLING override but NOT the era rule -- same as the pre-existing Fleer-Tiffany era rule", () => {
      // authoritativeSetKey exists to stop the two OVERRIDE tables
      // (applyChromePrefixOverride, applySiblingChecklistOverride) from
      // second-guessing a checklist ingest's own stated product -- those
      // repair untrusted vendor TEXT. spellForEra answers a different
      // question ("does this exact spelling name a different real product in
      // a different era") and resolveSetKeyForSlug has always applied it
      // unconditionally -- FLEER_TIFFANY_ERA_MISNOMERS already behaves this
      // way for "Fleer Tiffany" ingest rows, so this is not a new asymmetry
      // this PR introduces. No real scraped checklist in this repo ever
      // states "Skybox Metal Universe" for 1996-1999 (they are bare
      // "Metal Universe"), so the case is theoretical, but the behaviour is
      // the SAME rule applied consistently.
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 1997, setKey: "Skybox Metal Universe", cardNumber: "31",
        parallel: "Base", isAuto: false, playerName: "Chipper Jones",
        authoritativeSetKey: true,
      });
      expect(setKeyOf(id)).toBe("metal-universe");
    });
  });

  describe("slugRederivation.rederiveRow — the guard-pass branch now catches this", () => {
    it("MODE=rederive now moves the Chipper Jones holding off skybox-metal-universe onto metal-universe", () => {
      const res = rederiveRow({
        hobbyiqCardId: "hiq:baseball:1997:skybox-metal-universe:31:base:no-auto",
        sport: "baseball",
        cardYear: 1997,
        setName: "Skybox Metal Universe",
        cardNumber: "31",
        parallel: "Base",
        isAuto: false,
        title: "1997 Skybox Metal Universe Chipper Jones #31",
      });
      expect(res.action).toBe("sibling-corrected");
      expect(res.setName).toBe("metal-universe");
      expect(res.hobbyiqCardId).toBe("hiq:baseball:1997:metal-universe:31:base:no-auto");
    });

    it("a real modern (2021) Skybox Metal Universe hockey row is left ok-untouched", () => {
      const res = rederiveRow({
        sport: "hockey",
        cardYear: 2021,
        setName: "Skybox Metal Universe",
        cardNumber: "P-20",
        parallel: "Base",
        isAuto: false,
        title: "2021 Skybox Metal Universe Hockey #P-20",
      });
      expect(res.action).toBe("ok-untouched");
    });
  });
});

/**
 * Mutation checks. A guard that cannot fail is not a guard: each of these
 * asserts the SOURCE still carries the load-bearing clause, so deleting it
 * reddens CI rather than silently restoring the collapse.
 */
describe("the fixes are load-bearing in source, not just in these tests", () => {
  const hobbyIqCardIdSrc = readFileSync(
    path.resolve(__dirname, "../src/services/portfolioiq/hobbyIqCardId.service.ts"),
    "utf8",
  );
  const productSetKeysSrc = readFileSync(
    path.resolve(__dirname, "../src/services/catalog/productSetKeys.ts"),
    "utf8",
  );

  it("SIBLING_CHECKLIST_OVERRIDES is keyed on an exact card number set, never a prefix regex", () => {
    expect(hobbyIqCardIdSrc).toMatch(/cardNumbers:\s*new Set\(\["CPA-MG"\]\)/);
    // The whole point of the table: no cardNumberPrefix-shaped entry exists in it.
    const tableBody = hobbyIqCardIdSrc.slice(
      hobbyIqCardIdSrc.indexOf("SIBLING_CHECKLIST_OVERRIDES: readonly SiblingChecklistOverride[]"),
      hobbyIqCardIdSrc.indexOf("function applySiblingChecklistOverride"),
    );
    expect(tableBody).not.toMatch(/cardNumberPrefix/);
  });

  it("applySiblingChecklistOverride is consulted from computeHobbyIqCardId's setKey resolution", () => {
    expect(hobbyIqCardIdSrc).toMatch(/applySiblingChecklistOverride\(\s*applyChromePrefixOverride\(baseSetKey/);
  });

  it("METAL_UNIVERSE_ERA_MISNOMERS still declares the revival boundary", () => {
    expect(productSetKeysSrc).toContain('"skybox-metal-universe": "metal-universe"');
    expect(productSetKeysSrc).toMatch(/METAL_UNIVERSE_REVIVAL_FROM_YEAR = 2000/);
  });

  it("spellForEra still honours the metal-universe boundary instead of ignoring it", () => {
    expect(productSetKeysSrc).toMatch(
      /year < METAL_UNIVERSE_REVIVAL_FROM_YEAR \? metalUniverseMisnomer : setKey/,
    );
  });
});
