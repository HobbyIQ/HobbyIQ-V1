// D28 -- CF-A-CARD-NUMBER-IS-NOT-A-GRADE (Drew, 2026-08-30).
//
// The pins are the verbatim shapes measured in sold_comps on 2026-08-30, plus
// the three titles that put Harrison's Ohtani on `topps-chrome:9`. Every
// rejection is paired with a KEEP case that is the same shape and legitimate,
// because a guard that cannot be shown to leave good rows alone is a guard
// nobody can measure the blast radius of.

import { describe, it, expect } from "vitest";
import {
  judgeCardNumber,
  explicitTitleCardNumber,
  isGraderDigit,
  isPrintRunSlash,
  isBarePrintRun,
  isYearNumber,
  isOrdinal,
  isLotCount,
  isTcgVertical,
} from "../src/services/portfolioiq/cardNumberIntegrity.js";

describe("a card number is never a grader's digit", () => {
  it.each([
    ["1972 Icee Bear Set Break Wilt Chamberlain PSA 9 MINT", "9"],
    ["1972 Icee Bear Set Break Wilt Chamberlain SGC 8 NM-MT", "8"],
    ["CGC 10 GEM MINT Entei Neo Revelation Movie Promo", "10"],
    ["2018 Topps Chrome Shohei Ohtani Refractor BGS 9.5", "9.5"],
    ["2021 Bowman Chrome Wander Franco Auto GEM MT 10", "10"],
    ["1989 Upper Deck Ken Griffey Jr MINT 9", "9"],
  ])("refuses %s -> %s", (title, num) => {
    expect(isGraderDigit(title, num)).toBe(true);
    const v = judgeCardNumber(num, title);
    expect(v.cardNumber).toBeNull();
    expect(v.rejected).toBe("grader-digit");
  });

  it("keeps a real #9 that happens to be graded PSA 9", () => {
    const t = "1989 Upper Deck #9 Gary Sheffield RC PSA 9";
    expect(isGraderDigit(t, "9")).toBe(false);
    const v = judgeCardNumber("9", t);
    expect(v.cardNumber).toBe("9");
    expect(v.source).toBe("title");
  });

  it("leaves a bare number alone when the title never mentions a grade", () => {
    const v = judgeCardNumber("9", "1989 Upper Deck Gary Sheffield Rookie");
    expect(v.cardNumber).toBe("9");
    expect(v.rejected).toBeNull();
  });

  it("does not read a grade above 10 as one", () => {
    expect(isGraderDigit("Lot PSA 25 cards", "25")).toBe(false);
  });
});

describe("a card number is never a print run", () => {
  it("refuses the slash form outside TCG", () => {
    expect(isPrintRunSlash("108/165")).toBe(true);
    const v = judgeCardNumber("108/165", "2018 Bowman Chrome Blue Refractor /165");
    expect(v.cardNumber).toBeNull();
    expect(v.rejected).toBe("print-run-slash");
  });

  // Measured 2026-08-30: 12,099 of the pool rows a "any slash is a print run"
  // rule would have thrown away are real SKUs. Fleer Avant numbers its
  // dual-player inserts by both players' initials, and "N/A" is the slug
  // builder's own word for unnumbered.
  it("keeps a slashed SKU whose halves are not both numbers", () => {
    expect(isPrintRunSlash("AAC/BG")).toBe(false);
    expect(isPrintRunSlash("N/A")).toBe(false);
    expect(judgeCardNumber("AAC/BG", "2003 Fleer Avant Baseball #AAC/BG Blue").cardNumber).toBe("AAC/BG");
    expect(explicitTitleCardNumber("2003 Fleer Avant Baseball #AAC/BR Blue")).toBe("AAC/BR");
    expect(explicitTitleCardNumber("1951 Topps Major League All-Stars Baseball #n/a Base")).toBe("N/A");
  });

  it("still refuses a number over a number", () => {
    expect(isPrintRunSlash("22/30")).toBe(true);
    expect(isPrintRunSlash("108/165")).toBe(true);
  });

  it("keeps POS/TOTAL in a TCG vertical", () => {
    expect(isPrintRunSlash("044/193", { isTcg: true })).toBe(false);
    const v = judgeCardNumber("044/193", "Charizard VMAX Darkness Ablaze 044/193 PSA 10", { isTcg: true });
    expect(v.cardNumber).toBe("044/193");
  });

  it("refuses the bare N of a /N the title states", () => {
    const t = "2021 Topps Chrome Shohei Ohtani Orange Refractor /25 PSA 10";
    expect(isBarePrintRun(t, "25")).toBe(true);
    expect(judgeCardNumber("25", t).rejected).toBe("print-run-bare");
  });

  it.each([["25"], ["50"], ["99"], ["150"], ["199"], ["250"], ["299"], ["499"]])(
    "refuses the bare print run %s",
    (n) => {
      expect(isBarePrintRun(`2022 Panini Prizm Gold Prizm /${n}`, n)).toBe(true);
    },
  );

  it("keeps the bare number when the title states it as #N as well", () => {
    const t = "2021 Topps Chrome #25 Shohei Ohtani Orange Refractor /25";
    expect(isBarePrintRun(t, "25")).toBe(false);
    expect(judgeCardNumber("25", t).cardNumber).toBe("25");
  });
});

