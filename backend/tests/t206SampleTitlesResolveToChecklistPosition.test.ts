// CF-T206-NAME-TO-POSITION (Drew, "fix all of baseball now", 2026-09-28).
//
// Table-driven regression over REAL sale titles pulled from the read-only
// probe's samples.csv (C:/tmp/t206probe_1430/samples.csv, 4,000-row sample
// of the 41,682 unbacked T206 sales). Each `residue` below is the subject
// string as it survives stripT206BackBrand on that real title (verified by
// hand against the checklist fixture); `expectedPosition` is the checklist
// row this sale SHOULD land on, taken from
// backend/data/checklists/t206/1909-11-t206-baseball.positions.json (the
// same 524-row sportscardchecklist excerpt the catalog's own 550 rows are
// keyed from).
//
// This is the end-to-end pin: computeHobbyIqCardId itself, not just the
// resolver in isolation, so a wiring regression between the two functions
// is caught here too.

import { describe, it, expect } from "vitest";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

function t206Id(playerName: string): string {
  return computeHobbyIqCardId({
    sport: "baseball", year: 1909, setKey: "1909-11 T206 Baseball",
    cardNumber: "NNO", parallel: "Base", isAuto: false, playerName,
  });
}

// [sourceTitle, residueAsExtractedFromTitle, expectedChecklistPosition]
const RESOLVING_CASES: Array<[string, string, number]> = [
  ["1909-11 T206 Fred Abbott Sweet Caporal 350/30 SGC 3", "Fred Abbott", 3],
  ["1909-11 T206 Sweet Caporal 350/30 Fred Abbott VG-EX PSA 4", "Fred Abbott", 3],
  ["1909-11 T206 SWEET CAPORAL 150/25 ED CICOTTE PSA 1 102461688", "Ed Cicotte", 88],
  ["1909-11 T206 ED CICOTTE BOSTON RED SOX PIEDMONT 350/25 SGC 2.5 GD+ NICE CARD!", "Ed Cicotte", 88],
  ["1909-11 T206 WHITE BORDER PETER CASSIDY PIEDMONT 350 BALTIMORE ML - SGC 2.5 GD+", "Peter Cassidy", 76],
  ["T206 Eddie Collins HOF ~~ SGC 2 SHARP ~~ Old Mill rare back", "Eddie Collins", 100],
  ["1909-11 T206 - George Schirm - Sweet Caporal 350/30 - POP 6 - PSA 3 VG", "George Schirm", 422],
  ["1909-11 T206 Set-Break Charlie Starr Piedmont PSA 7 NM (MK)", "Charlie Starr", 461],
  ["1909-11 T206 Set-Break Charlie Starr Piedmont LOW GRADE (filler) *GMCARDS* - Raw", "Charlie Starr", 461],
  ["T206 Piedmont 150: ED HAHN Chicago ~ Centered - Raw", "Ed Hahn", 199],
  ["1909-11 T206 SWEET CAPORAL 350/25 ED HAHN PSA 5 102461808", "Ed Hahn", 199],
  ["1909-11 T206 PSA 4 Ed Hahn - Piedmont 150 -Beautiful 4!", "Ed Hahn", 199],
  ["1909 T206 PSA 2 Jimmy Williams Piedmont 150 Back Just Graded", "Jimmy Williams", 511],
  ["T206  Jimmy Williams White border, Piedmont 150 PSA PR 1 ST Louis", "Jimmy Williams", 511],
  ["1909-11 T206 Baseball #512 Jimmy Williams Sovereign PR - Raw 10", "Jimmy Williams", 511],
  ["1909-11 T206 JACK WHITE Buffalo OLD MILL - Raw", "Jack White", 506],
  ["T206 Art Fletcher 1910 Piedmont Cigarettes 350 SGC 5.5 EX+ New York", "Art Fletcher", 174],
  ["1909-11 T206 - Southern League (SL) - Gordon Hickman - Piedmont 350 - PSA 1", "Gordon Hickman", 211],
  ["1909-11 T206 Jerry Freeman POLAR BEAR PSA 2 GD", "Jerry Freeman", 178],
  ["1909-11 T206 Set-Break Bill Lattimore Polar Bear LOW GRADE (filler) *GMCARDS* - Raw", "Bill Lattimore", 276],
  ["1909-11 T206 PIEDMONT 150 ED WALSH PSA 3", "Ed Walsh", 498],
  ["T206 Piedmont 150: MICKEY DOOLIN Portrait, Philadelphia Phillies ~ POOR mk  - Raw 10", "Mickey Doolin Portrait", 139],
  ["1909-11 T206 Piedmont 150 Mickey Doolin Portrait Crease Upper Right GD LOOK! - Raw 10", "Mickey Doolin Portrait", 139],
  ["1909-11 T206 Jean Dubuc Piedmont 350 SGC 1.5", "Jean Dubuc", 151],
  ["1909-11 T206 JEAN DUBUC PIEDMONT 350 PSA 5 EX", "Jean Dubuc", 151],
  ["T206 Piedmont 350 Tris Speaker PSA VG-EX 4 PSA 4", "Tris Speaker", 455],
  ["1909-11 T206 TRIS SPEAKER PIEDMONT 350 PSA 2.5 HOF RC ROOKIE CENTERED", "Tris Speaker", 455],
  ["1909-11 T206 - Tris Speaker Piedmont 350 PSA AUTHENTIC VIVID COLORS BEAUTIFUL", "Tris Speaker", 455],
  ["Clyde Milan 1909 T206 Sweet Caporal 350/25 PSA 3 (VG) Baseball Card", "Clyde Milan", 333],
  ["T206 Sweet Caporal 350/25 Clyde Milan SGC 6 - Washington - centered", "Clyde Milan", 333],
  ["1909 SWEET CAPORAL 350/25 T206 PADDY LIVINGSTONE ATHLETICS BASEBALL CARD SGC 5.5", "Paddy Livingstone", 287],
  ["1909-11 T206 Sweet Caporal 350/25 Jimmy Slagle PSA 5 Baltimore POP 2 ONLY 2 High", "Jimmy Slagle", 444],
  // Multi-pose players whose sale title actually states the disambiguating
  // pose word (unlike the mangled stored player-<slug> segments this fix
  // is repairing, an intact playerName extraction keeps the pose).
  ["T206 CY SEYMOUR - 'Batting' - NEW YORK GIANTS - PIEDMONT 150 - Raw 10", "Cy Seymour Batting", 434],
  ["1909-11 T206 White Border Cy Seymour, Batting - Sweet Caporal 150/30 - PSA 3", "Cy Seymour Batting", 434],
  ["1909-11 T206 White Border Christy Mathewson, Portrait - Sweet Caporal 150/30 - PSA 3.5", "Christy Mathewson Portrait", 306],
  ["TY COBB PSA 2 1909-11 T206 OLD MILL BACK RED PORTRAIT TIGERS", "Ty Cobb Red Portrait", 96],
  ["1909-11 T206 TY COBB TIGERS RED PORTRAIT PSA 4 VG-EX OLD MILL 511060 SET BREAK", "Ty Cobb Red Portrait", 96],
];

