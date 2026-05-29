// CF-UNIFIED-SEARCH-AND-CERT W4 — PortfolioHolding cert-identity round-trip.
//
// Verifies the two additive fields shipped by W4 (certNumber + certGrader)
// flow cleanly through the full write/read path:
//   POST /api/portfolio/holdings → store → GET /api/portfolio/holdings/:id
//
// The store at portfolioStore.service.ts:1158 spreads req.body via
// `const { id, ...rest } = incoming`, so any additive field is
// persisted without explicit allow-listing. These tests document
// that contract at the API layer rather than relying on it
// implicitly — if a future refactor switches to explicit field
// projection, these tests catch the regression.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app";

beforeEach(() => {
  // Same pattern as portfolio.routes.test.ts — disable external HTTP so
  // autoPriceHolding's Cardsight calls fail gracefully without affecting
  // the schema round-trip we're actually testing.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  expect(response.body.sessionId).toBeTruthy();
  return response.body.sessionId as string;
}

describe("PortfolioHolding cert-identity fields (W4)", () => {
  it("round-trips certNumber + certGrader through POST → GET", async () => {
    const session = await signIn();
    const holdingId = `w4-cert-roundtrip-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Greg Maddux",
        cardTitle: "1987 Topps Traded Tiffany",
        cardYear: 1987,
        certNumber: "76556858",
        certGrader: "PSA",
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.certNumber).toBe("76556858");
    expect(get.body.certGrader).toBe("PSA");
  });

  it("accepts certGrader values from each v1.5 grader id (BGS / SGC / CGC) + future grader widening", async () => {
    const session = await signIn();
    const cases: Array<{ id: string; grader: string }> = [
      { id: `w4-cert-bgs-${Date.now()}`, grader: "BGS" },
      { id: `w4-cert-sgc-${Date.now() + 1}`, grader: "SGC" },
      { id: `w4-cert-cgc-${Date.now() + 2}`, grader: "CGC" },
      // String widening preserves forward-compat for v1.5 graders that
      // ship with new ids (e.g. HGA).
      { id: `w4-cert-hga-${Date.now() + 3}`, grader: "HGA" },
    ];

    for (const { id, grader } of cases) {
      const add = await request(app)
        .post("/api/portfolio/holdings")
        .set("x-session-id", session)
        .send({ id, playerName: "Test", certNumber: "00000000", certGrader: grader });
      expect(add.status).toBe(201);

      const get = await request(app)
        .get(`/api/portfolio/holdings/${id}`)
        .set("x-session-id", session);
      expect(get.status).toBe(200);
      expect(get.body.certGrader).toBe(grader);
    }
  });

  it("accepts null cert fields (explicit absence)", async () => {
    const session = await signIn();
    const holdingId = `w4-cert-null-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        certNumber: null,
        certGrader: null,
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.certNumber).toBeNull();
    expect(get.body.certGrader).toBeNull();
  });

  it("backward compatibility — holdings without cert fields persist + retrieve without error", async () => {
    // The schema additions are optional. Existing client flows that
    // never send certNumber/certGrader must continue working unchanged.
    const session = await signIn();
    const holdingId = `w4-cert-omitted-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Legacy Holding",
        cardTitle: "1989 Upper Deck #1",
        cardYear: 1989,
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    // Fields are absent — both undefined when omitted from POST body.
    expect(get.body.certNumber).toBeUndefined();
    expect(get.body.certGrader).toBeUndefined();
    // And the rest of the holding round-trips unchanged.
    expect(get.body.playerName).toBe("Legacy Holding");
    expect(get.body.cardYear).toBe(1989);
  });

  it("PATCH preserves cert fields on a holding when not included in the update body", async () => {
    // updateHolding at portfolioStore.service.ts:1232 spreads req.body
    // over the existing holding (`{ ...doc.holdings[id], ...req.body }`),
    // so omitted fields are preserved. Confirm cert fields survive a
    // partial PATCH that touches only quantity/price.
    const session = await signIn();
    const holdingId = `w4-cert-patch-${Date.now()}`;

    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        certNumber: "12345678",
        certGrader: "PSA",
        quantity: 1,
      });

    const patch = await request(app)
      .patch(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session)
      .send({ quantity: 2 });
    expect([200, 204]).toContain(patch.status);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.quantity).toBe(2);
    expect(get.body.certNumber).toBe("12345678");
    expect(get.body.certGrader).toBe("PSA");
  });
});
