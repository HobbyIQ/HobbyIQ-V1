// CF-PARSE-TITLE-IDENTITY tests (issue #722). Pins real observed
// marketplace titles from today's Owen Carey / Eric Hartman / Gage Wood
// ingests so the parser survives future edits without regressing.

import { describe, it, expect } from "vitest";
import {
  detectInsertSet,
  inferIsAuto,
  isCardNumberAutoSubset,
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";

// CF-CARDNUMBER-IMPLIES-AUTO (Drew, 2026-07-30). Empirical prefixes
// mined from sold_comps (2005+, discover-auto-cardnumber-prefixes).
// The rule promotes isAuto=true whenever the cardNumber prefix is on
// the confident-auto list (>=90% empirical, n>=100 samples).
describe("isCardNumberAutoSubset — empirical prefixes", () => {
  it("CPA-EHA → auto (98.6% empirical, Chrome Prospect Autographs)", () => {
    expect(isCardNumberAutoSubset("CPA-EHA")).toBe(true);
    expect(isCardNumberAutoSubset("#CPA-BA")).toBe(true);
    expect(isCardNumberAutoSubset("cpa-oc")).toBe(true);
  });
  it("BSA-JL → auto (99.5%, Bowman Sterling Autographs)", () => {
    expect(isCardNumberAutoSubset("BSA-JL")).toBe(true);
  });
  it("CDA-BOB → auto (90.9%, Chrome Draft Autographs)", () => {
    expect(isCardNumberAutoSubset("CDA-BOB")).toBe(true);
  });
  it("CRA-CAG → auto (95.9%, Chrome Rookie Autographs)", () => {
    expect(isCardNumberAutoSubset("CRA-CAG")).toBe(true);
  });
  it("USA-JH → auto (100%, Update Series Autographs)", () => {
    expect(isCardNumberAutoSubset("USA-JH")).toBe(true);
  });
  it("SCCA-JH → auto (93.3%)", () => {
    expect(isCardNumberAutoSubset("SCCA-JH")).toBe(true);
  });

  it("BCP-102 → NOT auto (0.0% empirical, base Bowman Chrome Prospects)", () => {
    expect(isCardNumberAutoSubset("BCP-102")).toBe(false);
    expect(isCardNumberAutoSubset("#BCP-102")).toBe(false);
  });
  it("BST-14 → NOT auto (0.0%, Bowman Sterling insert BASE — my initial rule was WRONG)", () => {
    expect(isCardNumberAutoSubset("BST-14")).toBe(false);
  });
  it("BPA-AF → auto (Bowman Prospect Autographs; parser under-tagged; Drew's list)", () => {
    // Empirical was 21.8% because parser MISSED the auto flag on most
    // BPA rows — Drew's domain list confirms BPA is 100% auto by product
    // definition. This rule fixes the mislabeling retroactively via the
    // backfill-isauto-from-cardnumber pass.
    expect(isCardNumberAutoSubset("BPA-AF")).toBe(true);
  });
  it("BCPA-LGA → auto (Bowman Chrome Prospect Autographs; Drew's list)", () => {
    expect(isCardNumberAutoSubset("BCPA-LGA")).toBe(true);
  });
  it("RA-BL → auto (Topps Chrome Rookie Autos / Prizm Draft Rookie Autos)", () => {
    expect(isCardNumberAutoSubset("RA-BL")).toBe(true);
  });
  it("AA-JD → auto (Museum Collection Archival Autographs)", () => {
    expect(isCardNumberAutoSubset("AA-JD")).toBe(true);
  });
  it("BA-14 → auto (Bowman's Best Autographs / Leaf Draft)", () => {
    expect(isCardNumberAutoSubset("BA-14")).toBe(true);
  });
  it("ROA-JV → auto (Real One Autographs)", () => {
    expect(isCardNumberAutoSubset("ROA-JV")).toBe(true);
  });
  it("C20A-KM → auto (Class of 2020 Autographs, year-varying)", () => {
    expect(isCardNumberAutoSubset("C20A-KM")).toBe(true);
  });
  it("APDCA-XX → auto but NOT AP (5-char prefix wins over 2-char AP)", () => {
    // Regex ordering test: APDCA must precede AP in the alternation.
    expect(isCardNumberAutoSubset("APDCA-XX")).toBe(true);
  });
  it("CA-LD → NOT auto (5.4%, mostly base)", () => {
    expect(isCardNumberAutoSubset("CA-LD")).toBe(false);
  });

  it("null/empty → false", () => {
    expect(isCardNumberAutoSubset(null)).toBe(false);
    expect(isCardNumberAutoSubset("")).toBe(false);
  });
  it("pure-digit cardNumber → false", () => {
    expect(isCardNumberAutoSubset("500")).toBe(false);
    expect(isCardNumberAutoSubset("#87")).toBe(false);
  });
});

// CF-INSERT-DETECTION (Drew, 2026-07-30). Detect insert subset from
// cardNumber prefix; returns the insert-slug to compound into setKey.
describe("detectInsertSet — baseball insert prefix mapping", () => {
  it("BTP-10 → scouts-top-100 (Bowman)", () => {
    expect(detectInsertSet("BTP-10")).toBe("scouts-top-100");
  });
  it("HRC-15 → home-run-challenge (Topps flagship)", () => {
    expect(detectInsertSet("HRC-15")).toBe("home-run-challenge");
  });
  it("FS-42 → future-stars (Topps Chrome)", () => {
    expect(detectInsertSet("FS-42")).toBe("future-stars");
  });
  it("SMLB-3 → stars-of-mlb", () => {
    expect(detectInsertSet("SMLB-3")).toBe("stars-of-mlb");
  });
  it("MR-100 → mood-ring (Bowman Draft)", () => {
    expect(detectInsertSet("MR-100")).toBe("mood-ring");
  });
  it("NAP-8 → new-age-performers (Heritage)", () => {
    expect(detectInsertSet("NAP-8")).toBe("new-age-performers");
  });
  it("TAN-5 → then-and-now (Heritage)", () => {
    expect(detectInsertSet("TAN-5")).toBe("then-and-now");
  });
  it("54F-JD → bowman-54", () => {
    expect(detectInsertSet("54F-JD")).toBe("bowman-54");
  });

  it("89BC-15 → anniversary-bc (year-stamped, letter suffix)", () => {
    expect(detectInsertSet("89BC-15")).toBe("anniversary-bc");
  });
  it("85TF-3 → anniversary-tf (year-stamped)", () => {
    expect(detectInsertSet("85TF-3")).toBe("anniversary-tf");
  });
  it("87ASA-JD → anniversary-asa (year-stamped, 3-letter)", () => {
    expect(detectInsertSet("87ASA-JD")).toBe("anniversary-asa");
  });

  it("BCP-102 → null (base Bowman Chrome Prospects, not an insert)", () => {
    expect(detectInsertSet("BCP-102")).toBe(null);
  });
  it("CPA-EHA → null (auto, but not an insert — belongs to base Bowman Chrome pool with auto flag)", () => {
    expect(detectInsertSet("CPA-EHA")).toBe(null);
  });
  it("pure-digit → null", () => {
    expect(detectInsertSet("100")).toBe(null);
  });
  it("null/empty → null (silent-safe)", () => {
    expect(detectInsertSet(null)).toBe(null);
    expect(detectInsertSet("")).toBe(null);
  });
});

// CF-UNIFIED-AUTO-INFERENCE (Drew, 2026-07-30). Sport-aware detector.
describe("inferIsAuto — sport-aware routing", () => {
  describe("baseball", () => {
    it("cardNumber prefix CPA-EHA → auto", () => {
      expect(inferIsAuto({ sport: "baseball", cardNumber: "CPA-EHA" })).toBe(true);
    });
    it("setName 'Real One Autographs' → auto (Heritage)", () => {
      expect(inferIsAuto({ sport: "baseball", setName: "Topps Heritage Real One Autographs" })).toBe(true);
    });
    it("no signals → false", () => {
      expect(inferIsAuto({ sport: "baseball", cardNumber: "BCP-102", setName: "Bowman Chrome Prospects" })).toBe(false);
    });
  });

  describe("basketball (Panini era — setName-primary)", () => {
    it("setName 'Panini Prizm Signatures' → auto", () => {
      expect(inferIsAuto({ sport: "basketball", setName: "2020 Panini Prizm Signatures" })).toBe(true);
    });
    it("setName 'Rookie Ink' → auto (Hoops)", () => {
      expect(inferIsAuto({ sport: "basketball", setName: "Panini Hoops Rookie Ink" })).toBe(true);
    });
    it("setName 'Rookie Ticket Autographs' → auto (Contenders)", () => {
      expect(inferIsAuto({ sport: "basketball", setName: "Panini Contenders Rookie Ticket Autographs" })).toBe(true);
    });
    it("setName 'Sensational Signatures' → auto (Prizm insert)", () => {
      expect(inferIsAuto({ sport: "basketball", setName: "Prizm Sensational Signatures" })).toBe(true);
    });
    it("cardNumber prefix does NOT trigger for basketball (Panini era has no prefixes)", () => {
      // "PA-" is baseball prefix but basketball Panini era doesn't use
      // prefixes — should NOT auto-tag a basketball row on cardNumber alone.
      expect(inferIsAuto({ sport: "basketball", cardNumber: "PA-100", setName: null })).toBe(false);
    });
    it("plain base insert (no auto keyword) → false", () => {
      expect(inferIsAuto({ sport: "basketball", setName: "Panini Prizm Kaboom", cardNumber: "K-1" })).toBe(false);
    });
  });

  describe("football (hybrid — WT/SOT prefix + setName)", () => {
    it("Winning Ticket cardNumber WT-15 → auto", () => {
      expect(inferIsAuto({ sport: "football", cardNumber: "WT-15" })).toBe(true);
    });
    it("baseball prefix RA-XX also works (Prizm Draft Picks)", () => {
      expect(inferIsAuto({ sport: "football", cardNumber: "RA-CJS" })).toBe(true);
    });
    it("setName 'Panini Prizm Rookie Autographs' → auto", () => {
      expect(inferIsAuto({ sport: "football", setName: "Panini Prizm Rookie Autographs" })).toBe(true);
    });
    it("setName 'NFL Ink' → auto (Contenders)", () => {
      expect(inferIsAuto({ sport: "football", setName: "Contenders NFL Ink" })).toBe(true);
    });
  });

  describe("title has explicit auto text — always wins", () => {
    it("title with 'auto' short-circuits regardless of other signals", () => {
      expect(inferIsAuto({ sport: "basketball", titleHasAutoText: true })).toBe(true);
    });
  });

  describe("guardrails", () => {
    it("basketball setName 'Signatures Series' → auto (broad match)", () => {
      expect(inferIsAuto({ sport: "basketball", setName: "Panini Chronicles Signature Series" })).toBe(true);
    });
    it("baseball with no setName + non-auto cardNumber → false", () => {
      expect(inferIsAuto({ sport: "baseball", cardNumber: "100", setName: null })).toBe(false);
    });
  });
});

describe("parseListingIdentity — cardNumber → isAuto promotion", () => {
  it("terse title without 'auto' but CPA-XXX cardNumber → isAuto=true", () => {
    // Sellers frequently list "2025 Bowman #CPA-EHA Braves" with no
    // "auto" text at all — the prefix carries the signal.
    const r = parseListingIdentity("2025 Bowman #CPA-EHA Braves");
    expect(r.isAuto).toBe(true);
    expect(r.cardNumber).toBe("CPA-EHA");
  });
  it("title says 'auto' AND cardNumber is CPA-XXX → isAuto=true (both signals)", () => {
    const r = parseListingIdentity("2025 Bowman Chrome Auto #CPA-EHA");
    expect(r.isAuto).toBe(true);
  });
  it("title without 'auto' and BCP-XXX cardNumber → isAuto=false (base prospect)", () => {
    const r = parseListingIdentity("2025 Bowman Chrome #BCP-102 Braves");
    expect(r.isAuto).toBe(false);
  });
  it("title without 'auto' and BST-XX cardNumber → isAuto=false (Sterling insert base)", () => {
    const r = parseListingIdentity("2026 Bowman Sterling #BST-14");
    expect(r.isAuto).toBe(false);
  });
});

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
  // CF-SPECKLE-REFRACTOR (Drew, 2026-07-29). Bowman Chrome speckle
  // parallel — small-dot foil pattern. Bare form + color-prefixed form.
  it("Patterned refractor: Blue Speckle Refractor", () => {
    expect(parseListingIdentity("Eric Hartman Blue Speckle Refractor #CPA-EHA /150").parallel).toBe("Blue Speckle Refractor");
  });
  it("Patterned refractor: Orange Speckle Refractor", () => {
    expect(parseListingIdentity("Owen Carey 2026 Bowman Chrome Orange Speckle Refractor /25").parallel).toBe("Orange Speckle Refractor");
  });
  it("Patterned refractor: bare Speckle Refractor (silver-based)", () => {
    expect(parseListingIdentity("Eric Hartman 2026 Bowman Chrome Speckle Refractor #CPA-EHA").parallel).toBe("Speckle Refractor");
  });
  it("Patterned refractor: bare 'Speckle' word alone still resolves", () => {
    expect(parseListingIdentity("Eric Hartman 2026 Bowman Chrome Speckle #CPA-EHA").parallel).toBe("Speckle Refractor");
  });
  // CF-NO-REFRACTOR-AUTO-RELEASED (Drew, 2026-08-15): "eric hartman is the
  // only one without a refractor auto ... no card was released by topps.
  // There was an issue with his cards. It is an anomoly."
  //
  // One card, not a product rule. The first two are the exact live titles
  // that mislabelled 431 sold_comps rows; the last two pin that the ordinary
  // chrome-auto default is UNCHANGED for everyone else.
  it("CPA-EHA auto → Base (Topps never released the Refractor)", () => {
    expect(parseListingIdentity(
      "2026 Bowman Chrome Eric Hartman 1st Bowman RC Auto Prospect Autographs #CPA-EHA - Raw",
    ).parallel).toBe("Base");
  });
  it("CPA-EHA auto → Base even when the title says only 'Chrome Prospect Auto'", () => {
    expect(parseListingIdentity(
      "ERIC HARTMAN 2026 Bowman 1st Chrome Prospect Auto Atlanta Braves #CPA-EHA",
    ).parallel).toBe("Base");
  });
  // RETRACTED 2026-08-25. These three used to assert the 2026-07-31 rule that a
  // chrome auto with no colour word IS a Refractor, on the premise that the
  // base tier of the CPA- ladder is a /499 Refractor. Drew overturned the
  // premise: "no refractor is a base. Refractor is a parallel or a finish and
  // is out of /499 for autos". Refractor sits ABOVE base, so a chrome auto
  // naming no parallel is a BASE auto. Kept as tests, inverted, so the old
  // behaviour cannot quietly return.
  it("a chrome auto naming no parallel is Base, not Refractor", () => {
    expect(parseListingIdentity(
      "2026 Bowman Chrome Owen Carey 1st Bowman RC Auto Prospect Autographs #CPA-OC",
    ).parallel).toBe("Base");
    expect(parseListingIdentity(
      "2025 Bowman Draft #CPA-JHA Josiah Hartshorn 1st Prospect Chrome Auto",
    ).parallel).toBe("Base");
    expect(parseListingIdentity(
      "2028 Bowman Chrome Prospect Autographs #CPA-EHA 1st Auto",
    ).parallel).toBe("Base");
  });

  it("a chrome auto that NAMES a parallel still gets it", () => {
    // The retraction must not cost us the parallels the ladder does have.
    expect(parseListingIdentity("2026 Bowman Chrome #CPA-OC 1st Auto Refractor /499").parallel).toBe("Refractor");
    expect(parseListingIdentity("Eric Hartman Red /5 #CPA-EHA").parallel).toBe("Red Refractor");
    expect(parseListingIdentity("2026 BOWMAN CHROME PROSPECTS #CPA-MG Marconi German RC 1st Auto Purple /250").parallel).toBe("Purple Refractor");
    expect(parseListingIdentity("2026 Bowman Chrome Prospects #CPA-XX Player 1st Auto Aqua /125").parallel).toBe("Aqua Refractor");
  });

  it("an explicit Base in the title is never overridden", () => {
    expect(parseListingIdentity("2022 Bowman Chrome Prospects Baseball #CPA-MG Base").parallel).toBe("Base");
    expect(parseListingIdentity("2026 Bowman Chrome 1st - Marconi German - True Base Auto - CPA-MG - Raw").parallel).toBe("Base");
  });

  it("reads the -fractor family by shape, not by name", () => {
    // Mined from the 10,144 sales the refractor repair held back. Both read
    // their PRINT RUN and lost the parallel, so a /99 Logofractor auto was
    // filed as base.
    expect(parseListingIdentity("2024 Topps Chrome Logofractor Future Stars Auto #FSA-CR Ceddanne Rafaela /99 RC").parallel).toBe("Logofractor");
    expect(parseListingIdentity("#CPA-BA Brailyn Antunez 2026 Bowman SN Milwaukee Brewers Chrome PackFractor /89 - Raw").parallel).toBe("Packfractor");
    // ...without swallowing the three that already had homes.
    expect(parseListingIdentity("2026 Bowman Chrome #CPA-OC 1st Auto Refractor /499").parallel).toBe("Refractor");
    expect(parseListingIdentity("2026 Bowman Chrome #CPA-OC 1st Auto SuperFractor 1/1").parallel).toBe("SuperFractor");
    expect(parseListingIdentity("2026 Bowman Chrome Baseball #CPA-MG Gold Refractor").parallel).toBe("Gold Refractor");
  });

  it("reads Mojo, the most common miss in the held set", () => {
    expect(parseListingIdentity("2022 Bowman Chrome - Mega Box Chrome Mojo Autographs Joshua Baez #BCMA-JB").parallel).toBe("Mojo");
    expect(parseListingIdentity("2023 Bowman Chrome Keiner Delgado Auto /150 Choice Mojo #CPA-KD (RC, AU) Yankees").parallel).toBe("Mojo");
  });

  it("an insert set name is not a parallel", () => {
    // Found by sampling 8,500 real rows after the colour rules were widened:
    // "Red Hot Rookies" is the INSERT's name, so this is a plain Refractor of
    // that insert, not a Red Refractor. The colour belongs to the set name.
    expect(parseListingIdentity("2010 Topps Chrome Carlos Santana Red Hot Rookies Refractor #RHR-1 RC").parallel).toBe("Refractor");
    // ...but the colours that ARE parallels must still read.
    expect(parseListingIdentity("2010 Topps Chrome Ichiro Suzuki Orange Refractor #38 Mariners").parallel).toBe("Orange Refractor");
    expect(parseListingIdentity("DREW BREES SP PURPLE REFRACTOR #/555 ~ 2010 TOPPS CHROME #C220").parallel).toBe("Purple Refractor");
  });

  it("a team name is not a parallel", () => {
    expect(parseListingIdentity("2026 Bowman Chrome #CPA-XX Player 1st Auto Toronto Blue Jays").parallel).toBe("Base");
    expect(parseListingIdentity("2026 Bowman Chrome #CPA-XX Player 1st Auto Boston Red Sox").parallel).toBe("Base");
  });
  it("no year in the title still resolves to Base (sellers omit it)", () => {
    expect(parseListingIdentity(
      "ERIC HARTMAN Bowman 1st Chrome Prospect Auto Braves #CPA-EHA",
    ).parallel).toBe("Base");
  });
  // The exception is the BASE tier only. Hartman's colour autos were printed
  // and still normalize through the colour rules above this fallback.
  it("CPA-EHA colour auto still resolves to '{Color} Refractor'", () => {
    expect(parseListingIdentity("Eric Hartman Blue /150 Auto #CPA-EHA").parallel).toBe("Blue Refractor");
  });

  // CF-CHROME-IMPLIED (Drew, 2026-07-29). Speckle/Shimmer/Lava/etc are
  // Chrome-only parallels; title with "Bowman" + Speckle should resolve
  // setKey → "Bowman Chrome" even when "Chrome" isn't in the title.
  it("Chrome-implied: 'Bowman' + Speckle → Bowman Chrome setKey", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Eric Hartman Blue Speckle Refractor #CPA-EHA")).toBe("Bowman Chrome");
  });
  it("Chrome-implied: 'Bowman' + Shimmer → Bowman Chrome setKey", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Owen Carey Green Shimmer Refractor")).toBe("Bowman Chrome");
  });
  it("Chrome-implied: 'Bowman' + bare Refractor → Bowman Chrome setKey", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Aaron Judge Refractor #100")).toBe("Bowman Chrome");
  });
  it("Chrome-implied guardrail: 'Bowman' with no chrome signal stays 'Bowman'", () => {
    expect(inferSetKeyFromTitle("2026 Bowman Eric Hartman base rookie card")).toBe("Bowman");
  });
  it("Chrome-implied guardrail: explicit Bowman Draft + refractor stays Bowman Draft", () => {
    // Explicit Draft product line wins over the chrome-implied upgrade.
    expect(inferSetKeyFromTitle("2025 Bowman Draft Gage Wood Refractor #BD-100")).toBe("Bowman Draft");
  });
  // CF-CHROME-IMPLIED-EDITION-GUARD (Drew, 2026-07-30). Sapphire/Mega
  // are separate FMV pools; chrome-implied MUST NOT collapse them.
  it("Chrome-implied edition guard: 'Bowman Chrome Sapphire Speckle Refractor' stays Sapphire", () => {
    expect(inferSetKeyFromTitle("2024 Bowman Chrome Sapphire Speckle Refractor Eric Hartman")).toBe("Bowman Chrome Sapphire");
  });
  it("Chrome-implied edition guard: 'Bowman Mega Box' + wave refractor stays Mega Box", () => {
    expect(inferSetKeyFromTitle("2024 Bowman Mega Box Mojo Refractor Aaron Judge")).toBe("Bowman Chrome Mega Box");
  });
  it("Chrome-implied via BSPA cardNumber: 'Bowman' + speckle + BSPA-* → Bowman Chrome Sapphire", () => {
    expect(inferSetKeyFromTitle("2024 Bowman Speckle Refractor #BSPA-EH", "BSPA-EH")).toBe("Bowman Chrome Sapphire");
  });
  it("Chrome-implied still fires when NO edition present: 'Bowman + Speckle Refractor' → Bowman Chrome", () => {
    expect(inferSetKeyFromTitle("2024 Bowman Speckle Refractor Eric Hartman #BCP-102")).toBe("Bowman Chrome");
  });
  // CF-BARE-WAVE-REFRACTOR (Drew, 2026-07-29). Bare Wave Refractor
  // (silver-based, no color modifier) was falling through to bare
  // "Refractor" because color-prefixed Wave rules didn't match.
  it("Patterned refractor: bare Wave Refractor (no color)", () => {
    expect(parseListingIdentity("2026 Bowman - Eric Hartman Wave Refractor /350 #BCP-102").parallel).toBe("Wave Refractor");
  });
  it("Patterned refractor: bare Ray Wave Refractor (no color)", () => {
    expect(parseListingIdentity("Owen Carey Ray Wave Refractor #BCP-99").parallel).toBe("Ray Wave Refractor");
  });
  it("Guardrail: 'Blue Wave Refractor' still returns Blue-prefixed (color rule wins)", () => {
    expect(parseListingIdentity("Owen Carey Blue Wave Refractor").parallel).toBe("Blue Wave Refractor");
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

// CF-MEGA-MOJO-ALIAS (Drew, 2026-07-29). Mega Refractor and Mojo
// Refractor are the same physical parallel; different market vocab.
// Collapse to canonical "Mojo Refractor" so their comp pool doesn't
// split.
describe("parseListingIdentity — Mega/Mojo alias", () => {
  it("'Mojo Refractor' → Mojo Refractor", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Mojo Refractor #100").parallel)
      .toBe("Mojo Refractor");
  });
  it("'Mega Refractor' → Mojo Refractor (same physical parallel)", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Mega Refractor #100").parallel)
      .toBe("Mojo Refractor");
  });
  it("guardrail: 'Orange Refractor' stays Orange Refractor (visually distinct — solid orange, no pattern)", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Orange Refractor #100 /25").parallel)
      .toBe("Orange Refractor");
  });
});

