// CF-EBAY-ACTIVE-LISTINGS-RANK (Drew, 2026-07-17). Pinning tests for
// the eBay Browse match-quality ranker.

import { describe, it, expect } from "vitest";
import { scoreListing, rankAndFilter } from "../src/services/ebay/ebayListingRank.js";

describe("scoreListing", () => {
  const hartmanOrangeShimmer = {
    year: 2026,
    set: "Bowman Chrome",
    cardNumber: "CPA-EHA",
    parallel: "Orange Shimmer Refractor",
    knownDifferentParallels: [
      "Orange Wave Refractor",
      "Orange X-Fractor",
      "Refractor",
      "Blue Refractor",
    ],
  };

  it("perfect Raw match: parallel + cardNumber + year + set → high score", () => {
    const t = "2026 Bowman Chrome Orange Shimmer Refractor Eric Hartman CPA-EHA Auto /25";
    const s = scoreListing(t, hartmanOrangeShimmer);
    expect(s.score).toBeGreaterThanOrEqual(90);
    expect(s.parallelHit).toBe(true);
    expect(s.wrongParallelHit).toBeNull();
    expect(s.cardNumberHit).toBe(true);
    expect(s.yearHit).toBe(true);
    expect(s.setHit).toBe(true);
  });

  it("wrong parallel (Orange Wave) penalized below threshold", () => {
    const t = "2026 Bowman Chrome Orange Wave Refractor Eric Hartman CPA-EHA Auto /25";
    const s = scoreListing(t, hartmanOrangeShimmer);
    expect(s.wrongParallelHit).toBe("Orange Wave Refractor");
    // year(10) + set(10) + cardNumber(20) - wrongParallel(30) = 10 → below default 30 threshold
    expect(s.score).toBeLessThan(30);
  });

  it("Refractor (base parallel) does not hit as parallel", () => {
    const t = "2026 Bowman Chrome Refractor Eric Hartman CPA-EHA";
    const s = scoreListing(t, hartmanOrangeShimmer);
    // Correct parallel is "Orange Shimmer Refractor" — full-token
    // match requires "orange" + "shimmer" + "refractor" all present.
    // Title only has "refractor" → parallelHit false.
    expect(s.parallelHit).toBe(false);
    // knownDifferentParallels: "Refractor" is a token-subset of
    // "Orange Shimmer Refractor" so it's skipped as a wrong-parallel
    // candidate — it might just be part of the correct name. Since
    // no OTHER wrong-parallel matches, wrongParallelHit stays null.
    expect(s.wrongParallelHit).toBeNull();
  });

  it("Raw owner sees a graded listing → penalize (raw-but-graded)", () => {
    const t = "2026 Bowman Chrome Orange Shimmer Refractor Eric Hartman PSA 10";
    const s = scoreListing(t, hartmanOrangeShimmer);   // no gradeCompany → Raw
    expect(s.gradeMatch).toBe("raw-but-graded");
    // parallel(50) + year(10) + set(10) + raw-but-graded(-30) = 40
    expect(s.score).toBe(40);
  });

  it("PSA 10 owner sees exact PSA 10 listing → +20 grade bonus", () => {
    const t = "2026 Bowman Chrome Orange Shimmer Refractor Eric Hartman CPA-EHA PSA 10";
    const s = scoreListing(t, {
      ...hartmanOrangeShimmer,
      gradeCompany: "PSA",
      gradeValue: "10",
    });
    expect(s.gradeMatch).toBe("correct");
    // parallel(50) + cardNumber(20) + year(10) + set(10) + correct(20) = 110
    expect(s.score).toBe(110);
  });

  it("PSA 10 owner sees BGS 9.5 listing → wrong-grade penalty", () => {
    const t = "2026 Bowman Chrome Orange Shimmer Eric Hartman BGS 9.5";
    const s = scoreListing(t, {
      ...hartmanOrangeShimmer,
      gradeCompany: "PSA",
      gradeValue: "10",
    });
    expect(s.gradeMatch).toBe("wrong-grade");
  });

  it("empty title → zero everything", () => {
    const s = scoreListing("", hartmanOrangeShimmer);
    expect(s.score).toBe(0);
    expect(s.parallelHit).toBe(false);
  });

  it("cardNumber with # prefix strips before matching", () => {
    const t = "2026 Bowman Chrome Orange Shimmer Refractor Eric Hartman CPA-EHA";
    const s = scoreListing(t, { ...hartmanOrangeShimmer, cardNumber: "#CPA-EHA" });
    expect(s.cardNumberHit).toBe(true);
  });
});

describe("rankAndFilter", () => {
  const hartmanOrangeShimmer = {
    year: 2026,
    set: "Bowman Chrome",
    cardNumber: "CPA-EHA",
    parallel: "Orange Shimmer Refractor",
    knownDifferentParallels: ["Orange Wave Refractor", "Refractor"],
  };

  const listings = [
    { id: "A", title: "2026 Bowman Chrome Orange Shimmer Refractor Eric Hartman CPA-EHA Auto /25" }, // top
    { id: "B", title: "2026 Bowman Chrome Orange Wave Refractor Eric Hartman CPA-EHA" },           // wrong parallel
    { id: "C", title: "2026 Bowman Chrome Refractor Eric Hartman CPA-EHA" },                        // base
    { id: "D", title: "Random unrelated card" },                                                    // noise
    { id: "E", title: "2026 Bowman Chrome Orange Shimmer Eric Hartman" },                           // partial (no CPA-EHA)
    { id: "F", title: "2026 Bowman Chrome Orange Shimmer Refractor Eric Hartman PSA 10 CPA-EHA" },  // graded, but Raw owner
  ];

  it("returns ranked results above threshold, drops noise", () => {
    const out = rankAndFilter(listings, hartmanOrangeShimmer, 5);
    // A is the perfect match: parallel + cardNumber + year + set = 90
    expect(out[0].id).toBe("A");
    // F (graded PSA 10, Raw owner) still above threshold at 60,
    // ranked below A. Rendered with the wrong-grade badge on iOS.
    expect(out.map((x) => x.id)).toContain("F");
    // Dropped: D (random noise) and B (wrong parallel Orange Wave).
    // "Orange Wave Refractor" is a distinguishing wrong-parallel (has
    // "wave" token, correct parallel does not) → fires the -30 penalty.
    const ids = out.map((x) => x.id);
    expect(ids).not.toContain("D");
    expect(ids).not.toContain("B");
    // C (base "Refractor" only) IS included with a medium score of 40.
    // "Refractor" alone is a token-subset of "Orange Shimmer Refractor"
    // so it's not treated as a distinguishing wrong-parallel. iOS
    // surfaces it with the low-confidence badge so the user can judge.
    expect(ids).toContain("C");
  });

  it("limit=1 returns only the best match", () => {
    const out = rankAndFilter(listings, hartmanOrangeShimmer, 1);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("A");
  });

  it("passthrough matchScore + scoreBreakdown for iOS to render badges", () => {
    const out = rankAndFilter(listings, hartmanOrangeShimmer, 5);
    expect(typeof out[0].matchScore).toBe("number");
    expect(out[0].scoreBreakdown.parallelHit).toBe(true);
  });

  it("empty input array returns empty", () => {
    expect(rankAndFilter([], hartmanOrangeShimmer)).toEqual([]);
  });
});
