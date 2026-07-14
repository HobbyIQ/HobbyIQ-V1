// CF-EDIT-SHEET-DRY-RUN-SUGGEST (Drew, 2026-07-14) — pins the stateless
// suggester route that powers the iOS "verify card" edit sheet.
//
// The route is intentionally thin: validate playerName presence, run
// the normalizer, run the multi-vendor suggester, return both.
// Persistence lives on `/holdings/:id/confirm` — this route writes
// nothing.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

// Mock the suggester so we don't hit real CH/CS vendors.
const suggestMock = vi.fn();
vi.mock("../src/services/portfolioiq/cardIdSuggester.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    suggestCardIdForHolding: (...args: unknown[]) => suggestMock(...args),
  };
});

function makeUser(plan: string) {
  return {
    userId: `u-${plan}`,
    email: `${plan}@t`,
    username: null, fullName: null, plan,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const ROUTE = "/api/portfolio/holdings/dry-run-suggest";

let app: any;
beforeAll(async () => {
  app = (await import("../src/app")).default;
});
beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  suggestMock.mockReset().mockResolvedValue(null);
});

describe("POST /api/portfolio/holdings/dry-run-suggest — gates", () => {
  it("401 without session", async () => {
    const r = await request(app).post(ROUTE).send({ playerName: "Eric Hartman" });
    expect(r.status).toBe(401);
  });

  it("free tier passes — verify-before-price is not entitlement-gated", async () => {
    setUser(makeUser("free"));
    suggestMock.mockResolvedValue(null);
    const r = await request(app)
      .post(ROUTE)
      .set("x-session-id", "s")
      .send({ playerName: "Eric Hartman", cardYear: 2026 });
    // Not 402 — no entitlement gate. Not 401 — session accepted.
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(402);
  });
});

describe("POST /api/portfolio/holdings/dry-run-suggest — shape", () => {
  beforeEach(() => setUser(makeUser("investor")));

  it("400 when playerName missing", async () => {
    const r = await request(app)
      .post(ROUTE)
      .set("x-session-id", "s")
      .send({ cardYear: 2026 });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toMatch(/playerName/i);
    expect(r.body.suggestion).toBeNull();
  });

  it("400 when playerName is empty string", async () => {
    const r = await request(app)
      .post(ROUTE)
      .set("x-session-id", "s")
      .send({ playerName: "   ", cardYear: 2026 });
    expect(r.status).toBe(400);
  });

  it("200 returns { suggestion, normalized } — passes cleaned fields to suggester", async () => {
    suggestMock.mockResolvedValue({
      cardId: "ch-abc",
      confidence: 0.9,
      confidenceTier: "high",
      candidateSource: "cardhedge",
      matchBreakdown: { fieldsChecked: 5, fieldsMatched: 5, mismatchedFields: [] },
      candidate: { set: "2026 Bowman Baseball", year: 2026, number: "CPA-EHA", variant: "Green Refractor" },
    });

    const r = await request(app)
      .post(ROUTE)
      .set("x-session-id", "s")
      .send({
        playerName: "Eric Hartman",
        cardYear: 2026,
        setName: "2026 Bowman",         // year-doubled — normalizer will strip
        parallel: "Chrome Refractor",   // subset prefix — normalizer will strip
        cardNumber: "cpa-eha",          // lowercase — normalizer will uppercase
        isAuto: true,
      });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.suggestion).toEqual(expect.objectContaining({
      cardId: "ch-abc",
      confidenceTier: "high",
      candidateSource: "cardhedge",
    }));

    // Normalized fields returned so iOS can render the diff.
    expect(r.body.normalized.fields.setName).toBe("Bowman");
    expect(r.body.normalized.fields.parallel).toBe("Refractor");
    expect(r.body.normalized.fields.cardNumber).toBe("CPA-EHA");
    expect(r.body.normalized.changes.length).toBeGreaterThan(0);
  });

  it("200 with null suggestion when suggester returns null", async () => {
    suggestMock.mockResolvedValue(null);
    const r = await request(app)
      .post(ROUTE)
      .set("x-session-id", "s")
      .send({ playerName: "Ladd McConkey", cardYear: 2024 });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.suggestion).toBeNull();
  });

  it("200 does NOT persist anything (dry-run gate)", async () => {
    // Just verifying the suggester is invoked but no write path is called.
    // Cosmos would throw in a test env, so a passing response here confirms
    // the route never tried to persist.
    suggestMock.mockResolvedValue(null);
    const r = await request(app)
      .post(ROUTE)
      .set("x-session-id", "s")
      .send({ playerName: "Eric Hartman", cardYear: 2026 });
    expect(r.status).toBe(200);
    expect(suggestMock).toHaveBeenCalledOnce();
  });

  it("500 when suggester throws — error response, no crash", async () => {
    suggestMock.mockRejectedValue(new Error("vendor timeout"));
    const r = await request(app)
      .post(ROUTE)
      .set("x-session-id", "s")
      .send({ playerName: "Eric Hartman", cardYear: 2026 });
    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toMatch(/vendor timeout/);
    expect(r.body.suggestion).toBeNull();
  });
});
