// CF-CARD-SAVE-FAST (Drew, 2026-08-31) — "saving edits on a card is SLOW".
//
// The unit tests in holdingSaveDeferredWork.test.ts pin the ledger. This file
// pins the ROUTE: that PATCH /api/portfolio/holdings/:id still writes exactly
// what it wrote before, and that the work it now defers still happens — once.
//
// The property that matters most is the one a "make it fast" change is most
// likely to break: the edit itself must be fully persisted by the time the
// response is sent. Everything deferred is work the user is not waiting on,
// so nothing deferred may be load-bearing for the response body.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import {
  readPending,
  PENDING_FIELD,
} from "../src/services/portfolioiq/holdingSaveDeferredWork.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const r = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

async function seed(session: string, id: string, over: Record<string, unknown> = {}) {
  const r = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", session)
    .send({
      id,
      playerName: "Mookie Betts",
      cardYear: 2020,
      setName: "Panini Prizm",
      product: "Panini Prizm",
      cardNumber: "275",
      quantity: 1,
      purchasePrice: 200,
      totalCostBasis: 200,
      isAuto: false,
      ...over,
    });
  expect(r.status).toBeLessThan(400);
}

async function getHolding(session: string, id: string) {
  const r = await request(app)
    .get("/api/portfolio/holdings")
    .set("x-session-id", session);
  return r.body.holdings.find((h: { id: string }) => h.id === id);
}

describe("PATCH /holdings/:id — the edit is fully persisted in the response", () => {
  it("returns the edited values in the response body, not a stale copy", async () => {
    const session = await signIn();
    const id = `fast-${Date.now()}-a`;
    await seed(session, id);

    const r = await request(app)
      .patch(`/api/portfolio/holdings/${id}`)
      .set("x-session-id", session)
      .send({ notes: "bought at the show", quantity: 3 });

    expect(r.status).toBe(200);
    // The response is what the client renders optimistically-confirmed. If the
    // deferred lane were load-bearing for this, the user would see stale data.
    expect(r.body.holding.notes).toBe("bought at the show");
    expect(r.body.holding.quantity).toBe(3);
  });

  it("persists the edit — a follow-up read sees it without waiting for the deferred lane", async () => {
    const session = await signIn();
    const id = `fast-${Date.now()}-b`;
    await seed(session, id);

    await request(app)
      .patch(`/api/portfolio/holdings/${id}`)
      .set("x-session-id", session)
      .send({ notes: "persisted" });

    const holding = await getHolding(session, id);
    expect(holding.notes).toBe("persisted");
  });

  it("still enforces the identity gate — validation did NOT move off the request path", async () => {
    const session = await signIn();
    const id = `fast-${Date.now()}-c`;
    await seed(session, id);

    // A grade company with no number is the CF-GRADE-EDIT-MUST-STICK 400. It
    // must still be decided synchronously, before anything is written.
    const r = await request(app)
      .patch(`/api/portfolio/holdings/${id}`)
      .set("x-session-id", session)
      .send({ gradeCompany: "PSA" });

    expect(r.status).toBe(400);
    // And the rejected edit left nothing behind.
    const holding = await getHolding(session, id);
    expect(holding.gradeCompany ?? null).toBeNull();
  });

  it("a 404 on an unknown holding is still synchronous", async () => {
    const session = await signIn();
    const r = await request(app)
      .patch("/api/portfolio/holdings/does-not-exist")
      .set("x-session-id", session)
      .send({ notes: "x" });
    expect(r.status).toBe(404);
  });
});

describe("the deferred work is owed, then settled — never lost, never doubled", () => {
  it("an edit that cannot move the price and has no comp leaves no debt", async () => {
    const session = await signIn();
    const id = `fast-${Date.now()}-d`;
    await seed(session, id);

    await request(app)
      .patch(`/api/portfolio/holdings/${id}`)
      .set("x-session-id", session)
      .send({ notes: "just a note" });

    // Give the unawaited deferred lane a turn of the event loop to settle.
    await new Promise((r) => setImmediate(r));

    const holding = await getHolding(session, id);
    // Nothing was owed, so nothing is pending and nothing will be replayed.
    expect(readPending(holding)).toBeNull();
  });

  it("settles the debt: no marker survives once the deferred lane has run", async () => {
    const session = await signIn();
    const id = `fast-${Date.now()}-e`;
    await seed(session, id);

    // An identity edit — this DOES change what the engine reads, so a reprice
    // is genuinely owed and gets deferred.
    const r = await request(app)
      .patch(`/api/portfolio/holdings/${id}`)
      .set("x-session-id", session)
      .send({ parallel: "Silver", cardNumber: "276" });
    expect(r.status).toBe(200);

    // Let the deferred lane finish.
    await new Promise((res) => setTimeout(res, 50));

    const holding = await getHolding(session, id);
    // The debt is settled. A leftover marker here would mean the reconcile
    // sweep re-runs this reprice forever.
    expect(readPending(holding)).toBeNull();
    expect(holding[PENDING_FIELD]).toBeUndefined();
  });

  it("the deferred lane does not clobber a later edit", async () => {
    const session = await signIn();
    const id = `fast-${Date.now()}-f`;
    await seed(session, id);

    // Edit 1 defers a reprice; edit 2 lands immediately after with a note.
    await request(app)
      .patch(`/api/portfolio/holdings/${id}`)
      .set("x-session-id", session)
      .send({ parallel: "Gold" });
    await request(app)
      .patch(`/api/portfolio/holdings/${id}`)
      .set("x-session-id", session)
      .send({ notes: "the later edit" });

    await new Promise((res) => setTimeout(res, 50));

    const holding = await getHolding(session, id);
    // The deferred lane re-reads the doc rather than writing through its own
    // stale copy, so the note written after it started is still there.
    expect(holding.notes).toBe("the later edit");
    expect(holding.parallel).toBe("Gold");
  });
});