describe("a card number is never a 4-digit year", () => {
  it.each([["2018"], ["1990"], ["1900"], ["2035"]])("refuses %s", (y) => {
    expect(isYearNumber(`${y} Topps Chrome Shohei Ohtani Gold Refractor`, y)).toBe(true);
    expect(judgeCardNumber(y, `${y} Topps Chrome Shohei Ohtani Gold Refractor`).rejected).toBe("year");
  });

  it("keeps a 4-digit number outside the year range", () => {
    expect(isYearNumber("2021 Topps Update 2400 insert", "2400")).toBe(false);
  });

  it("keeps #1990 when the title says it explicitly", () => {
    expect(isYearNumber("1990 Donruss #1990 oddball", "1990")).toBe(false);
  });
});

describe("a card number is never an ordinal or a lot count", () => {
  it("refuses the 1st Bowman trap", () => {
    const t = "2023 Bowman Chrome Paul Skenes 1st Bowman Auto Refractor";
    expect(isOrdinal(t, "1")).toBe(true);
    expect(judgeCardNumber("1", t).rejected).toBe("ordinal");
  });

  it("refuses 2nd", () => {
    expect(isOrdinal("2024 Topps 2nd Series Aaron Judge", "2")).toBe(true);
  });

  it("keeps #1 when the title says #1", () => {
    expect(isOrdinal("2023 Bowman Chrome #1 Paul Skenes 1st Bowman", "1")).toBe(false);
  });

  it.each([
    ["LOT OF 2 Shohei Ohtani Topps Chrome Refractors", "2"],
    ["Shohei Ohtani 2 CARD LOT Topps Chrome", "2"],
    ["Topps Chrome (2) card lot Ohtani", "2"],
  ])("refuses the lot count in %s", (title, n) => {
    expect(isLotCount(title, n)).toBe(true);
    expect(judgeCardNumber(n, title).rejected).toBe("lot-count");
  });

  it("keeps #2 in a lot title that also states the card number", () => {
    expect(isLotCount("LOT OF 2 -- Topps Chrome #2 Ohtani", "2")).toBe(false);
  });
});

