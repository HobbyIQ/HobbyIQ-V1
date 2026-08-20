// CF-PRIZMS-WORD-ORDER (Drew, 2026-08-15: "now can we match it with what we
// have?"). The answer was yes — the parallels were already catalogued, under
// two word orders written by two different scrapers:
//
//   Green Pulsar Prizm  /25   baseballcardpedia, bccp
//   Prizms Green Pulsar /25   checklistcenter
//
// Same card, same print run. The matcher requires exact parallel-token
// equality, so a sale matched one form and missed the other, and the catalog
// carried both as separate parallels — 51,335 rows in "Prizms X" against
// 444,219 in "X Prizm".
import { describe, it, expect } from "vitest";
import { canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";

describe("canonicalizeParallelName — Prizms word order", () => {
  it.each([
    ["Prizms Green Pulsar", "Green Pulsar Prizm"],
    ["Prizms Glitter", "Glitter Prizm"],
    ["Prizms Red Power", "Red Power Prizm"],
    ["Prizms White Sparkle", "White Sparkle Prizm"],
    ["Prizms Cherry Blossom", "Cherry Blossom Prizm"],
  ])("%s -> %s", (input, want) => {
    expect(canonicalizeParallelName(input)).toBe(want);
  });

  it("the majority form is already canonical and is left alone", () => {
    expect(canonicalizeParallelName("Green Pulsar Prizm")).toBe("Green Pulsar Prizm");
    expect(canonicalizeParallelName("Snakeskin Prizm")).toBe("Snakeskin Prizm");
  });

  it("both forms converge, which is the whole point", () => {
    expect(canonicalizeParallelName("Prizms Green Pulsar"))
      .toBe(canonicalizeParallelName("Green Pulsar Prizm"));
  });

  describe("guardrails", () => {
    // Bare "Prizm" is a real parallel in its own right (2,360 catalog rows),
    // which is why this reorders and never strips the family word.
    it("bare Prizm survives", () => {
      expect(canonicalizeParallelName("Prizm")).toBe("Prizm");
      expect(canonicalizeParallelName("Prizms")).toBe("Prizms");
    });
    it("does not double-suffix when the remainder already ends in Prizm", () => {
      expect(canonicalizeParallelName("Prizms Gold Prizm")).toBe("Gold Prizm");
    });
    it("unrelated aliases still work", () => {
      expect(canonicalizeParallelName("Gold Border")).toBe("Gold");
      expect(canonicalizeParallelName("True Blue")).toBe("Blue Refractor");
      expect(canonicalizeParallelName("[base]")).toBe("Base");
      expect(canonicalizeParallelName(null)).toBe("Base");
    });
  });
});
