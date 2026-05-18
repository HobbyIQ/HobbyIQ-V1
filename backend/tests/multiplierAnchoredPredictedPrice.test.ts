import { describe, expect, it } from "vitest";
import {
  computeMultiplierAnchoredPredictedPrice,
  normalizeSubjectParallel,
} from "../src/agents/multiplierAnchoredPredictedPrice.js";

const NOW = new Date("2026-05-17T12:00:00.000Z");

function soldDateDaysAgo(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
}

function makeComp(title: string, price: number, daysAgo = 7) {
  return { title, price, soldDate: soldDateDaysAgo(daysAgo) };
}

const SUBJECT = {
  playerName: "Drake Baldwin",
  year: 2022,
  product: "Bowman Chrome" as const,
  subset: "Chrome Prospect Autographs" as const,
  parallelName: "Blue Refractor",
  isAutograph: true,
};

describe("computeMultiplierAnchoredPredictedPrice", () => {
  it("happy path: same-subset anchor found and predicts in expected range", () => {
    const result = computeMultiplierAnchoredPredictedPrice({
      subject: SUBJECT,
      now: NOW,
      comps: [
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 145, 4),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 150, 8),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 155, 13),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Purple Refractor Auto /250", 260, 18),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Gold Refractor Auto /50", 1250, 20),
      ],
    });

    expect(result.predictedPrice).not.toBeNull();
    expect(result.predictedPriceRange).not.toBeNull();
    expect(result.predictedPriceAttribution.mechanism).toBe("multiplier-anchored");
    expect(result.predictedPriceAttribution.failureReason).toBeUndefined();
    expect(result.predictedPriceAttribution.anchorParallel).toBe("Refractor");
    expect(result.predictedPriceAttribution.anchorComps).toBe(3);
    expect(result.predictedPriceRange!.low).toBeCloseTo(450, 0);
    expect(result.predictedPriceRange!.high).toBeCloseTo(660, 0);
  });

  it("subject uncurated parallel returns null with uncurated-subject-parallel", () => {
    const result = computeMultiplierAnchoredPredictedPrice({
      subject: { ...SUBJECT, parallelName: "Rainbow Ice Foil" },
      now: NOW,
      comps: [
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 145),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 150),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 155),
      ],
    });

    expect(result.predictedPrice).toBeNull();
    expect(result.predictedPriceAttribution.failureReason).toBe("uncurated-subject-parallel");
  });

  it("anchor not found returns null with no-anchor-comps", () => {
    const result = computeMultiplierAnchoredPredictedPrice({
      subject: SUBJECT,
      now: NOW,
      comps: [
        makeComp("2022 Bowman Chrome Prospects Drake Baldwin Green Refractor /99", 70),
        makeComp("2022 Bowman Chrome Prospects Drake Baldwin Blue Refractor /150", 55),
      ],
    });

    expect(result.predictedPrice).toBeNull();
    expect(result.predictedPriceAttribution.failureReason).toBe("no-anchor-comps");
  });

  it("<3 anchor comps returns insufficient-anchor-data after preference walk", () => {
    const result = computeMultiplierAnchoredPredictedPrice({
      subject: SUBJECT,
      now: NOW,
      comps: [
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 145),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 150),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Purple Refractor Auto /250", 260),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Gold Refractor Auto /50", 1250),
      ],
    });

    expect(result.predictedPrice).toBeNull();
    expect(result.predictedPriceAttribution.failureReason).toBe("insufficient-anchor-data");
  });

  it("direct-comp-only subject parallel returns null", () => {
    const result = computeMultiplierAnchoredPredictedPrice({
      subject: { ...SUBJECT, parallelName: "Superfractor" },
      now: NOW,
      comps: [
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 145),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 150),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 155),
      ],
    });

    expect(result.predictedPrice).toBeNull();
    expect(result.predictedPriceAttribution.failureReason).toBe("direct-comp-only-parallel");
  });

  it("cross-product anchor returns prediction with cross-product flag", () => {
    const result = computeMultiplierAnchoredPredictedPrice({
      subject: SUBJECT,
      now: NOW,
      comps: [
        makeComp("2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499", 140),
        makeComp("2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499", 150),
        makeComp("2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499", 160),
        makeComp("2022 Bowman Draft CDA-DBN Drake Baldwin Purple Refractor Auto /250", 230),
        makeComp("2022 Bowman Draft CDA-DBN Drake Baldwin Gold Refractor Auto /50", 1100),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 152),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 153),
      ],
    });

    expect(result.predictedPrice).not.toBeNull();
    expect(result.predictedPriceAttribution.crossProductAnchor).toBe(true);
    expect(result.predictedPriceAttribution.anchorProduct).toBe("Bowman Draft");
  });

  it("subject-is-anchor degenerate case returns null", () => {
    const result = computeMultiplierAnchoredPredictedPrice({
      subject: { ...SUBJECT, parallelName: "Refractor" },
      now: NOW,
      comps: [
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 145),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 150),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Refractor Auto /499", 155),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Purple Refractor Auto /250", 260),
        makeComp("2022 Bowman Chrome CPA-DBN Drake Baldwin Gold Refractor Auto /50", 1250),
      ],
    });

    expect(result.predictedPrice).toBeNull();
    expect(result.predictedPriceAttribution.failureReason).toBe("subject-is-anchor");
  });
});

describe("canonicalizeParallelForLookup regression coverage", () => {
  it("preserves hyphenated parallel names", () => {
    expect(normalizeSubjectParallel("X-Fractor")).toBe("X-Fractor");
  });

  it("preserves year-prefixed names", () => {
    expect(normalizeSubjectParallel("1989 Retro")).toBe("1989 Retro");
  });

  it("preserves ordinal tokens", () => {
    // Intentional: step 10 title-cases tokens, so 1st becomes 1St in canonical form.
    expect(normalizeSubjectParallel("1st Bowman Chrome")).toBe("1St Bowman Chrome");
  });

  it("preserves product-number token names", () => {
    expect(normalizeSubjectParallel("Topps 206")).toBe("Topps 206");
  });

  it("retains Blue Refractor alias behavior after canonicalization", () => {
    expect(normalizeSubjectParallel("Blue Refractor Auto /25")).toBe("HTA Choice Refractor");
  });

  it("strips serial fragments from #/ forms", () => {
    expect(normalizeSubjectParallel("Refractor #25/99")).toBe("Refractor");
  });

  it("strips trailing serial on hyphenated parallels", () => {
    expect(normalizeSubjectParallel("X-Fractor 100")).toBe("X-Fractor");
  });

  it("handles empty string safely", () => {
    expect(normalizeSubjectParallel("")).toBe("");
  });

  it("handles all-digits input safely", () => {
    // All-digit input is normalized to empty to avoid non-parallel numeric-only lookup keys.
    expect(normalizeSubjectParallel("1234")).toBe("");
  });
});