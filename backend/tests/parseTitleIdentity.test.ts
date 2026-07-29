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

  // CF-TRUE-COLOR-PARALLEL (Drew, 2026-07-28). "True <Color>" is a
  // market synonym for "<Color> Refractor". Real repro: Hartman
  // Blue Auto sold at $905 tagged as "Base" because the parser
  // didn't recognize "Bowman Blue …True" as True Blue Refractor.
  it("True Blue → Blue Refractor (adjacent, market synonym)", () => {
    expect(parseListingIdentity("2026 Bowman True Blue Eric Hartman #CPA-EHA Auto").parallel).toBe("Blue Refractor");
  });
  it("True Blue → Blue Refractor (color before True, eBay title order)", () => {
    expect(parseListingIdentity("2026 Bowman Blue Eric Hartman True #CPA-EHA").parallel).toBe("Blue Refractor");
  });
  it("True Green → Green Refractor", () => {
    expect(parseListingIdentity("2026 Bowman True Green Refractor Hartman #CPA-EHA").parallel).toBe("Green Refractor");
  });
  it("True Orange → Orange Refractor (color anywhere)", () => {
    expect(parseListingIdentity("2026 Bowman Orange Hartman True Auto").parallel).toBe("Orange Refractor");
  });
  it("'True' alone (no refractor color) → Base (no false positive)", () => {
    expect(parseListingIdentity("2026 Bowman True Grit Prospect Auto #BCP-1").parallel).toBe("Base");
  });

  // CF-BASKETBALL-PARALLELS (Drew, 2026-07-28). Basketball vocabulary.
  it("Panini Prizm Silver Prizm → Silver Prizm", () => {
    expect(parseListingIdentity("2024 Panini Prizm Basketball Victor Wembanyama Silver Prizm").parallel).toBe("Silver Prizm");
  });
  it("Panini Prizm Blue → Blue Prizm", () => {
    expect(parseListingIdentity("2024 Panini Prizm Anthony Edwards Blue Prizm").parallel).toBe("Blue Prizm");
  });
  it("Panini Prizm Green Pulsar → Green Pulsar Prizm", () => {
    expect(parseListingIdentity("2024 Panini Prizm Cooper Flagg Green Pulsar").parallel).toBe("Green Pulsar Prizm");
  });
  it("Fast Break Blue → Fast Break Blue Prizm", () => {
    expect(parseListingIdentity("2023 Panini Prizm Fast Break Blue Luka Doncic").parallel).toBe("Fast Break Blue Prizm");
  });
  it("Donruss Optic Blue Velocity → Blue Velocity Optic", () => {
    expect(parseListingIdentity("2024 Donruss Optic Basketball Ja Morant Blue Velocity").parallel).toBe("Blue Velocity Optic");
  });
  it("Donruss Optic Holo → Holo Optic", () => {
    expect(parseListingIdentity("2024 Donruss Optic Holo Cooper Flagg").parallel).toBe("Holo Optic");
  });
  it("Select Blue → Blue Select", () => {
    expect(parseListingIdentity("2024 Panini Select Basketball Blue Select LeBron James").parallel).toBe("Blue Select");
  });
  it("Contenders Cracked Ice → Cracked Ice", () => {
    expect(parseListingIdentity("2024 Panini Contenders Cracked Ice Nikola Jokic").parallel).toBe("Cracked Ice");
  });
  it("Zebra Select → Zebra Select", () => {
    expect(parseListingIdentity("2024 Panini Select Zebra Anthony Edwards").parallel).toBe("Zebra Select");
  });
  it("no-false-positive: 'basketball' word alone doesn't trigger", () => {
    expect(parseListingIdentity("2024 Panini Basketball Base Card #100 LeBron").parallel).toBe("Base");
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

// CF-PAPER-AUTO-BORDERS (Drew, 2026-07-29). Bowman flagship paper autos
// use a Color Border ladder that's paper's parallel to Chrome's Refractor
// ladder. Prior parser collapsed every Border color to "Base" — losing
// the parallel means every paper-auto priced against the base pool.
describe("parseListingIdentity — Bowman paper-auto Border ladder", () => {
  it("Sky Blue Border /499 → Sky Blue Border", () => {
    const r = parseListingIdentity("2025 Bowman Chrome Prospects Auto Eric Hartman #BPA-EH Sky Blue Border /499");
    expect(r.parallel).toBe("Sky Blue Border");
    expect(r.isAuto).toBe(true);
    expect(r.printRun).toBe(499);
    expect(r.cardNumber).toBe("BPA-EH");
  });
  it("Neon Green Border /399 → Neon Green Border", () => {
    expect(parseListingIdentity("2025 Bowman Baseball Auto Neon Green Border /399 #BPA-XY").parallel)
      .toBe("Neon Green Border");
  });
  it("Fuchsia Border /299 → Fuchsia Border", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Prospects Auto Fuchsia Border /299 #BPA-AB").parallel)
      .toBe("Fuchsia Border");
  });
  it("Purple Border /250 → Purple Border", () => {
    expect(parseListingIdentity("2025 Bowman Draft Auto Purple Border /250 #BDA-CD").parallel)
      .toBe("Purple Border");
  });
  it("Blue Border /150 → Blue Border (not Blue Refractor)", () => {
    // Print-run overlap (Blue Refractor is also /150) — Border rule
    // must win. This is the concrete collision reason Border rules run
    // BEFORE base color refractor rules in parseTitleIdentity.
    const r = parseListingIdentity("2025 Bowman Baseball Auto Blue Border /150 #BPA-EF");
    expect(r.parallel).toBe("Blue Border");
    expect(r.printRun).toBe(150);
  });
  it("Yellow Border /75 → Yellow Border", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Prospects Auto Yellow Border /75 #BPA-GH").parallel)
      .toBe("Yellow Border");
  });
  it("Gold Border /50 → Gold Border (not Gold Refractor)", () => {
    const r = parseListingIdentity("2025 Bowman Draft Auto Gold Border /50 #BDA-IJ");
    expect(r.parallel).toBe("Gold Border");
    expect(r.printRun).toBe(50);
  });
  it("Orange Border /25 → Orange Border (not Orange Refractor)", () => {
    expect(parseListingIdentity("2025 Bowman Baseball Auto Orange Border /25 #BPA-KL").parallel)
      .toBe("Orange Border");
  });
  it("Red Border /5 → Red Border (not Red Refractor)", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Prospects Auto Red Border /5 #BPA-MN").parallel)
      .toBe("Red Border");
  });
  it("Platinum Border 1/1 → Platinum Border", () => {
    const r = parseListingIdentity("2025 Bowman Draft Auto Platinum Border 1/1 #BDA-OP");
    expect(r.parallel).toBe("Platinum Border");
    expect(r.printRun).toBe(1);
  });
  it("bare 'Border' on an auto → 'Border' (unknown color, still not Base)", () => {
    // Better a generic Border marker than collapsing to Base — Base
    // routing would price the paper auto against the wrong comp pool.
    expect(parseListingIdentity("2025 Bowman Prospect Autographs Border variant #BPA-QR").parallel)
      .toBe("Border");
  });
  it("BPA- card number prefix extracts cleanly", () => {
    expect(parseListingIdentity("#BPA-EH Hartman 2025 Bowman auto").cardNumber).toBe("BPA-EH");
  });
  it("BDA- card number prefix extracts cleanly", () => {
    expect(parseListingIdentity("#BDA-JW Willits 2025 Bowman Draft auto").cardNumber).toBe("BDA-JW");
  });
  it("BCRA- card number prefix extracts cleanly (Bowman Chrome Rookie Auto)", () => {
    expect(parseListingIdentity("#BCRA-JS Skenes 2025 Bowman auto").cardNumber).toBe("BCRA-JS");
  });
  it("TCRA- card number prefix extracts cleanly (Topps Chrome Rookie Auto)", () => {
    expect(parseListingIdentity("#TCRA-PC Crow-Armstrong 2025 Topps Chrome auto").cardNumber).toBe("TCRA-PC");
  });
});