describe("T206 real sample titles resolve to the checklist's numeric position", () => {
  it(`covers ${RESOLVING_CASES.length} real titles (>= 30 required)`, () => {
    expect(RESOLVING_CASES.length).toBeGreaterThanOrEqual(30);
  });

  for (const [sourceTitle, residue, expectedPosition] of RESOLVING_CASES) {
    it(`"${sourceTitle}" -> position ${expectedPosition}`, () => {
      expect(t206Id(residue)).toBe(`hiq:baseball:1909:t206:${expectedPosition}:base:no-auto`);
    });
  }

  it("multi-pose players WITHOUT a stated pose stay on player-<slug> — never a guess", () => {
    // Same players as the resolving Cy Seymour/Cobb/Mathewson cases above,
    // but with the pose dropped -- exactly what the OLD parser produced
    // (measured live: stored Ty Cobb rows carry no pose text at all).
    expect(t206Id("Ty Cobb")).toBe("hiq:baseball:1909:t206:player-ty-cobb:base:no-auto");
    expect(t206Id("Christy Mathewson")).toBe("hiq:baseball:1909:t206:player-christy-mathewson:base:no-auto");
    expect(t206Id("Cy Seymour")).toBe("hiq:baseball:1909:t206:player-cy-seymour:base:no-auto");
  });
});
