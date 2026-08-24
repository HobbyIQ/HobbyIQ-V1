import { describe, it, expect } from "vitest";
import { buildEstimateRequestFromHolding } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

/**
 * CF-THE-GUARD-NEVER-SAW-THE-CARD-NUMBER (2026-08-23).
 *
 * CF-SIBLING-POOL-SKIP-FOR-AUTOS was written on 2026-07-04 to stop the
 * computeEstimate sibling rescue from pricing a Bowman auto off its whole
 * player+product segment. The commit that added it cites the failure it was
 * preventing: "the 2026-07-03 Hartman LogoFractor (CPA-EHA) trace showed 315
 * sibling sales producing a weighted median of $9 for a card CH catalogs at
 * $1038."
 *
 * It reads cardIdentity.number, and on the portfolio rail that was always
 * null, because buildEstimateRequestFromHolding never populated cardNumber:
 *
 *   builder omits cardNumber
 *     -> needsParseFallback needs !cardYear && !product, and the builder sets
 *        both, so the defensive re-parse never runs either
 *     -> cardNumber: body.cardNumber ?? parsed?.cardNumber ?? undefined
 *     -> buildIdentityFromContext: number: ctx?.cardNumber ?? null
 *     -> NUMBER_IS_AUTO_PREFIX.test("") === false
 *     -> the rescue the guard exists to prevent runs on every reprice
 *
 * Prod at the time of the fix: 5 of 92 holdings carried the rescue's own
 * verdict string, every one a numbered auto, at 0.7%-19.2% of cost.
 *
 * This is the same defect shape this codebase keeps producing — a guard that
 * is correct in isolation, running on only one of the paths its value travels.
 */
describe("the auto-prefix guard receives a card number from the portfolio rail", () => {
  // The real prod holding, field for field.
  const gillen = {
    id: "afd40fed-f7fd-45f1-8a1f-e5122fadcf55",
    playerName: "Theo Gillen",
    cardNumber: "CPA-TG",
    cardYear: 2024,
    product: "Bowman Draft",
    parallel: "Blue Refractor",
    isAuto: true,
    quantity: 1,
    purchasePrice: 700,
  } as unknown as PortfolioHolding;

  // Copied from compiqEstimate.service.ts:6363 — if that regex changes, this
  // test should be updated deliberately, not silently pass on a stale copy.
  const NUMBER_IS_AUTO_PREFIX =
    /^(CPA|CDA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA|AU|HSA|RRA|PRV|TEK)(-|$)/i;

  it("puts the card number on the request at all", () => {
    expect(buildEstimateRequestFromHolding(gillen).cardNumber).toBe("CPA-TG");
  });

  it("carries a number the auto-prefix guard actually matches", () => {
    // The whole point. A request that carries "" or undefined here is a
    // request the guard cannot act on, which is the bug.
    const req = buildEstimateRequestFromHolding(gillen);
    expect(typeof req.cardNumber).toBe("string");
    expect(NUMBER_IS_AUTO_PREFIX.test(req.cardNumber ?? "")).toBe(true);
  });

  it("covers the other four holdings the rescue was pricing in prod", () => {
    for (const cardNumber of ["CPA-MWI", "CPA-TG", "CPA-DT", "CPA-GF"]) {
      const req = buildEstimateRequestFromHolding({ ...gillen, cardNumber } as PortfolioHolding);
      expect(NUMBER_IS_AUTO_PREFIX.test(req.cardNumber ?? ""), cardNumber).toBe(true);
    }
  });

  it("omits the field rather than sending an empty string", () => {
    // undefined and "" are not the same to the guard's typeof check, and an
    // empty string would also pollute the engine's LRU cache key.
    for (const bad of [undefined, null, "", "   "]) {
      const req = buildEstimateRequestFromHolding({ ...gillen, cardNumber: bad } as unknown as PortfolioHolding);
      expect(req.cardNumber, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("leaves non-auto card numbers alone — the guard must NOT fire for them", () => {
    // A base card's sibling rescue is legitimate; this fix must not suppress it.
    const base = { ...gillen, cardNumber: "BDC-17", isAuto: false } as PortfolioHolding;
    const req = buildEstimateRequestFromHolding(base);
    expect(req.cardNumber).toBe("BDC-17");
    expect(NUMBER_IS_AUTO_PREFIX.test(req.cardNumber ?? "")).toBe(false);
  });

  it("makes a card-number correction a repricing trigger", () => {
    // estimateInputChanged diffs this function's output, so a field that was
    // absent could never trigger a reprice when it was fixed.
    const a = JSON.stringify(buildEstimateRequestFromHolding(gillen));
    const b = JSON.stringify(buildEstimateRequestFromHolding({ ...gillen, cardNumber: "CPA-MWI" } as PortfolioHolding));
    expect(a).not.toBe(b);
  });
});
