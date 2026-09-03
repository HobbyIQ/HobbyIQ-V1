// CF-PRO-SELLER-GATE (Drew, 2026-09-02) — the no-regression half of the ruling.
//
// The ruling gates five paid surfaces AND forbids taking anything away from
// the free tier: "a free user must keep whatever the free tier already showed
// BEFORE this ruling". Those two pull in opposite directions, because the
// DailyIQ action plan reaches the SAME engines the gated routes serve.
//
// This file is the fixture for the second half. Every assertion here describes
// something a free user could do before this CF and must still be able to do
// after it. If a future edit gates one of these, it fails here — which is the
// point: the loss would otherwise be invisible until a free user complained.
//
// THE CONFLICT, STATED PLAINLY. GET /api/dailyiq/action-plan carries only
// requireSession. buildActionPlan() calls detectSellNowCandidates (the
// sell-now-radar engine) and analyzeHoldingGradeWorthy (the grade-arb engine)
// as in-process service calls. Gating those two HTTP routes therefore does not
// touch this path, and a free user still receives SELL_NOW / GRADE_UP verdicts
// from the DailyIQ hero exactly as they have since PR #546 (2026-07-17).
//
// That is deliberate. The free tier keeps the VERDICT it already had; the paid
// tiers get the EVIDENCE — the ranked candidate lists, velocity multiples,
// urgency scores, expected-gain figures, the deal feed, the per-holding timing
// call, and the fee/P&L summary. Anyone narrowing that line should do it
// deliberately, with Drew, not by adding a middleware.

import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../src/services/portfolioiq/portfolioStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readUserDoc: vi.fn(async (userId: string) => ({
      id: userId,
      userId,
      holdings: {},
      ledger: [],
    })),
  };
});

let app: any;

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = null;
  if (!app) {
    app = (await import("../src/app")).default;
  }
});

const freeUser = {
  userId: "u-free",
  email: "free@t",
  username: null,
  fullName: null,
  plan: "free",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("CF-PRO-SELLER-GATE — free surfaces this CF must NOT regress", () => {
  it("the DailyIQ action plan stays reachable for a free user", async () => {
    setUser(freeUser);
    const r = await request(app)
      .get("/api/dailyiq/action-plan")
      .set("x-session-id", "s");
    // Not 402: this is the known conflict, resolved in the free tier's
    // favour. It shipped free and stays free.
    expect(r.status).not.toBe(402);
    expect(r.status).not.toBe(403);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("actions");
    expect(r.body).toHaveProperty("counts");
  });

  it("a free user still gets their whole portfolio back from GET /api/portfolio", async () => {
    setUser(freeUser);
    const r = await request(app).get("/api/portfolio").set("x-session-id", "s");
    // The sellSignal gate is a FIELD gate. Turning the portfolio read itself
    // into 402 would take a free user's entire inventory away to withhold one
    // timing call — the regression this design exists to avoid.
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body).toHaveProperty("items");
    expect(r.body).toHaveProperty("summary");
    // Prices are NOT a paid field. FMV stays canonical for everyone.
    expect(r.body).toHaveProperty("valuation");
  });

  it("a free user's holdings list is still served (GET /api/portfolio/holdings)", async () => {
    setUser(freeUser);
    const r = await request(app)
      .get("/api/portfolio/holdings")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("holdings");
  });

  it("no holding on a free user's wire carries sellSignal", async () => {
    setUser(freeUser);
    const r = await request(app).get("/api/portfolio").set("x-session-id", "s");
    expect(r.status).toBe(200);
    for (const item of r.body.items ?? []) {
      expect(Object.keys(item)).not.toContain("sellSignal");
    }
  });

  it("the per-holding grade-arb look-at-my-own-card route is not swept into the gate", async () => {
    // /holdings/:id/grade-arb is a user asking about ONE card they own. The
    // ruling gates the portfolio-wide grade-arb SCAN the paid workspace
    // calls, not this. A 402 here would be scope creep.
    setUser(freeUser);
    const r = await request(app)
      .get("/api/portfolio/holdings/does-not-exist/grade-arb")
      .set("x-session-id", "s");
    expect(r.status).not.toBe(402);
  });
});
