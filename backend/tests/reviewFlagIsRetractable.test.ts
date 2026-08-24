import { describe, it, expect } from "vitest";
import {
  costBasisReviewPatch,
  isCostBasisReviewReason,
  COST_BASIS_REVIEW_FLOOR_PCT,
} from "../src/services/portfolioiq/portfolioStore.service.js";

/**
 * CF-A-REVIEW-FLAG-MUST-BE-RETRACTABLE (Drew, 2026-08-23).
 *
 * "But missing doesn't go away after I verify it."
 * "I selected the correct card and it still does this."
 *
 * The real holding: aff3236a, 2025 Bowman Draft Gold Refractor /50 auto,
 * $301.43 paid. The owner picked the correct catalog card through the new
 * accept-identity flow. It worked — cardId and hobbyiqCardId both pinned to
 * hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50, verified
 * by catalog-picker. The reprice ran and moved the stored value from $13.50 to
 * $53.77, taking it from 4.5% of cost to 17.8% — above the 15% floor.
 *
 * And the card still said "FMV $13.50 is 4.48% of $301.43 paid — likely a
 * card-identity mismatch", because the check that wrote that sentence returned
 * `{}` on a healthy ratio, and `{}` spreads as "leave it exactly as it was".
 *
 * The flag was a one-way switch. Every reprice after the first flagging was
 * incapable of changing the outcome, so no amount of correct work by the owner
 * could ever clear it.
 */
describe("the cost-basis review flag can be retracted", () => {
  const REASON =
    "FMV $13.50 is 4.48% of $301.43 paid — likely a card-identity mismatch, not a price move.";

  it("retracts its own flag once the value recovers above the floor", () => {
    // The exact numbers from holding aff3236a, before and after.
    const p = costBasisReviewPatch({
      costBasis: 301.43,
      fairMarketValue: 53.77,
      quantity: 1,
      needsReview: true,
      reviewReason: REASON,
    });
    expect(p.needsReview).toBe(false);
    expect(p.reviewReason).toBeNull();
    // Sanity: 53.77/301.43 really is above the floor, so this test is about
    // retraction and not about the threshold moving.
    expect(53.77 / 301.43).toBeGreaterThan(COST_BASIS_REVIEW_FLOOR_PCT);
  });

  it("does NOT retract a flag raised by the unidentified-holding guard", () => {
    // Same healthy ratio, but the flag belongs to a different concern whose
    // reason is still true. Clearing it here is the wrong-scope defect.
    const p = costBasisReviewPatch({
      costBasis: 301.43,
      fairMarketValue: 53.77,
      quantity: 1,
      needsReview: true,
      reviewReason:
        "We could not identify this card, so we are not showing a value. Confirm the set, card number and parallel.",
    });
    expect(p.needsReview).toBeUndefined();
    expect(p.reviewReason).toBeUndefined();
  });

  it("does not retract while there is no price to judge", () => {
    // A holding that lost its value has not been vindicated, it has gone
    // quiet. Dropping the flag here would hide it.
    const p = costBasisReviewPatch({
      costBasis: 301.43,
      fairMarketValue: null,
      quantity: 1,
      needsReview: true,
      reviewReason: REASON,
    });
    expect(p.needsReview).toBeUndefined();
  });

  it("retracts when the cost basis falls below the floor's minimum", () => {
    // The check no longer applies to this holding, so it has no standing to
    // keep asserting anything about it.
    const p = costBasisReviewPatch({
      costBasis: 20,
      fairMarketValue: 1,
      quantity: 1,
      needsReview: true,
      reviewReason: REASON,
    });
    expect(p.needsReview).toBe(false);
  });

  it("still sets the flag when the value really is far below cost", () => {
    const p = costBasisReviewPatch({
      costBasis: 301.43,
      fairMarketValue: 13.5,
      quantity: 1,
      needsReview: false,
      reviewReason: null,
    });
    expect(p.needsReview).toBe(true);
    expect(p.reviewReason).toContain("4.48%");
    expect(isCostBasisReviewReason(p.reviewReason)).toBe(true);
  });

  it("never clears when the caller does not pass the stored state", () => {
    // Back-compat: callers that only want the set behaviour keep it.
    const p = costBasisReviewPatch({ costBasis: 301.43, fairMarketValue: 53.77 });
    expect(p.needsReview).toBeUndefined();
    expect(p.reviewReason).toBeUndefined();
  });

  it("recognises its own sentence and no one else's", () => {
    expect(isCostBasisReviewReason(REASON)).toBe(true);
    expect(isCostBasisReviewReason("We could not identify this card, so we are not showing a value.")).toBe(false);
    expect(isCostBasisReviewReason(null)).toBe(false);
    expect(isCostBasisReviewReason(undefined)).toBe(false);
    expect(isCostBasisReviewReason(42)).toBe(false);
  });
});
