/**
 * CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG at the USER-PURCHASE writer (M5).
 *
 * ebayReviewQueue.service.ts is the one root of #1666 that shipped with no
 * pin: the verifier reverted `parallelDecision.parallel` back to
 * `holding.parallel ?? null` and the whole 10,317-test suite passed unchanged.
 * That is the source with the HIGHEST silent rate of any ingest path -- 15.9%
 * of its Bowman finish-slug rows carry a parallel no title names -- so it is
 * the root least able to afford being unpinned.
 *
 * These tests drive the real approve path (`confirmHoldingInDoc`, the function
 * that contains the writer) against a synthetic portfolio doc, and assert on
 * the parallel that reaches `recordSoldComp`.
 *
 * MUTATION: restore `parallel: holding.parallel ?? null` at the recordSoldComp
 * call and the first test reds -- it records "Gold Refractor" from a title that
 * names no finish.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordSoldComp = vi.fn().mockResolvedValue({ ok: true });

vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", () => ({
  recordSoldComp: (...a: unknown[]) => recordSoldComp(...a),
}));
// The rest of the deferred afterWrite() work is fire-and-forget and irrelevant
// here; stub it so the test asserts on the comp emit alone.
vi.mock("../src/services/portfolioiq/suggesterFeedback.service.js", () => ({
  recordSuggesterFeedback: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/services/portfolioiq/userReputation.service.js", () => ({
  bumpUserStats: vi.fn().mockResolvedValue(undefined),
}));

/** A pending-review holding + the purchase whose `notes` IS the listing title. */
function docWith(opts: { title: string; parallel: string | null }) {
  return {
    id: "u-m5",
    userId: "u-m5",
    purchases: [{
      id: "p-1",
      source: "ebay",
      ebayOrderId: "order-m5-1",
      subtotal: 120,
      shipping: 0,
      tax: 0,
      otherFees: 0,
      notes: opts.title,
      purchaseDate: "2026-08-01T00:00:00Z",
    }],
    holdings: {
      "h-1": {
        id: "h-1",
        cardStatus: "pending-review",
        source: "ebay-auto",
        sourcePurchaseId: "p-1",
        cardId: "hiq:baseball:2026:bowman-chrome:cpa-vf:base:auto",
        playerName: "Victor Figueroa",
        cardYear: 2026,
        setName: "Bowman Chrome",
        cardNumber: "CPA-VF",
        parallel: opts.parallel,
        isAuto: true,
        purchaseDate: "2026-08-01T00:00:00Z",
        purchasePrice: 120,
      },
    },
  } as never;
}

/** Run the approve path and return the single recordSoldComp payload. */
async function approveAndCaptureComp(doc: unknown): Promise<Record<string, unknown>> {
  const { confirmHoldingInDoc } = await import(
    "../src/services/portfolioiq/ebayReviewQueue.service.js"
  );
  const outcome = await confirmHoldingInDoc("u-m5", doc as never, "h-1", {});
  expect(outcome.status).toBe("confirmed");
  if (outcome.status !== "confirmed") throw new Error("not confirmed");
  outcome.afterWrite();
  // afterWrite() is deliberately detached (void async IIFE); let its dynamic
  // imports and the emit settle before asserting.
  for (let i = 0; i < 50 && recordSoldComp.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(recordSoldComp).toHaveBeenCalledTimes(1);
  return recordSoldComp.mock.calls[0][0] as Record<string, unknown>;
}

describe("M5: the approve path records the parallel the TITLE names", () => {
  beforeEach(() => {
    recordSoldComp.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  });

  it("a holding tagged 'Gold Refractor' whose title names NO finish records Base", async () => {
    const comp = await approveAndCaptureComp(docWith({
      // A real finish-silent Bowman auto title: no colour, no refractor.
      title: "2026 Bowman Chrome Victor Figueroa 1st Prospect Auto #CPA-VF Orioles",
      parallel: "Gold Refractor",
    }));
    // OLD: "Gold Refractor" -- the buyer's TAG stamped onto the sale as fact,
    // splitting the base auto's pool onto a Gold Refractor slug.
    expect(comp.parallel).toBe("Base");
  });

  it("the reverse: the TITLE names 'Gold Refractor' on a blank holding -> Gold Refractor", async () => {
    const comp = await approveAndCaptureComp(docWith({
      title: "2026 Bowman Chrome Victor Figueroa Gold Refractor Auto #CPA-VF /50",
      parallel: null,
    }));
    // The guard must not be a blanket "always Base": a title that names the
    // finish is the sale's own evidence and is adopted.
    expect(String(comp.parallel ?? "").toLowerCase()).toContain("gold");
  });

  it("a tag the title CORROBORATES still survives", async () => {
    const comp = await approveAndCaptureComp(docWith({
      title: "2026 Bowman Chrome Victor Figueroa Gold Refractor Auto #CPA-VF /50",
      parallel: "Gold Refractor",
    }));
    expect(String(comp.parallel ?? "").toLowerCase()).toContain("gold");
  });
});
