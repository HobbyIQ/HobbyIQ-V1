// CF-CARDSIGHT-GRADE-ID-PATTERN -- PortfolioHolding cardsightGradeId
// round-trip integration tests.
//
// Mirrors the W4 cert-fields + R1 cardsightCardId test patterns at
// portfolioHoldingCertFields.test.ts (683b26f) +
// portfolioHoldingR1CardsightCardId.test.ts (bf836c0). Verifies the
// additive R2 field shipped by this CF:
//
//   POST /api/portfolio/holdings -> resolver populates cardsightGradeId
//     when (gradeCompany, gradeValue, isAuto) matches Cardsight taxonomy
//   GET /api/portfolio/holdings/:id -> field surfaces in response
//   PATCH -> field re-resolves
//
// Fetch is stubbed to:
//   - Return Cardsight grades taxonomy responses for matching URLs
//   - Reject everything else so autoPriceHolding's other upstream
//     calls fail gracefully without affecting the schema round-trip
//     we're testing (mirrors R1 test pattern).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { __resetMemoryCacheForTest } from "../src/services/shared/cache.service";

const PSA_UUID = "7acc6827-3794-4205-bc73-08a9060d5af7";
const PSA_CARD_TYPE_UUID = "psa-card-type-rt-uuid";
const PSA_10_GRADE_UUID = "psa-10-grade-rt-uuid";
const PSA_9_GRADE_UUID = "psa-9-grade-rt-uuid";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cardsightGradesRouter(url: string): Response | null {
  if (url.endsWith("/v1/grades/companies")) {
    return jsonResponse({
      companies: [
        { id: PSA_UUID, name: "PSA", description: "PSA" },
      ],
      total: 1,
    });
  }
  if (url.endsWith(`/v1/grades/companies/${PSA_UUID}/types`)) {
    return jsonResponse({
      types: [
        { id: PSA_CARD_TYPE_UUID, gradingCompanyId: PSA_UUID,
          gradingCompanyName: "PSA", name: "Card", description: "Card" },
      ],
      total: 1,
    });
  }
  if (url.endsWith(`/v1/grades/companies/${PSA_UUID}/types/${PSA_CARD_TYPE_UUID}/grades`)) {
    return jsonResponse({
      grades: [
        { id: PSA_10_GRADE_UUID, gradingTypeId: PSA_CARD_TYPE_UUID,
          gradingTypeName: "Card", gradingCompanyId: PSA_UUID,
          gradingCompanyName: "PSA", grade: "10", condition: "Gem Mint" },
        { id: PSA_9_GRADE_UUID, gradingTypeId: PSA_CARD_TYPE_UUID,
          gradingTypeName: "Card", gradingCompanyId: PSA_UUID,
          gradingCompanyName: "PSA", grade: "9", condition: "Mint" },
      ],
      total: 2,
    });
  }
  return null;
}

beforeEach(() => {
  process.env.CARDSIGHT_API_KEY = "test-key";
  __resetMemoryCacheForTest();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const cs = cardsightGradesRouter(url);
    if (cs) return cs;
    // Everything else fails -- autoPriceHolding's other upstream calls
    // (catalog search, pricing, etc.) end up null + the holding still
    // persists fine. We only care about the schema round-trip here.
    throw new Error("network disabled (non-grades fetch)");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  return response.body.sessionId as string;
}

describe("PortfolioHolding cardsightGradeId field (R2)", () => {
  it("addHolding -- PSA 10 Card resolves to gradeId UUID via resolver", async () => {
    const session = await signIn();
    const holdingId = `r2-psa10-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Aaron Judge",
        cardYear: 2017,
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        product: "Topps Update",
        gradeCompany: "PSA",
        gradeValue: 10,
        isAuto: false,
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightGradeId).toBe(PSA_10_GRADE_UUID);
  });

  it("addHolding -- gradingCompany (legacy field name) is honored by the resolver coalesce", async () => {
    const session = await signIn();
    const holdingId = `r2-legacy-field-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Mike Trout",
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        cardYear: 2021,
        product: "Topps Chrome",
        gradingCompany: "PSA",
        gradeValue: 9,
        isAuto: false,
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightGradeId).toBe(PSA_9_GRADE_UUID);
  });

  it("addHolding -- unknown grader returns no gradeId; field stays unset", async () => {
    const session = await signIn();
    const holdingId = `r2-unknown-grader-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        cardYear: 2024,
        product: "Test Set",
        gradeCompany: "FakeGrader",
        gradeValue: 10,
        isAuto: false,
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    // Field is either undefined or null -- both signal "not populated"
    // and are permanent valid states per the additive R2 design.
    expect(get.body.cardsightGradeId == null).toBe(true);
  });

  it("addHolding -- ungraded holding (no grade fields) leaves cardsightGradeId unset", async () => {
    const session = await signIn();
    const holdingId = `r2-ungraded-${Date.now()}`;

    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        cardYear: 1989,
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        product: "Upper Deck",
        cardTitle: "Raw 1989 Upper Deck #1",
      });
    expect(add.status).toBe(201);

    const get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.status).toBe(200);
    expect(get.body.cardsightGradeId == null).toBe(true);
  });

  it("updateHolding -- changing grade re-resolves cardsightGradeId", async () => {
    const session = await signIn();
    const holdingId = `r2-update-${Date.now()}`;

    // Initial: PSA 10
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Test",
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        cardYear: 2024,
        product: "Test Set",
        gradeCompany: "PSA",
        gradeValue: 10,
        isAuto: false,
        quantity: 1,
      });

    let get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.body.cardsightGradeId).toBe(PSA_10_GRADE_UUID);

    // PATCH: PSA 9 -> resolver fires again
    const patch = await request(app)
      .patch(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session)
      .send({ gradeValue: 9 });
    expect([200, 204]).toContain(patch.status);

    get = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session);
    expect(get.body.cardsightGradeId).toBe(PSA_9_GRADE_UUID);
  });
});