describe("an explicit #X in the title wins over the vendor field", () => {
  it("Harrison's Ohtani: the title says #150, CardHedge said 9", () => {
    const t = "2018 Topps Chrome #150 Shohei Ohtani Refractor RC PSA 10";
    const v = judgeCardNumber("9", t);
    expect(v.cardNumber).toBe("150");
    expect(v.titleNumber).toBe("150");
    expect(v.vendorDisagrees).toBe(true);
    expect(v.source).toBe("title");
  });

  it("DeJong: the title says #83T-22, the pool said 9", () => {
    const t = "2018 Topps Chrome #83T-22 Paul DeJong 1983 35th Anniversary Refractor PSA 9";
    const v = judgeCardNumber("9", t);
    expect(v.cardNumber).toBe("83T-22");
    expect(v.vendorDisagrees).toBe(true);
  });

  it("Ohtani 1983 insert: the title says #83T-6, the pool said 9", () => {
    const t = "2018 Topps Chrome Shohei Ohtani #83T-6 1983 Topps Baseball Refractor RC PSA 9";
    expect(judgeCardNumber("9", t).cardNumber).toBe("83T-6");
  });

  it("agreement is not a disagreement", () => {
    const v = judgeCardNumber("150", "2018 Topps Chrome #150 Shohei Ohtani Refractor");
    expect(v.vendorDisagrees).toBe(false);
    expect(v.cardNumber).toBe("150");
  });

  it("reads prefixed SKUs", () => {
    expect(explicitTitleCardNumber("2022 Bowman Chrome #BCP-16 Jackson Holliday")).toBe("BCP-16");
    expect(explicitTitleCardNumber("2025 Topps #US175 Roki Sasaki RC")).toBe("US175");
    expect(explicitTitleCardNumber("2025 Bowman Draft #CPA-EW Eli Willits Auto")).toBe("CPA-EW");
  });

  // The three shapes measured in the pool on 2026-08-30 that the first draft of
  // the reader could not parse -- each one fell through to the vendor's digit
  // and became a grade-keyed row.
  it("reads the glued and digit-led SKUs the pool actually prints", () => {
    expect(judgeCardNumber("10", "2025 TOPPS STARS OF MLB #SMLB10 SHOHEI OHTANI PSA 10 GEM MINT DODGERS").cardNumber).toBe("SMLB10");
    expect(judgeCardNumber("10", "Shohei Ohtani 2025 Topps Chrome 1990 Topps #90CB-7 - PSA 10 Gem Mint - NL MVP").cardNumber).toBe("90CB-7");
    expect(judgeCardNumber("10", "2018 Topps Chrome Shohei Ohtani 1983 Topps Rookie Refractor PSA 10 GEM MT #83T-6").cardNumber).toBe("83T-6");
  });

  it("does not read a hashed grade as a SKU", () => {
    expect(explicitTitleCardNumber("2018 Topps Chrome Ohtani Refractor #PSA10")).toBeNull();
    expect(explicitTitleCardNumber("2018 Topps Chrome Ohtani Refractor #BGS 9")).toBeNull();
  });

  it("does not read a serial number as an explicit card number", () => {
    expect(explicitTitleCardNumber("2021 Topps Chrome Ohtani Orange Refractor serial #25/99")).toBeNull();
    expect(explicitTitleCardNumber("2021 Topps Chrome Ohtani numbered #/25")).toBeNull();
    expect(explicitTitleCardNumber("2021 Topps Chrome Ohtani Gold #25/50")).toBeNull();
  });

  it("does not read the set year as an explicit card number", () => {
    expect(explicitTitleCardNumber("Topps Chrome #2018 Gold Refractor")).toBeNull();
  });

  it("reads the TCG POS/TOTAL form when the vertical says so", () => {
    expect(explicitTitleCardNumber("Charizard VMAX #044/193 Darkness Ablaze", { isTcg: true })).toBe("044/193");
  });
});

describe("verdict shape", () => {
  it("an empty candidate with no title number is 'none', not a rejection", () => {
    const v = judgeCardNumber(null, "2018 Topps Chrome Shohei Ohtani Refractor");
    expect(v.cardNumber).toBeNull();
    expect(v.rejected).toBeNull();
    expect(v.source).toBe("none");
  });

  it("strips a leading # and upper-cases the candidate", () => {
    expect(judgeCardNumber("#bcp-16", "no number here").cardNumber).toBe("BCP-16");
  });

  it("leaves a prefixed SKU alone -- no rule applies to it", () => {
    const v = judgeCardNumber("83T-22", "Paul DeJong 1983 35th Anniversary Refractor PSA 9");
    expect(v.cardNumber).toBe("83T-22");
    expect(v.rejected).toBeNull();
  });

  it("knows the TCG verticals", () => {
    expect(isTcgVertical("pokemon")).toBe(true);
    expect(isTcgVertical("Yugioh")).toBe(true);
    expect(isTcgVertical("baseball")).toBe(false);
    expect(isTcgVertical(null)).toBe(false);
  });
});
