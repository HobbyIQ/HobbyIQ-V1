/**
 * CF-FINAL-PRICE-COHERENCE (2026-08-22) — unit tests on the two guards.
 *
 * Both guards existed already in narrower forms. Both bugs they close share
 * one shape — the same shape as the Kurtz canonical-override bug: a CORRECT
 * guard scoped to ONE code path, while the value can arrive by several.
 *
 *   Barry Bonds  (46f3dd96)  fairMarketValue 112.50 with estimateLow 21 /
 *                estimateHigh 31 / estimatedValue 26 and valuationStatus
 *                "estimated". The UI rendered 112.50; the engine's own band
 *                said 21-31.
 *
 *   Jac Caglianone (9b971b03)  $9.66 published against $205.48 paid (4.7%).
 *                CF-COST-BASIS-SANITY-FLOOR would have caught it, but that
 *                floor lived inside the our-pool branch and this holding
 *                arrived with pricingSource=null.
 *
 * Why the cost-basis guard FLAGS rather than re-prices: flipping eBay
 * title-over-aspect precedence was measured at 10 of 59 titled holdings
 * (16.9%) changing identity, of which only 2 were genuine errors — the rest
 * were the documented product-family ladder. Guessing a different slug here
 * would stack a second guess on the first.
 */
import { describe, it, expect } from "vitest";
import {
  reconcileEstimatedFmvToBand,
  costBasisReviewPatch,
} from "../src/services/portfolioiq/portfolioStore.service.js";

describe("reconcileEstimatedFmvToBand", () => {
  it("replaces an FMV that sits ABOVE its own band (the Bonds shape)", () => {
    const r = reconcileEstimatedFmvToBand({
      valuationStatus: "estimated",
      fairMarketValue: 112.5,
      estimateLow: 21,
      estimateHigh: 31,
      estimatedValue: 26,
    });
    expect(r.changed).toBe(true);
    expect(r.fmv).toBe(26);
  });

  it("replaces an FMV that sits BELOW its own band", () => {
    const r = reconcileEstimatedFmvToBand({
      valuationStatus: "estimated",
      fairMarketValue: 3,
      estimateLow: 21,
      estimateHigh: 31,
      estimatedValue: 26,
    });
    expect(r.changed).toBe(true);
    expect(r.fmv).toBe(26);
  });

  it("leaves an FMV INSIDE the band untouched", () => {
    const r = reconcileEstimatedFmvToBand({
      valuationStatus: "estimated",
      fairMarketValue: 24,
      estimateLow: 21,
      estimateHigh: 31,
      estimatedValue: 26,
    });
    expect(r.changed).toBe(false);
    expect(r.fmv).toBe(24);
  });

  it("treats the band as inclusive at both edges", () => {
    for (const v of [21, 31]) {
      const r = reconcileEstimatedFmvToBand({
        valuationStatus: "estimated",
        fairMarketValue: v,
        estimateLow: 21,
        estimateHigh: 31,
        estimatedValue: 26,
      });
      expect(r.changed).toBe(false);
      expect(r.fmv).toBe(v);
    }
  });

  it("does NOT touch observed holdings — only estimated ones have a band to honour", () => {
    const r = reconcileEstimatedFmvToBand({
      valuationStatus: "observed",
      fairMarketValue: 112.5,
      estimateLow: 21,
      estimateHigh: 31,
      estimatedValue: 26,
    });
    expect(r.changed).toBe(false);
    expect(r.fmv).toBe(112.5);
  });

  it("falls back to null when there is no usable estimatedValue", () => {
    const r = reconcileEstimatedFmvToBand({
      valuationStatus: "estimated",
      fairMarketValue: 112.5,
      estimateLow: 21,
      estimateHigh: 31,
      estimatedValue: null,
    });
    expect(r.changed).toBe(true);
    expect(r.fmv).toBeNull();
  });

  it("is inert when the band is absent", () => {
    const r = reconcileEstimatedFmvToBand({
      valuationStatus: "estimated",
      fairMarketValue: 112.5,
      estimateLow: null,
      estimateHigh: null,
      estimatedValue: 26,
    });
    expect(r.changed).toBe(false);
    expect(r.fmv).toBe(112.5);
  });
});

describe("costBasisReviewPatch", () => {
  it("flags the Caglianone shape: $9.66 against $205.48 paid", () => {
    const p = costBasisReviewPatch({ costBasis: 205.48, fairMarketValue: 9.6625, quantity: 1 });
    expect(p.needsReview).toBe(true);
    expect(p.reviewReason).toContain("4.7");
    expect(p.reviewReason).toContain("205.48");
  });

  it("does NOT flag a normal holding priced near cost", () => {
    const p = costBasisReviewPatch({ costBasis: 205.48, fairMarketValue: 190, quantity: 1 });
    expect(p.needsReview).toBeUndefined();
  });

  it("does NOT flag cheap holdings, where a big ratio swing is ordinary", () => {
    // $6.85 Kurtz card at $3.10 is 45% of cost but only $6.85 at stake.
    const p = costBasisReviewPatch({ costBasis: 6.85, fairMarketValue: 0.2, quantity: 1 });
    expect(p.needsReview).toBeUndefined();
  });

  it("respects the $50 minimum-cost boundary", () => {
    expect(costBasisReviewPatch({ costBasis: 50, fairMarketValue: 1 }).needsReview).toBeUndefined();
    expect(costBasisReviewPatch({ costBasis: 50.01, fairMarketValue: 1 }).needsReview).toBe(true);
  });

  it("respects the 15% floor boundary", () => {
    // exactly 15% must NOT flag; a hair under must flag
    expect(costBasisReviewPatch({ costBasis: 100, fairMarketValue: 15 }).needsReview).toBeUndefined();
    expect(costBasisReviewPatch({ costBasis: 100, fairMarketValue: 14.99 }).needsReview).toBe(true);
  });

  it("multiplies by quantity before comparing", () => {
    // Chosen so the two readings DISAGREE, otherwise this test proves nothing:
    //   with qty:    4 x $10 = $40 / $200 = 20%  -> no flag
    //   without qty:      $10 / $200 =  5%       -> would flag
    // An earlier version used $30 x 4, which lands exactly on the 15% boundary
    // and returns "no flag" either way — it passed against a mutant that
    // dropped the multiply entirely.
    expect(costBasisReviewPatch({ costBasis: 200, fairMarketValue: 10, quantity: 4 }).needsReview).toBeUndefined();
    // And the single-quantity reading of the same numbers DOES flag.
    expect(costBasisReviewPatch({ costBasis: 200, fairMarketValue: 10, quantity: 1 }).needsReview).toBe(true);
  });

  it("is inert when there is no price or no cost", () => {
    expect(costBasisReviewPatch({ costBasis: 205.48, fairMarketValue: null }).needsReview).toBeUndefined();
    expect(costBasisReviewPatch({ costBasis: null, fairMarketValue: 9.66 }).needsReview).toBeUndefined();
    expect(costBasisReviewPatch({ costBasis: 0, fairMarketValue: 9.66 }).needsReview).toBeUndefined();
  });
});
