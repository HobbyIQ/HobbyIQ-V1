import { describe, it, expect } from "vitest";
import { decideFinestSport, titleNamesPlayer, withSport, gradeParentOf, isFabricatedPrintRun, isSmearedCardNumber } from "../src/services/catalog/finestSportConflationRule";

/**
 * REFUTATION PROBE 4 -- drive Canseco and Shaq BOTH ways, and mutation-test
 * the guards: does each guard actually STOP something, and does removing it
 * change a verdict?
 */
describe("Canseco / Shaq both ways", () => {
  it("a real Canseco baseball title stays baseball", () => {
    const v = decideFinestSport("1993 Topps Finest Jose Canseco #99 Baseball Texas Rangers");
    expect(v).toMatchObject({ decided: true, sport: "baseball" });
  });

  it("a real Shaq basketball title goes basketball", () => {
    const v = decideFinestSport("1993-94 Topps Finest Shaquille O'Neal #99 Refractor Magic");
    expect(v).toMatchObject({ decided: true, sport: "basketball" });
  });

  it("A CANSECO TITLE THAT MENTIONS THE 1993-94 SEASON IS REFUSED, not moved", () => {
    // The dangerous direction: a baseball card whose listing carries the
    // basketball season form. Must NOT become basketball.
    const v = decideFinestSport("1993-94 Topps Finest Jose Canseco #99 Baseball");
    expect(v.decided).toBe(false);
  });

  it("a Canseco title with NO sport word and NO season form is left alone", () => {
    const v = decideFinestSport("Topps Finest Jose Canseco #99");
    expect(v).toMatchObject({ decided: false, reason: "no-evidence" });
  });

  it("BARE '1993' IS NOT EVIDENCE OF BASEBALL -- a Shaq listing omitting the season is left alone", () => {
    const v = decideFinestSport("1993 Topps Finest Shaquille O'Neal #99 Refractor");
    // No sport word, no 1993-94 form -> undecided. It does NOT get called baseball.
    expect(v.decided).toBe(false);
  });
});

describe("guard mutation: does each guard stop something real?", () => {
  it("HOCKEY TEAM guard: Mats Sundin would become basketball without it", () => {
    const sundin = "1993-94 Topps Finest Mats Sundin #110 Toronto Maple Leafs Unpeeled";
    // With the guard:
    expect(decideFinestSport(sundin)).toMatchObject({ decided: false, reason: "names-other-sport" });
    // Mutation: strip the club word, leaving only the season form.
    const withoutClub = sundin.replace(/Toronto Maple Leafs/i, "Toronto");
    expect(decideFinestSport(withoutClub)).toMatchObject({ decided: true, sport: "basketball" });
    // -> the guard is load-bearing; removing the club name flips the verdict.
  });

  it("SIGNALS-DISAGREE guard: the BASEBALL...BULLS typo is refused", () => {
    const v = decideFinestSport("MICHAEL JORDAN PSA 10 1993-94 TOPPS FINEST BASEBALL #1 BULLS");
    expect(v).toMatchObject({ decided: false, reason: "signals-disagree" });
  });

  it("ANCHOR guard: a price like 1993-9400 must not read as a season", () => {
    const v = decideFinestSport("Topps Finest lot 1993-9400 Jose Canseco #99");
    expect(v.decided).toBe(false);
  });

  it("titleNamesPlayer: a bare surname never matches", () => {
    expect(titleNamesPlayer("1993-94 topps finest johnson #143", "avery johnson")).toBe(false);
    expect(titleNamesPlayer("1993-94 topps finest avery johnson #143", "avery johnson")).toBe(true);
    // Eddie Johnson (NBA) must not be matched by an Ervin Johnson title.
    expect(titleNamesPlayer("1993-94 topps finest ervin johnson #71", "eddie johnson")).toBe(false);
  });

  it("titleNamesPlayer: the O'Neal ingest casualty still meets its title", () => {
    expect(titleNamesPlayer("1993-94 topps finest shaquille oneal #3", "Shaquille 'neal")).toBe(true);
  });
});

describe("guard mutation: the plural / parallel collapse the orchestrator asked about", () => {
  it("withSport touches ONLY segment 1 -- Refractors vs Refractor is untouched", () => {
    const a = "hiq:baseball:1993:topps-finest:162:refractor:no-auto";
    expect(withSport(a, "basketball")).toBe("hiq:basketball:1993:topps-finest:162:refractor:no-auto");
    // a numbered sibling keeps its num- segment
    const b = "hiq:baseball:1993:topps-finest:1927:base:no-auto:num-27";
    expect(withSport(b, "basketball")).toBe("hiq:basketball:1993:topps-finest:1927:base:no-auto:num-27");
  });

  it("gradeParentOf does not eat a num- segment", () => {
    const numbered = "hiq:baseball:1993:topps-finest:99:refractor:no-auto:num-241";
    expect(gradeParentOf(numbered)).toBe(numbered);
    const graded = "hiq:baseball:1993:topps-finest:99:refractor:no-auto:psa-8";
    expect(gradeParentOf(graded)).toBe("hiq:baseball:1993:topps-finest:99:refractor:no-auto");
  });
});

describe("pass C guards", () => {
  it("only /241 is blanked; a real neighbouring run is not", () => {
    expect(isFabricatedPrintRun(241)).toBe(true);
    expect(isFabricatedPrintRun("241")).toBe(true);
    expect(isFabricatedPrintRun(240)).toBe(false);
    expect(isFabricatedPrintRun(24)).toBe(false);
    // blank/absent must not be "fabricated"
    expect(isFabricatedPrintRun(null)).toBe(false);
    expect(isFabricatedPrintRun(undefined)).toBe(false);
    expect(isFabricatedPrintRun("")).toBe(false);
  });

  it("only cardNumber 1927 parks; 192 and 27 do not", () => {
    expect(isSmearedCardNumber("1927")).toBe(true);
    expect(isSmearedCardNumber("192")).toBe(false);
    expect(isSmearedCardNumber("27")).toBe(false);
    expect(isSmearedCardNumber(1927)).toBe(true);
  });
});
