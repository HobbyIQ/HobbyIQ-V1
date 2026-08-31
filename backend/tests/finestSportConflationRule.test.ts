/**
 * CF-1993-FINEST-SPORT-CONFLATION — the decision rules, pinned.
 *
 * Every title in here is a REAL string measured out of sold_comps on
 * 2026-08-31, not an invented example. The traps are the point: the rule was
 * written against these rows, so a regression that "simplifies" it will fail
 * on the case that motivated the complexity.
 */
import { describe, expect, it } from "vitest";
import {
  decideFinestSport, slugSport, slugCardNumber, withSport, canonSport,
  isFabricatedPrintRun, isSmearedCardNumber, normPlayer, titleNamesPlayer, gradeParentOf,
} from "../src/services/catalog/finestSportConflationRule";

describe("slug surgery", () => {
  const id = "hiq:baseball:1993:topps-finest:99:refractor:no-auto:psa-8";

  it("reads the sport and the card number out of a slug", () => {
    expect(slugSport(id)).toBe("baseball");
    expect(slugCardNumber(id)).toBe("99");
  });

  it("re-spells ONLY the sport segment and leaves every other byte alone", () => {
    expect(withSport(id, "basketball"))
      .toBe("hiq:basketball:1993:topps-finest:99:refractor:no-auto:psa-8");
  });

  it("treats ice-hockey and hockey as one sport (both spellings are live)", () => {
    expect(canonSport("ice-hockey")).toBe("hockey");
    expect(canonSport("Hockey")).toBe("hockey");
  });
});

describe("the sport word decides when it is unambiguous", () => {
  it("names basketball", () => {
    const v = decideFinestSport("1993 Topps Finest Basketball #27 Base");
    expect(v).toMatchObject({ decided: true, sport: "basketball", signal: "sport-word" });
  });

  it("names baseball", () => {
    const v = decideFinestSport("1993 Topps Finest Baseball #143 Refractor");
    expect(v).toMatchObject({ decided: true, sport: "baseball", signal: "sport-word" });
  });
});

describe("the 1993-94 season form is the signal that does the real work", () => {
  // These four are baseball-SLUGGED rows in production whose titles never say
  // "basketball" — the sport-word test misses every one of them.
  it.each([
    "1993-94 Topps Finest - Clyde Drexler #74",
    "1993-94 Topps Finest - Vin Baker #139 (RC)",
    "1993-94 Topps Finest - A.C. Green #59 Refractor",
    "1993-94 Finest #162 Larry Johnson Refractors",
  ])("reads %s as basketball", (title) => {
    expect(decideFinestSport(title)).toMatchObject({
      decided: true, sport: "basketball", signal: "season-form",
    });
  });

  it("accepts the 1993-4 short form too", () => {
    expect(decideFinestSport("1993-4 Topps Finest #212 Chris Webber")).toMatchObject({
      decided: true, sport: "basketball",
    });
  });

  it("does NOT read a bare 1993 as evidence of baseball", () => {
    // A basketball listing may simply omit the season. Silence is not a verdict.
    expect(decideFinestSport("1993 Finest #111 Christian Laettner Ref")).toMatchObject({
      decided: false, reason: "no-evidence",
    });
  });

  it("does not let a long number masquerade as a season", () => {
    expect(decideFinestSport("1993 Topps Finest #27 lot 19939400")).toMatchObject({ decided: false });
  });
});

describe("the traps — where a naive rule moves a card it should not", () => {
  it("refuses the one real word-vs-season conflict in the whole pool", () => {
    // 1 of 2,491 titles naming "baseball" also carries the season form, and it
    // is a seller's typo: Jordan, Bulls — a basketball card. Neither signal is
    // trustworthy here, so the row stays put.
    const v = decideFinestSport("MICHAEL JORDAN PSA 10 1993-94 TOPPS FINEST BASEBALL #1 BULLS 447");
    expect(v).toMatchObject({ decided: false, reason: "signals-disagree" });
  });

  it("refuses a title naming both sports", () => {
    expect(decideFinestSport("1993 Topps Finest Baseball and Basketball lot")).toMatchObject({
      decided: false, reason: "signals-disagree",
    });
  });

  it("refuses a hockey title rather than calling it basketball on the season form", () => {
    // Real row: a Mats Sundin sale sitting on a 1993 topps-finest slug. The
    // season form is present, but the card is neither of our two products.
    const v = decideFinestSport("1993-94 Topps Finest Mats Sundin #110 Toronto Maple Leafs Unpeeled");
    expect(v).toMatchObject({ decided: false, reason: "names-other-sport" });
  });

  it("refuses a foreign-sport title even when it says baseball's season", () => {
    expect(decideFinestSport("1993-94 Fleer PowerPlay #104 Hartford Whalers hockey")).toMatchObject({
      decided: false,
    });
  });

  it("says nothing about an empty or whitespace title", () => {
    expect(decideFinestSport("")).toMatchObject({ decided: false, reason: "no-evidence" });
    expect(decideFinestSport("   ")).toMatchObject({ decided: false, reason: "no-evidence" });
    expect(decideFinestSport(undefined as unknown as string)).toMatchObject({ decided: false });
  });

  it("leaves the Ken Griffey Jr sales on #110 as baseball", () => {
    // The same wrong slug holds Griffey (baseball) and Sundin (hockey). The
    // rule must decide them DIFFERENTLY — that is why the pool is adjudicated
    // per sale rather than per partition.
    const griffey = decideFinestSport("1993 Topps Finest - Baseball's Finest All-Stars Ken Griffey Jr #110 HOF");
    expect(griffey).toMatchObject({ decided: true, sport: "baseball" });
  });
});