// Guardrail: chrome refractor titles MUST still match refractor rules,
// not the new Border rules. If someone regressed the ordering, these
// would flip to "Blue Border" / "Gold Border" incorrectly.
describe("parseListingIdentity — chrome refractor unaffected by Border rules", () => {
  it("'Blue Refractor /150' → Blue Refractor (Border rule NOT triggered — 'Refractor' present)", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Prospects Auto #CPA-EH Blue Refractor /150").parallel)
      .toBe("Blue Refractor");
  });
  it("'Gold Refractor /50' → Gold Refractor (no 'border' token)", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Prospects Auto #CPA-XX Gold Refractor /50").parallel)
      .toBe("Gold Refractor");
  });
  it("'True Blue' Chrome auto → Blue Refractor (True-color mapping intact)", () => {
    expect(parseListingIdentity("2026 Bowman Blue Eric Hartman True #CPA-EHA Auto").parallel)
      .toBe("Blue Refractor");
  });
});

// CF-HERITAGE-CHROME-PARALLELS + CF-HERITAGE-BARE-CARDNUMBER
// (Drew, 2026-07-29). Topps Heritage rows shipping with cardNumber=null
// and parallel="Base" because the parser didn't handle bare-digit
// card#s (#136) or Chrome-<modifier> Heritage parallels (Chrome White).
describe("parseListingIdentity — Topps Heritage patterns", () => {
  it("bare-digit '#136' extracts cardNumber", () => {
    expect(parseListingIdentity("2026 Topps Heritage Jac Caglianone Chrome White RC #136").cardNumber)
      .toBe("136");
  });
  it("bare-digit '#500' extracts cardNumber (vintage safety)", () => {
    expect(parseListingIdentity("1972 Topps Hank Aaron #500").cardNumber)
      .toBe("500");
  });
  it("'Chrome White' in Heritage title → 'Chrome White' parallel (not Base)", () => {
    expect(parseListingIdentity("2026 Topps Heritage Jac Caglianone Chrome White RC #136").parallel)
      .toBe("Chrome White");
  });
  it("'Chrome Purple Refractor' in Heritage → 'Chrome Purple Refractor'", () => {
    expect(parseListingIdentity("2026 Topps Heritage #250 Chrome Purple Refractor").parallel)
      .toBe("Chrome Purple Refractor");
  });
  it("'Chrome Refractor' in Heritage → 'Chrome Refractor'", () => {
    expect(parseListingIdentity("2026 Topps Heritage #100 Chrome Refractor").parallel)
      .toBe("Chrome Refractor");
  });
  it("bare 'Chrome' in Heritage → 'Chrome' (base chromium parallel)", () => {
    expect(parseListingIdentity("2026 Topps Heritage #136 Jac Caglianone Chrome RC").parallel)
      .toBe("Chrome");
  });
});

