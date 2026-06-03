// CF-PAYMENTS-B1 (tweak, 2026-06-02): gate verification for the 5 newly-
// covered compiq endpoints:
//
//   priceChecksPerDay (rate-limit class):
//     - POST /api/compiq/search   (closes /price <-> /search alias bypass)
//     - POST /api/compiq/what-if  (hypothetical FMV)
//
//   predictions (collector+ entitlement class):
//     - POST /api/compiq/sell-window
//     - POST /api/compiq/grade-premium
//     - POST /api/compiq/bulk     (power-user batch — see HALT for choice)
//
// Three concerns per endpoint:
//   (a) 401 without x-session-id.
//   (b) 402 for a user who lacks the entitlement / is at the rate-limit cap.
//   (c) "paid short-circuit": paid user passes the gate and the handler is
//       reached (we assert NOT-402; handler internals are mocked at the
//       service boundary to avoid real Cardsight / network calls).

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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

// Mock the usageCounter so the rate-limit cap tests can inject a count
// without needing a real Cosmos round-trip.
let mockPriceCheckCount = 0;
function setPriceCheckCount(n: number) { mockPriceCheckCount = n; }

vi.mock("../src/services/usage/usageCounter.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUsageCount: vi.fn(() => mockPriceCheckCount),
    incrementUsage: vi.fn(async () => undefined),
  };
});

// Mock the downstream services that the paid-pass-through tests would
// otherwise hit. Each returns a minimal shape that's enough to satisfy
// the handler's "shape it back to the client" code without making any
// network calls.
const HAPPY_ESTIMATE = {
  fairMarketValue: 100,
  premiumValue: 115,
  quickSaleValue: 88,
  marketDNA: { trend: "flat", speed: "Normal" },
  confidence: { pricingConfidence: 70 },
  source: "live",
  verdict: "ok",
  compsUsed: 5,
  compsAvailable: 7,
  recentComps: [],
  cardIdentity: null,
  gradeUsed: "Raw",
  daysSinceNewestComp: 2,
  variantWarning: [],
  neighborSynthesis: null,
  crossParallelAnchor: null,
  effectiveFmv: 100,
};

vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    computeEstimate: vi.fn(async () => HAPPY_ESTIMATE),
    simulateWhatIf: vi.fn(async () => ({ result: "what-if-stub" })),
  };
});

let app: any;

beforeEach(async () => {
  currentUser = null;
  mockPriceCheckCount = 0;
  if (!app) {
    app = (await import("../src/app")).default;
  }
});

const makeUser = (plan: string) => ({
  userId: `u-${plan}`,
  email: `${plan}@t`,
  username: null,
  fullName: null,
  plan,
  createdAt: "2026-01-01T00:00:00Z",
});

// ─────────────────────────────────────────────────────────────────────────────
// priceChecksPerDay class — /search + /what-if
// ─────────────────────────────────────────────────────────────────────────────

describe("CF-PAYMENTS-B1-TWEAK — /api/compiq/search (priceChecksPerDay)", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app)
      .post("/api/compiq/search")
      .send({ query: "Mike Trout" });
    expect(r.status).toBe(401);
  });

  it("402 rate_limit_exceeded when free user is at the cap (count=5, limit=5)", async () => {
    setUser(makeUser("free"));
    setPriceCheckCount(5);
    const r = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "s")
      .send({ query: "Mike Trout" });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("rate_limit_exceeded");
    expect(r.body.cap).toBe("priceChecksPerDay");
    expect(r.body.requiredTier).toBe("collector");
  });

  it("paid (pro_seller) passes the gate — handler reached", async () => {
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "s")
      .send({ query: "Mike Trout" });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(402);
  });
});

