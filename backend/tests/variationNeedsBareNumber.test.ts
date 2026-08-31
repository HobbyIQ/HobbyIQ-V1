/**
 * CF-A-VARIATION-NEEDS-A-BARE-NUMBER (D37, 2026-08-30).
 *
 * The D37 tail row `hiq:baseball:2026:bowman-paper:bp-18:logo-variation` is a
 * MALFORMED identity: it puts a base-set variation subset on a Paper-Prospects
 * card number. 2026 Bowman's source proves the split —
 *   Base Rookie Red RC Logo Variation   40 cards, ALL bare numeric (#18 = Roman Anthony)
 *   Base Etched in Glass Variation      12 cards, ALL bare numeric
 *   Chrome Prospects Etched in Glass    11 cards, ALL BCP-
 *   Anime Kanji Variation                7 cards, ALL BA-
 * — BP-18 is Blaine Bullard and appears in NO variation subset.
 *
 * The guard refuses a variation on a prefixed number the checklist does not
 * back, and keeps one the checklist does (BCP-139 Etched in Glass).
 */
import { describe, it, expect } from "vitest";
import { resolveIdentityFromFields } from "../src/services/portfolioiq/identityFromFields";

const baseFields = {
  sport: "baseball", year: 2026, setName: "2026 Bowman", player: "Blaine Bullard",
  isAuto: false, printRun: null, source: "ebay-import" as const, title: null,
};

/** Records what the matcher was asked, so the assertion is on the QUESTION. */
function seam(held: string[]) {
  const asked: any[] = [];
  return {
    asked,
    deps: {
      canonicalize: async (input: any) => { asked.push(input); return { found: false, slug: null, confidence: 0 } as any; },
      resolveCardNumberByPlayer: async () => ({ cardNumber: null, candidates: [] }),
      variationParallelsForCard: async () => held,
    },
  };
}

describe("a base-set variation never attaches to a prefixed card number", () => {
  it("refuses Logo Variation on BP-18 when the checklist holds none for it", async () => {
    const s = seam([]);
    const r = await resolveIdentityFromFields(
      { ...baseFields, cardNumber: "BP-18", parallel: "Logo Variation" }, s.deps as any);
    expect(r.variationRefusedForPrefixedNumber).toBe(true);
    // The matcher is asked about the CARD, not the fusion.
    expect(s.asked[0].parallel).toBe("Base");
    expect(String(s.asked[0].parallel).toLowerCase()).not.toContain("variation");
  });

  it("KEEPS a variation the checklist does hold for that prefixed number", async () => {
    const s = seam(["etched-in-glass-variation"]);
    const r = await resolveIdentityFromFields(
      { ...baseFields, cardNumber: "BCP-139", parallel: "Etched in Glass Variation" }, s.deps as any);
    expect(r.variationRefusedForPrefixedNumber).toBeFalsy();
    expect(String(s.asked[0].parallel).toLowerCase()).toContain("variation");
  });

  it("leaves a BARE numeric alone — #18 Roman Anthony really has the variation", async () => {
    const s = seam([]);
    const r = await resolveIdentityFromFields(
      { ...baseFields, player: "Roman Anthony", cardNumber: "18", parallel: "Logo Variation" }, s.deps as any);
    expect(r.variationRefusedForPrefixedNumber).toBeFalsy();
    expect(String(s.asked[0].parallel).toLowerCase()).toContain("variation");
  });

  it("does not disturb an ordinary parallel on a prefixed number", async () => {
    // BP-18's real card: the Bowman Logo Pattern rung, which is NOT a variation.
    const s = seam([]);
    const r = await resolveIdentityFromFields(
      { ...baseFields, cardNumber: "BP-18", parallel: "Bowman Logo Pattern" }, s.deps as any);
    expect(r.variationRefusedForPrefixedNumber).toBeFalsy();
    expect(s.asked[0].parallel).toBe("Bowman Logo Pattern");
  });
});
