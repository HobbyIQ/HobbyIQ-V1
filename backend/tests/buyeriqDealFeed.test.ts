// CF-BUYERIQ-DEAL-FEED (Drew, 2026-09-02). Pins the scan's behaviour at
// the boundaries: budget exhaustion truncates AND SAYS SO, cache hits
// ride free, title verification gates cross-parallel listings, and the
// no-basis / speculative refusals survive the round trip through the
// service (not just the pure gate).

import { describe, expect, it, vi, beforeEach } from "vitest";

const listTargets = vi.fn();
const fetchCardActiveListings = vi.fn();
const readCachedActiveListings = vi.fn();
const writeCachedActiveListings = vi.fn();
const computeCanonicalFmv = vi.fn();

vi.mock("../src/services/buyeriq/buyeriqStore.service.js", () => ({
  listTargets: (...a: unknown[]) => listTargets(...a),
}));
vi.mock("../src/services/ebay/ebayListingSearch.service.js", () => ({
  fetchCardActiveListings: (...a: unknown[]) => fetchCardActiveListings(...a),
}));
vi.mock("../src/services/ebay/ebayActiveListingsCache.service.js", () => ({
  readCachedActiveListings: (...a: unknown[]) => readCachedActiveListings(...a),
  writeCachedActiveListings: (...a: unknown[]) => writeCachedActiveListings(...a),
}));
// The feed prices through the one valuation path's canonical-shaped door
// (canonicalValuation.ts -> valueIdentity), so THAT is what a unit test of the
// feed's SELECTION logic stubs. The old mock named computeCanonicalFmv, the
// second engine the feed no longer calls.
vi.mock("../src/services/compiq/canonicalValuation.js", () => ({
  computeCanonicalValuation: (...a: unknown[]) => computeCanonicalFmv(...a),
}));

const { scanDeals } = await import("../src/services/buyeriq/dealFeed.service.js");

function target(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: "u1",
    docType: "target" as const,
    listId: "l1",
    // H-2 (audit 2026-09-03): a target with no slug is REFUSED, never priced
    // off a minted `buyeriq-identity:...` cache key. Every fixture here is a
    // target that HAS a catalog identity, which is the case these tests are
    // about; the refusal itself is pinned separately below.
    hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto",
    playerName: "Eric Hartman",
    cardYear: 2026,
    setName: "Bowman Chrome",
    cardNumber: "CPA-EHA",
    parallel: null,
    gradeCompany: null,
    gradeValue: null,
    status: "wanted" as const,
    priority: "medium" as const,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

// CF-BUYERIQ-GRADE-AWARE-MATCH (2026-09-03): the default target below is
// RAW (gradeCompany null), so the default listing title must SAY raw.
// Since the grade fix, a title that does not settle its grade tier is
// "grade unknown" and is not scored at all — which is the point of the
// fix, and which would otherwise silently empty every test here. Tests
// that care about the grade axis pass their own title.
function listing(id: string, price: number, title = "2026 Bowman Chrome Eric Hartman CPA-EHA Raw") {
  return {
    id,
    title,
    price,
    currency: "USD",
    imageUrl: null,
    itemWebUrl: `https://ebay.com/itm/${id}`,
    seller: { username: "seller1", feedbackScore: 100, feedbackPercentage: 99.5 },
    endsAt: null,
    matchScore: 1,
    scoreBreakdown: {} as never,
  };
}

function fmv(value: number | null, confidence: number, method = "direct-comp", rungLabel = "exact-pool-projection") {
  return { fmv: value, confidence, method, rungLabel, provenance: { summary: "", compCount: null, comps: [], trendPctPerMonth: null, multipliers: {} }, computedAt: "2026-09-02T00:00:00Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  readCachedActiveListings.mockResolvedValue(null);
  writeCachedActiveListings.mockResolvedValue(undefined);
});

describe("scanDeals — the deals feed", () => {
  it("flags a listing under the confidence-weighted threshold, with its basis", async () => {
    listTargets.mockResolvedValue([target("t1")]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 70)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(1);
    const deal = res.deals[0];
    expect(deal.listing.price).toBe(70);
    expect(deal.basis.projection).toBe(100);
    expect(deal.basis.rung).toBe("exact-pool-projection");
    expect(deal.basis.exactPool).toBe(true);
    expect(deal.basis.confidence).toBe(0.9);
    expect(deal.discountPctDisplay).toBeCloseTo(30, 5);
    expect(deal.requiredDiscountPctDisplay).toBeCloseTo(20, 5);
    expect(deal.savingsVsProjection).toBe(30);
    expect(res.complete).toBe(true);
    expect(res.stoppedReason).toBeNull();
  });

  it("does NOT flag a speculative projection, and says why", async () => {
    listTargets.mockResolvedValue([target("t1")]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 75)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.2, "player-index-projection", "player-index-projection"));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toBe("speculative-confidence");
  });

  it("does NOT flag a no-basis projection at any price", async () => {
    listTargets.mockResolvedValue([target("t1")]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 1)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(null, 0.0, "no-basis", "no-basis"));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(0);
    expect(res.skipped[0].reason).toBe("no-basis");
    expect(res.skipped[0].basis).toBeNull();
  });

  it("keeps the DEEPEST qualifying listing per target", async () => {
    listTargets.mockResolvedValue([target("t1")]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 75), listing("i2", 55), listing("i3", 70)],
      totalReported: 3, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(1);
    expect(res.deals[0].listing.listingId).toBe("i2");
    expect(res.deals[0].discountPctDisplay).toBeCloseTo(45, 5);
  });

  it("sorts the feed deepest-discount first", async () => {
    listTargets.mockResolvedValue([
      target("t1", { playerName: "Player A" }),
      target("t2", { playerName: "Player B" }),
    ]);
    fetchCardActiveListings
      .mockResolvedValueOnce({ listings: [listing("i1", 75, "2026 Bowman Chrome Player A CPA-EHA Raw")], totalReported: 1, effectiveQuery: "q", snapshottedAt: "" })
      .mockResolvedValueOnce({ listings: [listing("i2", 40, "2026 Bowman Chrome Player B CPA-EHA Raw")], totalReported: 1, effectiveQuery: "q", snapshottedAt: "" });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals.map((d) => d.listing.listingId)).toEqual(["i2", "i1"]);
  });

  it("only scans targets still wanted", async () => {
    listTargets.mockResolvedValue([
      target("t1", { status: "acquired" }),
      target("t2", { status: "passed" }),
    ]);

    const res = await scanDeals({ userId: "u1" });

    expect(res.targetsEligible).toBe(0);
    expect(fetchCardActiveListings).not.toHaveBeenCalled();
  });
});

