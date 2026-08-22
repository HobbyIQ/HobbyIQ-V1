/**
 * CF-NO-REGRESSION-ON-STARVED-POOL (2026-08-22).
 *
 * A reprice that found nothing is a failed query, not an observation that the
 * card became unpriceable — and it must not be written down as a valuation.
 *
 * Live case: Shohei Ohtani 2018 Bowman Chrome #1 PSA 9 held a correct
 * fairMarketValue of $2,341.20, computed from 225 real PSA 9 sales and equal
 * to its own grade-curve tile. A reprice ran during a Cosmos throttling event
 * (17,834 x 429 in one five-minute bucket), its pool queries came back
 * starved, and the engine persisted "estimated" with fairMarketValue REMOVED,
 * over the good number. The grade curve recomputes on read, so it still showed
 * $2,341.20 — and the card page displayed a current value that disagreed with
 * its own curve.
 *
 * The guard is deliberately narrow. It protects a stored number ONLY when the
 * recompute produced literally nothing; any number at all, including a worse
 * one, is a real answer and must win.
 */
import { describe, it, expect } from "vitest";
import { shouldKeepStoredPriceOnEmptySurface as keep } from "../src/services/portfolioiq/portfolioStore.service.js";

const base = {
  newFairMarketValue: null as number | null,
  newEstimatedValue: null as number | null,
  storedFairMarketValue: 2341.2,
  identityResolved: true,
};

describe("shouldKeepStoredPriceOnEmptySurface", () => {
  it("keeps the stored price when the recompute produced nothing at all", () => {
    // The Ohtani case exactly.
    expect(keep({ ...base })).toBe(true);
  });

  it("yields to a real FMV, even a much worse one", () => {
    // A genuine repricing downward is not what this guard is for.
    expect(keep({ ...base, newFairMarketValue: 12.5 })).toBe(false);
  });

  it("yields to an estimate", () => {
    // An estimate is still an answer the engine stands behind.
    expect(keep({ ...base, newEstimatedValue: 1900 })).toBe(false);
  });

  it("does nothing when there is no stored value to protect", () => {
    expect(keep({ ...base, storedFairMarketValue: null })).toBe(false);
    expect(keep({ ...base, storedFairMarketValue: 0 })).toBe(false);
  });

  it("NEVER overrides the unidentified-holding withhold (#1179)", () => {
    // That path blanks the surface deliberately. If this guard resurrected the
    // old price there, an unidentifiable card would keep quoting a number —
    // the exact thing #1179 exists to stop.
    expect(keep({ ...base, identityResolved: false })).toBe(false);
  });

  it("treats a zero FMV as a real answer, not as nothing", () => {
    // 0 is falsy but it IS a computed value; only null/undefined mean "no
    // answer". A truthiness check here would silently resurrect stale prices.
    expect(keep({ ...base, newFairMarketValue: 0 })).toBe(false);
  });

  it("ignores NaN, which is not an answer", () => {
    expect(keep({ ...base, newFairMarketValue: Number.NaN })).toBe(true);
  });
});