describe("a graded child reads its ungraded parent's sales", () => {
  it("strips a grade suffix", () => {
    expect(gradeParentOf("hiq:baseball:1993:topps-finest:212:refractor:no-auto:psa-8"))
      .toBe("hiq:baseball:1993:topps-finest:212:refractor:no-auto");
    expect(gradeParentOf("hiq:baseball:1993:topps-finest:3:base:no-auto:bgs-9"))
      .toBe("hiq:baseball:1993:topps-finest:3:base:no-auto");
    expect(gradeParentOf("hiq:baseball:1993:topps-finest:110:base:no-auto:cgc-10"))
      .toBe("hiq:baseball:1993:topps-finest:110:base:no-auto");
  });

  it("leaves an already-ungraded slug alone", () => {
    const id = "hiq:baseball:1993:topps-finest:212:refractor:no-auto";
    expect(gradeParentOf(id)).toBe(id);
  });

  it("does not mistake a print-run segment for a grade", () => {
    const id = "hiq:basketball:1993:topps-finest:1927:base:no-auto:num-27";
    expect(gradeParentOf(id)).toBe(id);
  });
});

describe("attributing a sale to one of the two cards that share a number", () => {
  it("matches a clean full name", () => {
    expect(titleNamesPlayer("1993-94 Topps Finest - Clyde Drexler #74", "Clyde Drexler")).toBe(true);
  });

  it("survives the stored O'Neal corruption in both directions", () => {
    // Production stores this row's player as "Shaquille 'neal".
    expect(titleNamesPlayer("1993-94 Finest #3 Shaquille O'Neal", "Shaquille 'neal")).toBe(true);
    expect(titleNamesPlayer("1993-94 Finest #3 Shaquille 'neal", "Shaquille O'Neal")).toBe(true);
  });

  it("does NOT let a shared surname match the wrong man", () => {
    // #143 Avery Johnson, #71 Ervin Johnson, #27 Eddie Johnson, #162 Larry
    // Johnson are four different people in this one product.
    expect(titleNamesPlayer("1993-94 Topps Finest - Avery Johnson #143", "Ervin Johnson")).toBe(false);
    expect(titleNamesPlayer("1993-94 Finest #162 Larry Johnson Refractors", "Eddie Johnson")).toBe(false);
    expect(titleNamesPlayer("Topps Finest 1993-94 Ervin Johnson #71", "Avery Johnson")).toBe(false);
  });

  it("keeps the two men who share #27 apart", () => {
    // Baseball #27 is Alex Fernandez; basketball #27 is Eddie Johnson.
    const t = "1993 TOPPS FINEST REFRACTORS #27 ALEX FERNANDEZ SP 1/241";
    expect(titleNamesPlayer(t, "Alex Fernandez")).toBe(true);
    expect(titleNamesPlayer(t, "Eddie Johnson")).toBe(false);
  });

  it("does not match a title that names nobody relevant", () => {
    expect(titleNamesPlayer("1993 Topps Finest Basketball #53 Base", "Bret Saberhagen")).toBe(false);
    expect(titleNamesPlayer("", "Clyde Drexler")).toBe(false);
    expect(titleNamesPlayer("1993 Finest #74", "")).toBe(false);
  });

  it("normalises punctuation and case", () => {
    expect(normPlayer("  Ken  Griffey, Jr. ")).toBe("ken griffey jr");
    expect(titleNamesPlayer("1993 Topps Finest KEN GRIFFEY JR #110", "Ken Griffey Jr.")).toBe(true);
  });
});

describe("the two data defects", () => {
  it("recognises the fabricated /241 in both string and number form", () => {
    expect(isFabricatedPrintRun(241)).toBe(true);
    expect(isFabricatedPrintRun("241")).toBe(true);
  });

  it("does not treat a blank print run as fabricated — blank means unknown", () => {
    expect(isFabricatedPrintRun(null)).toBe(false);
    expect(isFabricatedPrintRun(undefined)).toBe(false);
    expect(isFabricatedPrintRun("")).toBe(false);
  });

  it("leaves a genuine print run alone", () => {
    expect(isFabricatedPrintRun(27)).toBe(false);
    expect(isFabricatedPrintRun(5)).toBe(false);
  });

  it("recognises the smeared cardNumber 1927", () => {
    expect(isSmearedCardNumber("1927")).toBe(true);
    expect(isSmearedCardNumber(" 1927 ")).toBe(true);
    expect(isSmearedCardNumber("19")).toBe(false);
    expect(isSmearedCardNumber("27")).toBe(false);
  });
});
