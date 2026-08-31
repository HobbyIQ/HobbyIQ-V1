// CF-CARD-SAVE-FAST (Drew, 2026-08-31) — "saving edits on a card is SLOW".
//
// The fix moves the reprice and the comp emit out of the save request and runs
// them after the response. The whole risk of that move is LOSING the work, so
// these tests pin the ledger that makes the move safe rather than the speed:
//
//   - a save that owes work records exactly that work, and no more;
//   - the marker is written before the doc write, so "saved" and "owed"
//     are persisted together;
//   - completing the work clears the debt EXACTLY once — a replay of an
//     already-finished save owes nothing;
//   - a partial failure keeps the half that did not run;
//   - a second save landing on an unfinished one does not erase its debt.
//
// The reprice gate itself (estimateInputChanged) is pinned separately in
// tests/estimateInputChanged.test.ts and is unchanged by this work.

import { describe, it, expect } from "vitest";
import {
  deferredOpsFor,
  compEligible,
  markPending,
  readPending,
  clearPending,
  clearOps,
  bumpAttempts,
  PENDING_FIELD,
  MAX_ATTEMPTS,
  type DeferredOp,
} from "../src/services/portfolioiq/holdingSaveDeferredWork";
import type { PortfolioHolding } from "../src/types/portfolioiq.types";

/** A holding whose purchase makes it comp-eligible (purchaseSource ~ /^ebay/). */
const EBAY_BUY = {
  id: "h-1",
  playerName: "Paul Skenes",
  cardYear: 2024,
  product: "Bowman Chrome",
  purchaseSource: "ebay:seller-handle",
  purchasePrice: 120,
  purchaseDate: "2026-08-01",
} as unknown as PortfolioHolding;

/** Same card, bought anywhere else — the comp emit must not fire. */
const MANUAL_BUY = {
  ...(EBAY_BUY as object),
  purchaseSource: "manual",
} as unknown as PortfolioHolding;

const clone = <T,>(h: T): T => JSON.parse(JSON.stringify(h)) as T;

describe("what a save owes", () => {
  it("an identity edit on an eBay purchase owes both operations", () => {
    expect(deferredOpsFor(EBAY_BUY, true)).toEqual(["reprice", "comp-emit"]);
  });

  it("a photo/notes edit owes no reprice — the CF-PHOTO-PATCH-LATENCY gate still decides", () => {
    // repriceNeeded=false is estimateInputChanged's answer, passed straight
    // through. Deferral must not resurrect a reprice the gate already skipped.
    expect(deferredOpsFor(EBAY_BUY, false)).toEqual(["comp-emit"]);
  });

  it("a non-eBay purchase owes no comp — deferral never invents market data", () => {
    expect(deferredOpsFor(MANUAL_BUY, true)).toEqual(["reprice"]);
  });

  it("a photo edit on a non-eBay card owes nothing at all, so no marker is written", () => {
    const h = clone(MANUAL_BUY);
    const ops = deferredOpsFor(h, false);
    expect(ops).toEqual([]);
    markPending(h, ops);
    expect(readPending(h)).toBeNull();
    expect(PENDING_FIELD in (h as object)).toBe(false);
  });
});

describe("comp eligibility mirrors emitUserEbayPurchaseComp's own guards", () => {
  it("accepts a well-formed eBay purchase", () => {
    expect(compEligible(EBAY_BUY)).toBe(true);
  });

  it.each([
    ["no purchase source", { purchaseSource: "" }],
    ["a non-eBay source", { purchaseSource: "cardshow" }],
    ["a zero price", { purchasePrice: 0 }],
    ["a negative price", { purchasePrice: -5 }],
    ["a non-numeric price", { purchasePrice: "abc" }],
    ["no purchase date", { purchaseDate: "" }],
    ["no player name", { playerName: "" }],
  ])("rejects %s", (_label, over) => {
    const h = { ...(EBAY_BUY as object), ...over } as unknown as PortfolioHolding;
    expect(compEligible(h)).toBe(false);
  });

  it("is case-insensitive on the source, like the emitter's regex", () => {
    const h = { ...(EBAY_BUY as object), purchaseSource: "EBAY:x" } as unknown as PortfolioHolding;
    expect(compEligible(h)).toBe(true);
  });
});

