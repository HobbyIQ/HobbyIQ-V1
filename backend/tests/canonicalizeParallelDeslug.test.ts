// CF-PARALLEL-DESLUG (Drew, 2026-08-15: "normalize it and add it to vocab").
//
// 1,588 distinct parallel values are stored in slug form — "optic-red",
// "1992-nba-mvp" — and 1,455 (91.6%) have a properly spaced twin. They come
// from the sold-comps-stub seeding path, which wrote the slug into the
// display field.
//
// SCOPE: this is vocabulary hygiene, NOT a matching fix. The matcher compares
// parallelSlug, and both spellings already slugify to "optic-red". The
// invariance test below is the one that matters — it proves this change
// cannot move a card onto a different slug.
import { describe, it, expect } from "vitest";
import { canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

describe("canonicalizeParallelName — slug-form display values", () => {
  it.each([
    ["optic-red", "Optic Red"],
    ["optic-holo", "Optic Holo"],
    ["blue-velocity-optic", "Blue Velocity Optic"],
    ["1934-statistics", "1934 Statistics"],
    ["1973-topps-refractor", "1973 Topps Refractor"],
  ])("%s -> %s", (input, want) => {
    expect(canonicalizeParallelName(input)).toBe(want);
  });

  // Naive title-casing gives "1992 Nba Mvp", matching neither the real twin
  // "1992 NBA MVP" nor how anyone writes it.
  it.each([
    ["1992-nba-mvp", "1992 NBA MVP"],
    ["1st-day-issue", "1st Day Issue"],
  ])("preserves acronyms and ordinals: %s -> %s", (input, want) => {
    expect(canonicalizeParallelName(input)).toBe(want);
  });

  it("converges on the spaced twin", () => {
    expect(canonicalizeParallelName("optic-red"))
      .toBe(canonicalizeParallelName("Optic Red"));
  });

  // THE GUARDRAIL THAT MATTERS. Output must re-slugify to the input, so a
  // display-only cleanup can never reassign a card's identity.
  it.each(["optic-red", "1992-nba-mvp", "1973-topps-refractor", "blue-velocity-optic"])(
    "slug invariance: %s round-trips",
    (input) => {
      expect(slugify(canonicalizeParallelName(input))).toBe(input);
    },
  );

  describe("leaves everything else alone", () => {
    it.each([
      ["Optic Red", "Optic Red"],
      ["Base", "Base"],
      ["gold", "gold"],            // single lowercase word is not slug form
      ["Gold Border", "Gold"],      // existing alias still wins
      ["Prizms Glitter", "Glitter Prizm"],
      ["True Blue", "Blue"], // CF-COLOUR-FOLLOWS-THE-CHECKLIST (Drew, 2026-08-30)
    ])("%s -> %s", (input, want) => {
      expect(canonicalizeParallelName(input)).toBe(want);
    });
  });
});