describe("CF-PAYMENTS-B1-TWEAK — /api/compiq/what-if (priceChecksPerDay)", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app)
      .post("/api/compiq/what-if")
      .send({ playerName: "Mike Trout" });
    expect(r.status).toBe(401);
  });

  it("402 rate_limit_exceeded when free user is at the cap", async () => {
    setUser(makeUser("free"));
    setPriceCheckCount(5);
    const r = await request(app)
      .post("/api/compiq/what-if")
      .set("x-session-id", "s")
      .send({ playerName: "Mike Trout" });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("rate_limit_exceeded");
    expect(r.body.cap).toBe("priceChecksPerDay");
  });

  it("paid (pro_seller) passes the gate — handler reached", async () => {
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .post("/api/compiq/what-if")
      .set("x-session-id", "s")
      .send({ playerName: "Mike Trout" });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(402);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// predictions class — /sell-window + /grade-premium + /bulk
// ─────────────────────────────────────────────────────────────────────────────

describe("CF-PAYMENTS-B1-TWEAK — /api/compiq/sell-window (predictions)", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app)
      .post("/api/compiq/sell-window")
      .send({ playerName: "Mike Trout" });
    expect(r.status).toBe(401);
  });

  it("402 subscription_required for free (predictions is collector+)", async () => {
    setUser(makeUser("free"));
    const r = await request(app)
      .post("/api/compiq/sell-window")
      .set("x-session-id", "s")
      .send({ playerName: "Mike Trout" });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("subscription_required");
    expect(r.body.feature).toBe("predictions");
    expect(r.body.requiredTier).toBe("collector");
  });

  it("collector passes the gate — handler reached", async () => {
    setUser(makeUser("collector"));
    const r = await request(app)
      .post("/api/compiq/sell-window")
      .set("x-session-id", "s")
      .send({ playerName: "Mike Trout" });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(402);
  });
});

describe("CF-PAYMENTS-B1-TWEAK — /api/compiq/grade-premium (predictions)", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app)
      .post("/api/compiq/grade-premium")
      .send({ playerName: "Mike Trout" });
    expect(r.status).toBe(401);
  });

  it("402 subscription_required for free", async () => {
    setUser(makeUser("free"));
    const r = await request(app)
      .post("/api/compiq/grade-premium")
      .set("x-session-id", "s")
      .send({ playerName: "Mike Trout" });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("subscription_required");
    expect(r.body.feature).toBe("predictions");
    expect(r.body.requiredTier).toBe("collector");
  });

  it("collector passes the gate — handler reached", async () => {
    setUser(makeUser("collector"));
    const r = await request(app)
      .post("/api/compiq/grade-premium")
      .set("x-session-id", "s")
      .send({ playerName: "Mike Trout" });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(402);
  });
});

describe("CF-PAYMENTS-B1-TWEAK — /api/compiq/bulk (predictions — power feature)", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app)
      .post("/api/compiq/bulk")
      .send({ queries: ["Mike Trout 2023"] });
    expect(r.status).toBe(401);
  });

  it("402 subscription_required for free — confirms /bulk is a paid power feature, NOT per-item rate-limited", async () => {
    setUser(makeUser("free"));
    const r = await request(app)
      .post("/api/compiq/bulk")
      .set("x-session-id", "s")
      .send({ queries: ["Mike Trout 2023"] });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("subscription_required");
    expect(r.body.feature).toBe("predictions");
    expect(r.body.requiredTier).toBe("collector");
  });

  it("collector passes the gate — bulk-of-20 not artificially restricted", async () => {
    setUser(makeUser("collector"));
    const r = await request(app)
      .post("/api/compiq/bulk")
      .set("x-session-id", "s")
      .send({ queries: Array.from({ length: 20 }, (_, i) => `Card ${i + 1}`) });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(402);
  });

  it("priceChecksPerDay counter is NOT consumed by /bulk (paid power feature uses entitlement, not rate-limit)", async () => {
    setUser(makeUser("collector"));
    const usageMod = await import("../src/services/usage/usageCounter.service.js");
    (usageMod.incrementUsage as any).mockClear();
    const r = await request(app)
      .post("/api/compiq/bulk")
      .set("x-session-id", "s")
      .send({ queries: ["Card 1", "Card 2", "Card 3"] });
    expect(r.status).not.toBe(402);
    // /bulk does not flow through requireRateLimited at all — confirm the
    // counter was never touched (otherwise this would 3x undercount the
    // user's daily price-check budget for free collisions later).
    expect(usageMod.incrementUsage).not.toHaveBeenCalled();
  });
});
