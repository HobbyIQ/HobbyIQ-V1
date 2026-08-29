/**
 * CF-A-SUPERFRACTOR-IS-ONE-OF-ONE (D15, 2026-08-29).
 *
 * Drew: "superfractors are 1/1". The glossary: SuperFractor = 1/1, every
 * printing plate is a 1/1. 255,229 un-graded rows name one of these in
 * their slug and sit at an id without `:num-1`. The rule is the slug's own
 * parallel segment; a colour in front changes nothing; the plural
 * (`superfractors`, 21,536 rows) is a SuperFractor; a scraped footnote that
 * merely mentions one is prose, not a rung, and is left alone.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { oneOfOneFamily, targetSlug, decideRow } = require("../scripts/conform-one-of-one-parallels.cjs");

describe("oneOfOneFamily -- which 1/1 family a parallel slug is", () => {
  it.each([
    ["superfractor", "superfractor"],
    ["gold-superfractor", "superfractor"],
    ["chrome-superfractor", "superfractor"],
    ["superfractor-refractor", "superfractor"],
    ["superfractors", "superfractor"],
    ["superfractors-refractor", "superfractor"],
    ["superfractors-11-refractor", "superfractor"],
    ["all-star-superfractors", "superfractor"],
    ["printing-plate", "printing-plate"],
    ["printing-plates", "printing-plate"],
    ["printing-plates-cyan", "printing-plate"],
    ["framed-printing-plate", "printing-plate"],
    ["printing-plates-parallel", "printing-plate"],
    ["one-of-one", "one-of-one"],
    ["class-3-red-one-of-one", "one-of-one"],
    ["od-1-of-1", "one-of-one"],
    ["artist's-proof-1-of-1", "one-of-one"],
    ["relic-1-of-1", "one-of-one"],
  ])("%s -> %s", (slug, family) => {
    expect(oneOfOneFamily(slug)).toBe(family);
  });

  it.each([
    "base", "gold-refractor", "x-fractor", "refractor", "red-wave-refractor",
    "superfractory", "asuperfractor", "one-of-ones", "11", "printing",
  ])("%s is not a 1/1", (slug) => {
    expect(oneOfOneFamily(slug)).toBeNull();
  });

  it("a scraped footnote that mentions a 1/1 is prose, not a rung", () => {
    expect(oneOfOneFamily("all-100-base-cards-are-available-in-the-following-refractor-parallels.-refractor-(serial-numbered-to-250-copies)-superfractor-(one-of-one)-printing-plate-(set-of-four-for-each)-note")).toBe("prose");
    expect(oneOfOneFamily("cards-17-50-and-56-do-not-exist-in-the-one-of-one-platinum-parallel")).toBe("prose");
    expect(oneOfOneFamily("longevity-holographic-(one-of-one).")).toBe("prose");
  });

  it("is null-safe", () => {
    expect(oneOfOneFamily(null)).toBeNull();
    expect(oneOfOneFamily("")).toBeNull();
  });
});

describe("targetSlug -- the same identity at :num-1", () => {
  it("adds :num-1 to an un-numbered id and replaces any other run", () => {
    expect(targetSlug("hiq:baseball:2025:bowman:cpa-ag:superfractor:auto")).toBe("hiq:baseball:2025:bowman:cpa-ag:superfractor:auto:num-1");
    expect(targetSlug("hiq:hockey:2023:upper-deck:14:printing-plates-parallel:no-auto:num-4")).toBe("hiq:hockey:2023:upper-deck:14:printing-plates-parallel:no-auto:num-1");
    expect(targetSlug("hiq:baseball:2024:topps-chrome:1:superfractor:no-auto:num-1368310399850795000")).toBe("hiq:baseball:2024:topps-chrome:1:superfractor:no-auto:num-1");
  });
  it("is the identity on an id already at :num-1, and null for a graded child", () => {
    expect(targetSlug("hiq:baseball:2025:bowman:cpa-ag:superfractor:auto:num-1")).toBe("hiq:baseball:2025:bowman:cpa-ag:superfractor:auto:num-1");
    expect(targetSlug("hiq:baseball:2025:bowman:cpa-ag:superfractor:auto:psa-10")).toBeNull();
    expect(targetSlug("not-a-slug")).toBeNull();
  });
});

describe("decideRow -- move to :num-1, heal the field, or leave alone", () => {
  it("an un-numbered SuperFractor moves", () => {
    expect(decideRow({ id: "hiq:baseball:2025:bowman:cpa-ag:gold-superfractor:auto", printRun: null }))
      .toEqual({ action: "move", family: "superfractor", newSlug: "hiq:baseball:2025:bowman:cpa-ag:gold-superfractor:auto:num-1" });
  });
  it("a plate parsed as /4 moves", () => {
    expect(decideRow({ id: "hiq:hockey:2023:upper-deck:14:printing-plates-parallel:no-auto:num-4", printRun: 4 }))
      .toEqual({ action: "move", family: "printing-plate", newSlug: "hiq:hockey:2023:upper-deck:14:printing-plates-parallel:no-auto:num-1" });
  });
  it("a :num-1 id whose field is not 1 is healed; one whose field is 1 agrees", () => {
    expect(decideRow({ id: "hiq:baseball:2025:bowman:cpa-ag:superfractor:auto:num-1", printRun: "1" })).toEqual({ action: "heal", family: "superfractor" });
    expect(decideRow({ id: "hiq:baseball:2025:bowman:cpa-ag:superfractor:auto:num-1", printRun: 1 })).toEqual({ action: "agree", family: "superfractor" });
  });
  it("the id's own segment decides, not the parallelSlug field", () => {
    // parallelSlug said superfractor (that is how the query found it); the id says gold-refractor.
    expect(decideRow({ id: "hiq:baseball:2025:bowman:cpa-ag:gold-refractor:auto", parallelSlug: "superfractor", printRun: null })).toEqual({ action: "skip-field-id-disagree" });
  });
  it("prose and non-hiq ids are skipped", () => {
    expect(decideRow({ id: "hiq:baseball:2020:topps:1:all-100-base-cards-are-available-in-the-following-refractor-parallels.-superfractor-(one-of-one):no-auto" })).toEqual({ action: "skip-prose" });
    expect(decideRow({ id: "1675907831540x123" })).toEqual({ action: "skip-not-hiq" });
  });
});
