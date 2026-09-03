// CF-PRO-SELLER-GATE (Drew, 2026-09-02): the FIELD-shaped gate.
//
// Of the five paid Pro Seller surfaces, four are routes and one is a field:
// per-holding `sellSignal` on the portfolio wire. The ruling is explicit that
// this one gates the FIELD'S POPULATION, not the portfolio read — a free user
// must still get their whole portfolio back, with every price on it, and lose
// only the paid timing call.
//
// So this cannot be a middleware. GET /api/portfolio answering 402 would take
// a free user's entire inventory away to withhold one field. The gate lives in
// the wire composer, and this file pins both halves of it:
//
//   1. a free/collector caller's wire has NO sellSignal key at all
//   2. an investor/pro_seller caller's wire HAS it, populated
//   3. every OTHER field is byte-identical between the two
//
// (3) is the one that matters most. A field gate is only correct if it removes
// exactly one thing; a gate that also dropped a price would be a far worse bug
// than the leak it fixed, and it would be invisible to (1) and (2).
//
// ABSENT, NOT EMPTIED. The composer omits the key rather than emitting a
// `signal: "none"`. `none` is a MEASUREMENT — "we looked, there is no call" —
// and every client renders it as one (SellSignalChip returns null on it; the
// Pro Seller section shows "No open sell windows"). A free user has not been
// looked at. Absence already means "capability not live" by prior contract on
// both clients (apps/web/src/lib/api.ts declares `sellSignal?:` with exactly
// that instruction), so omission is the reading that is already understood.

import { describe, expect, it } from "vitest";
import {
  composeHoldingWireShape,
  composePortfolioListResponse,
} from "../src/services/portfolioiq/responseAssembly.js";
import { wireEntitlementsFor } from "../src/services/portfolioiq/portfolioStore.service.js";
import { hasEntitlement } from "../src/config/entitlements.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

/** A holding carrying a real trend, so a signal WOULD be derived if allowed.
 *  Using a trendless holding would make the test pass for the wrong reason —
 *  the field would be a `none` either way and omission would prove nothing. */
function holdingWithTrend(): PortfolioHolding {
  return {
    id: "h-1",
    userId: "u-1",
    playerName: "Test Player",
    year: 2024,
    setName: "Bowman Chrome",
    cardNumber: "BCP-1",
    quantity: 1,
    purchasePrice: 100,
    fairMarketValue: 180,
    lastUpdated: new Date().toISOString(),
    confidence: 0.82,
    trendIQ: {
      lastUpdated: new Date().toISOString(),
      components: {
        playerMomentum: { multiplier: 0.94, recentCount: 20, olderCount: 20 },
        cardTrajectory: { multiplier: 1.16, recentCount: 9, olderCount: 11 },
      },
    },
  } as unknown as PortfolioHolding;
}

// H-13 (audit 2026-09-03): the sell-window signal's player side is the
// measured #1644/#1647 index, handed to the assembler by the caller. The
// fixture supplies one for h-1 (player -6%) so these cases still exercise a
// REAL derived signal — which is the whole point of the entitled case: an
// entitlement gate that only ever passed refusals would prove nothing.
const PLAYER_INDEX = new Map([
  ["h-1", { ratio: 0.94, basketSize: 11, tierScope: "same-tier" }],
]);
const ENTITLED = { sellSignalEntitled: true, playerIndexByHoldingId: PLAYER_INDEX };
const NOT_ENTITLED = { sellSignalEntitled: false, playerIndexByHoldingId: PLAYER_INDEX };