// CF-STERLING-REFRACTOR (Drew, 2026-07-29). Bowman Sterling insert
// (BST-XX cardNumber) with Sterling Refractor parallel — its own pool
// so pricing doesn't blend with Chrome Refractor.
describe("parseListingIdentity — Bowman Sterling insert", () => {
  it("'Bowman Sterling #BST-14' → cardNumber BST-14", () => {
    expect(parseListingIdentity("2026 Bowman Jac Caglianone Bowman Sterling #BST-14 Kansas City Royals").cardNumber)
      .toBe("BST-14");
  });
  it("'Bowman Sterling Refractor Insert #BST-14' → parallel Sterling Refractor + cardNumber BST-14", () => {
    const r = parseListingIdentity("2026 Bowman JAC CAGLIANONE Bowman Sterling Refractor Insert #BST-14 Royals RC");
    expect(r.parallel).toBe("Sterling Refractor");
    expect(r.cardNumber).toBe("BST-14");
  });
  it("'Blue Sterling Refractor' → Blue Sterling Refractor (color-ladder support)", () => {
    expect(parseListingIdentity("2026 Bowman Blue Sterling Refractor #BST-14").parallel)
      .toBe("Blue Sterling Refractor");
  });
});

// CF-COLOR-ROOKIE (Drew, 2026-07-29). "Red Rookie" is a distinct
// parallel — rookie-designated color-foiled variant.
describe("parseListingIdentity — Color Rookie parallels", () => {
  it("'Red Rookie' → Red Rookie", () => {
    expect(parseListingIdentity("2025 Topps Red Rookie #100 Wembanyama").parallel)
      .toBe("Red Rookie");
  });
  it("'Blue Rookie' → Blue Rookie", () => {
    expect(parseListingIdentity("2025 Topps Blue Rookie #100").parallel)
      .toBe("Blue Rookie");
  });
  it("'Gold Rookie' → Gold Rookie", () => {
    expect(parseListingIdentity("2025 Topps Gold Rookie #100").parallel)
      .toBe("Gold Rookie");
  });
});

