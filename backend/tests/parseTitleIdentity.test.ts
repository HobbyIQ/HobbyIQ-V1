// CF-PARSE-TITLE-IDENTITY tests (issue #722). Pins real observed
// marketplace titles from today's Owen Carey / Eric Hartman / Gage Wood
// ingests so the parser survives future edits without regressing.

import { describe, it, expect } from "vitest";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";

describe("parseListingIdentity — cardNumber extraction", () => {
  it("extracts CPA-EHA from an Eric Hartman auto title", () => {
    const r = parseListingIdentity("2026 Bowman Chrome Eric Hartman Auto #CPA-EHA Braves");
    expect(r.cardNumber).toBe("CPA-EHA");
  });
  it("extracts BSPA-OC from an Owen Carey Sapphire title", () => {
    const r = parseListingIdentity("2026 Bowman Sapphire Owen Carey Chrome Prospects Auto #/199 #BSPA-OC Braves");
    expect(r.cardNumber).toBe("BSPA-OC");
  });
  it("extracts BCP-69 from an Owen Carey prospect title", () => {
    const r = parseListingIdentity("OWEN CAREY 2026 BOWMAN CHROME 1ST SAPPHIRE REFRACTOR #BCP-69 BRAVES");
    expect(r.cardNumber).toBe("BCP-69");
  });
  it("extracts CPA-GW from a Gage Wood title", () => {
    const r = parseListingIdentity("2025 Bowman Draft Chrome Gage Wood Auto Gold Refractor /50 #CPA-GW");
    expect(r.cardNumber).toBe("CPA-GW");
  });
  it("returns null cardNumber when title has no # prefix", () => {
    const r = parseListingIdentity("2026 Bowman Eric Hartman rookie card");
    expect(r.cardNumber).toBeNull();
  });
  it("caller-supplied cardNumberRe overrides default", () => {
    const r = parseListingIdentity(
      "2026 Bowman Eric Hartman Auto #CPA-EHA Braves",
      /#(CPAEHA-alt|CPA-EHA)\b/i,
    );
    expect(r.cardNumber).toBe("CPA-EHA");
  });
});

describe("parseListingIdentity — isAuto detection", () => {
  it("'Auto' anywhere → isAuto = true", () => {
    expect(parseListingIdentity("Eric Hartman Auto Refractor").isAuto).toBe(true);
  });
  it("'Autograph' → isAuto = true", () => {
    expect(parseListingIdentity("Eric Hartman Autograph Refractor").isAuto).toBe(true);
  });
  it("'Hard Signed' → isAuto = true (Topps PR term for on-card auto)", () => {
    expect(parseListingIdentity("2026 Bowman Chrome Eric Hartman Blue Refractor Hard Signed #CPA-EHA").isAuto).toBe(true);
  });
  it("'Auto Relic' → isAuto = false (relic patch card, not just auto)", () => {
    expect(parseListingIdentity("Eric Hartman Auto Relic Patch").isAuto).toBe(false);
  });
  it("no auto keyword → isAuto = false", () => {
    expect(parseListingIdentity("2026 Bowman Chrome Owen Carey Base #BCP-69").isAuto).toBe(false);
  });
});

describe("parseListingIdentity — print run extraction", () => {
  it("extracts 199 from '/199 #BSPA-OC'", () => {
    expect(parseListingIdentity("2026 Bowman Sapphire Owen Carey Auto #/199 #BSPA-OC").printRun).toBe(199);
  });
  it("extracts 50 from '/50 Braves'", () => {
    expect(parseListingIdentity("2026 Bowman Chrome Eric Hartman Gold Refractor /50 Braves").printRun).toBe(50);
  });
  it("extracts 199 from '77/199' serial pattern", () => {
    expect(parseListingIdentity("2026 Bowman Chrome Sapphire Owen Carey 77/199 Braves").printRun).toBe(199);
  });
  it("extracts 5 from '3/5' serial pattern", () => {
    expect(parseListingIdentity("Owen Carey 2026 Red Sapphire Auto 3/5 Atlanta Braves").printRun).toBe(5);
  });
  it("does NOT extract 2024 as print run (guard against grabbing years)", () => {
    // Year in the title, no /N suffix
    expect(parseListingIdentity("2024 Bowman Chrome Leo De Vries #CPALD").printRun).toBeNull();
  });
  it("returns null when no print run pattern present", () => {
    expect(parseListingIdentity("2026 Bowman Eric Hartman Base Auto #CPA-EHA").printRun).toBeNull();
  });
});

