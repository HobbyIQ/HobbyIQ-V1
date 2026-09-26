/**
 * STAMP-FIX BATCH 2 (2026-09-26). Two identity-parser defects found by live
 * traces against prod (Cosmos, read-only, no writes) run today.
 *
 * DEFECT A -- "SS" (Sensational Signatures, 2025 Panini Prizm baseball) is
 * an autograph-only insert. AUTO_SETNAME_RE already recognizes the phrase
 * "sensational signatures" in TITLE TEXT, but the cardNumber-prefix auto
 * tables (isCardNumberAutoSubset's global AUTO_PREFIX, and
 * hobbyIqCardId.service.ts's AUTO_ONLY_CARDNUMBER_PREFIX) had no entry, so
 * generic vendor listings that never say the insert's name by name (e.g.
 * "#SS-JW Base") stored isAuto=false while the checklist rows for the same
 * cardNumber+parallel are already :auto. Evidence:
 * C:/tmp/prizm_ss_trace_1422/RESULT.md -- 7,058 sold_comps rows, 86% stored
 * no-auto.
 *
 * "SS" cannot be added GLOBALLY: the identical letters are a card-number-
 * INITIALS token on other Panini Prizm products with no auto meaning at all
 * (e.g. "2020 Panini Prizm Basketball #SS-AEW Base" -- wrestling initials,
 * see inferSportFromTitle's own comment on this exact card). Scoped to
 * (sport, year, setKey) = (baseball, 2025, panini-prizm) in BOTH tables,
 * mirroring the existing SCOPED_AUTO_PREFIX / isScopedAutoPrefix additive
 * contract -- a miss changes nothing.
 *
 * DEFECT B -- "Topps Living" / "Topps Living Set" is its own annual,
 * continuously-numbered product (2018 -> present; numbers do not reset
 * year over year) but had no token in inferSetKeyFromTitle, so every title
 * fell to the bare `/topps/` catch-all AND "Living"/"Living Set" survived
 * into the player-name span on the eBay/CardHedge-title parser
 * (ebayTitleParser.service.ts), producing playerName "Living Shohei Ohtani".
 * Evidence: C:/tmp/topps24_trace_1530/RESULT.md -- 1,632 2024 sales, 41
 * distinct cardNumbers (700s-900s, outside base Series 1/2's ~1-660 range),
 * zero card_catalog rows for any Topps Living Set spelling.
 *
 * Fixed by: registering `topps-living-set` (spelled, with alias "topps-
 * living") in productSetKeys.ts so productSetKeyForName answers ahead of
 * the bare /topps/ fallback (both computeHobbyIqCardId's resolveSetKeyForSlug
 * and normalizeSetKey read this same table, so they agree by construction);
 * a title token in inferSetKeyFromTitle ordered before the bare /topps/
 * rule; and an INSERT_TOKENS entry ("living") in ebayTitleParser.service.ts
 * so extractPlayerName's strip set removes the word before the player-name
 * run is found.
 */
