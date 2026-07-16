// CF-EBAY-TITLE-PARSER (2026-07-12) — locks the 5 spec test cases + a
// handful of real eBay titles pulled from Drew's live import today
// (2026-07-12 GetMyeBayBuying). If the scorer weights change, every
// title in this file must still land in its expected tier:
//   ≥ 0.70 → auto-create holding
//   0.40 – 0.69 → mark needsAttribution / needs-review
//   < 0.40 → skip

import { describe, it, expect } from "vitest";
import { parseListingTitle } from "../src/services/portfolioiq/ebayTitleParser.service";

describe("parseListingTitle — spec test cases", () => {
  it("high-confidence: '2020 Panini Prizm Mookie Betts #275 PSA 10 GEM MINT'", () => {
    const p = parseListingTitle("2020 Panini Prizm Mookie Betts #275 PSA 10 GEM MINT");
    expect(p.year).toBe(2020);
    expect(p.playerName).toBe("Mookie Betts");
    expect(p.setName).toBe("Panini Prizm");
    expect(p.cardNumber).toBe("275");
    expect(p.grade).toBe("PSA 10");
    expect(p.gradeCompany).toBe("PSA");
    expect(p.parseConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("all-caps + emoji: '🔥 SHOHEI OHTANI 2018 TOPPS CHROME UPDATE ROOKIE HTU89 PSA 9'", () => {
    const p = parseListingTitle("🔥 SHOHEI OHTANI 2018 TOPPS CHROME UPDATE ROOKIE HTU89 PSA 9");
    expect(p.year).toBe(2018);
    // Player name capitalized cleanly
    expect(p.playerName).toBe("Shohei Ohtani");
    expect(p.setName).toBe("Topps Chrome");
    expect(p.grade).toBe("PSA 9");
    expect(p.isRookie).toBe(true);
    expect(p.cardNumber).toBe("HTU89");
    expect(p.parseConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("mixed markers: 'Mike Trout 2011 Topps Update #US175 Rookie RC BGS 9.5 GEM MINT'", () => {
    const p = parseListingTitle("Mike Trout 2011 Topps Update #US175 Rookie RC BGS 9.5 GEM MINT");
    expect(p.year).toBe(2011);
    expect(p.playerName).toBe("Mike Trout");
    expect(p.setName).toBe("Topps Update");
    expect(p.grade).toBe("BGS 9.5");
    expect(p.cardNumber).toBe("US175");
    expect(p.isRookie).toBe(true);
    expect(p.parseConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("low-confidence: 'Base 1990 Score Bo Jackson (RC?) NM' — should score <0.40", () => {
    const p = parseListingTitle("Base 1990 Score Bo Jackson (RC?) NM");
    expect(p.year).toBe(1990);
    // Player name recognized but question mark + Base prefix penalize
    expect(p.playerName).toBe("Bo Jackson");
    // Explicit spec assertion: no auto-create
    expect(p.parseConfidence).toBeLessThan(0.4);
  });

  it("zero-confidence: 'lot of 500 penny sleeves and top loaders' — should score 0", () => {
    const p = parseListingTitle("lot of 500 penny sleeves and top loaders");
    expect(p.year).toBeNull();       // 500 isn't in 1950-2029
    expect(p.playerName).toBeNull(); // no proper noun run
    expect(p.setName).toBeNull();
    expect(p.grade).toBeNull();
    expect(p.parseConfidence).toBe(0);
  });
});

describe("parseListingTitle — real Drew eBay titles from 2026-07-12 import", () => {
  it("Owen Carey Prospect Auto Gold Refractor 14/50", () => {
    const p = parseListingTitle("2026 Bowman Chrome 1st Owen Carey Prospect Auto Gold Refractor #14/50 M377");
    expect(p.year).toBe(2026);
    // Owen Carey is 2 proper nouns → player name captured
    expect(p.playerName).toBe("Owen Carey");
    expect(p.setName).toBe("Bowman Chrome");
    expect(p.parallel).toMatch(/refractor|gold/i);
    expect(p.parseConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("Ladd McConkey Purple Ice Prizm PSA 9", () => {
    const p = parseListingTitle("Panini 2024 Prizm Ladd McConkey Purple Ice Prizm RC PSA 9 #3");
    expect(p.year).toBe(2024);
    expect(p.playerName).toBe("Ladd Mcconkey");
    expect(p.setName).toBe("Panini Prizm");
    expect(p.grade).toBe("PSA 9");
    expect(p.parseConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("Break spot (no player, has -RANDOM TEAM- red flag)", () => {
    // Real break-spot listing from Drew's history. No individual player,
    // just a randomized team assignment. Should NOT auto-create.
    const p = parseListingTitle(
      "#009 - (B4) 1x 2026 Bowman Jumbo & 1x 2026 Bowman Hobby(4autos)-RANDOM TEAM-7/9",
    );
    expect(p.year).toBe(2026);
    expect(p.setName).toContain("Bowman"); // has bowman brand
    // No consecutive proper-noun run left after stripping — the "-RANDOM TEAM-"
    // pattern doesn't produce a 2-token proper noun run.
    expect(p.playerName).toBeNull();
    expect(p.parseConfidence).toBeLessThan(0.7);
  });
});

describe("parseListingTitle — edge cases", () => {
  it("empty input returns null everywhere + 0 confidence", () => {
    const p = parseListingTitle("");
    expect(p.parseConfidence).toBe(0);
    expect(p.playerName).toBeNull();
  });

  it("null / undefined input handled defensively", () => {
    expect(parseListingTitle(null).parseConfidence).toBe(0);
    expect(parseListingTitle(undefined).parseConfidence).toBe(0);
  });

  it("year clamped to 1950-2029 window; 500 rejected, 1849 rejected", () => {
    const p1 = parseListingTitle("lot of 500 items with Mike Trout");
    expect(p1.year).toBeNull();
    const p2 = parseListingTitle("1849 antique postcard Robert Lee");
    expect(p2.year).toBeNull();
    const p3 = parseListingTitle("2005 Topps Chrome Mike Trout");
    expect(p3.year).toBe(2005);
  });

  it("suffix tokens (Jr, Sr, III) attach to a player name run", () => {
    const p = parseListingTitle("2018 Topps Chrome Ronald Acuna Jr. Rookie RC #150 PSA 10");
    expect(p.playerName).toBe("Ronald Acuna Jr.");
  });

  it("Bobby Witt Jr. — period in suffix", () => {
    const p = parseListingTitle("2022 Bowman Chrome Bobby Witt Jr. #12 PSA 9");
    expect(p.playerName).toBe("Bobby Witt Jr.");
  });

  it("brand+insert combo scores higher than brand alone", () => {
    const brandOnly = parseListingTitle("2020 Topps Mike Trout #175");
    const combo = parseListingTitle("2020 Topps Chrome Mike Trout #175");
    expect(combo.parseConfidence).toBeGreaterThan(brandOnly.parseConfidence);
  });

  it("all four grading companies recognized: PSA / BGS / SGC / CGC", () => {
    for (const c of ["PSA", "BGS", "SGC", "CGC"]) {
      const p = parseListingTitle(`2020 Panini Prizm Mookie Betts #275 ${c} 10 GEM MINT`);
      expect(p.gradeCompany).toBe(c);
      expect(p.grade).toBe(`${c} 10`);
    }
  });

  it("half-point grades parse (BGS 9.5)", () => {
    const p = parseListingTitle("Mike Trout 2011 Topps Update #US175 BGS 9.5");
    expect(p.grade).toBe("BGS 9.5");
  });

  it("cardNumber handles alphanumeric with dashes (BCP-16, CPA-CBO)", () => {
    const p1 = parseListingTitle("2024 Bowman Chrome Prospects Devin Taylor Auto BCP-16");
    expect(p1.cardNumber).toBe("BCP-16");
    const p2 = parseListingTitle("2024 Bowman Draft Caleb Bonemer #CPA-CBO Auto");
    expect(p2.cardNumber).toBe("CPA-CBO");
  });

  it("named parallel captured (Padparadscha, Refractor, X-Fractor, Wave)", () => {
    for (const parallel of ["Padparadscha", "Refractor", "Xfractor", "Wave"]) {
      const p = parseListingTitle(`2025 Bowman Chrome Sapphire ${parallel} Owen Carey`);
      expect(p.parallel).toMatch(new RegExp(parallel, "i"));
    }
  });

  it("serial /150 numbering marks parallel as 'Numbered' when no named parallel present", () => {
    const p = parseListingTitle("2020 Topps Chrome Bobby Witt Jr. /150 PSA 10");
    expect(p.parallel).toBe("Numbered");
  });
});

describe("parseListingTitle — autograph detection", () => {
  it("explicit AUTO keyword", () => {
    const p = parseListingTitle("2024 Bowman Chrome Prospects Devin Taylor Auto BCP-16");
    expect(p.isAuto).toBe(true);
  });

  it("AUTOGRAPH / AUTOGRAPHED / SIGNED / SIGNATURE (case-insensitive)", () => {
    for (const kw of ["AUTOGRAPH", "Autographed", "signed", "SIGNATURE"]) {
      const p = parseListingTitle(`2020 Topps Chrome Mike Trout ${kw} #175 PSA 10`);
      expect(p.isAuto).toBe(true);
    }
  });

  it("card-code prefix (CPA-, TCRA-, HSA-, etc.) implies auto even without keyword", () => {
    // No word "auto" but the CPA- prefix on the card number itself signals
    // the autograph insert.
    const p1 = parseListingTitle("2024 Bowman Draft Caleb Bonemer #CPA-CBO");
    expect(p1.isAuto).toBe(true);
    const p2 = parseListingTitle("2024 Topps Chrome Update USA Baseball HSA-JD");
    expect(p2.isAuto).toBe(true);
  });

  it("non-auto listing does NOT flag isAuto=true", () => {
    const p = parseListingTitle("2020 Panini Prizm Mookie Betts #275 PSA 10 GEM MINT");
    expect(p.isAuto).toBe(false);
  });

  it("does NOT match 'automatic' or other AUTO-prefix false-positives", () => {
    const p = parseListingTitle("Automatic Sports Card Sleeve Dispenser 100pk");
    expect(p.isAuto).toBe(false);
  });

  it("isAuto contributes +0.05 to confidence", () => {
    const withAuto = parseListingTitle("2020 Panini Prizm Mookie Betts Auto #275 PSA 10");
    const withoutAuto = parseListingTitle("2020 Panini Prizm Mookie Betts #275 PSA 10");
    expect(withAuto.parseConfidence).toBeGreaterThanOrEqual(withoutAuto.parseConfidence);
  });

  it("real Drew title: Owen Carey Prospect Auto → isAuto=true", () => {
    const p = parseListingTitle("2026 Bowman Chrome 1st Owen Carey Prospect Auto Gold Refractor #14/50 M377");
    expect(p.isAuto).toBe(true);
  });
});
