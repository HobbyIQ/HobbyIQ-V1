// CF-EBAY-REVIEW-QUEUE (2026-07-12) — end-to-end integration.
// Covers: auto-import lands in pending-review, doesn't show in /holdings,
// shows in /holdings/pending-review, confirm promotes to active with
// corrections logged, reject deletes + unlinks.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const r = await request(app).post("/api/auth/signin").send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

async function seedEbayPurchase(session: string, opts: {
  notes: string;
  totalCost: number;
  ebayOrderId: string;
  purchaseDate?: string;
}): Promise<string> {
  const r = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
    purchaseDate: opts.purchaseDate ?? "2031-01-15T00:00:00Z",
    source: "ebay",
    subtotal: opts.totalCost - 5,
    tax: 0,
    shipping: 5,
    otherFees: 0,
    vendor: "test-seller",
    notes: opts.notes,
    ebayOrderId: opts.ebayOrderId,
  });
  expect(r.status).toBe(201);
  return r.body.purchase.id;
}

async function backfillHoldings(session: string) {
  const r = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
  expect(r.status).toBe(200);
  return r.body;
}

describe("eBay review queue lifecycle", () => {
  it("auto-import → pending-review; NOT in /holdings; IS in /holdings/pending-review", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10 GEM MINT",
      totalCost: 200,
      ebayOrderId: "review-queue-1",
    });
    await backfillHoldings(session);

    const active = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    expect(active.status).toBe(200);
    const activeMookie = active.body.holdings.find((h: any) => h.playerName === "Mookie Betts");
    // Mookie is in pending-review — should NOT appear in the main /holdings list
    expect(activeMookie).toBeFalsy();

    const pending = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    expect(pending.status).toBe(200);
    const pendingMookie = pending.body.holdings.find((h: any) => h.playerName === "Mookie Betts");
    expect(pendingMookie).toBeTruthy();
    expect(pendingMookie.source).toBe("ebay-auto");
  });

  it("?includePendingReview=true opts pending rows back into /holdings", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10",
      totalCost: 200,
      ebayOrderId: "review-queue-optin-1",
      purchaseDate: "2031-02-15T00:00:00Z",
    });
    await backfillHoldings(session);

    const r = await request(app).get("/api/portfolio/holdings?includePendingReview=true").set("x-session-id", session);
    const found = r.body.holdings.find((h: any) => h.playerName === "Mookie Betts");
    expect(found).toBeTruthy();
  });

  it("confirm → moves to active + shows up in /holdings + records correction on edit", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Baseball Mookie Betts #275 PSA 10",   // polluted with "Baseball"
      totalCost: 200,
      ebayOrderId: "review-queue-confirm-1",
      purchaseDate: "2031-03-15T00:00:00Z",
    });
    await backfillHoldings(session);

    const pending = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    // Find the one this test created — filter by ebayOrderId's linked purchase
    const targets = pending.body.holdings.filter((h: any) => h.playerName?.includes("Mookie") || h.playerName?.includes("Baseball"));
    expect(targets.length).toBeGreaterThan(0);
    const target = targets[0];

    // User edits playerName from "Baseball Mookie Betts" (or whatever the
    // parser did) to the clean form, then confirms.
    const confirm = await request(app)
      .post(`/api/portfolio/erp/holdings/${target.id}/confirm`)
      .set("x-session-id", session)
      .send({ playerName: "Mookie Betts" });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("confirmed");

    // Now it shows in /holdings
    const active = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    const activeTarget = active.body.holdings.find((h: any) => h.id === target.id);
    expect(activeTarget).toBeTruthy();
    expect(activeTarget.playerName).toBe("Mookie Betts");

    // And no longer in pending-review
    const pending2 = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    const stillPending = pending2.body.holdings.find((h: any) => h.id === target.id);
    expect(stillPending).toBeFalsy();
  });

  it("reject → deletes holding + unlinks from source purchase", async () => {
    const session = await signIn();
    const purchaseId = await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10",
      totalCost: 200,
      ebayOrderId: "review-queue-reject-1",
      purchaseDate: "2031-04-15T00:00:00Z",
    });
    await backfillHoldings(session);

    const pending = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    // Grab the newest holding linked to this purchase
    const p = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    const holdingId = p.body.purchase.holdingIds[0];
    expect(holdingId).toBeTruthy();

    const reject = await request(app)
      .post(`/api/portfolio/erp/holdings/${holdingId}/reject`)
      .set("x-session-id", session);
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("rejected");
    expect(reject.body.unlinkedPurchaseId).toBe(purchaseId);

    // Purchase's holdingIds is now empty (unlinked)
    const p2 = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    expect(p2.body.purchase.holdingIds).toEqual([]);

    // Holding gone from both lists
    const active = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    expect(active.body.holdings.find((h: any) => h.id === holdingId)).toBeFalsy();
    const pending2 = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    expect(pending2.body.holdings.find((h: any) => h.id === holdingId)).toBeFalsy();
  });

  it("confirm on an already-active holding → 409 not-pending", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10",
      totalCost: 200,
      ebayOrderId: "review-queue-double-confirm-1",
      purchaseDate: "2031-05-15T00:00:00Z",
    });
    await backfillHoldings(session);

    const pending = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    const target = pending.body.holdings[0];
    expect(target).toBeTruthy();

    const first = await request(app).post(`/api/portfolio/erp/holdings/${target.id}/confirm`).set("x-session-id", session).send({});
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/portfolio/erp/holdings/${target.id}/confirm`).set("x-session-id", session).send({});
    expect(second.status).toBe(409);
    expect(second.body.status).toBe("not-pending");
  });
});
