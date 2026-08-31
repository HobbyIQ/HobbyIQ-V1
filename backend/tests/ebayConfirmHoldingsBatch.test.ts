/**
 * CF-APPROVE-MULTIPLES (Drew, 2026-08-31: approve "is SLOW and cannot approve
 * MULTIPLES").
 *
 * confirmHoldingsBatch approves N pending-review holdings in one request. Two
 * things have to hold, and both are load-bearing:
 *
 *   1. It costs ONE portfolio read and ONE portfolio write for N holdings. The
 *      portfolio is a single Cosmos doc per user (measured on prod 2026-08-31:
 *      Drew's is 1,698,221 bytes over 41 holdings), so the old N-confirms cost
 *      N full reads + N full upserts of that doc. The doc-write count is the
 *      whole point of the endpoint, so it is asserted directly rather than
 *      inferred from wall-clock.
 *
 *   2. It reuses the ONE identity gate. The batch loops confirmHoldingInDoc,
 *      the same function the single route calls, so applyCatalogMatchToHolding
 *      stays the only pin gate and stampChecklistBackedIdentity the only
 *      VERIFIED rule. D35 exists because a second call site reimplemented the
 *      >= 0.9 gate and wrote only cardId; a batch endpoint with its own copy
 *      would be the fourth instance of that defect. The hobbyiqCardId
 *      assertion below is what catches that regression.
 *
 * PARTIAL FAILURE is the normal case, not an edge case — a row approved in
 * another tab comes back not-pending — so a mixed batch must still persist the
 * rows that did confirm.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHECKLIST_SLUG = "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto";

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

// Catalog cross-reference is a separate concern (CF-CATALOG-VERIFY-OWN-POOL)
// and reaches the network; keep it out of the way, as the D35 test does.
vi.mock("../src/services/catalog/catalogVerify.service.js", () => ({
  verifyCardIdentity: vi.fn(async () => null),
}));

const USER = "user-batch-confirm-0831";

type Holding = Record<string, unknown>;

function pendingHolding(id: string, overrides: Holding = {}): Holding {
  return {
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
    ...overrides,
  };
}

async function seed(holdings: Record<string, Holding>): Promise<void> {
  const { readUserDoc, writeUserDoc } = await import("../src/services/portfolioiq/portfolioStore.service.js");
  const doc = await readUserDoc(USER);
  (doc as { holdings: Record<string, unknown> }).holdings = holdings;
  (doc as { ebayCorrections?: unknown[] }).ebayCorrections = [];
  await writeUserDoc(USER, doc);
}

async function readHoldings(): Promise<Record<string, Record<string, unknown>>> {
  const { readUserDoc } = await import("../src/services/portfolioiq/portfolioStore.service.js");
  const doc = await readUserDoc(USER);
  return doc.holdings as Record<string, Record<string, unknown>>;
}

async function batch(ids: string[], edits: Record<string, unknown> = {}) {
  const { confirmHoldingsBatch } = await import("../src/services/portfolioiq/ebayReviewQueue.service.js");
  return await confirmHoldingsBatch(USER, ids, edits as never);
}

describe("confirmHoldingsBatch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
    match = { found: true, slug: CHECKLIST_SLUG, confidence: 0.98, matchedBy: "exact" };
  });

  it("approves every pending holding in one call and activates them all", async () => {
    await seed({
      a: pendingHolding("a"),
      b: pendingHolding("b"),
      c: pendingHolding("c"),
    });

    const out = await batch(["a", "b", "c"]);

    expect(out.requested).toBe(3);
    expect(out.confirmed).toBe(3);
    expect(out.failed).toBe(0);
    expect(out.results.map((r) => r.status)).toEqual(["confirmed", "confirmed", "confirmed"]);

    const h = await readHoldings();
    for (const id of ["a", "b", "c"]) {
      expect(h[id].cardStatus).toBe("active");
      expect(h[id].needsReview).toBe(false);
    }
  });

  it("writes the portfolio doc ONCE for N holdings — the reason this endpoint exists", async () => {
    await seed({
      a: pendingHolding("a"),
      b: pendingHolding("b"),
      c: pendingHolding("c"),
      d: pendingHolding("d"),
    });

    const store = await import("../src/services/portfolioiq/portfolioStore.service.js");
    const writeSpy = vi.spyOn(store, "writeUserDoc");
    const readSpy = vi.spyOn(store, "readUserDoc");
    writeSpy.mockClear();
    readSpy.mockClear();

    const out = await batch(["a", "b", "c", "d"]);
    expect(out.confirmed).toBe(4);

    // One write total. Four single confirms would be four full-doc upserts of
    // a doc measured at 1.7 MB in prod.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // And one read: the per-holding half never re-reads the doc.
    expect(readSpy).toHaveBeenCalledTimes(1);

    writeSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("reuses the ONE identity gate — both hobbyiqCardId and cardId are written (D35)", async () => {
    await seed({ a: pendingHolding("a"), b: pendingHolding("b") });

    await batch(["a", "b"]);

    const h = await readHoldings();
    for (const id of ["a", "b"]) {
      // The regression guard: the D35 defect wrote cardId only. A batch
      // endpoint that reimplemented the gate would fail exactly here.
      expect(h[id].hobbyiqCardId).toBe(CHECKLIST_SLUG);
      expect(h[id].cardId).toBe(CHECKLIST_SLUG);
      expect(h[id].identityVerified).toBe(true);
    }
  });

  it("a sub-gate match parks as a proposal in batch exactly as it does singly", async () => {
    match = { found: true, slug: CHECKLIST_SLUG, confidence: 0.72, matchedBy: "fuzzy-parallel" };
    await seed({ a: pendingHolding("a") });

    const out = await batch(["a"]);
    expect(out.confirmed).toBe(1);

    const h = await readHoldings();
    expect(h.a.hobbyiqCardId).toBeUndefined();
    expect(h.a.cardId).toBeFalsy();
    expect(h.a.catalogMatchSlug).toBe(CHECKLIST_SLUG);
    expect(h.a.cardStatus).toBe("active");
  });

  // ─── Partial failure ─────────────────────────────────────────────────────

  it("PARTIAL FAILURE: reports per item and still persists the successes", async () => {
    await seed({
      good1: pendingHolding("good1"),
      already: pendingHolding("already", { cardStatus: "active" }),
      good2: pendingHolding("good2"),
    });

    const out = await batch(["good1", "already", "missing-id", "good2"]);

    expect(out.requested).toBe(4);
    expect(out.confirmed).toBe(2);
    expect(out.failed).toBe(2);

    const byId = Object.fromEntries(out.results.map((r) => [r.holdingId, r.status]));
    expect(byId.good1).toBe("confirmed");
    expect(byId.good2).toBe("confirmed");
    expect(byId.already).toBe("not-pending");
    expect(byId["missing-id"]).toBe("not-found");

    // The two that worked are durable — a neighbour's failure must not roll
    // them back.
    const h = await readHoldings();
    expect(h.good1.cardStatus).toBe("active");
    expect(h.good2.cardStatus).toBe("active");
    // ...and the already-active one was left exactly as it was.
    expect(h.already.needsReview).toBeUndefined();
  });

  it("a holding that THROWS is isolated: neighbours still confirm and persist", async () => {
    await seed({
      good1: pendingHolding("good1"),
      // A holding whose playerName getter throws mid-confirm stands in for any
      // unexpected per-item explosion.
      boom: pendingHolding("boom"),
      good2: pendingHolding("good2"),
    });

    const store = await import("../src/services/portfolioiq/portfolioStore.service.js");
    const doc = await store.readUserDoc(USER);
    Object.defineProperty((doc.holdings as Record<string, unknown>).boom as object, "cardStatus", {
      get() { throw new Error("synthetic per-item failure"); },
      configurable: true,
    });

    const out = await batch(["good1", "boom", "good2"]);

    expect(out.confirmed).toBe(2);
    expect(out.failed).toBe(1);
    const boomRow = out.results.find((r) => r.holdingId === "boom")!;
    expect(boomRow.status).toBe("error");
    expect(boomRow.reason).toContain("synthetic per-item failure");

    expect(out.results.find((r) => r.holdingId === "good1")!.status).toBe("confirmed");
    expect(out.results.find((r) => r.holdingId === "good2")!.status).toBe("confirmed");
  });

  it("an all-failed batch does not rewrite the doc", async () => {
    await seed({ already: pendingHolding("already", { cardStatus: "active" }) });

    const store = await import("../src/services/portfolioiq/portfolioStore.service.js");
    const writeSpy = vi.spyOn(store, "writeUserDoc");
    writeSpy.mockClear();

    const out = await batch(["already", "nope"]);

    expect(out.confirmed).toBe(0);
    expect(out.failed).toBe(2);
    expect(writeSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
  });

  // ─── Input handling ──────────────────────────────────────────────────────

  it("de-duplicates repeated ids so one holding is not confirmed twice", async () => {
    await seed({ a: pendingHolding("a") });

    const out = await batch(["a", "a", "a"]);

    // Without the dedupe the 2nd and 3rd would come back not-pending — the
    // first confirm having already flipped the status — and read as failures
    // for a batch the user considers wholly successful.
    expect(out.requested).toBe(1);
    expect(out.confirmed).toBe(1);
    expect(out.failed).toBe(0);
  });

  it("applies per-holding edits to the right holding", async () => {
    await seed({ a: pendingHolding("a"), b: pendingHolding("b") });

    await batch(["a", "b"], { a: { playerName: "Chipper Jones" } });

    const h = await readHoldings();
    expect(h.a.playerName).toBe("Chipper Jones");
    expect(h.b.playerName).toBe("Derek Jeter");
  });

  it("an empty request is a no-op, not an error", async () => {
    await seed({ a: pendingHolding("a") });
    const out = await batch([]);
    expect(out).toMatchObject({ requested: 0, confirmed: 0, failed: 0 });
    expect(out.results).toEqual([]);
    expect((await readHoldings()).a.cardStatus).toBe("pending-review");
  });
});