describe("the debt is recorded, then cleared exactly once", () => {
  it("marks what is owed, and readPending reads it back", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice", "comp-emit"], "2026-08-31T00:00:00.000Z");
    const pending = readPending(h);
    expect(pending).toEqual({
      ops: ["reprice", "comp-emit"],
      at: "2026-08-31T00:00:00.000Z",
      attempts: 0,
    });
  });

  it("completing every op clears the marker — the work is not owed twice", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice", "comp-emit"]);
    clearOps(h, ["reprice", "comp-emit"]);
    expect(readPending(h)).toBeNull();
    // The field is gone, not merely empty: a leftover {ops:[]} would make the
    // reconcile sweep re-run finished work on every pass.
    expect(PENDING_FIELD in (h as object)).toBe(false);
  });

  it("a completed save owes nothing on replay — the sweep skips it", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice", "comp-emit"]);
    clearOps(h, ["reprice", "comp-emit"]);
    // Second pass: this is what reconcileDeferredSaveWork sees. Nothing owed
    // means the comp is not re-emitted and the card is not repriced again.
    expect(readPending(h)).toBeNull();
  });

  it("a partial failure keeps only the half that did not run", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice", "comp-emit"]);
    // The reprice succeeded and the comp emit threw.
    clearOps(h, ["reprice"]);
    expect(readPending(h)?.ops).toEqual(["comp-emit"]);
  });

  it("clearing an op that was never owed is a no-op", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["comp-emit"]);
    clearOps(h, ["reprice"]);
    expect(readPending(h)?.ops).toEqual(["comp-emit"]);
  });

  it("clearPending wipes the marker outright", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice"]);
    clearPending(h);
    expect(readPending(h)).toBeNull();
  });
});

describe("a second save must not erase the first save's debt", () => {
  it("unions the ops and keeps the ORIGINAL timestamp", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["comp-emit"], "2026-08-31T00:00:00.000Z");
    // A follow-up edit lands before the deferred lane ran.
    markPending(h, ["reprice"], "2026-08-31T00:05:00.000Z");
    const pending = readPending(h);
    expect(pending?.ops).toEqual(["comp-emit", "reprice"]);
    // The age of the debt is the age of the OLDEST unpaid work, so the sweep
    // can prioritise by it and an operator can see how far behind the lane is.
    expect(pending?.at).toBe("2026-08-31T00:00:00.000Z");
  });

  it("does not duplicate an op that is already owed", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice"]);
    markPending(h, ["reprice"]);
    expect(readPending(h)?.ops).toEqual(["reprice"]);
  });

  it("preserves the attempt count across a re-mark", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice"]);
    bumpAttempts(h);
    markPending(h, ["comp-emit"]);
    expect(readPending(h)?.attempts).toBe(1);
  });
});

describe("replay is bounded", () => {
  it("counts attempts so a permanently failing holding stops being retried", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice"]);
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      expect(bumpAttempts(h)).toBe(i);
    }
    expect(readPending(h)!.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
  });

  it("bumping with nothing owed is a no-op", () => {
    const h = clone(EBAY_BUY);
    expect(bumpAttempts(h)).toBe(0);
  });
});

describe("the marker survives a Cosmos round-trip and tolerates junk", () => {
  it("round-trips through JSON, which is how it is persisted", () => {
    const h = clone(EBAY_BUY);
    markPending(h, ["reprice", "comp-emit"], "2026-08-31T00:00:00.000Z");
    const revived = JSON.parse(JSON.stringify(h)) as PortfolioHolding;
    expect(readPending(revived)).toEqual({
      ops: ["reprice", "comp-emit"],
      at: "2026-08-31T00:00:00.000Z",
      attempts: 0,
    });
  });

  it.each([
    ["a missing marker", undefined],
    ["null", null],
    ["a string", "reprice"],
    ["an empty object", {}],
    ["an empty op list", { ops: [], at: "x", attempts: 0 }],
    ["unknown op names only", { ops: ["launch-missiles"], at: "x", attempts: 0 }],
  ])("reads %s as nothing owed", (_label, raw) => {
    const h = clone(EBAY_BUY) as unknown as Record<string, unknown>;
    h[PENDING_FIELD] = raw;
    expect(readPending(h as unknown as PortfolioHolding)).toBeNull();
  });

  it("keeps the known ops and drops unknown ones", () => {
    const h = clone(EBAY_BUY) as unknown as Record<string, unknown>;
    h[PENDING_FIELD] = { ops: ["reprice", "nonsense"], at: "x", attempts: 0 };
    expect(readPending(h as unknown as PortfolioHolding)?.ops).toEqual(["reprice"]);
  });

  it("reads a holding that is null/undefined as nothing owed", () => {
    expect(readPending(undefined)).toBeNull();
    expect(readPending(null)).toBeNull();
  });
});

describe("the ops run in a fixed order", () => {
  it("reprices before emitting the comp", () => {
    // The comp emit reads the holding's pinned identity, which the reprice may
    // hydrate. Emitting first would key the comp off the pre-reprice identity.
    const ops: DeferredOp[] = deferredOpsFor(EBAY_BUY, true);
    expect(ops.indexOf("reprice")).toBeLessThan(ops.indexOf("comp-emit"));
  });
});