// CF-PINK-REFRACTOR + CF-BARE-REFRACTOR (Drew, 2026-07-29). Two
// omissions in the Topps Chrome parallel vocab that caused Aaron
// Judge 2017 #169 rows to collapse to parallel="Base":
//   1. "Pink Refractor" — Mother's Day pink variant, common on Topps
//      Chrome. Was not in the color-ladder.
//   2. Bare "Refractor" without AUTO — the silver-base refractor
//      parallel of the base card. Prior rule required AUTO, so non-auto
//      refractors collapsed to Base.
describe("parseListingIdentity — Refractor + Pink Refractor fixes", () => {
  it("'Pink Refractor' → Pink Refractor", () => {
    expect(parseListingIdentity("Aaron Judge 2017 Topps Chrome Catching PINK Refractor #169 RC PSA 10 GEM MT").parallel)
      .toBe("Pink Refractor");
  });
  it("bare 'Refractor' on a non-auto Topps Chrome card → Refractor", () => {
    // "2017 Topps Chrome Aaron Judge #169 Catching Refractor RC PSA 10"
    // — no color, no auto. Base silver refractor parallel.
    expect(parseListingIdentity("2017 Topps Chrome - Aaron Judge #169 Catching Refractor RC PSA 10").parallel)
      .toBe("Refractor");
  });
  it("guardrail: 'Blue Refractor' still → Blue Refractor (specific rules win first)", () => {
    expect(parseListingIdentity("2025 Topps Chrome Blue Refractor #100").parallel)
      .toBe("Blue Refractor");
  });
  it("guardrail: 'Mojo Refractor' still → Mojo Refractor", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Mojo Refractor #100").parallel)
      .toBe("Mojo Refractor");
  });
  it("bare 'Refractor' + auto → Refractor (pre-existing behavior preserved)", () => {
    expect(parseListingIdentity("2025 Bowman Chrome Prospect Auto #CPA-XX Refractor").parallel)
      .toBe("Refractor");
  });
  it("guardrail: title without 'refractor' does NOT get Refractor label", () => {
    expect(parseListingIdentity("2017 Topps Chrome Aaron Judge #169 RC PSA 10").parallel)
      .toBe("Base");
  });
});

