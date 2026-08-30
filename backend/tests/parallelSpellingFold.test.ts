/**
 * D29/R2 -- the identity key that can actually reach its population.
 *
 * R1 was correct and could not reach anything: it keyed on an EXACT
 * parallelSlug string, and the two products spell the same rung differently.
 * Every slug in these fixtures was read from card_catalog on 2026-08-30
 * (read-only); none is invented.
 *
 * CF-A-SPELLING-IS-NOT-A-SECOND-CARD (Drew, 2026-08-30 12:50Z, D31): two
 * checklist SOURCES spelling one card two ways at the SAME print run is a
 * spelling, not two cards; the majority spelling among the checklist sources
 * wins, tie -> the longer form.
 */
import { describe, expect, it } from "vitest";
import {
  foldSpelling,
  sameSpelling,
  chooseSpelling,
} from "../src/services/catalog/parallelSpellingFold";

describe("foldSpelling -- the spellings that are one rung", () => {
  // THE PIN. 2021 CPA-AM at /499, read live 2026-08-30: three sources, three
  // strings, one card. Before this fold they were three groups that each
  // abstained "single-setkey", which is exactly why R1 moved 1,603 rows.
  it("folds the three spellings of the 2021 CPA-AM /499 refractor into one", () => {
    const spellings = [
      "base-refractor", // checklistcenter-2026-08-29
      "refractors-refractor", // beckett-checklist-2026-08-27
      "refractor", // bccp
    ];
    const folded = new Set(spellings.map(foldSpelling));
    expect(folded.size, `three spellings must fold to one: ${[...folded].join(", ")}`).toBe(1);
    expect([...folded][0]).toBe("refractor");
  });

  it("keeps the colour when it collapses beckett's section plural", () => {
    expect(foldSpelling("green-refractors-refractor")).toBe("green-refractor");
    expect(foldSpelling("gold-shimmer-refractors-refractor")).toBe("gold-shimmer-refractor");
    expect(foldSpelling("wave-red-refractors-refractor")).toBe("wave-red-refractor");
    expect(foldSpelling("hta-choice-refractors-refractor")).toBe("hta-choice-refractor");
  });

  it("folds the superfractor spellings, footnote digits and all", () => {
    const forms = ["superfractor", "superfractors", "superfractor-1-refractor", "superfractors-11"];
    const folded = new Set(forms.map(foldSpelling));
    expect(folded).toEqual(new Set(["superfractor"]));
  });

  it("folds the ampersand, the spelled-out and, and the bw abbreviation", () => {
    const forms = [
      "black-&-white-mini-diamond-refractor",
      "black-and-white-mini-diamond-refractors-refractor",
      "bw-mini-diamond-refractor",
    ];
    const folded = new Set(forms.map(foldSpelling));
    expect(folded.size, `bw / & / and must be one rung: ${[...folded].join(", ")}`).toBe(1);
  });

  it("strips D28's Base-Cards section glue", () => {
    expect(foldSpelling("base-cards-refractor")).toBe("refractor");
    expect(foldSpelling("base-autograph-refractor")).toBe("autograph-refractor");
  });

  // THE REFUSAL THAT PROTECTS PANINI PRIZM. D31: no vocabulary rule equates a
  // colour with its refractor. If this ever folds, a /50 Gold and a /499 Gold
  // Refractor become one card and the grade ladder collapses into it.
  it("does NOT fold a bare colour into its refractor", () => {
    expect(sameSpelling("gold", "gold-refractor")).toBe(false);
    expect(sameSpelling("blue", "blue-refractor")).toBe(false);
    expect(sameSpelling("red", "red-refractor")).toBe(false);
  });

  it("leaves a row whose whole parallel is Base alone", () => {
    expect(foldSpelling("base")).toBe("base");
  });

  it("does not fold two genuinely different rungs together", () => {
    expect(sameSpelling("red-wave", "orange-wave")).toBe(false);
    expect(sameSpelling("gold-shimmer-refractor", "green-shimmer-refractor")).toBe(false);
    expect(sameSpelling("atomic-refractor", "speckle-refractor")).toBe(false);
    expect(sameSpelling("printing-plates", "platinum")).toBe(false);
  });

  it("an empty slug folds to empty and never matches anything", () => {
    expect(foldSpelling(null)).toBe("");
    expect(foldSpelling("")).toBe("");
    expect(sameSpelling("", "")).toBe(false);
    expect(sameSpelling(null, null)).toBe(false);
  });
});

describe("chooseSpelling -- the majority among the CHECKLIST sources (D31)", () => {
  const c = (parallelSlug: string, source: string, isChecklist = true) => ({ parallelSlug, source, isChecklist });

  it("the majority spelling wins", () => {
    const won = chooseSpelling([
      c("refractor", "checklistcenter-2026-08-29"),
      c("refractor", "checklistinsider-2026-08-27"),
      c("refractors-refractor", "beckett-checklist-2026-08-27"),
    ]);
    expect(won).toBe("refractor");
  });

  it("a tie goes to the LONGER form", () => {
    const won = chooseSpelling([
      c("refractor", "checklistcenter-2026-08-29"),
      c("base-refractor", "beckett-checklist-2026-08-27"),
    ]);
    expect(won).toBe("base-refractor");
  });

  // One SOURCE, one vote. A scraper that emitted the same string 40 times is
  // one transcription; letting rows vote hands the ruling to whichever scrape
  // ran longest rather than to the majority of sources.
  it("counts SOURCES, not rows", () => {
    const won = chooseSpelling([
      ...Array.from({ length: 40 }, () => c("refractors-refractor", "beckett-checklist-2026-08-27")),
      c("refractor", "checklistcenter-2026-08-29"),
      c("refractor", "checklistinsider-2026-08-27"),
    ]);
    expect(won).toBe("refractor");
  });

  it("a derived or wiki row never outvotes a checklist", () => {
    const won = chooseSpelling([
      c("refractor", "checklistcenter-2026-08-29", true),
      c("base-refractor", "bccp", false),
      c("base-refractor", "baseballcardpedia", false),
      c("base-refractor", "ingest-auto-seed", false),
    ]);
    expect(won).toBe("refractor");
  });

  it("falls back to the non-checklist candidates when no checklist row is present", () => {
    const won = chooseSpelling([c("refractor", "bccp", false)]);
    expect(won).toBe("refractor");
  });

  it("returns null when there is nothing to choose", () => {
    expect(chooseSpelling([])).toBeNull();
    expect(chooseSpelling([c("", "checklistcenter-2026-08-29")])).toBeNull();
  });
});