describe("PINNED: budget exhaustion truncates the scan and reports it", () => {
  it("stops at the budget and marks the feed incomplete", async () => {
    listTargets.mockResolvedValue([target("t1"), target("t2"), target("t3"), target("t4")]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 70)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1", vendorCallBudget: 2 });

    // Two live calls made, then the third target's fetch was refused.
    expect(fetchCardActiveListings).toHaveBeenCalledTimes(2);
    expect(res.complete).toBe(false);
    expect(res.stoppedReason).toBe("vendor-call-budget-exhausted");
    expect(res.targetsScanned).toBe(2);
    expect(res.targetsEligible).toBe(4);
    expect(res.targetsUnexamined).toBe(2);
    expect(res.budget.spent).toBe(2);
    expect(res.budget.remaining).toBe(0);
  });

  it("still returns the deals it DID find before stopping", async () => {
    listTargets.mockResolvedValue([target("t1"), target("t2"), target("t3")]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 70)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1", vendorCallBudget: 1 });

    expect(res.deals.length).toBe(1);
    expect(res.complete).toBe(false);
  });

  it("a zero budget makes NO vendor call and reports a fully truncated scan", async () => {
    listTargets.mockResolvedValue([target("t1"), target("t2")]);

    const res = await scanDeals({ userId: "u1", vendorCallBudget: 0 });

    expect(fetchCardActiveListings).not.toHaveBeenCalled();
    expect(res.complete).toBe(false);
    expect(res.stoppedReason).toBe("vendor-call-budget-exhausted");
    expect(res.deals).toHaveLength(0);
    expect(res.targetsUnexamined).toBe(2);
  });

  it("cache hits do NOT draw down the budget — a fully-cached scan completes on a zero budget", async () => {
    listTargets.mockResolvedValue([target("t1"), target("t2"), target("t3")]);
    readCachedActiveListings.mockResolvedValue({
      listings: [listing("i1", 70)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1", vendorCallBudget: 0 });

    expect(fetchCardActiveListings).not.toHaveBeenCalled();
    expect(res.complete).toBe(true);
    expect(res.stoppedReason).toBeNull();
    expect(res.budget.cacheHits).toBe(3);
    expect(res.budget.spent).toBe(0);
    expect(res.deals).toHaveLength(3);
  });

  it("writes fetched listings back to the shared cache so the next reader rides free", async () => {
    listTargets.mockResolvedValue([target("t1")]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 70)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    await scanDeals({ userId: "u1" });

    expect(writeCachedActiveListings).toHaveBeenCalledTimes(1);
  });
});

describe("reuse: title verification gates the comparison", () => {
  it("does not price a Blue Refractor target against a base-card listing", async () => {
    listTargets.mockResolvedValue([target("t1", { parallel: "Blue Refractor" })]);
    fetchCardActiveListings.mockResolvedValue({
      // A base card at a base price — a 70% "discount" if we let it through.
      listings: [listing("i1", 30, "2026 Bowman Chrome Eric Hartman CPA-EHA Base")],
      totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(0);
    expect(res.skipped[0].reason).toBe("no-listings");
  });
});

// CF-BUYERIQ-GRADE-AWARE-MATCH (Drew, 2026-09-03). The grade half of the
// same identity check, at the SERVICE level — the pure-function pins
// live in buyeriqListingGradeMatch.test.ts. These prove the refusal
// survives the round trip and actually changes what the feed returns.
describe("PINNED: identity includes GRADE — the false positives the verifier found", () => {
  it("does NOT price a PSA 10 target against a RAW listing", async () => {
    listTargets.mockResolvedValue([
      target("t1", { gradeCompany: "PSA", gradeValue: 10 }),
    ]);
    fetchCardActiveListings.mockResolvedValue({
      // A raw card at a raw price. Against the PSA 10 projection of 100
      // this is a 70% "discount" — the exact shape of 6 of the 8 sampled
      // false positives.
      listings: [listing("i1", 30, "2026 Bowman Chrome Eric Hartman CPA-EHA Raw Ungraded")],
      totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(0);
    expect(res.skipped[0].reason).toBe("listing-raw-target-graded");
    // The feed must say listings EXIST but were the wrong tier — not the
    // misleading "nothing is listed".
    expect(res.skipped[0].gradeRejections).toMatchObject({ "listing-raw-target-graded": 1 });
  });

  it("does NOT price a PSA 10 target against a PSA 9 listing", async () => {
    listTargets.mockResolvedValue([
      target("t1", { gradeCompany: "PSA", gradeValue: 10 }),
    ]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 55, "2026 Bowman Chrome Eric Hartman CPA-EHA PSA 9")],
      totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(0);
    expect(res.skipped[0].reason).toBe("grade-value-mismatch");
  });

  it("DOES flag a PSA 10 listing against a PSA 10 target, and names the tier", async () => {
    listTargets.mockResolvedValue([
      target("t1", { gradeCompany: "PSA", gradeValue: 10 }),
    ]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 70, "2026 Bowman Chrome Eric Hartman CPA-EHA PSA 10 GEM MINT")],
      totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(1);
    expect(res.deals[0].matchedTier).toBe("PSA 10");
    expect(res.deals[0].discountPctDisplay).toBeCloseTo(30, 5);
  });

  it("PINNED: an unreadable grade is not scored, at any discount", async () => {
    listTargets.mockResolvedValue([
      target("t1", { gradeCompany: "PSA", gradeValue: 10 }),
    ]);
    fetchCardActiveListings.mockResolvedValue({
      // Says nothing about grade. A 95% "discount" must NOT rescue it.
      listings: [listing("i1", 5, "2026 Bowman Chrome Eric Hartman CPA-EHA")],
      totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(0);
    expect(res.skipped[0].reason).toBe("grade-unknown");
  });

  it("PINNED: a silent title is not assumed RAW for a raw target either", async () => {
    listTargets.mockResolvedValue([target("t1")]);   // raw target
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 30, "2026 Bowman Chrome Eric Hartman CPA-EHA")],
      totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(0);
    expect(res.skipped[0].reason).toBe("grade-unknown");
  });

  it("picks the deepest listing IN TIER, not the deepest overall", async () => {
    listTargets.mockResolvedValue([
      target("t1", { gradeCompany: "PSA", gradeValue: 10 }),
    ]);
    fetchCardActiveListings.mockResolvedValue({
      listings: [
        // Cheapest, but RAW — must not win, and must not appear at all.
        listing("i1", 20, "2026 Bowman Chrome Eric Hartman CPA-EHA Raw"),
        listing("i2", 70, "2026 Bowman Chrome Eric Hartman CPA-EHA PSA 10"),
      ],
      totalReported: 2, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));

    const res = await scanDeals({ userId: "u1" });

    expect(res.deals).toHaveLength(1);
    expect(res.deals[0].listing.listingId).toBe("i2");
    expect(res.deals[0].matchedTier).toBe("PSA 10");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H-2 reached the FEED too (audit follow-up to #1679)
// ────────────────────────────────────────────────────────────────────────────
describe("PINNED: a target with no catalog identity is refused, never minted", () => {
  it("refuses by name, prices nothing, and never reaches the engine", async () => {
    listTargets.mockResolvedValue([target("t1", { hobbyiqCardId: null })]);
    // Listings ARE available and deeply discounted, so nothing but the
    // identity refusal can be what stops this becoming a deal.
    fetchCardActiveListings.mockResolvedValue({
      listings: [listing("i1", 70)], totalReported: 1, effectiveQuery: "q", snapshottedAt: "",
    });
    computeCanonicalFmv.mockResolvedValue(fmv(100, 0.9));
    // The live shape: a wanted target the user added by hand, with no slug.
    // The old feed passed `cacheCardId(t)` — "buyeriq-identity:2026:bowman
    // chrome:eric hartman:cpa-eha:" — into the engine, priced whatever pool
    // that collided with, and published it as DealBasis.projection.
    // MUTATION: restoring `cardId: t.hobbyiqCardId ?? cacheCardId(t)` makes
    // this red — the engine would be called and a deal could be flagged.
    const res = await scanDeals({ userId: "u1" });
    expect(res.deals).toEqual([]);
    expect(res.skipped).toEqual([
      { targetId: "t1", playerName: "Eric Hartman", reason: "no-catalog-identity", basis: null },
    ]);
    expect(computeCanonicalFmv).not.toHaveBeenCalled();
  });
});