// CF-FLEER-STICKERS (Drew, 2026-07-29). 1986 Fleer Stickers is
// basketball's iconic debut product (Michael Jordan Sticker #8 rookie).
// Distinct from base 1986 Fleer basketball. Sport = basketball by
// product convention when no basketball keyword is in the title.
describe("inferSetKeyFromTitle + inferSportFromTitle — Fleer Stickers", () => {
  it("'MICHAEL JORDAN 1986 FLEER STICKER #8 ROOKIE PSA MINT 9' → Fleer Stickers", () => {
    expect(inferSetKeyFromTitle("MICHAEL JORDAN 1986 FLEER STICKER #8 ROOKIE PSA MINT 9"))
      .toBe("Fleer Stickers");
  });
  it("'Michael Jordan 1986 Fleer Sticker #8 Rookie PSA 8 Chicago Bulls RC' → Fleer Stickers", () => {
    expect(inferSetKeyFromTitle("Michael Jordan 1986 Fleer Sticker #8 Rookie PSA 8 Chicago Bulls RC"))
      .toBe("Fleer Stickers");
  });
  it("plural 'Fleer Stickers' also matches", () => {
    expect(inferSetKeyFromTitle("1986 Fleer Stickers Michael Jordan #8"))
      .toBe("Fleer Stickers");
  });
  it("'1986 Fleer' base (no stickers word) → Fleer (not Bowman default)", () => {
    // Base Fleer is now recognized as its own set — separate from
    // Fleer Stickers (which is a distinct product line).
    expect(inferSetKeyFromTitle("1986 Fleer #57 Michael Jordan Rookie"))
      .toBe("Fleer");
  });
  it("'Fleer Sticker' with no other basketball keyword → sport=basketball", () => {
    expect(inferSportFromTitle("MICHAEL JORDAN 1986 FLEER STICKER #8 ROOKIE PSA MINT 9"))
      .toBe("basketball");
  });
  it("explicit 'basketball' keyword still wins", () => {
    expect(inferSportFromTitle("2023 Panini Prizm Basketball Wembanyama"))
      .toBe("basketball");
  });
  it("guardrail: no basketball signal → baseball fallback preserved", () => {
    expect(inferSportFromTitle("2025 Bowman Chrome Eric Hartman #CPA-EH"))
      .toBe("baseball");
  });
});

