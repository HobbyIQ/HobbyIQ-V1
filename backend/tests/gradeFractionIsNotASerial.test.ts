// CF-GRADE-FRACTION-IS-NOT-A-SERIAL (Drew, 2026-08-20: "we need to fix the
// parser store").
//
// A GRADE written as a fraction is not a print run. Found by the rematch
// diagnostic, which flagged 4,837 comps claiming a serial the checklist denies.
// Leo De Vries CPA-LD is a card that only exists at /150, yet had comps sitting
// in /9 and /10 pools:
//
//   "2024 Bowman Chrome Leo De Vries Auto Autograph #CPA-LD PSA 10/9 DZ480"
//   "2024 Bowman Chrome Leo De Vries Auto 1st #CPA-LD Padres PSA 9/9"
//   "2024 Topps Bowman Chrome Leo De Vries ... #CPA-LD Padres PSA 9/10"
//   "2024 Bowman Chrome 1st Chrome Prospect Auto Leo De Vries PSA/9 #CPA-LD"
//
// Real sales at real prices, pooled with cards a hundred times rarer. A /150
// card priced against a /9 pool is wrong in the expensive direction.
//
// The grade fraction is STRIPPED rather than skipped, so a title carrying both
// a grade fraction and a genuine serial still reports the serial.

import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const pr = (t: string) => parseListingIdentity(t).printRun;

describe("CF-GRADE-FRACTION-IS-NOT-A-SERIAL", () => {
  it("the four production titles that caused it", () => {
    expect(pr("2024 Bowman Chrome Leo De Vries Auto Autograph #CPA-LD PSA 10/9 DZ480")).toBeNull();
    expect(pr("2024 Bowman Chrome Leo De Vries Auto 1st #CPA-LD Padres PSA 9/9")).toBeNull();
    expect(pr("2024 Topps Bowman Chrome Leo De Vries 1st Prospects Auto #CPA-LD Padres PSA 9/10")).toBeNull();
    expect(pr("2024 Bowman Chrome 1st Chrome Prospect Auto Leo De Vries PSA/9 #CPA-LD")).toBeNull();
  });

  it("covers the other graders and half grades", () => {
    for (const t of [
      "2024 Bowman Chrome Auto #CPA-LD BGS 9.5/10",
      "2024 Bowman Chrome Auto #CPA-LD SGC 9/10",
      "2024 Bowman Chrome Auto #CPA-LD CGC 8.5/9",
      "2024 Bowman Chrome Auto #CPA-LD BGS/9.5",
    ]) expect(pr(t), t).toBeNull();
  });

  it("a REAL serial still wins when both appear", () => {
    // The reason the grade fraction is stripped rather than short-circuited.
    expect(pr("2024 Bowman Chrome Leo De Vries PSA 9/10 Blue Refractor Auto /150")).toBe(150);
    expect(pr("2024 Bowman Chrome BGS 9.5/10 Gold Refractor 26/50")).toBe(50);
  });

  it("ordinary serials are untouched", () => {
    expect(pr("2024 Bowman Chrome Blue Refractor Auto 9/150 PSA 10")).toBe(150);
    expect(pr("2024 Bowman Chrome Blue Refractor Auto #9/150")).toBe(150);
    expect(pr("2024 Bowman Chrome Gold Refractor 26/50 Walker Jenkins")).toBe(50);
    expect(pr("2024 Bowman Chrome Refractor /499")).toBe(499);
    expect(pr("2024 Bowman Chrome Superfractor 1/1")).toBe(1);
    expect(pr("2024 Bowman Chrome Refractor #/50 Braves")).toBe(50);
  });

  it("a plain grade with no fraction is still not a serial", () => {
    expect(pr("2024 Bowman Chrome Walker Jenkins Refractor PSA 10 Gem Mint")).toBeNull();
    expect(pr("2024 Bowman Chrome Refractor BGS 9.5")).toBeNull();
  });

  it("the grade is still detected — only the print run changes", () => {
    // Stripping must not cost us the grade itself.
    const p = parseListingIdentity("2024 Bowman Chrome Leo De Vries #CPA-LD PSA 9/10");
    expect(p.printRun).toBeNull();
    expect(p.cardNumber).toBe("CPA-LD");
  });
});
