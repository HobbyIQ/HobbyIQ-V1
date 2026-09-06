// CF-THE-YEAR-IS-THE-CARDS-YEAR-NOT-THE-SALES (Drew, 2026-09-06).
//
// A 1952 Topps Mickey Mantle #311 that sold for $54,000 was filed at
// hiq:baseball:2015:topps:311 -- the year segment was the year it SOLD. These
// tests pin the two halves of the repair:
//
//   1. extractYearFromTitle reads the year the TITLE states, positionally,
//      and can see a vintage year at all (the old guess matched 20xx only);
//   2. yearTheTitleAllows makes the title outrank the vendor card-year field
//      and refuses a vendor value that is the sale year in disguise.

import { describe, it, expect } from "vitest";
import { extractYearFromTitle } from "../src/services/portfolioiq/slugRederivation.service.js";
import { yearTheTitleAllows } from "../src/services/portfolioiq/yearTheTitleAllows.js";

describe("extractYearFromTitle -- a vintage year is a year", () => {
  // Real titles from the #1890 census. The old guess returned null on all of
  // them because it matched 20xx only, and a 1952 has no 20xx in it.
  it.each([
    ["1952 Topps #311 Mickey Mantle SGC EX/NM 80", 1952],
    ["1952 Topps #311 Mickey Mantle", 1952],
    ["1954 Topps #128 Hank Aaron Rookie PSA NM-MT 8", 1954],
    ["1951 Bowman #253 Mickey Mantle Rookie", 1951],
    ["1986-1987 O-Pee-Chee Hockey #3 Wayne Gretzky PSA MINT 9", 1986],
  ])("%s -> %s", (title, expected) => {
    expect(extractYearFromTitle(title as string)).toBe(expected);
  });

  it("reads a pre-1990 year the shipped guess could not see at all", () => {
    // The old implementation, quoted so the regression is unmistakable.
    const oldGuess = (t: string): number | null => {
      const m = t.match(/\b(20\d{2})\b/);
      if (m) { const y = Number(m[1]); if (y >= 2000 && y <= 2030) return y; }
      return null;
    };
    const title = "1952 Topps #311 Mickey Mantle SGC EX/NM 80";
    expect(oldGuess(title)).toBeNull();              // the defect
    expect(extractYearFromTitle(title)).toBe(1952);  // the repair
  });
});

describe("extractYearFromTitle -- the retro/heritage rule", () => {
  // THE CASE THAT WOULD MAKE THE WHOLE FIX WRONG. A retro product states the
  // homaged year in its title and is NOT a card of that year.
  it("keeps 2023 for a Heritage card homaging a 1954 design", () => {
    expect(extractYearFromTitle("2023 Topps Heritage 1954 design Mike Trout #1")).toBe(2023);
  });

  it("keeps 2007 for a Durant homaging a 1957-58 design", () => {
    // Real title. The season pattern used to be tested across the whole string
    // BEFORE any plain year, so 1957-58 beat the 2007 that opened the title.
    expect(extractYearFromTitle("2007 Topps Kevin Durant 1957-58 Variation #112 PSA 9 Mint")).toBe(2007);
  });

  it("keeps the modern year when the PLAYER leads and the homage follows", () => {
    // A retro insert puts the player first, so "first year in the title" alone
    // would take the design year. A homage word right after the year demotes
    // it while a later year survives.
    expect(extractYearFromTitle("Pete Crow-Armstrong 1990 Foil 2025 Topps Update Series Card #U90-7")).toBe(2025);
    expect(extractYearFromTitle("HANK AARON Silver Crackle 1991 35th All-Star 2026 Topps Series 2")).toBe(2026);
  });

  it("does not let the homage rule strip the only year a title has", () => {
    expect(extractYearFromTitle("1987 Topps Mini Reprint")).toBe(1987);
  });
});

describe("extractYearFromTitle -- numbers that are not years", () => {
  it("does not read a card number as a season", () => {
    // "#1974-61" is the card NUMBER of a Topps Originals Buyback. The season
    // pattern lacked the # guard its sibling carried, so it won outright.
    expect(extractYearFromTitle("2015 Topps - Originals Buybacks Luis Aparicio #1974-61")).toBe(2015);
  });

  it("does not read a card number as a season even when it LEADS the title", () => {
    // Isolates the season pattern's `(?<!#)` from the positional rule. In the
    // title above the real year happens to come first, so first-year-wins hides
    // a missing guard; here the card number is all there is, and without the
    // guard "#1974-61" reads as the season 1974.
    expect(extractYearFromTitle("#1974-61 Aparicio Topps Buyback")).toBeNull();
  });

  it("does not read a card number as a year", () => {
    expect(extractYearFromTitle("Topps Card #1978 no year here")).toBeNull();
  });

  it("does not read a serial print run as a year", () => {
    expect(extractYearFromTitle("Barry Sanders 1998 Upper Deck UD3 Upper Realm Die-Cut #d/2000")).toBe(1998);
    expect(extractYearFromTitle("1998 Upper Deck Maxximum Dale Earnhardt #*10 One Star /2000")).toBe(1998);
  });

  it("does not read a death year as the card year", () => {
    expect(extractYearFromTitle("1959 Topps #409 GUS ZERNIAL (Detroit Tigers) *AUTOGRAPHED* d.2011")).toBe(1959);
    expect(extractYearFromTitle("1959 Topps #318 Rocky Bridges Autograph Tigers D-2015")).toBe(1959);
  });

  it("does not read a death year as the card year even when it LEADS", () => {
    // Isolates the strip from the positional rule: in the titles above the real
    // year comes first, so first-year-wins would answer correctly even with the
    // strip gone. Here the death year is the only thing before the issue year.
    expect(extractYearFromTitle("GUS ZERNIAL d.2011 Autographed 1959 Topps #409")).toBe(1959);
    expect(extractYearFromTitle("Rocky Bridges D-2015 Autograph 1959 Topps #318")).toBe(1959);
  });

  it("returns null when a title states no year", () => {
    expect(extractYearFromTitle("Mickey Mantle no year at all")).toBeNull();
    expect(extractYearFromTitle("")).toBeNull();
    expect(extractYearFromTitle(null)).toBeNull();
    expect(extractYearFromTitle(undefined)).toBeNull();
  });
});

