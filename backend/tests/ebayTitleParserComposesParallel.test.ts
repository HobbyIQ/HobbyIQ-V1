// CF-THE-TITLE-COMPOSES-ITS-FINISH (2026-08-29). The parallel is the
// composed, most specific finish the title names, in the pool's spelling.
// The one-token parser listed "refractor" before every colour, so the Marconi
// German title below parsed as bare "Refractor" — the Gold was lost and the
// ingest seam and the pool repair each had to grow a "refinement" rule.
import { describe, it, expect } from "vitest";
import { parseListingTitle } from "../src/services/portfolioiq/ebayTitleParser.service";

describe("parseListingTitle composes the finish the title names", () => {
  it("the Marconi German title: Gold Refractor, not Refractor — and the /50 is read", () => {
    const p = parseListingTitle("2026 Bowman Marconi German Chrome Auto Gold Refractor 1st #/50 Nationals");
    expect(p.parallel).toBe("Gold Refractor");
    expect(p.printRun).toBe(50);
    expect(p.isAuto).toBe(true);
    expect(p.playerName).toBe("Marconi German");
  });

  it("colour + family: Blue Refractor /150", () => {
    const p = parseListingTitle("2024 Bowman Chrome Konnor Griffin Blue Refractor /150");
    expect(p.parallel).toBe("Blue Refractor");
    expect(p.printRun).toBe(150);
    expect(p.playerName).toBe("Konnor Griffin");
  });

  it("a colour in the Sapphire line is a <Colour> Sapphire", () => {
    const p = parseListingTitle("2023 Topps Chrome Sapphire Edition #123 Green /99");
    expect(p.parallel).toBe("Green Sapphire");
    expect(p.printRun).toBe(99);
    expect(p.cardNumber).toBe("123");
  });

  it("colour + pattern + family keeps the title's order: Purple Shimmer Refractor 88/250", () => {
    const p = parseListingTitle("2022 Bowman Chrome 1st Cristhian Vaquero Auto Purple Shimmer Refractor 88/250");
    expect(p.parallel).toBe("Purple Shimmer Refractor");
    expect(p.printRun).toBe(250);
    expect(p.playerName).toBe("Cristhian Vaquero");
  });

  it("Prizm is a family only with a modifier: Silver Prizm, never bare Prizm", () => {
    expect(parseListingTitle("Panini Prizm Silver Prizm #12").parallel).toBe("Silver Prizm");
    expect(parseListingTitle("2020 Panini Prizm Mookie Betts #275 PSA 10 GEM MINT").parallel).toBeNull();
  });

  it("a family with no colour stays the family, in the pool's spelling", () => {
    expect(parseListingTitle("Topps Chrome X-Fractor #217").parallel).toBe("X-Fractor");
    expect(parseListingTitle("2026 Bowman Chrome Xfractor Owen Carey").parallel).toBe("X-Fractor");
    expect(parseListingTitle("2024 Bowman Chrome Refractor Eric Hartman #BCP-102").parallel).toBe("Refractor");
    expect(parseListingTitle("2024 Topps Chrome Logofractor Future Stars Auto /99").parallel).toBe("Logofractor");
    expect(parseListingTitle("2024 Bowman Chrome Superfractor 1/1 Auto Owen Carey").parallel).toBe("SuperFractor");
  });

  it("a base auto that names no finish is null, and stays null with a card number", () => {
    const p = parseListingTitle("2026 Bowman Marconi German Chrome Auto 1st Prospect #CPA-MG");
    expect(p.parallel).toBeNull();
    expect(p.printRun).toBeNull();
    expect(p.isAuto).toBe(true);
  });

  it("Gold Rainbow Foil /2025 — pattern before the family, and a four-digit run", () => {
    const p = parseListingTitle("2025 Topps Series 1 Aaron Judge Gold Rainbow Foil /2025 #99");
    expect(p.parallel).toBe("Gold Rainbow Foil");
    expect(p.printRun).toBe(2025);
  });

  it("a bare colour stays bare — the canonicalizer applies Colour ≡ Refractor per product", () => {
    const p = parseListingTitle("2026 Bowman Chrome Gold Baseball Owen Carey #CPA-OC /50");
    expect(p.parallel).toBe("Gold");
    expect(p.printRun).toBe(50);
  });

  it("the title's own modifier order is a real name and is kept", () => {
    expect(parseListingTitle("2026 Bowman Chrome Reptilian Green Refractor Eric Hartman").parallel).toBe("Reptilian Green Refractor");
    expect(parseListingTitle("2026 Bowman Chrome Green Shimmer Refractor Eric Hartman").parallel).toBe("Green Shimmer Refractor");
    expect(parseListingTitle("2025 Bowman Chrome Purple RayWave Refractor #BCP-1").parallel).toBe("Purple RayWave Refractor");
    expect(parseListingTitle("2025 Bowman Chrome Blue Ray Wave Refractor #BCP-1").parallel).toBe("Blue RayWave Refractor");
    expect(parseListingTitle("2024 Bowman Draft Devin Taylor Gold Wave Refractor /50").parallel).toBe("Gold Wave Refractor");
  });

  it("multi-word tokens are one token: Cracked Ice, Sky Blue", () => {
    expect(parseListingTitle("2023 Panini Contenders Cracked Ice Auto #12").parallel).toBe("Cracked Ice");
    expect(parseListingTitle("2024 Panini Prizm Red Cracked Ice Prizm #12").parallel).toBe("Red Cracked Ice Prizm");
    expect(parseListingTitle("2026 Bowman Sky Blue Refractor Owen Carey /499").parallel).toBe("Sky Blue Refractor");
  });

  it("Sapphire: colour-first, Padparadscha, and a refractor rung; bare Sapphire is the product", () => {
    expect(parseListingTitle("2025 Bowman Chrome Sapphire Padparadscha Owen Carey").parallel).toBe("Padparadscha Sapphire");
    expect(parseListingTitle("2025 Bowman Chrome Sapphire Owen Carey Orange Sapphire Refractor /25").parallel).toBe("Orange Sapphire Refractor");
    expect(parseListingTitle("2025 Bowman Chrome Sapphire Owen Carey #BSPA-OC").parallel).toBeNull();
    expect(parseListingTitle("2025 Bowman Chrome Sapphire Refractor Owen Carey").parallel).toBe("Refractor");
  });

  it("Printing Plate is the one family spelled colour-last", () => {
    const p = parseListingTitle("2024 Topps Chrome Owen Carey Black Printing Plate 1/1 #12");
    expect(p.parallel).toBe("Printing Plate Black");
    expect(p.printRun).toBe(1);
    // "Topps Chrome Black" is a PRODUCT; its name does not colour a plate.
    expect(parseListingTitle("2024 Topps Chrome Black Owen Carey Printing Plate Cyan 1/1").parallel).toBe("Printing Plate Cyan");
  });

  it("True <Colour> is <Colour> Refractor (glossary §1), in either order", () => {
    expect(parseListingTitle("2026 Bowman Owen Carey True Blue #CPA-OC").parallel).toBe("Blue Refractor");
    expect(parseListingTitle("2026 Bowman Blue Eric Hartman True #CPA-EHA").parallel).toBe("Blue Refractor");
    expect(parseListingTitle("2026 Bowman Chrome True Blue Shimmer Refractor").parallel).toBe("Blue Shimmer Refractor");
  });

  it("'Ref' is Refractor", () => {
    expect(parseListingTitle("2025 Bowman Draft Chrome Max Williams 1/50 1st Auto Gold Ref. #CPA-MWI PSA 9").parallel).toBe("Gold Refractor");
  });

  it("a team's colour is not a finish", () => {
    expect(parseListingTitle("2024 Topps Chrome Vladimir Guerrero Jr. Blue Jays Refractor #100").parallel).toBe("Refractor");
    expect(parseListingTitle("2024 Topps Chrome Rafael Devers Red Sox #50").parallel).toBeNull();
  });

  it("finish words never leak into the player name", () => {
    expect(parseListingTitle("2026 Bowman Chrome Gold Wave Refractor Owen Carey /50").playerName).toBe("Owen Carey");
  });
});