import { describe, it, expect } from "vitest";
import {
  inferSetKeyFromTitle,
  isCardNumberAutoSubset,
  parseListingIdentity,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { computeHobbyIqCardId, normalizeSetKey, resolveSetKeyForSlug } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { productSetKeyForName, productEntry } from "../src/services/catalog/productSetKeys.js";
import { parseListingTitle } from "../src/services/portfolioiq/ebayTitleParser.service.js";

describe("DEFECT A -- Sensational Signatures (SS-) is auto-only, scoped to 2025 Panini Prizm baseball", () => {
  describe("isCardNumberAutoSubset (parseTitleIdentity.service.ts)", () => {
    it("unscoped: unchanged from today", () => {
      expect(isCardNumberAutoSubset("SS-JW")).toBe(false);
    });

    it("scoped to baseball|2025|panini-prizm: reads auto", () => {
      const scope = { sport: "baseball", year: 2025, setKey: "panini-prizm" };
      for (const cn of ["SS-JW", "SS-JL", "SS-HK", "SS-JG", "SS-CK", "SS-CE", "SS-TH"]) {
        expect(isCardNumberAutoSubset(cn, scope)).toBe(true);
      }
    });

    it("case/hyphen-insensitive, matching the global rule's own convention", () => {
      const scope = { sport: "baseball", year: 2025, setKey: "panini-prizm" };
      expect(isCardNumberAutoSubset("ss-jw", scope)).toBe(true);
      expect(isCardNumberAutoSubset("#SS-JW", scope)).toBe(true);
    });

    it("PINNED: SS- in an adjacent year/product stays unscoped / non-auto", () => {
      expect(isCardNumberAutoSubset("SS-JW", { sport: "baseball", year: 2024, setKey: "panini-prizm" })).toBe(false);
      expect(isCardNumberAutoSubset("SS-JW", { sport: "baseball", year: 2026, setKey: "panini-prizm" })).toBe(false);
      expect(isCardNumberAutoSubset("SS-JW", { sport: "baseball", year: 2025, setKey: "panini-prizm-draft-picks" })).toBe(false);
    });

    it("PINNED NEGATIVE CONTROL: SS-AEW under Panini Prizm BASKETBALL never reads auto", () => {
      // "2020 Panini Prizm Basketball #SS-AEW Base" -- wrestling initials
      // inside a Prizm insert number, not an autograph anywhere.
      expect(isCardNumberAutoSubset("SS-AEW", { sport: "basketball", year: 2020, setKey: "panini-prizm" })).toBe(false);
      expect(isCardNumberAutoSubset("SS-AEW", { sport: "basketball", year: 2025, setKey: "panini-prizm" })).toBe(false);
    });

    it("missing scope fields never throw and read false", () => {
      expect(isCardNumberAutoSubset("SS-JW", {})).toBe(false);
      expect(isCardNumberAutoSubset("SS-JW", { sport: "baseball" })).toBe(false);
      expect(isCardNumberAutoSubset("SS-JW", { sport: "baseball", year: 2025 })).toBe(false);
      expect(isCardNumberAutoSubset(null, { sport: "baseball", year: 2025, setKey: "panini-prizm" })).toBe(false);
    });
  });

  describe("parseListingIdentity -- real terse templated titles from the trace", () => {
    it('"2025 Panini Prizm - Sensational Signatures Jaxon Wiggins #SS-JW (AU, RC)" -- AUTO_RE needs the word "auto"/"autograph", not the "AU" abbreviation -- the scoped cardNumber fix is what catches it', () => {
      const title = "2025 Panini Prizm - Sensational Signatures Jaxon Wiggins #SS-JW (AU, RC)";
      // extractIsAuto's AUTO_RE requires \bauto\b/autograph/hard-signed; "(AU, RC)"
      // alone does not match, so title text alone (no scope) reads false here --
      // exactly the real prod sample from the trace, and exactly why the
      // cardNumber-prefix fix (not just AUTO_SETNAME_RE) is the needed repair.
      expect(parseListingIdentity(title).isAuto).toBe(false);
      expect(
        parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "panini-prizm" }).isAuto,
      ).toBe(true);
    });

    it('generic vendor listing "#SS-JL Base" carries none of the insert wording -- auto only when scoped', () => {
      const title = "2025 Panini Prizm Baseball #SS-JL Base";
      expect(parseListingIdentity(title).isAuto).toBe(false);
      expect(
        parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "panini-prizm" }).isAuto,
      ).toBe(true);
    });

    it('"#SS-HK Base" -- same shape, different number', () => {
      const title = "2025 Panini Prizm Baseball #SS-HK Base";
      expect(parseListingIdentity(title).isAuto).toBe(false);
      expect(
        parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "panini-prizm" }).isAuto,
      ).toBe(true);
    });

    it("wrong scope (basketball, same SS- initials) must not leak a positive", () => {
      const title = "2020 Panini Prizm Basketball #SS-AEW Base";
      expect(
        parseListingIdentity(title, undefined, { vertical: "basketball", year: 2020, setKey: "panini-prizm" }).isAuto,
      ).toBe(false);
    });
  });

  describe("hobbyIqCardId.service.ts -- computeHobbyIqCardId writes :auto for the real product", () => {
    it("SS-JW under 2025 panini-prizm baseball: id ends :auto", () => {
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 2025, setKey: "panini-prizm",
        cardNumber: "SS-JW", parallel: "Base", isAuto: false,
      });
      expect(id).toMatch(/:auto(:|$)/);
      expect(id).not.toMatch(/:no-auto/);
    });

    it("BEFORE/AFTER: SS-JL, SS-HK stored isAuto=false are repaired to :auto", () => {
      for (const cn of ["SS-JL", "SS-HK", "SS-JG", "SS-CK", "SS-CE"]) {
        const before = `hiq:baseball:2025:panini-prizm:${cn.toLowerCase()}:base:no-auto`; // what prod held
        const after = computeHobbyIqCardId({
          sport: "baseball", year: 2025, setKey: "panini-prizm",
          cardNumber: cn, parallel: "Base", isAuto: false,
        });
        expect(after).not.toBe(before);
        expect(after).toMatch(/:auto(:|$)/);
      }
    });

    it("PINNED: the same SS- prefix on 2025 panini-prizm-draft-picks (a different insert address) is untouched", () => {
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 2025, setKey: "panini-prizm-draft-picks",
        cardNumber: "SS-JW", parallel: "Base", isAuto: false,
      });
      expect(id).toMatch(/:no-auto/);
    });

    it("PINNED NEGATIVE CONTROL: 2020 Panini Prizm BASKETBALL SS-AEW stays :no-auto", () => {
      const id = computeHobbyIqCardId({
        sport: "basketball", year: 2020, setKey: "panini-prizm",
        cardNumber: "SS-AEW", parallel: "Base", isAuto: false,
      });
      expect(id).toMatch(/:no-auto/);
    });

    it("authoritativeSetKey callers (checklist ingest) still get the scoped auto-force -- it is orthogonal to setKey override", () => {
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 2025, setKey: "panini-prizm",
        cardNumber: "SS-TH", parallel: "Red Prizm", isAuto: false, printRun: 5,
        authoritativeSetKey: true,
      });
      expect(id).toMatch(/:auto(:|$)/);
    });
  });
});

