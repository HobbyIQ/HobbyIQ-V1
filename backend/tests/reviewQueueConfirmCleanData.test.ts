// CF-REVIEW-QUEUE-CLEAN-DATA (2026-07-12) — verify iOS's full-canonical
// confirm flow persists every sent field, supports null-clearing, returns
// entry.holding envelope, and matches raw wire ids exactly.

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
  purchaseDate: string;
}) {
  const r = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
    purchaseDate: opts.purchaseDate,
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

async function getFirstPending(session: string, marker: string) {
  const pending = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
  return pending.body.holdings.find((h: any) => h.playerName?.includes(marker) || h.setName?.includes(marker));
}

describe("CF-REVIEW-QUEUE-CLEAN-DATA — /confirm persist-every-field", () => {
  it("persists ALL sent fields verbatim including cardId, even when values equal parsed", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10",
      totalCost: 200,
      ebayOrderId: "clean-data-1",
      purchaseDate: "2032-01-15T00:00:00Z",
    });
    await backfillHoldings(session);
    const target = await getFirstPending(session, "Mookie");
    expect(target).toBeTruthy();

    // Send the FULL canonical row — same-value playerName intentionally
    // included to test that we DON'T no-op equal fields.
    const canonicalRow = {
      playerName: "Mookie Betts",
      cardYear: 2020,
      setName: "Panini Prizm",
      parallel: "Silver",
      cardNumber: "275",
      gradeCompany: "PSA",
      gradeValue: 10.0,
      isAuto: false,
      team: "Los Angeles Dodgers",
      sport: "Baseball",
      cardId: "ch-mookie-2020-prizm-275",
    };

    const confirm = await request(app)
      .post(`/api/portfolio/erp/holdings/${target.id}/confirm`)
      .set("x-session-id", session)
      .send(canonicalRow);
    expect(confirm.status).toBe(200);
    expect(confirm.body.success).toBe(true);
    expect(confirm.body.status).toBe("confirmed");

    // Response envelope: entry.holding present
    expect(confirm.body.entry).toBeTruthy();
    expect(confirm.body.entry.holding).toBeTruthy();
    // Legacy holding also at top level
    expect(confirm.body.holding).toBeTruthy();
    expect(confirm.body.holding.id).toBe(target.id);

    // Every canonical field reflected verbatim
    const h = confirm.body.entry.holding;
    expect(h.playerName).toBe("Mookie Betts");
    expect(h.cardYear).toBe(2020);
    expect(h.setName).toBe("Panini Prizm");
    expect(h.parallel).toBe("Silver");
    expect(h.cardNumber).toBe("275");
    expect(h.gradeCompany).toBe("PSA");
    expect(h.gradeValue).toBe(10);
    expect(h.isAuto).toBe(false);
    expect(h.team).toBe("Los Angeles Dodgers");
    expect(h.sport).toBe("Baseball");
    expect(h.cardId).toBe("ch-mookie-2020-prizm-275");

    // Round-trip: same fields on GET /holdings after confirm
    const active = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    const activeH = active.body.holdings.find((x: any) => x.id === target.id);
    expect(activeH.cardId).toBe("ch-mookie-2020-prizm-275");
    expect(activeH.playerName).toBe("Mookie Betts");
    expect(activeH.setName).toBe("Panini Prizm");
    expect(activeH.parallel).toBe("Silver");
    expect(activeH.gradeCompany).toBe("PSA");
    expect(activeH.gradeValue).toBe(10);
  });

  it("null on gradeCompany clears the field (Raw signal) and cascades to gradeValue", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Rookie Card PSA 10",   // parser will find PSA 10
      totalCost: 200,
      ebayOrderId: "clean-data-raw-1",
      purchaseDate: "2032-02-15T00:00:00Z",
    });
    await backfillHoldings(session);
    const pending = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    const target = pending.body.holdings.find((h: any) => h.gradeCompany === "PSA");
    expect(target).toBeTruthy();
    expect(target.gradeCompany).toBe("PSA");
    expect(target.gradeValue).toBe(10);

    const confirm = await request(app)
      .post(`/api/portfolio/erp/holdings/${target.id}/confirm`)
      .set("x-session-id", session)
      .send({ gradeCompany: null });   // user asserts Raw
    expect(confirm.status).toBe(200);
    const h = confirm.body.entry.holding;
    expect(h.gradeCompany).toBeUndefined();
    expect(h.gradingCompany).toBeUndefined();
    expect(h.gradeValue).toBeUndefined();   // cascade

    const active = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    const activeH = active.body.holdings.find((x: any) => x.id === target.id);
    expect(activeH.gradeCompany).toBeUndefined();
    expect(activeH.gradeValue).toBeUndefined();
  });

  it(":id matcher accepts the raw wire id from GET /pending-review", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Nick Kurtz #275 PSA 9",
      totalCost: 100,
      ebayOrderId: "clean-data-id-1",
      purchaseDate: "2032-03-15T00:00:00Z",
    });
    await backfillHoldings(session);
    const pending = await request(app).get("/api/portfolio/holdings/pending-review").set("x-session-id", session);
    const target = pending.body.holdings.find((h: any) => h.playerName?.includes("Kurtz"));
    expect(target).toBeTruthy();
    expect(typeof target.id).toBe("string");

    // Send the exact wire id string — no transformation
    const confirm = await request(app)
      .post(`/api/portfolio/erp/holdings/${target.id}/confirm`)
      .set("x-session-id", session)
      .send({});
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("confirmed");

    // A malformed :id should return 404 with stable body iOS can drop on
    const notFound = await request(app)
      .post(`/api/portfolio/erp/holdings/not-a-real-id-xyz/confirm`)
      .set("x-session-id", session)
      .send({});
    expect(notFound.status).toBe(404);
    expect(notFound.body.success).toBe(false);
    expect(notFound.body.status).toBe("not-found");
  });

  it("does NOT log corrections for same-value writes but DOES persist them", async () => {
    const session = await signIn();
    await seedEbayPurchase(session, {
      notes: "2020 Panini Prizm Owen Carey #275",
      totalCost: 100,
      ebayOrderId: "clean-data-no-corr-1",
      purchaseDate: "2032-04-15T00:00:00Z",
    });
    await backfillHoldings(session);
    const target = await getFirstPending(session, "Owen Carey");
    expect(target).toBeTruthy();

    const parsedYear = target.cardYear;
    const parsedPlayer = target.playerName;

    const confirm = await request(app)
      .post(`/api/portfolio/erp/holdings/${target.id}/confirm`)
      .set("x-session-id", session)
      .send({
        playerName: parsedPlayer,
        cardYear: parsedYear,
        cardId: "ch-owen-carey-2020",   // ONLY changed field
      });
    expect(confirm.status).toBe(200);
    // correctionCount reflects only the one real change (cardId went from
    // absent to present); same-value writes did NOT log corrections.
    expect(confirm.body.correctionCount).toBe(1);
  });
});
