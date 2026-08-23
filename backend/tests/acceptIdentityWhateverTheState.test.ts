/**
 * CF-ACCEPT-IDENTITY-WHATEVER-THE-STATE (Drew, 2026-08-23).
 *
 * The accept action existed and was unreachable.
 *
 * confirmHoldingReview returns not-pending (409) unless cardStatus ===
 * "pending-review", and that status is written in exactly ONE place: holding
 * creation. There is no route back to it. So every holding that landed active —
 * or was ever confirmed — could be shown a proposed identity and had no way to
 * take it. The picker shipped in #1214/#1215 opens a door that, for those
 * holdings, is welded shut.
 *
 *   holding aff3236a, 2025 Bowman Draft Gold #CPA-MWI, $301.43 paid
 *     cardStatus       "active"        (pendingTotal on the whole doc: 0)
 *     catalogMatchSlug …:cpa-mwi:gold:auto:num-50   — correct, and unusable
 *
 * Search was not a workaround: probed against prod with that holding's own
 * context, the parked :gold: row was absent from the top ten and every call
 * came back timedOut.
 *
 * This pins the extracted adoption logic — ONE definition now shared by confirm
 * and accept, because a second copy is what produced two player-name matchers
 * whose difference silently refused 828 sales.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const GOLD = "hiq:baseball:2025:bowman-draft:cpa-mwi:gold:auto:num-50";

const { readIdentityMock } = vi.hoisted(() => ({ readIdentityMock: vi.fn() }));

vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, readCatalogIdentityBySlug: readIdentityMock };
});

import { applyCatalogIdentityToHolding } from "../src/services/portfolioiq/ebayReviewQueue.service.js";

/** The catalog row for the /50 Gold — what the pick should make the holding say. */
const GOLD_ROW = {
  id: GOLD,
  playerName: "Max Williams",
  year: 2025,
  setName: "Bowman Draft",
  setKey: "bowman-draft",
  cardNumber: "CPA-MWI",
  parallel: "Gold",
  isAuto: true,
  sport: "baseball",
};

/** The holding as it really is in prod: eBay's parse, no identity. */
const holdingShape = () => ({
  id: "aff3236a",
  playerName: "Max Williams",
  cardYear: 2025,
  setName: "2025 Bowman Draft",
  product: "2025 Bowman Draft",
  cardNumber: "CPA-MWI",
  parallel: "Gold",
  cardStatus: "active",
} as Record<string, unknown>);

beforeEach(() => { readIdentityMock.mockReset(); });

describe("adopting a picked catalog identity", () => {
  it("takes the catalog row's fields onto the holding", async () => {
    readIdentityMock.mockResolvedValue(GOLD_ROW);
    const h = holdingShape();
    const r = await applyCatalogIdentityToHolding(h, GOLD, { holdingId: "aff3236a" });
    expect(r.applied).toBe(true);
    expect(h.setName).toBe("Bowman Draft");
    expect(h.parallel).toBe("Gold");
    expect(h.identitySource).toBe("user-selected-catalog");
  });

  it("moves product WITH setName — the defect that let a pick undo itself", async () => {
    // portfolioStore feeds canonicalize `product ?? setName` — product FIRST.
    // The inline version adopted setName alone, so the next edit re-derived
    // identity from a stale product and could rebind away from the picked row.
    readIdentityMock.mockResolvedValue(GOLD_ROW);
    const h = holdingShape();
    await applyCatalogIdentityToHolding(h, GOLD, { holdingId: "aff3236a" });
    expect(h.product).toBe("Bowman Draft");
    expect(h.product).toBe(h.setName);
  });

  it("records HOW the identity was chosen, so its weight as evidence survives", async () => {
    readIdentityMock.mockResolvedValue(GOLD_ROW);
    const h = holdingShape();
    await applyCatalogIdentityToHolding(h, GOLD, {
      holdingId: "aff3236a",
      identitySource: "user-accepted-parked-match",
    });
    // Accepting a 0.72 proposal the machine authored is weaker evidence than a
    // human searching and picking. Flattening both to "user-selected" loses that.
    expect(h.identitySource).toBe("user-accepted-parked-match");
  });

  it("reports the corrections it made", async () => {
    readIdentityMock.mockResolvedValue(GOLD_ROW);
    const h = holdingShape();
    const r = await applyCatalogIdentityToHolding(h, GOLD, { holdingId: "aff3236a" });
    expect(r.corrections.some((c) => c.field === "setName")).toBe(true);
  });
});

describe("what it must refuse", () => {
  it("changes NOTHING when the slug names no catalog row", async () => {
    // Storing a slug nothing resolves is an identity that prices from an empty
    // pool — the failure the 0.9 pin gate exists to prevent, arriving by
    // another route.
    readIdentityMock.mockResolvedValue(null);
    const h = holdingShape();
    const before = JSON.stringify(h);
    const r = await applyCatalogIdentityToHolding(h, GOLD, { holdingId: "aff3236a" });
    expect(r.applied).toBe(false);
    expect(JSON.stringify(h)).toBe(before);
    expect(h.identitySource).toBeUndefined();
  });

  it("never overwrites a field the user typed in the same request", async () => {
    readIdentityMock.mockResolvedValue(GOLD_ROW);
    const h = holdingShape();
    h.parallel = "Gold Refractor";                 // the user's correction
    await applyCatalogIdentityToHolding(h, GOLD, {
      holdingId: "aff3236a",
      skipFields: new Set(["parallel"]),
    });
    expect(h.parallel).toBe("Gold Refractor");
    expect(h.setName).toBe("Bowman Draft");        // everything else still adopted
  });

  it("refuses a slug that is not canonical", async () => {
    const h = holdingShape();
    const r = await applyCatalogIdentityToHolding(h, "cardhedge::12345", { holdingId: "x" });
    expect(r.applied).toBe(false);
    expect(readIdentityMock).not.toHaveBeenCalled();
  });

  it("survives a catalog read that throws, without half-applying", async () => {
    readIdentityMock.mockRejectedValue(new Error("cosmos down"));
    const h = holdingShape();
    const before = JSON.stringify(h);
    const r = await applyCatalogIdentityToHolding(h, GOLD, { holdingId: "aff3236a" });
    expect(r.applied).toBe(false);
    expect(JSON.stringify(h)).toBe(before);
  });

  it("does not touch cardStatus — accept is the identity half, not the queue", async () => {
    // Promoting status, writing an eBay correction record and clearing the
    // review queue are confirm's job and are meaningless for an active holding.
    readIdentityMock.mockResolvedValue(GOLD_ROW);
    const h = holdingShape();
    await applyCatalogIdentityToHolding(h, GOLD, { holdingId: "aff3236a" });
    expect(h.cardStatus).toBe("active");
  });
});