// CF-TEAM-NAME-SPORT-HINTS (Drew, 2026-07-29). Recover sport for
// titles that carry no explicit football/NFL/basketball/NBA keyword
// but do carry an unambiguous team name.
describe("inferSportFromTitle — team-name fallback", () => {
  it("'Justin Herbert Chargers' (no football keyword) → football", () => {
    expect(inferSportFromTitle("JUSTIN HERBERT 2020 PANINI PRIZM ROOKIE Chargers"))
      .toBe("football");
  });
  it("'Bolts' also maps to football (Chargers slang)", () => {
    expect(inferSportFromTitle("Herbert 2020 Panini Mosaic Bolts"))
      .toBe("football");
  });
  it("'Lakers' → basketball", () => {
    expect(inferSportFromTitle("Kobe Bryant Panini Prizm Lakers"))
      .toBe("basketball");
  });
  it("'Celtics' → basketball", () => {
    expect(inferSportFromTitle("Jayson Tatum Panini Select Celtics"))
      .toBe("basketball");
  });
  it("'Bruins' → hockey", () => {
    expect(inferSportFromTitle("Bobby Orr Bruins Rookie Card"))
      .toBe("hockey");
  });
  it("'Maple Leafs' → hockey", () => {
    expect(inferSportFromTitle("Auston Matthews Maple Leafs Rookie"))
      .toBe("hockey");
  });
  it("guardrail: title with EXPLICIT 'football' still wins", () => {
    expect(inferSportFromTitle("2024 Panini Prizm Football Ladd McConkey"))
      .toBe("football");
  });
  it("guardrail: title with no team + no sport keyword falls back to caller default", () => {
    expect(inferSportFromTitle("2025 Bowman Chrome Eric Hartman #CPA-EH"))
      .toBe("baseball");
  });
  it("guardrail: ambiguous 'Panthers' (NFL + NHL) NOT recognized — stays fallback", () => {
    // Carolina Panthers (NFL) + Florida Panthers (NHL) share the name.
    // Word is intentionally excluded from BOTH team lists.
    expect(inferSportFromTitle("Some Panthers Player 2020"))
      .toBe("baseball");
  });
});

// CF-SUBPRODUCT-SETKEY (Drew, 2026-08-15). 17 product lines existed in
// card_catalog with no parser rule, so their sales collapsed to the parent
// brand and then failed to match a catalog row that was already there.
describe("inferSetKeyFromTitle — sub-products that had no rule", () => {
  it.each([
    ["2024 Topps Pro Debut #PD-100 Jackson Holliday", "Topps Pro Debut"],
    ["2023 Topps Signature Class Auto #SC-JD", "Topps Signature Class"],
    ["2024 Topps Cosmic Chrome #55 Refractor", "Topps Cosmic Chrome"],
    ["2022 Topps Triple Threads Relic #TTR-1", "Topps Triple Threads"],
    ["2023 Topps Tier One Auto #TOA-BW", "Topps Tier One"],
    ["2025 Topps Now #35 Shohei Ohtani", "Topps Now"],
    ["2024 Topps Resurgence #R-12", "Topps Resurgence"],
    ["2003 eTopps #45 Albert Pujols", "eTopps"],
    ["Don Mattingly 2025 Topps Shoebox Treasures #14", "Topps Shoebox Treasures"],
    ["2024 Bowman Platinum Top Prospects #TP-5", "Bowman Platinum"],
    ["2023 Bowman Inception Auto #BI-JD", "Bowman Inception"],
    ["1994 Fleer Ultra #200 Griffey", "Fleer Ultra"],
    ["1996 Fleer Metal Universe #2 Barry Bonds", "Fleer Metal"],
    ["1990 Fleer Update #U-87", "Fleer Update"],
    ["2023 Leaf Metal Sports Heroes Auto #5", "Leaf Metal"],
  ])("%s -> %s", (title, want) => {
    expect(inferSetKeyFromTitle(title)).toBe(want);
  });

  // Both of these previously returned "Bowman" — not merely generic, wrong.
  it.each([
    ["2013 Panini Totally Certified Red #12", "Panini Totally Certified"],
    ["2024 Panini Noir USMNT #12", "Panini Noir"],
  ])("was mis-routed to Bowman: %s -> %s", (title, want) => {
    expect(inferSetKeyFromTitle(title)).toBe(want);
  });

  describe("guardrails — parent products must not be stolen", () => {
    it.each([
      ["2025 Topps Series 1 Baseball #100", "Topps"],
      ["2025 Topps Update Baseball #US140", "Topps Update"],
      ["2025 Topps Chrome #150 Refractor", "Topps Chrome"],
      ["2024 Bowman Chrome Prospect Auto #CPA-AB", "Bowman Chrome"],
      ["2024 Bowman Draft Chrome #BDC-1", "Bowman Draft Chrome"],
      ["1986 Fleer #57 Michael Jordan Rookie", "Fleer"],
    ])("%s -> %s", (title, want) => {
      expect(inferSetKeyFromTitle(title)).toBe(want);
    });
  });
});

// CF-WWE-UFC-NEVER-DETECTED (Drew, 2026-08-15: "This is marvel wwe cards").
// Neither wrestling nor MMA had detection, so both fell to the baseball
// fallback. Measured: of 7,071 sold_comps titles containing "WWE", 6,134
// (87%) were tagged baseball; of 5,573 containing "UFC", 4,715 (85%) were.
describe("inferSportFromTitle — wrestling / MMA / boxing", () => {
  it.each([
    ["2023 Panini Prizm WWE Roman Reigns #1", "wrestling"],
    ["2022 Topps WWE Slam Attax Liv Morgan", "wrestling"],
    ["2024 Panini AEW Chrome Adam Cole Auto", "wrestling"],
    ["WrestleMania 40 Topps Chrome Cody Rhodes", "wrestling"],
    ["2023 Panini Prizm UFC Conor McGregor #12", "mma"],
    ["2024 Topps UFC Bellator Auto", "mma"],
    ["2023 Topps Boxing Muhammad Ali #5", "boxing"],
  ])("%s -> %s", (title, want) => {
    expect(inferSportFromTitle(title)).toBe(want);
  });

  // "RAW" is the ungraded marker, not WWE Raw. It ends thousands of titles
  // in every sport, so matching it would drag the whole pool into wrestling.
  it.each([
    "2025 Bowman Chrome Eric Hartman #CPA-EH - Raw",
    "2026 Bowman - Chrome Prospect Autographs Breyson Guedez #CPA-BG (AU, RC) - Raw",
    "Shohei Ohtani 2025 Bowman Chrome - HS4 Sho-Time Showcase Hobby Stars #SLAD - Raw",
  ])("the ungraded marker '- Raw' stays baseball: %s", (title) => {
    expect(inferSportFromTitle(title)).toBe("baseball");
  });
});

