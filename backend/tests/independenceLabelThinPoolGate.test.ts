// CF-A-CAVEAT-THAT-FIRES-EVERYWHERE-SAYS-NOTHING (Drew, 2026-09-04).
//
// #1775 made `independence-unverified` TRUTHFUL. It did not make it
// INFORMATIVE. `sellerHandle` is absent on all but 24 of 6.87M sold_comps
// rows, so `basis` is `row-count` on essentially every exact-pool result in
// production and the label fired on all of them. A sentence that appears on
// every card tells a reader nothing about any card, and it crowds out the
// readings that do.
//
// Drew's ruling (2026-09-04): show it ONLY where it changes the read — on a
// THIN pool, where one seller could plausibly be behind every sale. No label
// on a healthy pool (many sales across many dates with spread prices).
//
// The gate hides nothing: #1775 threads each row's `sellerHandle` onto
// `provenance.comps`, so any caller can run `assessSellerIndependence` over
// the wire and recover the basis for itself. Only the SENTENCE is gated.
//
// The measured rule, pinned here: thin is `provenance.compCount < 5`.
// Distinct sale dates was the other candidate and cannot be measured
// honestly at the label site — `labelsForResult` sees `provenance.comps`,
// which canonicalFmv.service.ts truncates to the first 8-10 rows, so
// counting dates over it counts a rendering artifact and would call a
// 40-sale pool thin whenever its sample landed on two days. `compCount` is
// the pool total and is never truncated.
//
// MUTATION: drop the size gate (`isThinPoolForIndependence` -> always true,
// or delete the conjunct) and "a healthy 12-sale pool carries NO label"
// turns red. Drop the `seller-identity` guard on the second branch and
// "never speaks a seller COUNT it did not observe" turns red.
import { describe, it, expect } from "vitest";
import { labelsForResult } from "../src/services/ebay/ebaySellDraft.service.js";
import {
  isThinPoolForIndependence,
  INDEPENDENCE_THIN_POOL_MAX_SALES,
} from "../src/services/compiq/sellerIndependence.js";
import type { CanonicalFmvResult } from "../src/services/compiq/canonicalFmv.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

/** A comp as the wire carries it. `sellerHandle: null` is the production
 *  shape for every vendor row. */
function comp(price: number, d: number, sellerHandle: string | null = null) {
  return {
    price,
    soldAt: daysAgo(d),
    source: "tca-ebay",
    parallel: null,
    verifiedByUser: false,
    contributorUserId: null,
    sellerHandle,
  };
}

/** An exact-pool result. `compCount` is the POOL total; `comps` is the
 *  truncated display sample, exactly as canonicalFmv builds it. */
function exactPoolResult(input: {
  compCount: number;
  comps: ReturnType<typeof comp>[];
  confidence?: number;
}): CanonicalFmvResult {
  return {
    fairMarketValue: 300,
    confidence: input.confidence ?? 0.9,
    rungLabel: "exact-pool-last-sale",
    provenance: {
      summary: "fixture",
      compCount: input.compCount,
      comps: input.comps.slice(0, 8),
      trendPctPerMonth: null,
      multipliers: {},
    },
  } as unknown as CanonicalFmvResult;
}

const codes = (r: CanonicalFmvResult) => labelsForResult(r, null).map((l) => l.code);
const independenceLabel = (r: CanonicalFmvResult) =>
  labelsForResult(r, null).find((l) => l.code === "independence-unverified") ?? null;

