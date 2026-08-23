/**
 * CF-SURFACE-THE-PARKED-MATCH (2026-08-23).
 *
 * The matcher already found the card and we never showed the user.
 *
 * canonicalize() runs at eBay import and again at confirm, writes its answer to
 * the holding as catalogMatchSlug, and pins cardId only at confidence >= 0.9.
 * That gate is correct. What was wrong is that below the gate the answer was
 * parked and NOTHING in src/ ever read the field — the user saw "Fix identity"
 * with no suggestion attached and had to search for a card we had identified.
 *
 *   Max Williams "2025 Bowman Draft Gold #CPA-MWI" (aff3236a, $301.43 paid)
 *     cardId                  absent
 *     catalogMatchSlug        hiq:baseball:2025:bowman-draft:cpa-mwi:gold:auto:num-50
 *     catalogMatchConfidence  0.72     matchedBy "fuzzy-parallel"
 *
 * That slug is the correct /50 Gold.
 *
 * Measured across the live portfolio 2026-08-23: 23 of 91 holdings carry no
 * identity and 20 of those 23 have a parked match. Identity coverage goes from
 * 74.7% to ~96.7% by reading a field we already write.
 *
 * THE NEGATIVE CASES ARE THE POINT. A proposal must never look like a decision:
 * it must not appear on a holding that already resolved, must not be invented
 * where no match was parked, and must carry its confidence so a 0.72 can be
 * presented differently from a 0.89.
 */
import { describe, expect, it } from "vitest";
import { composeHoldingWireShape } from "../src/services/portfolioiq/responseAssembly.js";

const base = (over: Record<string, unknown> = {}) => ({
  id: "h1",
  playerName: "Max Williams",
  cardNumber: "CPA-MWI",
  parallel: "Gold",
  quantity: 1,
  ...over,
}) as any;

const GOLD_SLUG = "hiq:baseball:2025:bowman-draft:cpa-mwi:gold:auto:num-50";

describe("the parked match reaches the wire", () => {
  it("offers the Max Williams Gold proposal that was previously unread", () => {
    const w = composeHoldingWireShape(base({
      catalogMatchSlug: GOLD_SLUG,
      catalogMatchConfidence: 0.72,
      catalogMatchedBy: "fuzzy-parallel",
    }));
    expect(w.proposedIdentity).not.toBeNull();
    expect(w.proposedIdentity!.slug).toBe(GOLD_SLUG);
  });

  it("carries the confidence so a weak match is not presented as a certainty", () => {
    const w = composeHoldingWireShape(base({
      catalogMatchSlug: GOLD_SLUG,
      catalogMatchConfidence: 0.72,
      catalogMatchedBy: "fuzzy-parallel",
    }));
    expect(w.proposedIdentity!.confidence).toBe(0.72);
    expect(w.proposedIdentity!.matchedBy).toBe("fuzzy-parallel");
  });

  it("still offers a proposal when confidence is missing", () => {
    const w = composeHoldingWireShape(base({ catalogMatchSlug: GOLD_SLUG }));
    expect(w.proposedIdentity!.slug).toBe(GOLD_SLUG);
    expect(w.proposedIdentity!.confidence).toBeNull();
  });
});

describe("a proposal must never look like a decision", () => {
  it("is NULL when the holding already has a cardId — nothing to propose", () => {
    const w = composeHoldingWireShape(base({
      cardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto",
      catalogMatchSlug: GOLD_SLUG,
      catalogMatchConfidence: 0.98,
    }));
    expect(w.proposedIdentity).toBeNull();
  });

  it("is NULL when the holding already has a canonical hobbyiqCardId", () => {
    const w = composeHoldingWireShape(base({
      hobbyiqCardId: "hiq:baseball:1997:topps-finest:238:base:no-auto",
      catalogMatchSlug: GOLD_SLUG,
    }));
    expect(w.proposedIdentity).toBeNull();
  });

  it("is NULL when no match was ever parked — never invented", () => {
    expect(composeHoldingWireShape(base()).proposedIdentity).toBeNull();
  });

  it("is NULL for empty or whitespace-only parked slugs", () => {
    for (const s of ["", "   ", "\t"]) {
      expect(composeHoldingWireShape(base({ catalogMatchSlug: s })).proposedIdentity,
        JSON.stringify(s)).toBeNull();
    }
  });

  it("a DERIVED slug does not suppress the proposal", () => {
    // deriveHoldingSlug() computes a slug from the holding's own fields, and
    // those fields are exactly what is in doubt on an unidentified holding. If
    // a derived value counted as identity, the proposal would vanish precisely
    // where it is needed. Only STORED identity suppresses it.
    const w = composeHoldingWireShape(base({
      cardYear: 2025,
      setName: "2025 Bowman Draft",
      isAuto: true,
      catalogMatchSlug: GOLD_SLUG,
      catalogMatchConfidence: 0.72,
    }));
    expect(w.hobbyiqCardId, "a slug is still derived for display").toBeTruthy();
    expect(w.proposedIdentity, "but the proposal survives").not.toBeNull();
    expect(w.proposedIdentity!.slug).toBe(GOLD_SLUG);
  });
});