describe("extractYearFromTitle -- season spans", () => {
  it("takes the leading year of a two-digit season", () => {
    expect(extractYearFromTitle("2024-25 Upper Deck Connor Bedard #201")).toBe(2024);
  });

  it("takes the leading year of a FOUR-digit season", () => {
    // "2020-2021" did not read as a season at all before this fix -- the two
    // halves were seen as two independent years.
    expect(extractYearFromTitle("2020-2021 PANINI DONRUSS JERSEY SERIES CHARLES BARKLEY #JS-CBK")).toBe(2020);
    expect(extractYearFromTitle("2009-2010 Upper Deck #28 Lebron James Cleveland Cavaliers")).toBe(2009);
  });

  it("treats a four-digit season as ONE token the homage rule can demote", () => {
    // Isolates the four-digit half. Read as two independent years, "2020-2021"
    // leaves 2021 sitting between the homaged span and the product year, so the
    // demotion cannot reach past it and the answer stays 2020.
    expect(extractYearFromTitle("Connor Bedard 2020-2021 Retro Insert 2024 Upper Deck #201")).toBe(2024);
    expect(extractYearFromTitle("Gretzky 1986-1987 Reprint 2024 Upper Deck")).toBe(2024);
  });

  it("is not order-dependent across calls (the /g regexes reset)", () => {
    // Module-level /g regexes keep lastIndex between calls. Without a reset the
    // SECOND call resumes mid-string and silently misses the year.
    const t = "1952 Topps #311 Mickey Mantle";
    expect(extractYearFromTitle(t)).toBe(1952);
    expect(extractYearFromTitle(t)).toBe(1952);
    expect(extractYearFromTitle(t)).toBe(1952);
  });
});

describe("yearTheTitleAllows -- the title outranks the vendor", () => {
  it("takes the title 1952 over the vendor 2015 auction year", () => {
    const d = yearTheTitleAllows(2015, 1952, 2015);
    expect(d.cardYear).toBe(1952);
    expect(d.outcome).toBe("title-wins");
    expect(d.vendorOverruled).toBe(true);
  });

  it("adopts the title year when the vendor said nothing", () => {
    const d = yearTheTitleAllows(null, 1952, 2015);
    expect(d.cardYear).toBe(1952);
    expect(d.outcome).toBe("title-only");
    expect(d.vendorOverruled).toBe(false);
  });

  it("agrees without overruling when the two match", () => {
    const d = yearTheTitleAllows(2026, 2026, 2026);
    expect(d.cardYear).toBe(2026);
    expect(d.outcome).toBe("agree");
    expect(d.vendorOverruled).toBe(false);
  });
});

describe("yearTheTitleAllows -- absent beats wrong", () => {
  it("REFUSES a vendor year that is the sale year when the title is silent", () => {
    // The exact shape that filed a 1952 Mantle under 2015: an auction archive
    // whose year field is the year of the AUCTION. With no title year to
    // contradict it we cannot tell it from a genuine current-year card, so
    // nothing is adopted and the identity is UNDERIVABLE.
    const d = yearTheTitleAllows(2015, null, 2015);
    expect(d.cardYear).toBeNull();
    expect(d.outcome).toBe("vendor-is-sale-year");
    expect(d.vendorOverruled).toBe(true);
  });

  it("still uses a vendor year that is NOT the sale year", () => {
    const d = yearTheTitleAllows(1998, null, 2026);
    expect(d.cardYear).toBe(1998);
    expect(d.outcome).toBe("vendor-only");
    expect(d.vendorOverruled).toBe(false);
  });

  it("returns null when neither source states a year", () => {
    const d = yearTheTitleAllows(null, null, 2026);
    expect(d.cardYear).toBeNull();
    expect(d.outcome).toBe("neither");
  });

  it("never returns the sale year as the card year", () => {
    // The invariant, stated directly. No combination of inputs may produce the
    // sale year unless one of the two SOURCES stated it.
    for (const sale of [2015, 2020, 2026]) {
      expect(yearTheTitleAllows(null, null, sale).cardYear).toBeNull();
      expect(yearTheTitleAllows(sale, null, sale).cardYear).toBeNull();
      expect(yearTheTitleAllows(sale, 1952, sale).cardYear).toBe(1952);
    }
  });

  it("rejects implausible years from either side", () => {
    expect(yearTheTitleAllows(1799, null, 2026).cardYear).toBeNull();
    expect(yearTheTitleAllows(2099, null, 2026).cardYear).toBeNull();
    expect(yearTheTitleAllows(NaN as unknown as number, null, 2026).cardYear).toBeNull();
  });
});
