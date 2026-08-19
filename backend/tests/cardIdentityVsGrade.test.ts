// CF-CARD-IDENTITY-VS-GRADE (2026-08-19).
//
// Pins the join contract for the catalog-first rematch. Two dimensions that
// look alike in a slug and must never be confused:
//
//   PRINT RUN is IDENTITY   — a Gold /50 is a different card from a Ref /499
//   GRADE is a PRICING dim  — the same Gold /50 in PSA 9 and PSA 10
//
// sold_comps puts a print run in slug segment 8 (`num-499`); an exploded
// card_catalog row puts a grade tier there (`psa-9-5`). Join on hobbyiqCardId
// and every graded row becomes a phantom card, manufacturing ORPHANs. Join on
// parentSlug alone and every ungraded row vanishes.
//
// The `psa-th2` cases below are the ones that matter most: they are real
// production slugs where the CARD NUMBER begins "psa-". A positionally-blind
// grade regex flagged 221 of them as grade-in-slug defects. All false. That is
// why grade is read from fields and identity is checked by position.

import { describe, it, expect } from "vitest";
import { cardIdentityKey, gradeOf, isSameCard } from "../src/services/portfolioiq/cardIdentityKey.service.js";

describe("CF-CARD-IDENTITY-VS-GRADE", () => {
  it("an exploded catalog row identifies as its parent card", () => {
    expect(cardIdentityKey({
      hobbyiqCardId: "hiq:baseball:2026:bowman:bp-102:base:no-auto:psa-9-5",
      parentSlug: "hiq:baseball:2026:bowman:bp-102:base:no-auto",
    })).toBe("hiq:baseball:2026:bowman:bp-102:base:no-auto");
  });

  it("an ungraded row identifies as itself", () => {
    expect(cardIdentityKey({ hobbyiqCardId: "hiq:baseball:2026:bowman:bp-102:base:no-auto" }))
      .toBe("hiq:baseball:2026:bowman:bp-102:base:no-auto");
  });

  it("PRINT RUN is identity and must survive", () => {
    // The whole point: a /50 gold is not a /499 refractor.
    const slug = "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50";
    expect(cardIdentityKey({ hobbyiqCardId: slug })).toBe(slug);
    expect(isSameCard(
      { hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50" },
      { hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-499" },
    )).toBe(false);
  });

  it("a grade tier in segment 8 is stripped, as a backstop for rows without parentSlug", () => {
    expect(cardIdentityKey({ hobbyiqCardId: "hiq:baseball:2026:bowman:bp-102:base:no-auto:psa-10" }))
      .toBe("hiq:baseball:2026:bowman:bp-102:base:no-auto");
    expect(cardIdentityKey({ hobbyiqCardId: "hiq:baseball:2026:bowman:bp-102:base:no-auto:bgs-9-5" }))
      .toBe("hiq:baseball:2026:bowman:bp-102:base:no-auto");
    expect(cardIdentityKey({ hobbyiqCardId: "hiq:baseball:2026:bowman:bp-102:base:no-auto:raw" }))
      .toBe("hiq:baseball:2026:bowman:bp-102:base:no-auto");
  });

  it("a CARD NUMBER beginning 'psa-' is never mistaken for a grade", () => {
    // Real production slugs. A positionally-blind regex called all of these
    // grade-in-slug defects; there were 221 and every one was wrong.
    for (const slug of [
      "hiq:football:2024:bowman:psa-th2:base:no-auto",
      "hiq:football:2024:bowman:psa-th2:sky-blue:no-auto:num-499",
      "hiq:football:2024:bowman:psa-th2:purple:no-auto:num-250",
    ]) {
      expect(cardIdentityKey({ hobbyiqCardId: slug }), slug).toBe(slug);
    }
  });

  it("all grades of one card share an identity — the product requirement", () => {
    // "we want to have all grades available for people": many rows, one card.
    const parent = "hiq:baseball:2026:bowman:bp-102:base:no-auto";
    const graded = ["psa-9-5", "psa-10", "bgs-9-5", "sgc-10", "cgc-9", "raw"]
      .map((t) => ({ hobbyiqCardId: `${parent}:${t}`, parentSlug: parent }));
    for (const g of graded) expect(cardIdentityKey(g)).toBe(parent);
    expect(new Set(graded.map(cardIdentityKey)).size).toBe(1);
  });

  it("grade comes from FIELDS, never from the slug", () => {
    expect(gradeOf({ gradeCompany: "PSA", gradeValue: 9.5, gradeTier: "psa-9-5" }))
      .toEqual({ company: "PSA", value: 9.5, tier: "psa-9-5" });
    // No fields = raw, which is an answer rather than a gap.
    expect(gradeOf({}).tier).toBe("raw");
    // A psa- CARD NUMBER must not leak a grade.
    expect(gradeOf({ gradeCompany: null, gradeValue: null })).toEqual({ company: null, value: null, tier: "raw" });
  });

  it("derives a tier when the field is absent but company+value are present", () => {
    expect(gradeOf({ gradeCompany: "psa", gradeValue: "10" }).tier).toBe("psa-10");
    expect(gradeOf({ gradeCompany: "BGS", gradeValue: 9.5 }).tier).toBe("bgs-9-5");
  });

  it("returns null rather than an empty key when there is no slug", () => {
    // Silently matching on "" would join unrelated rows together.
    expect(cardIdentityKey({})).toBeNull();
    expect(cardIdentityKey({ hobbyiqCardId: "  " })).toBeNull();
    expect(isSameCard({}, {})).toBe(false);
  });
});
