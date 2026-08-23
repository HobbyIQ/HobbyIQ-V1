/**
 * CF-SELECTED-CARD-IS-THE-IDENTITY (Drew, 2026-08-23: "i want the SEARCH
 * function to find the card to match it. Not the edit card feature. That
 * search then gets selected and edits the card to the catalog match").
 *
 * Automated matching gets three attempts before a human ever sees the holding —
 * import-time canonicalize at >=0.9, a cached suggestion, and a synchronous
 * suggester at >=0.55. The ones that reach review are where all three failed,
 * and in prod they failed for one reason: the card IS in the catalog, under
 * several parallels, and only the person holding it knows which.
 *
 * So the pick is the answer, and the holding must take that ROW's fields.
 * Stamping the slug alone leaves setName/parallel/cardNumber saying whatever an
 * eBay title parse produced — a row whose fields disagree with its slug, which
 * is the Theo Gillen defect (8,412 catalog rows measured with that split).
 *
 * The catalog read is mocked; the hydration logic under test is real.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const PICK = "hiq:baseball:2025:bowman-draft:cpa-mwi:base:auto:num-15";

const { readIdentityMock, docRef } = vi.hoisted(() => ({
  readIdentityMock: vi.fn(),
  docRef: { current: null as Record<string, unknown> | null },
}));

vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, readCatalogIdentityBySlug: readIdentityMock };
});

// Keep the confirm flow off the network for everything that is not under test.
vi.mock("../src/services/portfolioiq/cardIdSuggester.service.js", () => ({
  suggestCardIdForHolding: async () => null,
}));
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", () => ({
  recordSoldComp: async () => undefined,
}));

const CATALOG_ROW = {
  playerName: "Max Williams",
  year: 2025,
  setKey: "bowman-draft",
  setName: "Bowman Draft",
  cardNumber: "CPA-MWI",
  parallel: "Base",
  isAuto: true,
  sport: "baseball",
};

/** A holding as the eBay title parse left it: right player, wrong everything
 *  that decides which card this is. */
function strandedHolding() {
  return {
    id: "h1",
    cardStatus: "pending-review",
    playerName: "Max Williams",
    cardYear: 2025,
    setName: "Bowman",             // wrong product
    cardNumber: "CPA-MWI",
    parallel: "Blue Refractor",    // wrong parallel — the whole problem
    isAuto: false,                 // wrong
    purchasePrice: 301.43,
    purchaseDate: "2026-08-01T00:00:00Z",
  } as Record<string, unknown>;
}

beforeEach(() => {
  readIdentityMock.mockReset();
  readIdentityMock.mockResolvedValue(CATALOG_ROW);
  docRef.current = null;
});

async function confirmWith(edits: Record<string, unknown>, holding = strandedHolding()) {
  const doc: Record<string, unknown> = { userId: "u1", holdings: { h1: holding } };
  const mod = await import("../src/services/portfolioiq/ebayReviewQueue.service.js");
  const store = await import("../src/services/portfolioiq/portfolioStore.service.js");
  vi.spyOn(store, "readUserDoc" as never).mockResolvedValue(doc as never);
  vi.spyOn(store, "writeUserDoc" as never).mockImplementation((async () => {
    docRef.current = doc;
  }) as never);
  await mod.confirmHoldingReview("u1", "h1", edits as never);
  return (doc.holdings as Record<string, Record<string, unknown>>).h1;
}

describe("a catalog pick becomes the holding's identity", () => {
  it("adopts the catalog row's fields, not the eBay title parse", async () => {
    const after = await confirmWith({ cardId: PICK });
    expect(after.cardId).toBe(PICK);
    // These are what make the card price against the right pool.
    expect(after.setName).toBe("Bowman Draft");
    expect(after.parallel).toBe("Base");
    expect(after.isAuto).toBe(true);
    expect(after.identitySource).toBe("user-selected-catalog");
  });

  it("never overwrites a field the user typed in the same request", async () => {
    // The user picked the card AND corrected the parallel — they may be fixing
    // the catalog. Their typing wins over the lookup.
    const after = await confirmWith({ cardId: PICK, parallel: "Gold Refractor" });
    expect(after.parallel).toBe("Gold Refractor");
    expect(after.setName).toBe("Bowman Draft");   // untouched field still adopted
  });

  it("does not store an identity for a pick that names no catalog row", async () => {
    readIdentityMock.mockResolvedValue(null);
    const after = await confirmWith({ cardId: PICK });
    // The slug is still recorded (the user asked for it) but nothing is
    // fabricated around it, and it is not marked as a verified identity.
    expect(after.identitySource).toBeUndefined();
    expect(after.setName).toBe("Bowman");   // left exactly as parsed
  });

  it("leaves a confirm with no pick completely alone", async () => {
    const after = await confirmWith({ playerName: "Max Williams" });
    expect(readIdentityMock).not.toHaveBeenCalled();
    expect(after.setName).toBe("Bowman");
    expect(after.identitySource).toBeUndefined();
  });
});