describe("CF-PRO-SELLER-GATE — sellSignal is gated on the field, not the route", () => {
  it("entitled: the key is present and carries a real derived signal", () => {
    const wire = composeHoldingWireShape(holdingWithTrend(), undefined, ENTITLED);
    expect(Object.keys(wire)).toContain("sellSignal");
    expect(wire.sellSignal).toBeDefined();
    // The fixture diverges (player -6%, own pool +16%), so this is a real
    // call, not a refusal — proving the gate lets actual signal through.
    expect(wire.sellSignal!.signal).not.toBe("none");
    expect(typeof wire.sellSignal!.basis).toBe("string");
  });

  it("unentitled: the key is ABSENT — not present-and-empty", () => {
    const wire = composeHoldingWireShape(holdingWithTrend(), undefined, NOT_ENTITLED);
    expect(Object.keys(wire)).not.toContain("sellSignal");
    expect("sellSignal" in wire).toBe(false);
    expect(wire.sellSignal).toBeUndefined();
  });

  it("unentitled is not a `none` signal — absence and 'no call' stay distinguishable", () => {
    const wire = composeHoldingWireShape(holdingWithTrend(), undefined, NOT_ENTITLED);
    // If the gate emitted { signal: "none" }, a free user would be told a
    // fact we never established, and the Pro Seller section would render
    // "No open sell windows" instead of hiding. Both are wrong.
    expect(wire.sellSignal).not.toEqual(
      expect.objectContaining({ signal: "none" }),
    );
  });

  // THE IMPORTANT ONE: the gate removes exactly one field.
  it("the gate removes sellSignal and NOTHING else — every other field byte-identical", () => {
    const h = holdingWithTrend();
    const paid = composeHoldingWireShape(h, undefined, ENTITLED);
    const free = composeHoldingWireShape(h, undefined, NOT_ENTITLED);

    const paidKeys = Object.keys(paid).sort();
    const freeKeys = Object.keys(free).sort();
    const removed = paidKeys.filter((k) => !freeKeys.includes(k));
    const added = freeKeys.filter((k) => !paidKeys.includes(k));

    expect(removed).toEqual(["sellSignal"]);
    expect(added).toEqual([]);

    // And every shared field holds the same value — no price, no range, no
    // confidence moved because of who was asking.
    const { sellSignal: _dropped, ...paidRest } = paid as Record<string, unknown>;
    expect(free).toEqual(paidRest);
  });

  it("a free user keeps their prices — FMV and the pricing envelope are untouched", () => {
    const h = holdingWithTrend();
    const paid = composeHoldingWireShape(h, undefined, ENTITLED);
    const free = composeHoldingWireShape(h, undefined, NOT_ENTITLED);
    expect(free.marketValue).toEqual(paid.marketValue);
    expect(free.fairMarketValueLive).toEqual(paid.fairMarketValueLive);
    expect(free.pricing).toEqual(paid.pricing);
    expect(free.trendIQ).toEqual(paid.trendIQ);
    expect(free.confidence).toEqual(paid.confidence);
  });

  // DEFAULT-DENY. A call site that forgets the option must not leak the
  // paid field. This is the property that makes the gate safe against the
  // next person adding a 14th call site.
  it("omitting the option entirely is DENY, not allow", () => {
    const bare = composeHoldingWireShape(holdingWithTrend());
    expect(Object.keys(bare)).not.toContain("sellSignal");

    const bareList = composePortfolioListResponse([holdingWithTrend()]);
    expect(Object.keys(bareList[0])).not.toContain("sellSignal");
  });

  it("the list composer threads the flag to EVERY entry, not just the first", () => {
    const items = [holdingWithTrend(), holdingWithTrend(), holdingWithTrend()];

    const paid = composePortfolioListResponse(items, undefined, ENTITLED);
    expect(paid).toHaveLength(3);
    for (const w of paid) expect(Object.keys(w)).toContain("sellSignal");

    const free = composePortfolioListResponse(items, undefined, NOT_ENTITLED);
    expect(free).toHaveLength(3);
    for (const w of free) expect(Object.keys(w)).not.toContain("sellSignal");
  });
});