describe("the thin-pool gate — the label fires only where it changes the read", () => {
  it("THIN, sellers invisible: 3 anonymous sales -> independence-unverified", () => {
    // One seller could plausibly be behind all three, and our sources cannot
    // rule it out. This is the case the caveat exists for.
    const r = exactPoolResult({ compCount: 3, comps: [comp(300, 5), comp(310, 12), comp(295, 20)] });
    const l = independenceLabel(r);
    expect(l).not.toBeNull();
    expect(l!.text).toMatch(/only 3 sales back this estimate/i);
    expect(l!.text).toMatch(/do not tell us who sold them/i);
    expect(l!.text).toMatch(/one seller could be behind all of them/i);
    // It never claims to have counted sellers.
    expect(l!.text).not.toMatch(/only \d+ independent seller/i);
  });

  it("HEALTHY, sellers invisible: a 12-sale pool carries NO independence label", () => {
    // THE MUTATION TARGET. Drop the size gate and this turns red — which is
    // exactly the #1775 behaviour Drew ruled against: a caveat on every card.
    const r = exactPoolResult({
      compCount: 12,
      comps: Array.from({ length: 12 }, (_, i) => comp(300 + i * 5, i * 7)),
    });
    expect(codes(r)).not.toContain("independence-unverified");
  });

  it("the boundary is measured and pinned: 4 labels, 5 does not", () => {
    // 5 is measured, not chosen. Drew's 43 holdings, read-only 2026-09-04:
    // the 27 that #1775 labeled have pool sizes clustering at 2 and 3
    // (eight holdings) and then jumping to 5, 7, 8, 9, 10, 13, 14, 18, 39,
    // 51, 112, 119, 151, 647. The floor sits in that gap, and it is not on
    // a knife edge — a floor of 4 labels the SAME eight; only at 6 does the
    // count move (to 12). Under this floor 27 labels become 8.
    expect(INDEPENDENCE_THIN_POOL_MAX_SALES).toBe(5);
    const four = exactPoolResult({ compCount: 4, comps: Array.from({ length: 4 }, (_, i) => comp(300, i * 6)) });
    const five = exactPoolResult({ compCount: 5, comps: Array.from({ length: 5 }, (_, i) => comp(300, i * 6)) });
    expect(codes(four)).toContain("independence-unverified");
    expect(codes(five)).not.toContain("independence-unverified");
    expect(isThinPoolForIndependence(4)).toBe(true);
    expect(isThinPoolForIndependence(5)).toBe(false);
  });

  it("reads compCount, NOT the truncated sample: a 40-sale pool showing 8 rows is not thin", () => {
    // `comps` is capped at 8 by canonicalFmv.service.ts. A gate written
    // against `comps.length` would label this deep pool thin.
    const r = exactPoolResult({
      compCount: 40,
      comps: Array.from({ length: 40 }, (_, i) => comp(300 + i, i * 3)),
    });
    expect(r.provenance!.comps!.length).toBe(8);
    expect(codes(r)).not.toContain("independence-unverified");
  });

  it("SELLERS VISIBLE and too few: the count publishes as fact at ANY pool size", () => {
    // Not a caveat about our sources — an observation about this market.
    // A 12-sale pool from 2 named sellers is a real concentration finding and
    // the size gate must not suppress it.
    const twelveFromTwo = Array.from({ length: 12 }, (_, i) =>
      comp(300 + i * 4, i * 7, i % 2 === 0 ? "probstein123" : "dcsports87"),
    );
    const r = exactPoolResult({ compCount: 12, comps: twelveFromTwo });
    const l = independenceLabel(r);
    expect(l).not.toBeNull();
    expect(l!.text).toMatch(/only 2 independent sellers stand behind this estimate/i);
  });

  it("SELLERS VISIBLE and enough: three different sellers carry no label at all", () => {
    const r = exactPoolResult({
      compCount: 3,
      comps: [comp(300, 5, "dcsports87"), comp(310, 12, "comc_consignment"), comp(295, 20, "old_cards_crib")],
    });
    expect(codes(r)).not.toContain("independence-unverified");
  });

  it("never speaks a seller COUNT it did not observe on a healthy anonymous pool", () => {
    // MUTATION TARGET for the identity guard on the second branch.
    //
    // `assessSellerIndependence` is handed `comps` — the TRUNCATED display
    // sample — while the size gate reads `compCount`, the pool total. Those
    // two disagree by construction, and this is the shape where the
    // disagreement bites: a healthy 12-sale pool whose result carries a
    // 2-row sample. The size gate correctly says "not thin", so the first
    // branch stays silent; the verdict over the sample is
    // `{basis: "row-count", count: 2, meets: false}`.
    //
    // Without `basis === "seller-identity"` on the else-if, that falls
    // straight into the branch that speaks seller counts and announces
    // "only 2 independent sellers stand behind this estimate" — about a
    // 12-sale pool, from rows that name no seller at all. That is a
    // fabricated identity claim, and a worse defect than the row-count
    // conflation #1775 was written to end. The guard is what makes the
    // second branch mean what it says.
    const r = exactPoolResult({ compCount: 12, comps: [comp(300, 5), comp(340, 30)] });
    for (const l of labelsForResult(r, null)) {
      expect(l.text).not.toMatch(/independent seller/i);
    }
    expect(codes(r)).not.toContain("independence-unverified");
  });

  it("a deep pool whose display sample is short is still not thin", () => {
    // The same disagreement, stated as the positive rule: the gate reads the
    // pool, never the sample it was rendered with.
    const r = exactPoolResult({ compCount: 40, comps: [comp(300, 5), comp(340, 30)] });
    expect(codes(r)).not.toContain("independence-unverified");
  });

  it("a fallback rung is still never given an independence caveat, thin or not", () => {
    const r = {
      ...exactPoolResult({ compCount: 2, comps: [comp(300, 5), comp(310, 9)] }),
      rungLabel: "family-baseline",
    } as unknown as CanonicalFmvResult;
    const c = codes(r);
    expect(c).not.toContain("independence-unverified");
    expect(c).toContain("fallback-rung");
  });

  it("prices and confidence are untouched by the gate", () => {
    // The label is a rendering decision. Nothing here may move a number.
    const thin = exactPoolResult({ compCount: 3, comps: [comp(300, 5), comp(310, 12), comp(295, 20)] });
    const healthy = exactPoolResult({
      compCount: 12,
      comps: Array.from({ length: 12 }, (_, i) => comp(300 + i * 5, i * 7)),
    });
    expect(thin.fairMarketValue).toBe(300);
    expect(healthy.fairMarketValue).toBe(300);
    expect(thin.confidence).toBe(0.9);
    expect(healthy.confidence).toBe(0.9);
  });
});
