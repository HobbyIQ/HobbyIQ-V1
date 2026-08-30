/**
 * D35 RC1 — CF-CONFIRM-USES-THE-ONE-PIN-GATE. The headline defect.
 *
 * confirmHoldingReview reimplemented the >= 0.9 pin gate inline and wrote
 * ONLY h.cardId. The identifier `hobbyiqCardId` did not appear anywhere in
 * ebayReviewQueue.service.ts. So seven of Drew's holdings sat at 0.95-0.98 —
 * comfortably ABOVE the gate — with no hobbyiqCardId at all: no guard refused
 * them, a second code path simply never wrote the field. Every reader keyed
 * on hobbyiqCardId (conform-holdings-to-catalog, priceFromOurPool) then found
 * nothing, which is why a conform APPLY reported CORRECTED 0 / verified
 * stamped 0 while cardId carried the answer all along.
 *
 * This is the "two rival confidence gates" shape from memory, third copy.
 * Raising or lowering ADD_SLUG_OVERRIDE_MIN_CONFIDENCE would have changed
 * nothing for this cohort — a threshold cannot fix a field nobody writes.
 *
 * THE MUTATION CHECK for this file: revert the ebayReviewQueue change (put the
 * inline `if (match.confidence >= 0.9) { h.cardId = match.slug }` back) and
 * the first case FAILS on hobbyiqCardId — the old code writes cardId only, so
 * the assertion on hobbyiqCardId is exactly what catches the regression.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHECKLIST_SLUG = "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto";

// The catalog the fake matcher and the authority reader agree on.
const CATALOG: Record<string, { source: string }> = {
  [CHECKLIST_SLUG]: { source: "baseballcardpedia" },
};

let match: { found: boolean; slug: string; confidence: number; matchedBy: string } | null = null;

vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    canonicalize: vi.fn(async () => match),
    getCatalogContainerForRead: vi.fn(async () => ({
      item: (id: string) => ({
        read: async () => ({ resource: CATALOG[id] ?? undefined }),
      }),
    })),
  };
});

// Keep the confirm's own catalog cross-reference out of the way — it is a
// separate concern (CF-CATALOG-VERIFY-OWN-POOL) and hits the network shape.
vi.mock("../src/services/catalog/catalogVerify.service.js", () => ({
  verifyCardIdentity: vi.fn(async () => null),
}));

const USER = "user-d35-confirm-pin";

async function seedPendingHolding(): Promise<string> {
  const { readUserDoc, writeUserDoc } = await import("../src/services/portfolioiq/portfolioStore.service.js");
  const doc = await readUserDoc(USER);
  const id = "h-d35";
  (doc as { holdings: Record<string, unknown> }).holdings = {
    ...(doc as { holdings?: Record<string, unknown> }).holdings,
    [id]: {
      id,
      cardStatus: "pending-review",
      source: "ebay-auto",
      playerName: "Derek Jeter",
      cardYear: 1997,
      sport: "baseball",
      setName: "Bowmans Best Preview Atomic Refractor",
      cardNumber: "BBP4",
      parallel: "Atomic Refractor",
      isAuto: false,
      quantity: 1,
    },
  };
  await writeUserDoc(USER, doc);
  return id;
}

async function confirm(id: string) {
  const { confirmHoldingReview } = await import("../src/services/portfolioiq/ebayReviewQueue.service.js");
  const out = await confirmHoldingReview(USER, id, {});
  const { readUserDoc } = await import("../src/services/portfolioiq/portfolioStore.service.js");
  const doc = await readUserDoc(USER);
  return { out, h: (doc.holdings as Record<string, Record<string, unknown>>)[id] };
}

describe("confirmHoldingReview writes identity through the ONE pin gate", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  });

  it("a confident match on a checklist row writes BOTH hobbyiqCardId and cardId", async () => {
    match = { found: true, slug: CHECKLIST_SLUG, confidence: 0.98, matchedBy: "exact" };
    const id = await seedPendingHolding();
    const { h } = await confirm(id);

    // THE REGRESSION THIS FILE EXISTS FOR. The old inline gate wrote cardId
    // only; hobbyiqCardId is what conform and priceFromOurPool read.
    expect(h.hobbyiqCardId).toBe(CHECKLIST_SLUG);
    expect(h.cardId).toBe(CHECKLIST_SLUG);
    expect(h.cardStatus).toBe("active");
  });

  it("a sub-gate match writes NEITHER identity field and parks as a proposal", async () => {
    match = { found: true, slug: CHECKLIST_SLUG, confidence: 0.72, matchedBy: "fuzzy-parallel" };
    const id = await seedPendingHolding();
    const { h } = await confirm(id);

    expect(h.hobbyiqCardId).toBeUndefined();
    expect(h.cardId).toBeFalsy();
    // The proposal is still recorded for the user to accept — the same fields
    // the eBay import writes and proposedIdentity surfaces.
    expect(h.catalogMatchSlug).toBe(CHECKLIST_SLUG);
    expect(h.catalogMatchConfidence).toBe(0.72);
    expect(h.cardStatus).toBe("active"); // approval still activates the holding
  });

  it("a confident match on a SELF-SEEDED vendor row is refused (RC2 at this seam)", async () => {
    // canonicalize seeds a `user-verified` row and then matches its own seed
    // at 0.98. Above the confidence gate, below the authority gate.
    const seeded = "hiq:baseball:2017:topps-gold-label:86:class-1-blue:no-auto";
    CATALOG[seeded] = { source: "user-verified" };
    match = { found: true, slug: seeded, confidence: 0.98, matchedBy: "seeded" };
    const id = await seedPendingHolding();
    const { h } = await confirm(id);

    expect(h.hobbyiqCardId).toBeUndefined();
    expect(h.cardId).toBeFalsy();
    expect(h.catalogMatchSlug).toBe(seeded); // parked, not pinned
    // ...and it must not read as verified off the back of it (RC7).
    expect(h.identityVerified).not.toBe(true);
  });

  it("VERIFIED follows the checklist-backed identity, not a truthy cardId (RC7)", async () => {
    match = { found: true, slug: CHECKLIST_SLUG, confidence: 0.98, matchedBy: "exact" };
    const id = await seedPendingHolding();
    const { h } = await confirm(id);
    expect(h.identityVerified).toBe(true);
    expect(h.identityVerifiedBy).toMatchObject({ candidateId: CHECKLIST_SLUG });
  });
});