describe("parseListingIdentity — parallel extraction", () => {
  it("SuperFractor recognized", () => {
    expect(parseListingIdentity("Eric Hartman SuperFractor 1/1 Auto #CPA-EHA").parallel).toBe("SuperFractor");
  });
  it("Gold Refractor (via /50 print run)", () => {
    expect(parseListingIdentity("Owen Carey Bowman Chrome Gold /50 Braves").parallel).toBe("Gold Refractor");
  });
  it("Red Refractor (via /5 print run)", () => {
    expect(parseListingIdentity("Eric Hartman Red /5 #CPA-EHA").parallel).toBe("Red Refractor");
  });
  it("Orange Refractor (via /25 print run)", () => {
    expect(parseListingIdentity("Eric Hartman Orange /25 #CPA-EHA").parallel).toBe("Orange Refractor");
  });
  it("Green Refractor (via /99 print run)", () => {
    expect(parseListingIdentity("Eric Hartman Green /99 #CPA-EHA").parallel).toBe("Green Refractor");
  });
  it("Blue Refractor (via /150 print run)", () => {
    expect(parseListingIdentity("Eric Hartman Blue /150 Auto #CPA-EHA").parallel).toBe("Blue Refractor");
  });
  it("Patterned refractor: Green Shimmer Refractor", () => {
    expect(parseListingIdentity("Eric Hartman Green Shimmer Refractor #CPA-EHA").parallel).toBe("Green Shimmer Refractor");
  });
  it("Patterned refractor: Orange Wave Refractor", () => {
    expect(parseListingIdentity("Eric Hartman Orange Wave Refractor #CPA-EHA").parallel).toBe("Orange Wave Refractor");
  });
  it("Patterned refractor: Blue Ray Wave Refractor (space form)", () => {
    expect(parseListingIdentity("Owen Carey Blue Ray Wave Refractor").parallel).toBe("Blue Ray Wave Refractor");
  });
  it("Patterned refractor: Blue RayWave Refractor (no-space form → space)", () => {
    expect(parseListingIdentity("Owen Carey Blue RayWave Refractor").parallel).toBe("Blue Ray Wave Refractor");
  });
  it("Patterned refractor: Green Grass Refractor", () => {
    expect(parseListingIdentity("Eric Hartman Green Grass Refractor #CPA-EHA /99").parallel).toBe("Green Grass Refractor");
  });
  it("Patterned refractor: Blue X-Fractor (hyphenated)", () => {
    expect(parseListingIdentity("Eric Hartman Blue X-Fractor #CPA-EHA").parallel).toBe("Blue X-Fractor");
  });
  it("Patterned refractor: Xfractor (no-hyphen form)", () => {
    expect(parseListingIdentity("Eric Hartman Blue Xfractor #CPA-EHA").parallel).toBe("Blue X-Fractor");
  });
  it("Sapphire Base (BSPA-OC /199 auto)", () => {
    expect(parseListingIdentity("2026 Bowman Sapphire Owen Carey Auto #/199 #BSPA-OC").parallel).toBe("Base");
  });
  it("Red Sapphire (BSPA-OC /5 auto)", () => {
    expect(parseListingIdentity("Owen Carey 2026 1st Bowman Chrome Red Sapphire Auto 3/5 Braves").parallel).toBe("Red Sapphire");
  });
  it("Green Sapphire (BSPA-OC /99 auto)", () => {
    expect(parseListingIdentity("2026 Bowman Chrome Sapphire Owen Carey Green 59/99 On Card RC Auto").parallel).toBe("Green Sapphire");
  });
  it("Mini Diamond Refractor recognized", () => {
    expect(parseListingIdentity("Leo De Vries Mini Diamond Refractor #CPALD").parallel).toBe("Mini Diamond Refractor");
  });
  it("Reptilian Refractor recognized", () => {
    expect(parseListingIdentity("Owen Carey Reptilian Refractor #BCP-69").parallel).toBe("Reptilian Refractor");
  });
  it("Chrome-Image Variation (NOT stripped — Topps variant)", () => {
    expect(parseListingIdentity("Kade Anderson Chrome-Image Variation #BDC-3").parallel).toBe("Chrome-Image Variation");
  });
  it("Base fallback when nothing matches", () => {
    expect(parseListingIdentity("Owen Carey #BCP-69 Baseball 1st Prospect").parallel).toBe("Base");
  });
});