describe("CF-PRO-SELLER-GATE — wireEntitlementsFor resolves against the matrix", () => {
  const makeReq = (user: unknown) => ({ user, headers: {} }) as never;

  it("free and collector are not entitled; investor and pro_seller are", () => {
    expect(wireEntitlementsFor(makeReq({ userId: "u", plan: "free" })).sellSignalEntitled).toBe(false);
    expect(wireEntitlementsFor(makeReq({ userId: "u", plan: "collector" })).sellSignalEntitled).toBe(false);
    expect(wireEntitlementsFor(makeReq({ userId: "u", plan: "investor" })).sellSignalEntitled).toBe(true);
    expect(wireEntitlementsFor(makeReq({ userId: "u", plan: "pro_seller" })).sellSignalEntitled).toBe(true);
  });

  it("no req.user is DENY (a handler reached without requireSession leaks nothing)", () => {
    expect(wireEntitlementsFor(makeReq(undefined)).sellSignalEntitled).toBe(false);
  });

  // The comped-owner trap this codebase has been bitten by before: gate on
  // user.plan and an owner sees the feature in the UI but gets nothing on
  // the wire. effectivePlanFor is the one resolver every gate must use.
  it("a comped owner (entitlementOverride) is entitled even on a free plan", () => {
    const owner = { userId: "owner", plan: "free", entitlementOverride: "pro_seller" };
    expect(wireEntitlementsFor(makeReq(owner)).sellSignalEntitled).toBe(true);
  });

  it("an unknown override falls through to the real plan rather than corrupting the gate", () => {
    const stale = { userId: "u", plan: "free", entitlementOverride: "legacy_gold" };
    expect(wireEntitlementsFor(makeReq(stale)).sellSignalEntitled).toBe(false);
  });

  // The helper must never become a second source of truth for tiering.
  it("the helper agrees with the matrix for every plan", () => {
    for (const plan of ["free", "collector", "investor", "pro_seller"] as const) {
      expect(wireEntitlementsFor(makeReq({ userId: "u", plan })).sellSignalEntitled).toBe(
        hasEntitlement(plan, "sellerIntelligence"),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CF-SELL-WINDOW-READS-PRICING-CONFIDENCE (2026-09-03).
//
// The wire seam. The gate tests above use a legacy-priced fixture, where the
// flat `confidence` field and the resolved pricing confidence agree — so they
// cannot tell whether responseAssembly reads the right one. These pin the
// UNIFIED row, where the two disagree, which is the whole population the
// defect affected.
// ─────────────────────────────────────────────────────────────────────────

/** The defect shape: a unified-engine row whose flat confidence is the
 *  saturated 1.0 match score, and whose real pricing confidence is 0.30. */
function unifiedHolding(pricingConfidence: number | null): PortfolioHolding {
  const h = holdingWithTrend() as Record<string, unknown>;
  h.confidence = 1.0;
  h.pricingSource = "unified-pricing";
  h.pricingSourceMeta = {
    slug: "hiq:2024-bowman-chrome-bcp-1",
    method: "exact-pool-raw",
    compsUsed: 20,
    ...(pricingConfidence === null ? {} : { confidence: pricingConfidence }),
  };
  return h as unknown as PortfolioHolding;
}

describe("sellSignal gates on pricing confidence, not the flat match score", () => {
  it("a unified row with pricing confidence 0.30 is refused, despite flat confidence 1.0", () => {
    const wire = composeHoldingWireShape(unifiedHolding(0.30), undefined, ENTITLED) as any;
    expect(wire.sellSignal.signal).toBe("none");
    expect(wire.sellSignal.reason).toBe("low-confidence");
    expect(wire.sellSignal.measures.confidence).toBe(0.30);
    // Reading the flat field would have quoted 100% and fired the signal.
    expect(wire.sellSignal.basis).toContain("30%");
    expect(wire.sellSignal.basis).not.toContain("100%");
  });

  it("a unified row with no recorded pricing confidence withholds the call, not assumes 1.0", () => {
    const wire = composeHoldingWireShape(unifiedHolding(null), undefined, ENTITLED) as any;
    expect(wire.sellSignal.signal).toBe("none");
    expect(wire.sellSignal.reason).toBe("unknown-confidence");
    expect(wire.sellSignal.measures.confidence).toBeNull();
    expect(wire.sellSignal.basis).not.toMatch(/\d+%/);
  });

  it("a unified row with a strong pricing confidence still fires the signal", () => {
    // Proves the two tests above refuse for the confidence reason and not
    // because a unified fixture broke the derivation outright.
    const wire = composeHoldingWireShape(unifiedHolding(0.88), undefined, ENTITLED) as any;
    expect(wire.sellSignal.signal).toBe("sell-window");
    expect(wire.sellSignal.measures.confidence).toBe(0.88);
  });
});
