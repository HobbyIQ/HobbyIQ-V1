/**
 * `sourceKeyOf` and `publisherOf` answer DIFFERENT questions and are NOT
 * interchangeable. Swapping them in the D31 colour gate flips Topps Finest
 * #197 from two cards to one -- 600 real cards merged -- so this test asserts
 * the distinction rather than trusting a comment to preserve it.
 */
import { describe, expect, it } from "vitest";
import {
  sourceKeyOf,
  publisherOf,
  oneSourceNamesBothColourForms,
  type DupRow,
} from "../src/services/catalog/duplicateWinnerRule.js";

describe("sourceKeyOf -- ONE SCRAPE RUN", () => {
  it("keeps dated scrape runs of one site DISTINCT", () => {
    expect(sourceKeyOf("checklistcenter")).toBe("checklistcenter");
    expect(sourceKeyOf("checklistcenter-2026-08-29")).toBe("checklistcenter-2026-08-29");
    expect(sourceKeyOf("checklistcenter")).not.toBe(sourceKeyOf("checklistcenter-2026-08-29"));
  });

  it("collapses ONLY the -graded twin, which is the same transcription", () => {
    expect(sourceKeyOf("checklistcenter-graded")).toBe("checklistcenter");
    expect(sourceKeyOf("beckett-checklist-2026-08-27-graded")).toBe("beckett-checklist-2026-08-27");
  });

  it("never returns an empty key", () => {
    expect(sourceKeyOf("")).toBe("(none)");
    expect(sourceKeyOf(null)).toBe("(none)");
    expect(sourceKeyOf(undefined)).toBe("(none)");
  });
});

describe("publisherOf -- THE SITE, for rule 3's majority only", () => {
  it("collapses every scrape run of one site to one voter", () => {
    expect(publisherOf("checklistcenter-2026-08-29")).toBe("checklistcenter");
    expect(publisherOf("checklistcenter")).toBe("checklistcenter");
    expect(publisherOf("beckett-scraped-2026-08-19")).toBe("beckett");
    expect(publisherOf("beckett-checklist-2026-08-27")).toBe("beckett");
    expect(publisherOf("bccp")).toBe("baseballcardpedia");
    expect(publisherOf("baseballcardpedia-ladders-2026-08-20")).toBe("baseballcardpedia");
  });

  it("keeps genuinely different SITES apart", () => {
    expect(publisherOf("checklistcenter")).not.toBe(publisherOf("checklistinsider"));
    expect(publisherOf("beckett")).not.toBe(publisherOf("tcdb"));
  });
});

describe("the two are NOT interchangeable", () => {
  const finest = (source1: string, source2: string): DupRow[] => [
    { id: "a", source: source1, parallelSlug: "uncommon", setKey: "topps-finest", cardNumber: "197", year: 2024, sport: "baseball" },
    { id: "b", source: source2, parallelSlug: "uncommon-refractor", setKey: "topps-finest", cardNumber: "197", year: 2024, sport: "baseball" },
  ];

  it("Finest #197 from ONE run is two cards; the SAME pair split across two runs is one card", () => {
    // The whole D31 discriminator in two assertions.
    expect(oneSourceNamesBothColourForms(finest("checklistcenter", "checklistcenter"))).toMatchObject({ both: true });
    expect(oneSourceNamesBothColourForms(finest("checklistcenter", "checklistcenter-2026-08-29"))).toEqual({ both: false });
  });

  it("a publisher-collapse reading would MERGE Finest #197 -- the refuted reading (b)/(a)", () => {
    // Demonstrated, not merely asserted: if the gate keyed on publisherOf, the
    // two rows above would share a key and the group would fold. They must not.
    const rows = finest("checklistcenter", "checklistcenter-2026-08-29");
    const byPublisher = new Set(rows.map((r) => publisherOf(r.source)));
    const bySourceKey = new Set(rows.map((r) => sourceKeyOf(r.source)));
    expect(byPublisher.size).toBe(1); // what the WRONG reading sees
    expect(bySourceKey.size).toBe(2); // what the rule actually uses
  });
});