describe("parseListingIdentity — autoStyle (on-card vs sticker) (#712 option B)", () => {
  it("'On-Card Auto' → on-card", () => {
    const r = parseListingIdentity("2026 Bowman Chrome Owen Carey On-Card Auto #BSPA-OC /199");
    expect(r.autoStyle).toBe("on-card");
  });
  it("'On Card Auto' (space form) → on-card", () => {
    const r = parseListingIdentity("2026 Bowman Sapphire Owen Carey On Card Auto 77/199");
    expect(r.autoStyle).toBe("on-card");
  });
  it("'Hard Signed' (Topps PR term) → on-card", () => {
    // Real-world Antunez description: "Hard Signed" indicates on-card
    const r = parseListingIdentity("2026 Bowman Chrome Blue Refractor Eric Hartman Auto Hard Signed #CPA-EHA");
    expect(r.autoStyle).toBe("on-card");
  });
  it("'Sticker Auto' → sticker", () => {
    const r = parseListingIdentity("2024 Panini Immaculate Some Player Sticker Auto");
    expect(r.autoStyle).toBe("sticker");
  });
  it("'Sticker Autograph' → sticker", () => {
    const r = parseListingIdentity("2024 Panini National Treasures Sticker Autograph");
    expect(r.autoStyle).toBe("sticker");
  });
  it("plain Auto without style hint → null", () => {
    const r = parseListingIdentity("2026 Bowman Eric Hartman Auto #CPA-EHA");
    expect(r.autoStyle).toBeNull();
  });
  it("non-auto row → null (no style even if 'on card' appears elsewhere)", () => {
    const r = parseListingIdentity("Some baseball card on card display");
    expect(r.isAuto).toBe(false);
    expect(r.autoStyle).toBeNull();
  });
});

describe("inferSetKeyFromTitle", () => {
  it("Sapphire → Bowman Chrome Sapphire", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Chrome Sapphire Owen Carey")).toBe("Bowman Chrome Sapphire");
  });
  it("Bowman Draft Chrome → Bowman Draft Chrome", () => {
    expect(inferSetKeyFromTitle("2025 Bowman Draft Chrome Gage Wood")).toBe("Bowman Draft Chrome");
  });
  it("Bowman Chrome Prospects → Bowman Chrome", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Chrome Prospects Owen Carey")).toBe("Bowman Chrome");
  });
  it("Topps Update → Topps Update", () => {
    expect(inferSetKeyFromTitle("2025 Topps Update Jacob Wilson Golden Mirror")).toBe("Topps Update");
  });
  it("Panini Prizm → Panini Prizm", () => {
    expect(inferSetKeyFromTitle("2024 Panini Prizm Football Ladd McConkey")).toBe("Panini Prizm");
  });
  it("bare Topps → Topps", () => {
    expect(inferSetKeyFromTitle("1972 Topps Hank Aaron")).toBe("Topps");
  });
});

describe("inferSportFromTitle", () => {
  it("football / NFL → football", () => {
    expect(inferSportFromTitle("2024 Panini Prizm Football Ladd McConkey")).toBe("football");
  });
  it("basketball / NBA → basketball", () => {
    expect(inferSportFromTitle("Jayson Tatum NBA basketball rookie")).toBe("basketball");
  });
  it("no sport keyword → falls back", () => {
    expect(inferSportFromTitle("Eric Hartman 2026 Bowman Chrome", "baseball")).toBe("baseball");
  });
});