// Guardrail: Heritage Chrome rules must NOT hijack Bowman Chrome /
// Topps Chrome titles where "Gold" means Gold Refractor. Without the
// heritage-gate these would flip to "Chrome Gold" and split the pool.
describe("parseListingIdentity — Bowman/Topps Chrome unaffected by Heritage rules", () => {
  it("'Bowman Chrome Gold /50' → Gold Refractor (heritage-gate holds)", () => {
    expect(parseListingIdentity("Owen Carey Bowman Chrome Gold /50 Braves").parallel)
      .toBe("Gold Refractor");
  });
  it("'Topps Chrome Judge Blue /150' → Blue Refractor", () => {
    expect(parseListingIdentity("2025 Topps Chrome Judge Blue /150 #100").parallel)
      .toBe("Blue Refractor");
  });
});

// CF-BOWMAN-PAPER-SETKEY (Drew, 2026-07-29). BPA-XX / BDA-XX indicate
// paper-stock autograph subset — must slug distinctly from paper base
// and from chrome variants. Prior parser collapsed everything to
// "Bowman", blending pool.
describe("inferSetKeyFromTitle — Bowman Paper", () => {
  it("'1st Paper Prospect Auto' title → Bowman Paper", () => {
    expect(inferSetKeyFromTitle("Andrew Fischer BPA-AF 1st Paper Prospect Auto Brewers 2026 Bowman"))
      .toBe("Bowman Paper");
  });
  it("'Paper Prospect' → Bowman Paper", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Paper Prospect Autographs #BPA-EH Hartman"))
      .toBe("Bowman Paper");
  });
  it("'Paper Auto' → Bowman Paper", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Chrome Prospect Auto Paper Auto #BPA-XX"))
      .toBe("Bowman Paper");
  });
  it("cardNumber BPA-XX with bare '2026 Bowman' title → Bowman Paper (cardNum-driven)", () => {
    // CH sometimes returns terse titles like "2026 Bowman Andrew Fischer";
    // the BPA card# is the fallback signal that says "paper auto".
    expect(inferSetKeyFromTitle("2026 Bowman Andrew Fischer", "BPA-AF"))
      .toBe("Bowman Paper");
  });
  it("cardNumber BDA-XX + 'draft' → Bowman Draft Paper", () => {
    expect(inferSetKeyFromTitle("2025 Bowman Draft Andrew Fischer", "BDA-AF"))
      .toBe("Bowman Draft Paper");
  });
  it("'Paper Prospect' + 'Draft' → Bowman Draft Paper", () => {
    expect(inferSetKeyFromTitle("2025 Bowman Draft Paper Prospect Auto Hartman"))
      .toBe("Bowman Draft Paper");
  });
});

// Guardrails: Bowman Paper detection must NOT hijack Chrome/Draft-Chrome
// titles (which use CPA-/BCDA- prefixes and lack the "Paper" token).
describe("inferSetKeyFromTitle — Chrome/Draft-Chrome NOT hijacked by Bowman Paper", () => {
  it("'2026 Bowman Chrome Prospect Auto CPA-EHA' → Bowman Chrome (not Bowman Paper)", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Chrome Prospect Auto Eric Hartman #CPA-EHA", "CPA-EHA"))
      .toBe("Bowman Chrome");
  });
  it("'2025 Bowman Draft Chrome Gage Wood #BCDA-GW' → Bowman Draft Chrome", () => {
    expect(inferSetKeyFromTitle("2025 Bowman Draft Chrome Gage Wood #BCDA-GW", "BCDA-GW"))
      .toBe("Bowman Draft Chrome");
  });
  it("bare '2026 Bowman' base card with no BPA/BDA prefix → Bowman", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Andrew Fischer #100")).toBe("Bowman");
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