// CF-SOCCER-NEVER-DETECTED (Drew, 2026-08-15). inferSportFromTitle had no
// soccer branch at all, so every soccer card fell through to the baseball
// fallback and polluted the pool that feeds baseball FMV + calibration.
// Measured in sold_comps: 14,826 baseball-slugged rows saying "WORLD CUP",
// 13,678 "FIFA", 8,293 "UEFA", against only 7,034 correctly tagged soccer.
describe("inferSportFromTitle — soccer", () => {
  it.each([
    ["Topps Chrome UCC", "2022-23 Topps Chrome UCC Julian Alvarez Aqua Wave Refractor RC /199 PSA 10"],
    ["UEFA", "JULIAN ALVAREZ 2025-26 TOPPS CHROME UEFA PURPLE GEOMETRIC AUTO /75 #CA-AL"],
    ["World Cup", "2026 PANINI PRIZM WORLD CUP #25 SCORERS CLUB SILVER ARGENTINA"],
    ["Panini Select FIFA", "2022-23 Panini Select FIFA - Gold Prizm Julian Alvarez #202"],
    ["MLS", "Lionel Messi 2023 Inter Miami MLS Debut"],
  ])("competition/league '%s' resolves to soccer", (_l, title) => {
    expect(inferSportFromTitle(title)).toBe("soccer");
  });

  it("a named competition beats the bare word 'football' (which means soccer abroad)", () => {
    expect(inferSportFromTitle("2024 Topps Merlin Football UEFA Champions League Haaland"))
      .toBe("soccer");
  });

  it("club name alone still resolves when no competition is named", () => {
    expect(inferSportFromTitle("Erling Haaland Manchester City 2023 Topps")).toBe("soccer");
  });

  describe("guardrails — must NOT be stolen by soccer", () => {
    it.each([
      ["2024 Panini Prizm Football Ladd McConkey", "football"],
      ["JUSTIN HERBERT 2020 PANINI PRIZM ROOKIE Chargers", "football"],
      ["2023 Panini Prizm Basketball Wembanyama", "basketball"],
      ["Auston Matthews Maple Leafs Rookie", "hockey"],
      ["2025 Bowman Chrome Eric Hartman #CPA-EH", "baseball"],
      ["2025 Pokemon Mega Evolution Phantasmal Flames #102 Base", "pokemon"],
    ])("%s -> %s", (title, want) => {
      expect(inferSportFromTitle(title)).toBe(want);
    });
  });
});

// CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). A slug sweep over 2026-07
// stamped 4,589 rows sport='hockey'; ~91.6% were wrong. Team words that
// are also ordinary English ("Stars", "Flames", "Wild") were matching
// product and insert names, and a GUESSED team outranked the product
// line sitting in the same title. Every title below is verbatim from
// the damaged set.
describe("inferSportFromTitle — CF-SPORT-TEAM-OVERMATCH", () => {
  describe("named product lines outrank guessed team names", () => {
    it("Pokemon 'Phantasmal Flames' is not Calgary (2,822 rows)", () => {
      expect(inferSportFromTitle("2025 2025 Pokemon Mega Evolution Phantasmal Flames #102 Base"))
        .toBe("pokemon");
    });
    it("Pokemon 'Brilliant Stars' is not Dallas", () => {
      expect(inferSportFromTitle("2022 2022 Pokemon Brilliant Stars #48 Base"))
        .toBe("pokemon");
    });
    it("Pokemon 'Wild Force' is not Minnesota (195 rows)", () => {
      expect(inferSportFromTitle("2024 2024 Pokemon Japanese Scarlet & Violet Wild Force #53 Base"))
        .toBe("pokemon");
    });
    it("Pokemon 'Lightning' type is not Tampa Bay", () => {
      expect(inferSportFromTitle("Morpeko Promo SWSH: Sword & Shield Promo Cards SWSH012 Lightning Holo Pokemon Ca - Raw"))
        .toBe("pokemon");
    });
  });

  describe("full player names outrank guessed team names", () => {
    it("Ohtani 'Hobby Stars' → baseball, not Dallas Stars", () => {
      expect(inferSportFromTitle("Shohei Ohtani 2025 Bowman Chrome - HS4 Sho-Time Showcase Hobby Stars #SLAD - Raw"))
        .toBe("baseball");
    });
    it("Hoops 'Frequent Flyers' → basketball, not Philadelphia Flyers", () => {
      expect(inferSportFromTitle("2024-25 Hoops #1 Damian Lillard Frequent Flyers - Raw"))
        .toBe("basketball");
    });
    it("Panini 'Rookies & Stars' is a FOOTBALL product", () => {
      expect(inferSportFromTitle("2025 Panini Rookies & Stars - Thrillers Chris Olave #14 Orange Prizm /25 - Raw"))
        .toBe("football");
    });
  });

  describe("weak team words need their city; strong names stand alone", () => {
    it.each([
      ["Calgary Flames", "2023-24 Upper Deck Calgary Flames Jonathan Huberdeau #77"],
      ["Dallas Stars", "2022-23 Dallas Stars Jason Robertson #12 Series 2"],
      ["Minnesota Wild", "2021-22 Minnesota Wild Kirill Kaprizov Series One"],
      ["San Jose Sharks", "24/25 UD Extended - MACKLIN CELEBRINI Rc #BH-24 Beehive Insert San Jose Sharks"],
      ["Anaheim Ducks", "2021-22 Upper Deck Series 1   Jamie Drysdale young guns #205 RC Anaheim Ducks"],
      ["Carolina Hurricanes", "Upper Deck 2024-25 Series 2 Jalen Chatfield #278 Deluxe Carolina Hurricanes /250"],
    ])("city-qualified '%s' still resolves to hockey", (_label, title) => {
      expect(inferSportFromTitle(title, "")).toBe("hockey");
    });

    it.each([
      ["Blackhawks", "2024 Colton Dach #102 Chicago Blackhawks Upper Deck SPX Rookie Card"],
      ["Bruins", "2013-14 Dougie Hamilton Rookie Card #646 Boston Bruins"],
      ["Islanders", "MATHEW BARZAL 2016-17 ROOKIE  CARD #689  New York Islanders"],
      ["Canadiens", "1986-87 Patrick Roy Rookie O-Pee-Chee OPC RC #53 PSA 7 NM Canadiens"],
    ])("distinctive '%s' matches bare", (_label, title) => {
      expect(inferSportFromTitle(title, "")).toBe("hockey");
    });

    it("an UNQUALIFIED weak word refuses rather than guessing", () => {
      // Doctrine: absent beats wrong. Nothing in this title proves a
      // sport, so the caller's default is what should decide it.
      expect(inferSportFromTitle("2024 Some Set Flames Insert #12", "")).toBe("");
      expect(inferSportFromTitle("2024 Some Set Wild Insert #12", "")).toBe("");
    });

    it("MLB Washington Senators are not the Ottawa Senators", () => {
      expect(inferSportFromTitle("1940 Play Ball #22 Sammy West - Washington Senators (vA1) RARE & VINTAGE! - Raw", ""))
        .not.toBe("hockey");
    });
    it("NFL Houston Oilers are not the Edmonton Oilers", () => {
      expect(inferSportFromTitle("1990 Pro Set #352 Bruce Matthews PB Oilers - Raw", ""))
        .not.toBe("hockey");
    });
    it("'Name in All Caps' is not the Washington Capitals", () => {
      expect(inferSportFromTitle("1939 Play Ball - Joe DiMaggio #26 Name in All Caps PSA Graded 1.5 PSA 1.5"))
        .toBe("baseball");
    });
  });

  describe("non-sport detector: card-title words removed", () => {
    it("'WOW' seller hype is not World of Warcraft", () => {
      expect(inferSportFromTitle("1997 Bowman's Best REFRACTOR #73 Barry Bonds SF Giants RARE ICONIC PARALLEL WOW - Raw"))
        .toBe("baseball");
    });
    it("'Halo' foil treatment is not the Halo franchise", () => {
      expect(inferSportFromTitle("2025 Topps Stadium Club Mike Trout #32 Los Angeles Angles Star Power Halo Photo", ""))
        .not.toBe("non-sport");
    });
    it("spelled-out 'World of Warcraft' still detected", () => {
      expect(inferSportFromTitle("2007 World of Warcraft TCG Landro Longshot Loot Card"))
        .toBe("non-sport");
    });
    it("'Diamond Marvels' (Donruss baseball insert) is not Marvel", () => {
      expect(inferSportFromTitle("2026 Panini Donruss Nick Kurtz Diamond Marvels #6 A's", ""))
        .not.toBe("non-sport");
    });
  });
});

