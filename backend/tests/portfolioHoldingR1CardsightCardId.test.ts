// CF-INVENTORYIQ-R1 — PortfolioHolding cardsightCardId round-trip.
//
// Verifies the additive field shipped by R1 (cardsightCardId) flows
// cleanly through the full write/read path:
//   POST /api/portfolio/holdings -> store -> GET /api/portfolio/holdings/:id
//
// Mirrors the W4 cert-fields test pattern at
// portfolioHoldingCertFields.test.ts (683b26f). The store at
// portfolioStore.service.ts addHolding spreads req.body via
// `const { id, ...rest } = incoming`, so any additive field is
// persisted without explicit allow-listing. The R1 normalizer
// additionally:
//   - strips a leading "cardsight:" prefix if the client forwards
//     the raw candidateId form
//   - emits a structured warn event on prefix-strip for telemetry
//   - normalizes empty string to null

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app";

beforeEach(() => {
  // Same pattern as portfolioHoldingCertFields.test.ts — disable
  // external HTTP so autoPriceHolding's Cardsight calls fail
  // gracefully without affecting the schema round-trip we're testing.
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

describe("PortfolioHolding cardsightCardId field (R1)", () => {
  it("round-trips a bare Cardsight UUID through POST -> GET", async () => {
    const session = await signIn();
    const holdingId = `r1-bare-uuid-${Date.now()}`;
    const cardsightCardId = "6134bc63-1a2b-4c3d-9e0f-aabbccddeeff";

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Aaron Judge",
        cardTitle: "2017 Topps Chrome RC",
        cardYear: 2017,
        cardsightCardId,
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightCardId).toBe(cardsightCardId);
  });

  it("strips a leading 'cardsight:' prefix on write and emits a warn event", async () => {
    const session = await signIn();
    const holdingId = `r1-prefix-strip-${Date.now()}`;
    const bareUuid = "8f2e1d4c-9a3b-4c5d-8e1f-112233445566";
    const prefixed = `cardsight:${bareUuid}`;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const add = await request(app)
        .post("/api/portfolio/holdings")
        .set("x-session-id", session)
        .send({
          id: holdingId,
          playerName: "Mike Trout",
          cardsightCardId: prefixed,
        });
      expect(add.status).toBe(201);

      // Stored form is the bare UUID — prefix stripped by the normalizer.
      const get = await request(app)
        .get(`/api/portfolio/holdings/${holdingId}`)
        .set("x-session-id", session);
      expect(get.status).toBe(200);
      expect(get.body.cardsightCardId).toBe(bareUuid);

      // Warn event fired with the structured shape required by
      // post-deploy telemetry grep.
      const stripEvents = warnSpy.mock.calls
        .map((args) => (typeof args[0] === "string" ? args[0] : ""))
        .filter((s) => s.includes("portfoliohq_cardsightCardId_prefix_stripped"));
      expect(stripEvents.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(stripEvents[0]);
      expect(parsed.event).toBe("portfoliohq_cardsightCardId_prefix_stripped");
      expect(parsed.source).toBe("portfolioStore.service.addHolding");
      expect(parsed.holdingId).toBe(holdingId);
      expect(typeof parsed.prefixedForm).toBe("string");
      expect(parsed.prefixedForm.startsWith("cardsight:")).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("accepts explicit null cardsightCardId (absence-as-data)", async () => {
    const session = await signIn();
    const holdingId = `r1-null-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        cardsightCardId: null,
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightCardId).toBeNull();
  });

  it("normalizes empty string cardsightCardId to null on write", async () => {
    const session = await signIn();
    const holdingId = `r1-empty-string-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        cardsightCardId: "",
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightCardId).toBeNull();
  });

  it("backward compatibility — holdings without cardsightCardId persist + retrieve without error", async () => {
    // The schema addition is optional. Existing client flows that
    // never send cardsightCardId must continue working unchanged.
    const session = await signIn();
    const holdingId = `r1-omitted-${Date.now()}`;

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
    expect(get.body.cardsightCardId).toBeUndefined();
    // And the rest of the holding round-trips unchanged.
    expect(get.body.playerName).toBe("Legacy Holding");
    expect(get.body.cardYear).toBe(1989);
  });

  it("PATCH preserves cardsightCardId on a holding when not included in the update body", async () => {
    // updateHolding spreads req.body over the existing holding
    // (`{ ...doc.holdings[id], ...req.body, id }`), so omitted fields
    // are preserved. Confirm cardsightCardId survives a partial PATCH
    // that touches only quantity.
    const session = await signIn();
    const holdingId = `r1-patch-${Date.now()}`;
    const cardsightCardId = "12345678-1234-1234-1234-123456789abc";

    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        cardsightCardId,
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
    expect(get.body.cardsightCardId).toBe(cardsightCardId);
  });

  it("survives full holding lifecycle (add -> refresh -> PATCH-other-field) without being dropped", async () => {
    // CF-INVENTORYIQ-R1 Phase 3 lifecycle verification — confirms the
    // field is preserved through every service that reads + writes
    // the holding via `{ ...holding, ... }` spread. Catches any silent
    // field-drop from hard-coded allow-listing in autoPriceHolding,
    // refreshHolding, or updateHolding's downstream path.
    //
    // Per Phase 1 code-read findings, autoPriceHolding spreads
    // `{ ...holding, currentValue, ... }` (line 454) with an override
    // list that does NOT include cardsightCardId; same for
    // repriceHoldingsForUser (line ~1996). This test confirms the
    // spread preservation empirically rather than relying on the
    // code-read alone.
    const session = await signIn();
    const holdingId = `r1-lifecycle-${Date.now()}`;
    const cardsightCardId = "aabbccdd-eeff-0011-2233-445566778899";

    // Step 1+2: addHolding + GET (addHolding internally routes through
    // autoPriceHolding at portfolioStore.service.ts:1181, so this also
    // implicitly exercises spread-preservation through autoPriceHolding
    // for a freshly created holding).
    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Aaron Judge",
        cardTitle: "2017 Topps Chrome RC",
        cardYear: 2017,
        cardsightCardId,
        quantity: 1,
      });
    expect(add.status).toBe(201);

    let get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightCardId).toBe(cardsightCardId);

    // Step 3+4: refreshHolding routes through autoPriceHolding for an
    // EXISTING holding (distinct code path from addHolding's first
    // call). Field must survive the autoPriceHolding spread regardless
    // of whether the upstream estimate succeeds (in tests fetch is
    // stubbed to fail, so the catch path runs; either way the spread
    // semantics are the same).
    const refresh = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/refresh`)
      .set("x-session-id", session);
    expect([200, 204]).toContain(refresh.status);

    get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightCardId).toBe(cardsightCardId);

    // Step 5+6: PATCH a different field; cardsightCardId must persist
    // through updateHolding's spread (`{ ...doc.holdings[id], ...req.body, id }`).
    const patch = await request(app)
      .patch(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session)
      .send({ quantity: 3 });
    expect([200, 204]).toContain(patch.status);

    get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.quantity).toBe(3);
    expect(get.body.cardsightCardId).toBe(cardsightCardId);
  });

  it("PATCH applies the prefix-strip normalizer when cardsightCardId is updated", async () => {
    // updateHolding routes through the same normalizer as addHolding —
    // confirm a PATCH that sends the prefixed form lands as the bare
    // UUID with the warn event reporting the updateHolding source.
    const session = await signIn();
    const holdingId = `r1-patch-prefix-strip-${Date.now()}`;
    const bareUuid = "abcdef01-2345-6789-abcd-ef0123456789";
    const prefixed = `cardsight:${bareUuid}`;

    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({ id: holdingId, playerName: "Test", quantity: 1 });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const patch = await request(app)
        .patch(`/api/portfolio/holdings/${holdingId}`)
        .set("x-session-id", session)
        .send({ cardsightCardId: prefixed });
      expect([200, 204]).toContain(patch.status);

      const get = await request(app)
        .get(`/api/portfolio/holdings/${holdingId}`)
        .set("x-session-id", session);
      expect(get.status).toBe(200);
      expect(get.body.cardsightCardId).toBe(bareUuid);

      const stripEvents = warnSpy.mock.calls
        .map((args) => (typeof args[0] === "string" ? args[0] : ""))
        .filter((s) => s.includes("portfoliohq_cardsightCardId_prefix_stripped"));
      expect(stripEvents.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(stripEvents[stripEvents.length - 1]);
      expect(parsed.source).toBe("portfolioStore.service.updateHolding");
      expect(parsed.holdingId).toBe(holdingId);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
