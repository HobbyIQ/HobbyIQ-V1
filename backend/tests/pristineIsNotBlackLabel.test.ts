// CF-PRISTINE-IS-NOT-BLACK-LABEL (Drew, 2026-08-19: "is the BGS 10 and BGS
// pristine 10 black label and PSA 10 matching? We may be missing the pristine").
//
// BGS names its grade TEN "Pristine". Black Label is the separate designation
// for a 10 whose FOUR SUBGRADES are all 10 — a different and far rarer card.
//
// detectGradeFromTitle used to treat "pristine" and a bare "bl" as Black Label,
// on a comment asserting "Pristine is BGS's other name for Black Label". That is
// wrong, and it is expensive: "10 Black Label" carries a 12.0x multiplier at low
// print runs.
//
// Measured in production on 2026-08-19:
//   6,434 BGS 10 comps say "Pristine"
//   1,212 BGS 10 comps say "Black Label"
//   Black Label median $510 vs ordinary BGS 10 median $160 — a 3.19x premium
//
// So ~5,200 ordinary BGS 10s were being priced as Black Label at 12x. The
// observed premium is 3.19x and belongs only to the genuine article.

import { describe, it, expect } from "vitest";
import { detectGradeFromTitle } from "../src/services/compiq/compiqEstimate.service.js";

describe("CF-PRISTINE-IS-NOT-BLACK-LABEL", () => {
  it("PRISTINE is BGS's name for grade 10, not Black Label", () => {
    expect(detectGradeFromTitle("2024 Bowman Chrome Auto BGS 10 Pristine"))
      .toEqual({ company: "BGS", grade: "10" });
    expect(detectGradeFromTitle("2025 Topps Now #338 Shohei Ohtani BGS 10 PRISTINE"))
      .toEqual({ company: "BGS", grade: "10" });
  });

  it("an explicit Black Label still resolves to Black Label", () => {
    // Real production titles.
    expect(detectGradeFromTitle("2024 Bowman's Best Wyatt Langford 1955 Anime RC #BA-19 BGS 10 Black Label"))
      .toEqual({ company: "BGS", grade: "10 Black Label" });
    expect(detectGradeFromTitle("2025 TOPPS NOW #338 SHOHEI OHTANI BGS 10 BLACK LABEL"))
      .toEqual({ company: "BGS", grade: "10 Black Label" });
    expect(detectGradeFromTitle("Card BGS 10 black-label"))
      .toEqual({ company: "BGS", grade: "10 Black Label" });
  });

  it("ALMOST Black Label is not a Black Label", () => {
    // Real production title: a $65 card that a naive match drops into a $510 pool.
    expect(detectGradeFromTitle("2024 Topps Now /5151 Aaron Judge #416 BGS 10 Pristine!! Almost Black Label -"))
      .toEqual({ company: "BGS", grade: "10" });
    for (const hedge of ["almost", "nearly", "near", "not", "like a", "close to", "basically", "practically"]) {
      const t = `2024 Bowman Chrome BGS 10 ${hedge} black label`;
      expect(detectGradeFromTitle(t)?.grade, t).toBe("10");
    }
  });

  it("a bare 'BL' no longer promotes to Black Label", () => {
    // Two letters that collide with ordinary words; the volume never justified
    // the risk of a 12x multiplier.
    expect(detectGradeFromTitle("2024 Bowman Chrome BGS 10 BL")?.grade).toBe("10");
  });

  it("only BGS 10 can be Black Label", () => {
    expect(detectGradeFromTitle("2024 Card BGS 9.5 Black Label")).toEqual({ company: "BGS", grade: "9.5" });
    expect(detectGradeFromTitle("2024 Card PSA 10 Black Label")).toEqual({ company: "PSA", grade: "10" });
  });

  it("ordinary grades are untouched", () => {
    expect(detectGradeFromTitle("2024 Bowman Chrome PSA 10 Gem Mint")).toEqual({ company: "PSA", grade: "10" });
    expect(detectGradeFromTitle("2024 Bowman Chrome BGS 9.5")).toEqual({ company: "BGS", grade: "9.5" });
    expect(detectGradeFromTitle("2024 Bowman Chrome SGC 10")).toEqual({ company: "SGC", grade: "10" });
    expect(detectGradeFromTitle("2024 Bowman Chrome raw ungraded")).toBeNull();
  });

  it("the TOPPS PRISTINE product line is not a grade signal", () => {
    // "Pristine" here is a SET name. These must keep the grade the title states.
    expect(detectGradeFromTitle("2001-02 Topps Pristine Gary Payton BGS 9 MINT"))
      .toEqual({ company: "BGS", grade: "9" });
    expect(detectGradeFromTitle("2003/04 Topps Pristine Gold Refractors #103 LeBron James BGS 9.5"))
      .toEqual({ company: "BGS", grade: "9.5" });
    // And a Topps Pristine card that IS a BGS 10 is a plain 10, not Black Label.
    expect(detectGradeFromTitle("2024 Topps Pristine Swings of Summer Shohei Ohtani SS-5 BGS 10"))
      .toEqual({ company: "BGS", grade: "10" });
  });
});
