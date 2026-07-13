// CF-INVENTORY-RAW-CLEAR (2026-07-12) — verify PATCH /holdings/:id
// correctly handles the "user switched to Raw" signal (null / "" / "Raw")
// AND returns the updated holding in the response envelope so iOS can
// verify the roundtrip.

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

async function seedGradedHolding(session: string, id: string) {
  const r = await request(app).post("/api/portfolio/holdings").set("x-session-id", session).send({
    id,
    playerName: "Mookie Betts",
    cardYear: 2020,
    setName: "Panini Prizm",
    product: "Panini Prizm",
    cardNumber: "275",
    gradeCompany: "PSA",
    gradeValue: 10,
    quantity: 1,
    purchasePrice: 200,
    totalCostBasis: 200,
    isAuto: false,
  });
  if (r.status >= 400) {
    console.error("seed failed:", r.status, r.body);
  }
  expect(r.status).toBeLessThan(400);
}

async function getHolding(session: string, id: string) {
  const r = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
  return r.body.holdings.find((h: any) => h.id === id);
}

describe("PATCH /holdings/:id — Raw clear signals", () => {
  it("gradeCompany: null clears grade fields on the persisted holding", async () => {
    const session = await signIn();
    await seedGradedHolding(session, "raw-clear-null");

    const patch = await request(app)
      .patch("/api/portfolio/holdings/raw-clear-null")
      .set("x-session-id", session)
      .send({ gradeCompany: null });
    expect(patch.status).toBe(200);
    // Response must include the updated holding
    expect(patch.body.holding).toBeTruthy();
    expect(patch.body.holding.gradeCompany).toBeUndefined();
    expect(patch.body.holding.gradeValue).toBeUndefined();
    // Also verify via re-fetch (persistence, not just response shape)
    const persisted = await getHolding(session, "raw-clear-null");
    expect(persisted.gradeCompany).toBeUndefined();
    expect(persisted.gradeValue).toBeUndefined();
  });

  it("gradeCompany: '' clears grade fields", async () => {
    const session = await signIn();
    await seedGradedHolding(session, "raw-clear-empty");

    const patch = await request(app)
      .patch("/api/portfolio/holdings/raw-clear-empty")
      .set("x-session-id", session)
      .send({ gradeCompany: "" });
    expect(patch.status).toBe(200);
    const persisted = await getHolding(session, "raw-clear-empty");
    expect(persisted.gradeCompany).toBeUndefined();
    expect(persisted.gradeValue).toBeUndefined();
  });

  it("gradeCompany: 'Raw' clears grade fields (case-insensitive)", async () => {
    const session = await signIn();
    await seedGradedHolding(session, "raw-clear-string");

    const patch = await request(app)
      .patch("/api/portfolio/holdings/raw-clear-string")
      .set("x-session-id", session)
      .send({ gradeCompany: "Raw" });
    expect(patch.status).toBe(200);
    const persisted = await getHolding(session, "raw-clear-string");
    expect(persisted.gradeCompany).toBeUndefined();
    expect(persisted.gradeValue).toBeUndefined();
    // Verify we didn't accidentally persist the literal "Raw" string
    expect(persisted.gradeCompany).not.toBe("Raw");
  });

  it("gradeCompany: 'raw' (lowercase) also clears", async () => {
    const session = await signIn();
    await seedGradedHolding(session, "raw-clear-lower");

    const patch = await request(app)
      .patch("/api/portfolio/holdings/raw-clear-lower")
      .set("x-session-id", session)
      .send({ gradeCompany: "raw" });
    expect(patch.status).toBe(200);
    const persisted = await getHolding(session, "raw-clear-lower");
    expect(persisted.gradeCompany).toBeUndefined();
  });

  it("gradeCompany: 'PSA' (real change) updates the field WITHOUT clearing gradeValue", async () => {
    const session = await signIn();
    await seedGradedHolding(session, "raw-clear-swap");

    const patch = await request(app)
      .patch("/api/portfolio/holdings/raw-clear-swap")
      .set("x-session-id", session)
      .send({ gradeCompany: "BGS", gradeValue: 9.5 });
    expect(patch.status).toBe(200);
    const persisted = await getHolding(session, "raw-clear-swap");
    expect(persisted.gradeCompany).toBe("BGS");
    expect(persisted.gradeValue).toBe(9.5);
  });

  it("PATCH response includes both legacy {id, message} and entry.holding envelope", async () => {
    const session = await signIn();
    await seedGradedHolding(session, "patch-envelope");

    const patch = await request(app)
      .patch("/api/portfolio/holdings/patch-envelope")
      .set("x-session-id", session)
      .send({ notes: "test note" });
    expect(patch.status).toBe(200);
    expect(patch.body.id).toBe("patch-envelope");
    expect(patch.body.message).toBe("Holding updated");
    expect(patch.body.holding).toBeTruthy();
    expect(patch.body.holding.notes).toBe("test note");
    // iOS decoder reads entry.holding too
    expect(patch.body.entry?.holding).toBeTruthy();
    expect(patch.body.entry.holding.id).toBe("patch-envelope");
  });

  it("omitted gradeCompany (not in body) does NOT clear the field", async () => {
    const session = await signIn();
    await seedGradedHolding(session, "patch-omitted");

    const patch = await request(app)
      .patch("/api/portfolio/holdings/patch-omitted")
      .set("x-session-id", session)
      .send({ notes: "changed notes only" });
    expect(patch.status).toBe(200);
    const persisted = await getHolding(session, "patch-omitted");
    // Grade left untouched
    expect(persisted.gradeCompany).toBe("PSA");
    expect(persisted.gradeValue).toBe(10);
    expect(persisted.notes).toBe("changed notes only");
  });
});
