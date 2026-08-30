// CF-BORDER-IS-THE-SAME-CARD (Drew, 2026-08-15: "bingo! just someone using
// different words").
//
// Checklist sources disagree on whether a colour parallel is called "Gold" or
// "Gold Border". Proven on 2024 Bowman #9, where the SAME card carries both:
//
//     Gold Border /50   source=checklistcenter
//     Gold        /50   source=bccp
//
// Same print run, same card, two vocabularies. Across cards holding both
// forms, 77 agreed on print run; the 20 that "differed" had a null print run
// on one side — missing data, not a second parallel.
//
// The normalization is deliberately narrow. "Border" is NOT generally
// droppable and a blanket strip would corrupt real identities, so these
// guardrails matter as much as the aliases.
import { describe, it, expect } from "vitest";
import { canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";

describe("canonicalizeParallelName — {Colour} Border is the same card", () => {
  it.each([
    ["Gold Border", "Gold"],
    ["Gold Bordered", "Gold"],
    ["gold border", "Gold"],
    ["Black Border", "Black"],
    ["White Border", "White"],
    ["Blue Bordered", "Blue"],
    ["Platinum Border", "Platinum"],
  ])("%s -> %s", (input, want) => {
    expect(canonicalizeParallelName(input)).toBe(want);
  });

  it("colour still distinguishes — vintage Black and White borders stay apart", () => {
    expect(canonicalizeParallelName("Black Border"))
      .not.toBe(canonicalizeParallelName("White Border"));
  });

  describe("guardrails — 'border' is not generally droppable", () => {
    it.each([
      // Opposite meaning.
      ["Borderless"],
      ["Borderless Refractor"],
      // Qualified form — a Mini is its own card.
      ["Mini Black Border"],
      // Not a colour parallel.
      ["Team Color Border Variation"],
      // Printing varieties.
      ["Gap in Border"],
      ["No Gap in Border"],
      // A PLAYER NAME sitting in the parallel field — Pat Borders, the
      // catcher. ~4,900 rows of a separate data defect; must stay untouched.
      ["222 Pat Border"],
      ["Pat Borders / Ted Power"],
      // Longer compound parallels keep every token.
      ["Black Border Pattern Refractor"],
    ])("%s is left alone", (input) => {
      expect(canonicalizeParallelName(input)).toBe(input);
    });
  });

  it("existing aliases and Base handling are unchanged", () => {
    // CF-COLOUR-FOLLOWS-THE-CHECKLIST (Drew, 2026-08-30): True Blue is Blue as written.
    expect(canonicalizeParallelName("True Blue")).toBe("Blue");
    expect(canonicalizeParallelName("[base]")).toBe("Base");
    expect(canonicalizeParallelName(null)).toBe("Base");
    expect(canonicalizeParallelName("Gold")).toBe("Gold");
  });
});