// CF-PLAYER-SPORT-HINTS (Drew, 2026-07-29). Last-resort player→sport
// disambiguation: title carries neither team nor league keyword —
// only the player name. Full-name matches only.
describe("inferSportFromTitle — player-name fallback (by sport)", () => {
  describe("football players", () => {
    it("'Justin Herbert' (no team, no NFL) → football", () => {
      expect(inferSportFromTitle("Justin Herbert 2020 Panini Stained Glass Prizm #18"))
        .toBe("football");
    });
    it("'Patrick Mahomes' → football", () => {
      expect(inferSportFromTitle("Patrick Mahomes 2020 Panini Prizm"))
        .toBe("football");
    });
    it("'Ja'Marr Chase' → football (apostrophe variants)", () => {
      expect(inferSportFromTitle("Ja'Marr Chase Rookie Card"))
        .toBe("football");
    });
    it("Tom Brady EXCLUDED — MLB Expos draft cards exist", () => {
      // Brady was drafted by the Expos in '95 and has Bowman Draft
      // baseball cards. Two-sport → no default (stays fallback).
      expect(inferSportFromTitle("Tom Brady Bowman Draft 1995 Expos", "baseball"))
        .toBe("baseball");
    });
  });

  describe("basketball players", () => {
    it("'LeBron James' → basketball", () => {
      expect(inferSportFromTitle("LeBron James 2003 Topps Chrome"))
        .toBe("basketball");
    });
    it("'Victor Wembanyama' → basketball", () => {
      expect(inferSportFromTitle("Victor Wembanyama 2023 Rookie"))
        .toBe("basketball");
    });
    it("'Steph Curry' → basketball", () => {
      expect(inferSportFromTitle("Steph Curry 2009 Topps"))
        .toBe("basketball");
    });
    it("'Kobe Bryant' → basketball", () => {
      expect(inferSportFromTitle("Kobe Bryant 1996 Topps Chrome"))
        .toBe("basketball");
    });
  });

  describe("hockey players", () => {
    it("'Connor McDavid' → hockey", () => {
      expect(inferSportFromTitle("Connor McDavid 2015 Upper Deck Rookie"))
        .toBe("hockey");
    });
    it("'Wayne Gretzky' → hockey", () => {
      expect(inferSportFromTitle("Wayne Gretzky 1979 O-Pee-Chee"))
        .toBe("hockey");
    });
    it("'Connor Bedard' → hockey", () => {
      expect(inferSportFromTitle("Connor Bedard 2023 Upper Deck Young Guns"))
        .toBe("hockey");
    });
  });

  describe("baseball players (would already hit fallback, but explicit is safer)", () => {
    it("'Shohei Ohtani' → baseball", () => {
      expect(inferSportFromTitle("Shohei Ohtani 2018 Topps Chrome", "football"))
        .toBe("baseball");
    });
    it("'Eric Hartman' → baseball (curated Drew personal roster)", () => {
      expect(inferSportFromTitle("Eric Hartman 2025 Bowman Chrome", "football"))
        .toBe("baseball");
    });
  });

  describe("guardrails", () => {
    it("last-name only ('Herbert') does NOT match — first name required", () => {
      // 'Herbert' alone appears in multiple sports (e.g. Herbert perry MLB).
      // Only full-name matches are safe.
      expect(inferSportFromTitle("Herbert 2020 Bowman Chrome", "baseball"))
        .toBe("baseball");
    });
    it("Deion Sanders (two-sport NFL+MLB) does NOT match", () => {
      // Deion played for Yankees/Braves/Reds/Giants. No correct default.
      expect(inferSportFromTitle("Deion Sanders 1989 Bowman Rookie", "baseball"))
        .toBe("baseball");
    });
    it("Bill Russell alone does NOT match (NBA legend + MLB Dodgers namesake)", () => {
      expect(inferSportFromTitle("Bill Russell 1970 Topps", "baseball"))
        .toBe("baseball");
    });
    it("Michael Jordan alone does NOT match (NBA + 1994-95 Barons baseball cards)", () => {
      expect(inferSportFromTitle("Michael Jordan 1994 Upper Deck Rookie", "baseball"))
        .toBe("baseball");
    });
    it("explicit sport keyword still wins over player hint", () => {
      // "basketball" keyword fires FIRST, before we ever reach the
      // player-name pass. Cross-sport player-name mismatches (which
      // shouldn't happen in practice) always defer to the keyword.
      expect(inferSportFromTitle("Michael Jordan 1994 basketball fantasy", "football"))
        .toBe("basketball");
    });
    it("no player match falls through to caller fallback", () => {
      expect(inferSportFromTitle("Some Random 2020 Card", "baseball"))
        .toBe("baseball");
    });
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

// CF-SERIAL-IS-NOT-A-CARDNUMBER (Drew, 2026-08-14: "fix it").
//
// The TCG `POS/TOTAL` rule had no vertical guard, so it fired on sports titles
// and turned SERIALS into card numbers. Every title below is a real one taken
// from comps_staging rows that were stuck in awaiting-catalog because of it.
//
// Verified before the fix: 206 of 208 decided cases were this bug, ~6,500
// distinct slugs, ~32,000 stuck sales, ~5,600 phantom cards in sold_comps.
describe("serial is not a card number", () => {
  // ─── sports: N/M is a SERIAL, never the card number ──────────────────────
  it("does not take a sports serial as the card number", () => {
    const r = parseListingIdentity("2025-26 Fleer Ultra Outlining Macklin Celebrini OL 22/30 Color Match Sharks");
    // Was "22/30" -> slug ...:2230:... which no checklist can contain.
    expect(r.cardNumber).not.toBe("22/30");
    expect(r.printRun).toBe(30);
  });

  it("reads the serial as print run only, on a real blocked title", () => {
    const r = parseListingIdentity("Josue De Paula 2025 Topps Pro Debut Gold AUTO 25/50 LA Dodgers");
    expect(r.cardNumber).not.toBe("25/50");
    expect(r.printRun).toBe(50);
  });

  it("prefers an explicit #cardNumber over the serial in the same title", () => {
    const r = parseListingIdentity("Tai PEETE 2024 Topps Pro Debut GREEN FOIL #TP-9 #'d 88/99 RC");
    expect(r.cardNumber).toBe("TP-9");
    expect(r.printRun).toBe(99);
  });

  it("an explicit vertical suppresses the TCG rule even when TCG-ish", () => {
    const r = parseListingIdentity("Some Player 40/147", undefined, { vertical: "baseball" });
    expect(r.cardNumber).not.toBe("40/147");
  });

  // ─── TCG: N/M IS the card number, and M is a SET SIZE not a print run ────
  it("keeps the TCG card number when the title names the vertical", () => {
    const r = parseListingIdentity("Pikachu Common SM - Burning Shadows 40/147 NM Pokemon");
    expect(r.cardNumber).toBe("40/147");
    // 147 is the set size. Burning Shadows was not a 147-copy print run.
    expect(r.printRun).toBeNull();
  });

  it("keeps the TCG card number via an explicit vertical", () => {
    const r = parseListingIdentity("PIKACHU EX MEGA DREAM EX HOLO DOUBLE RARE 044/193 CGC 10", undefined, { vertical: "pokemon" });
    expect(r.cardNumber).toBe("044/193");
    expect(r.printRun).toBeNull();
  });

  // CF-TCG-NUMBER-BEFORE-HASH. The VERBATIM listing title — the version above
  // had its "#" removed when the test was written, which is exactly why it
  // passed while the real input failed. Sellers write both forms, and on the
  // "#" form the generic #-prefix rule used to win and return "044",
  // silently dropping "/193" — a different card number, matching nothing.
  it("keeps the TCG card number when it is written with a # prefix", () => {
    const r = parseListingIdentity("PIKACHU EX 2025 POKEMON JAPANESE MEGA DREAM EX HOLO DOUBLE RARE #044/193 CGC 10");
    expect(r.cardNumber).toBe("044/193");
    expect(r.printRun).toBeNull();
  });

  it("a bare #NNN TCG number with no set total is still read as-is", () => {
    // "#072" with no "/total" is a real card number, not a truncated one.
    const r = parseListingIdentity("2021 POKEMON SWORD & SHIELD SHINING FATES #072 FULL ART/SKYLA PSA 10");
    expect(r.cardNumber).toBe("072");
  });

  it("a secret rare numbered above set size still parses", () => {
    const r = parseListingIdentity("Charizard VMAX 294/217 Pokemon Secret Rare");
    expect(r.cardNumber).toBe("294/217");
    expect(r.printRun).toBeNull();
  });

  it("a genuinely numbered TCG parallel still reports its print run", () => {
    // The set-size token is removed, not the whole print-run search — so an
    // actual serial elsewhere in the title survives.
    const r = parseListingIdentity("Pokemon Burning Shadows Pikachu 40/147 Gold Parallel /25", undefined, { vertical: "pokemon" });
    expect(r.cardNumber).toBe("40/147");
    expect(r.printRun).toBe(25);
  });

  // ─── the existing contract must not move ─────────────────────────────────
  it("sports print-run extraction is unchanged", () => {
    expect(parseListingIdentity("2026 Bowman Chrome Sapphire Owen Carey 77/199 Braves").printRun).toBe(199);
    expect(parseListingIdentity("Owen Carey 2026 Red Sapphire Auto 3/5 Atlanta Braves").printRun).toBe(5);
    expect(parseListingIdentity("2026 Bowman Chrome Eric Hartman Gold Refractor /50 Braves").printRun).toBe(50);
  });

  it("sports card numbers are unchanged", () => {
    expect(parseListingIdentity("2026 Bowman Eric Hartman Base Auto #CPA-EHA").cardNumber).toBe("CPA-EHA");
    expect(parseListingIdentity("2025 Topps Black & White - Freddie Freeman #020").cardNumber).toBe("020");
  });
});

// CF-A-GRADE-IS-NOT-A-CARD-NUMBER + CF-GAME-USED-IS-NOT-A-SKU (Drew,
// 2026-08-24). Both found by dry-running the sales resolver over 1955/1972/2001
// and reading the rows it proposed to create, rather than by a failing test.
// Every title below is verbatim from sold_comps.
describe("card number extraction rejects grades, years and relic phrases", () => {
  it("does not read a grading company's grade as the card number", () => {
    // The damage was per-grade card splitting: one Wilt Chamberlain became
    // cards #7, #8, #9 and #10, each with its own comp pool.
    expect(parseListingIdentity("1972 Icee Bear Set Break Wilt Chamberlain PSA 9 MINT").cardNumber).toBeNull();
    expect(parseListingIdentity("1972 Icee Bear Basketball Wilt Chamberlain SGC 8 NM-MT").cardNumber).toBeNull();
    expect(parseListingIdentity("1972 Icee Bear Wilt Chamberlain PSA 7 NM").cardNumber).toBeNull();
    expect(parseListingIdentity("1972 NFLPA IRON ONS TERRY BRADSHAW PSA 9 MINT PITTSBURGH STEELERS LOW POP RARE").cardNumber).toBeNull();
  });

  it("does not read the set year or the grade as the card number", () => {
    // CF-A-GRADE-IS-NOT-A-CARD-NUMBER's original witness. What this test exists
    // to prevent is reading the GRADE ("CGC 10" -> card #10), which split one
    // Entei into a card per grade. It asserted null because null was the best
    // answer the parser could give in 2026-08 -- not because this card has no
    // number.
    //
    // CF-A-POKEMON-CARD-STATES-ITS-NUMBER-BARE (2026-09-05) reads it: "34" is
    // the promo number, stated plainly in "Black Star Movie Promo 34". The
    // catalog agrees -- card_catalog holds Entei rows at cardNumber "34" for
    // 2001 (`hiq:pokemon:2001:2001-pokemon-game-movie:34:reverse-foil:...`,
    // source ingest-auto-seed-graded), read 2026-09-05.
    //
    // So the assertion moves to what was always the real invariant: NOT the
    // grade and NOT the year. Weakening the parser back to null to keep a green
    // test would be preserving a parse failure as if it were a ruling.
    const got = parseListingIdentity("CGC 10 GEM MINT Entei 2001 Black Star Movie Promo 34 Reverse Holo Pokemon Card");
    expect(got.cardNumber).not.toBe("10");     // the grade
    expect(got.cardNumber).not.toBe("2001");   // the year
    expect(got.cardNumber).toBe("34");         // the promo number the title states
  });

  it("does not read a relic phrase as a prefixed card number", () => {
    expect(parseListingIdentity("2001 Fleer Legacy TROY GLAUS Hit Kings Game-Used Bat Relic Anaheim Angels - Raw 10").cardNumber).toBeNull();
    expect(parseListingIdentity("2001 Fleer Legacy Barry Bonds San Francisco Giants Tailor Made Game-Worn Swatch - Raw 10").cardNumber).toBeNull();
    expect(parseListingIdentity("Chipper Jones Game-Worn Jersey 2001 Fleer Material Issue Pinstripe Atlanta Brave - Raw 10").cardNumber).toBeNull();
  });

  it("still reads the real card numbers these guards sit next to", () => {
    // The guards must not cost us the cases the standalone/prefixed rules exist for.
    expect(parseListingIdentity("2023 PANINI SELECT GOLD GLITTER JALEN BRUNSON 194 PSA 10").cardNumber).toBe("194");
    expect(parseListingIdentity("2025 Bowman Draft CPA-EW Eli Willits Yellow Refractor").cardNumber).toBe("CPA-EW");
    expect(parseListingIdentity("2025 Topps Stars of MLB SMLB-10 Shohei Ohtani").cardNumber).toBe("SMLB-10");
    expect(parseListingIdentity("1955 Parkhurst Syl Apps #28 PSA 2 GD").cardNumber).toBe("28");
    expect(parseListingIdentity("1955 Red Man Tobacco #22 Hank Bauer Sports Trading Card  - Raw 10").cardNumber).toBe("22");
  });
});

// Second round, from re-running the same dry run after the first fix: the
// condition VOCABULARY is the family, not the individual compounds.
describe("condition compounds are never card numbers", () => {
  it("rejects hyphenated condition grades printed in caps", () => {
    expect(parseListingIdentity("1972 ICEE BEAR DENNIS AWTREY 76ERS NR-MT 498104 (KYCARDS) - Raw 10").cardNumber).toBeNull();
    expect(parseListingIdentity("1972 MILTON BRADLEY  John Hiller  DETROIT TIGERS  NM-MINT  A - Raw 10").cardNumber).toBeNull();
  });

  it("does not read the numeric grade that follows a condition word", () => {
    // "PSA EX-MT 6" -- the grader check alone missed this, because the token
    // immediately before the 6 is the condition, not the grading company.
    expect(parseListingIdentity("1972 Comspec Bob Lanier PSA EX-MT 6").cardNumber).toBeNull();
  });
});
