/**
 * CF-NO-IDENTITY-NO-PRICE (2026-08-22).
 *
 * A holding we cannot identify must not be quoted a price.
 *
 * Max Williams "2025 Bowman Draft Gold #CPA-MWI" (holding deced7d3, $301.43
 * paid) carried NO cardId and NO hobbyiqCardId — catalogMatchedBy "not-found",
 * confidence 0.3 — and still rendered VALUE $13.64 with P&L -95.5%. That
 * $13.64 was the BASE Refractor's price: the sibling holding 98eda1a3 is the
 * plain Refractor at $14.44, and its number leaked onto a /50 Gold through a
 * fallback pool.
 *
 * Measured 2026-08-22: 18 sports holdings in this state carrying $2,117.19 of
 * cost basis, 23% of the portfolio, every one showing a confident number with
 * nothing to indicate it was unfounded.
 *
 * An "UNVERIFIED" badge is not enough when the number beside it looks real.
 */
import { describe, it, expect } from "vitest";
import { holdingIdentityIsResolved } from "../src/services/portfolioiq/portfolioStore.service.js";

describe("holdingIdentityIsResolved", () => {
  it("is FALSE for the Max Williams Gold shape — no vendor id, no slug", () => {
    expect(holdingIdentityIsResolved({ cardId: null, hobbyiqCardId: null })).toBe(false);
  });

  it("is FALSE when both are empty strings", () => {
    expect(holdingIdentityIsResolved({ cardId: "", hobbyiqCardId: "" })).toBe(false);
  });

  it("is FALSE when both are whitespace only", () => {
    expect(holdingIdentityIsResolved({ cardId: "   ", hobbyiqCardId: "\t" })).toBe(false);
  });

  it("is FALSE when both are absent from the object entirely", () => {
    expect(holdingIdentityIsResolved({})).toBe(false);
  });

  it("is TRUE on a canonical slug alone (hiq: holdings have no vendor id)", () => {
    expect(holdingIdentityIsResolved({
      cardId: null,
      hobbyiqCardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto",
    })).toBe(true);
  });

  it("is TRUE on a vendor cardId alone", () => {
    expect(holdingIdentityIsResolved({
      cardId: "1784782359263x992151372775175800",
      hobbyiqCardId: null,
    })).toBe(true);
  });

  it("is TRUE when both are present (the healthy Max Williams sibling)", () => {
    expect(holdingIdentityIsResolved({
      cardId: "1784782359263x992151372775175800",
      hobbyiqCardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto",
    })).toBe(true);
  });
});