describe("parseListingTitle reads the print run", () => {
  it("every stated form", () => {
    expect(parseListingTitle("2026 Bowman Chrome Owen Carey Gold Refractor #/50").printRun).toBe(50);
    expect(parseListingTitle("2026 Bowman Chrome Owen Carey Gold Refractor /50").printRun).toBe(50);
    expect(parseListingTitle("2026 Bowman Chrome Owen Carey Gold Refractor 50/50").printRun).toBe(50);
    expect(parseListingTitle("2026 Bowman Chrome Owen Carey Gold Refractor #'d /50").printRun).toBe(50);
    expect(parseListingTitle("2026 Bowman Chrome Owen Carey Gold Refractor numbered to 50").printRun).toBe(50);
    expect(parseListingTitle("2026 Bowman Chrome Owen Carey Superfractor 1/1").printRun).toBe(1);
    expect(parseListingTitle("2026 Bowman Chrome Owen Carey Superfractor one of one").printRun).toBe(1);
  });

  it("a grade written as a fraction is not a print run, and a real serial beside it still is", () => {
    expect(parseListingTitle("2024 Bowman Chrome Leo De Vries #CPA-LD PSA 10/9").printRun).toBeNull();
    expect(parseListingTitle("2024 Bowman Chrome Leo De Vries PSA 9/10 Blue Refractor /150").printRun).toBe(150);
    expect(parseListingTitle("2024 Bowman Chrome Leo De Vries Gold Refractor PSA 10 /50").printRun).toBe(50);
  });

  it("a season, a year, or a copy number above its run is not a serial", () => {
    expect(parseListingTitle("2024/25 Upper Deck Connor Bedard #200").printRun).toBeNull();
    expect(parseListingTitle("2020 Topps Chrome Bobby Witt Jr. #150 PSA 10").printRun).toBeNull();
  });

  it("the existing 'Numbered' fallback is untouched", () => {
    const p = parseListingTitle("2020 Topps Chrome Bobby Witt Jr. /150 PSA 10");
    expect(p.parallel).toBe("Numbered");
    expect(p.printRun).toBe(150);
  });
});