describe("DEFECT B -- Topps Living Set is its own product, not bare 'topps'", () => {
  describe("productSetKeys.ts registration", () => {
    it("topps-living-set is a declared product", () => {
      const entry = productEntry("topps-living-set");
      expect(entry, "topps-living-set must be a declared product").toBeTruthy();
      expect(entry?.spelled).toBe(true);
    });

    it("productSetKeyForName answers 'topps-living' as the alias -> topps-living-set", () => {
      expect(productSetKeyForName("topps-living")).toBe("topps-living-set");
      expect(productSetKeyForName("topps-living-set")).toBe("topps-living-set");
    });

    it("is its OWN family, not a refinement of flagship topps (own numbering/roster)", () => {
      const entry = productEntry("topps-living-set");
      expect(entry?.parent).toBeFalsy();
      expect(entry?.refines).toBeFalsy();
    });
  });

  describe("normalizeSetKey / resolveSetKeyForSlug agree, and the key is a fixed point", () => {
    it("normalizeSetKey leaves the canonical key alone", () => {
      expect(normalizeSetKey("topps-living-set")).toBe("topps-living-set");
    });

    it("both spellings the market uses resolve to the one key", () => {
      for (const spelling of ["Topps Living", "Topps Living Set", "topps-living", "Topps Living Baseball"]) {
        expect(normalizeSetKey(spelling), `${spelling} must reach topps-living-set`).toBe("topps-living-set");
      }
    });

    it("resolveSetKeyForSlug (the slugGuard-facing resolver) agrees with normalizeSetKey", () => {
      expect(resolveSetKeyForSlug("baseball", "Topps Living", 2024)).toBe("topps-living-set");
      expect(resolveSetKeyForSlug("baseball", "Topps Living Set", 2024)).toBe("topps-living-set");
    });

    it("THE PARENT IS UNTOUCHED -- flagship topps still normalizes to itself", () => {
      expect(normalizeSetKey("Topps")).toBe("topps");
      expect(normalizeSetKey("topps")).toBe("topps");
      expect(normalizeSetKey("Topps Series 1")).not.toBe("topps-living-set");
    });
  });

  describe("inferSetKeyFromTitle -- the title reader's own required test cases", () => {
    it('"2024 Topps Living Baseball #737 Base" -> topps-living-set, cardNumber 737', () => {
      const title = "2024 Topps Living Baseball #737 Base";
      expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe("topps-living-set");
      const identity = parseListingIdentity(title);
      expect(identity.cardNumber).toBe("737");
    });

    it('"2024 Topps Living Set #729 Shohei Ohtani PSA 10" -> topps-living-set, no "Living" in playerName', () => {
      const title = "2024 Topps Living Set #729 Shohei Ohtani PSA 10";
      expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe("topps-living-set");
      const parsed = parseListingTitle(title);
      expect(parsed.playerName).toBe("Shohei Ohtani");
      expect(String(parsed.playerName)).not.toMatch(/living/i);
    });

    it('"2024 Topps Series 1 #45 ..." is unchanged -- Series 1/2/Update fold into flagship "topps" today, exactly as before this PR', () => {
      const title = "2024 Topps Series 1 #45 Bobby Witt Jr";
      expect(normalizeSetKey(inferSetKeyFromTitle(title))).not.toBe("topps-living-set");
      expect(normalizeSetKey(inferSetKeyFromTitle(title))).toBe("topps");
    });

    it('"1992 Jimmy Dean Living Legends" is unchanged -- an unrelated product that also says "Living"', () => {
      const title = "1992 Jimmy Dean Living Legends";
      expect(normalizeSetKey(inferSetKeyFromTitle(title))).not.toBe("topps-living-set");
    });

    it("real trace titles: CardHedge slab-derived and all-caps market spellings all resolve", () => {
      const titles = [
        "2024 Topps Living Shohei Ohtani #729 PSA 10 Gem Mint",
        "2024 TOPPS LIVING SET #737 CEDDANNE RAFAELA *ROOKIE PSA 9 MINT*",
      ];
      for (const title of titles) {
        expect(normalizeSetKey(inferSetKeyFromTitle(title)), title).toBe("topps-living-set");
      }
    });
  });

  describe("ebayTitleParser.service.ts -- playerName no longer swallows 'Living'", () => {
    it('"2024 Topps Living Shohei Ohtani #729 PSA 10 Gem Mint" -> playerName "Shohei Ohtani", setName "Topps Living"', () => {
      const parsed = parseListingTitle("2024 Topps Living Shohei Ohtani #729 PSA 10 Gem Mint");
      expect(parsed.playerName).toBe("Shohei Ohtani");
      expect(parsed.setName).toBe("Topps Living");
      expect(normalizeSetKey(String(parsed.setName))).toBe("topps-living-set");
    });

    it('"2024 TOPPS LIVING SET #737 CEDDANNE RAFAELA *ROOKIE PSA 9 MINT*" -> playerName "Ceddanne Rafaela"', () => {
      const parsed = parseListingTitle("2024 TOPPS LIVING SET #737 CEDDANNE RAFAELA *ROOKIE PSA 9 MINT*");
      expect(parsed.playerName).toBe("Ceddanne Rafaela");
      expect(String(parsed.playerName)).not.toMatch(/living/i);
    });

    it("BEFORE/AFTER regression pin: this exact title used to parse playerName 'Living Shohei Ohtani'", () => {
      const parsed = parseListingTitle("2024 Topps Living Shohei Ohtani #729 PSA 10 Gem Mint");
      expect(parsed.playerName).not.toBe("Living Shohei Ohtani");
      expect(parsed.playerName).toBe("Shohei Ohtani");
    });

    it("COUNTER-CASE: an ordinary Topps title's setName/cardNumber are untouched by the new 'living' token", () => {
      // Pre-existing behavior, unrelated to this fix: "Baseball" is not in
      // IGNORE_TOKENS, so it survives into playerName both before and after
      // this PR -- out of scope here; only asserting the 'living' token
      // changed nothing else about this ordinary title.
      const parsed = parseListingTitle("2024 Topps Baseball #295 Henry Davis Base");
      expect(parsed.setName).toBe("Topps");
      expect(parsed.cardNumber).toBe("295");
      expect(String(parsed.playerName)).not.toMatch(/living/i);
    });
  });

  describe("computeHobbyIqCardId -- the resolved key reaches the written id, own year, no invented year logic", () => {
    it("2024 #737 Base -> hiq:baseball:2024:topps-living-set:737:base:no-auto", () => {
      const id = computeHobbyIqCardId({
        sport: "baseball", year: 2024, setKey: "topps-living-set",
        cardNumber: "737", parallel: "Base", isAuto: false,
      });
      expect(id).toBe("hiq:baseball:2024:topps-living-set:737:base:no-auto");
    });

    it("the sale title's OWN year is used verbatim -- 2018 and 2026 both pass through unchanged", () => {
      const id2018 = computeHobbyIqCardId({
        sport: "baseball", year: 2018, setKey: "topps-living-set",
        cardNumber: "1", parallel: "Base", isAuto: false,
      });
      const id2026 = computeHobbyIqCardId({
        sport: "baseball", year: 2026, setKey: "topps-living-set",
        cardNumber: "900", parallel: "Base", isAuto: false,
      });
      expect(id2018).toBe("hiq:baseball:2018:topps-living-set:1:base:no-auto");
      expect(id2026).toBe("hiq:baseball:2026:topps-living-set:900:base:no-auto");
    });
  });
});
