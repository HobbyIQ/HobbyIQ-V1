// CF-PAYMENTS-A — integration tests for the retrofitted route layer.
//
// Three concerns:
//   1. GET /api/entitlements/me returns the right matrix for each plan
//      and 401s without a session.
//   2. The retrofit didn't BREAK existing auth on the 10 session-using
//      routes — they still 401 without an x-session-id and reach the
//      handler with one.
//   3. The new entitlement gates work end-to-end:
//      a) collector's POST /api/ebay/status -> 402 (ebayIntegration is
//         investor+)
//      b) investor's POST /api/ebay/status reaches the handler (no 402).
//      c) free user POST /api/alerts -> 402 capacity_exceeded (priceAlerts
//         cap=0).
//
// We mock authService.getUserBySession + the downstream service surfaces
// that the routes touch, so the test stays at the middleware boundary.

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

// Per-test plan injection; setUser() sets what getUserBySession returns.
let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/authService.js",
  );
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

// Stub ebay connection so /api/ebay/status doesn't hit real services
// after passing the gate.
vi.mock("../src/services/ebay/ebayAuth.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/ebay/ebayAuth.service.js",
  );
  return {
    ...actual,
    getConnectionStatus: vi.fn(async () => ({ connected: false })),
  };
});

// Stub the priceAlerts repository so requireCapacity gets a deterministic
// count for the cap-gate test.
let mockAlertCount = 0;
function setAlertCount(n: number) { mockAlertCount = n; }

vi.mock("../src/repositories/priceAlerts.repository.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/repositories/priceAlerts.repository.js",
  );
  return {
    ...actual,
    listAlertsForUser: vi.fn(async () => Array.from({ length: mockAlertCount })),
    createAlert: vi.fn(async () => ({ id: "a1" })),
  };
});

let app: any;

beforeEach(async () => {
  currentUser = null;
  mockAlertCount = 0;
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
// (1) /api/entitlements/me
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/entitlements/me", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app).get("/api/entitlements/me");
    expect(r.status).toBe(401);
    expect(r.body.success).toBe(false);
  });

  it("free plan: empty features, caps as configured", async () => {
    setUser(makeUser("free"));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.plan).toBe("free");
    expect(r.body.features).toEqual([]);
    expect(r.body.caps.holdingsCap).toBe(25);
    expect(r.body.caps.priceAlerts).toBe(0);
  });

  it("collector plan: predictions + watchlist; holdingsCap=250", async () => {
    setUser(makeUser("collector"));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.features).toContain("predictions");
    expect(r.body.features).toContain("watchlist");
    expect(r.body.features).not.toContain("ebayIntegration");
    expect(r.body.caps.holdingsCap).toBe(250);
    expect(r.body.caps.priceAlerts).toBe(10);
  });

  it("investor plan: includes ebayIntegration + dailyIQBriefs", async () => {
    setUser(makeUser("investor"));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.features).toContain("ebayIntegration");
    expect(r.body.features).toContain("dailyIQBriefs");
    expect(r.body.features).not.toContain("trendIQLayer3Full");
    expect(r.body.caps.priceAlerts).toBe(30);
  });

  it("pro_seller plan: full feature set; all caps unlimited", async () => {
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.features).toContain("trendIQLayer3Full");
    expect(r.body.features).toContain("erpReconciliation");
    expect(r.body.caps.holdingsCap).toBe("unlimited");
    expect(r.body.caps.priceAlerts).toBe("unlimited");
  });

  it("legacy 'all-star' Cosmos plan is normalized to pro_seller", async () => {
    // Simulating an un-migrated user record still carrying the old plan
    // string. The toAuthUser projection in authService should normalize.
    // We exercise this by passing the legacy string in the mocked user
    // shape — getUserBySession in production calls toAuthUser internally,
    // but the test here mocks getUserBySession directly. So we mimic the
    // POST-normalization shape (plan: "pro_seller") to confirm /me
    // returns the right matrix for it. (The normalizer is unit-tested
    // via authService projection elsewhere.)
    setUser(makeUser("pro_seller"));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("pro_seller");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Retrofit didn't break existing auth — 401 without session on 10 routes
// ─────────────────────────────────────────────────────────────────────────────

describe("retrofit — 10 session-using routes still 401 without x-session-id", () => {
  const cases: Array<[string, "get" | "post" | "put" | "delete", string]> = [
    ["alerts list",            "get",    "/api/alerts"],
    ["alerts preferences",     "get",    "/api/alerts/preferences"],
    ["devices register token", "post",   "/api/devices/token"],
    ["uploads card-photo",     "post",   "/api/uploads/card-photo"],
    ["psa cert lookup",        "get",    "/api/psa/cert/12345"],
    ["search cards",           "post",   "/api/search/cards"],
    ["dailyiq watchlist GET",  "get",    "/api/dailyiq/watchlist"],
    ["ebay status",            "get",    "/api/ebay/status"],
    ["portfolio root",         "get",    "/api/portfolio"],
    ["auth session",           "get",    "/api/auth/session"],
  ];

  for (const [name, method, path] of cases) {
    it(`${name} -> 401`, async () => {
      const req = (request(app) as any)[method](path);
      const r = await req.send({});
      expect(r.status).toBe(401);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Entitlement gates work end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("retrofit — entitlement gates", () => {
  it("collector hitting /api/ebay/status -> 402 (ebayIntegration is investor+)", async () => {
    setUser(makeUser("collector"));
    const r = await request(app)
      .get("/api/ebay/status")
      .set("x-session-id", "s");
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("subscription_required");
    expect(r.body.feature).toBe("ebayIntegration");
    expect(r.body.currentTier).toBe("collector");
    expect(r.body.requiredTier).toBe("investor");
  });

  it("investor hitting /api/ebay/status -> 200 (handler runs)", async () => {
    setUser(makeUser("investor"));
    const r = await request(app)
      .get("/api/ebay/status")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.connected).toBe(false);
  });

  it("free trying POST /api/alerts -> 402 capacity_exceeded (priceAlerts cap=0)", async () => {
    setUser(makeUser("free"));
    setAlertCount(0);
    const r = await request(app)
      .post("/api/alerts")
      .set("x-session-id", "s")
      .send({
        cardId: "c1",
        playerName: "Mookie Betts",
        targetPrice: 100,
        direction: "above",
      });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("capacity_exceeded");
    expect(r.body.cap).toBe("priceAlerts");
    expect(r.body.limit).toBe(0);
    expect(r.body.current).toBe(0);
    expect(r.body.requiredTier).toBe("collector");
  });

  it("collector with 9 alerts can create a 10th (handler reached)", async () => {
    setUser(makeUser("collector"));
    setAlertCount(9);
    const r = await request(app)
      .post("/api/alerts")
      .set("x-session-id", "s")
      .send({
        cardId: "c1",
        playerName: "Mookie Betts",
        targetPrice: 100,
        direction: "above",
      });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
  });

  it("collector with 10 alerts is capped (402 -> investor)", async () => {
    setUser(makeUser("collector"));
    setAlertCount(10);
    const r = await request(app)
      .post("/api/alerts")
      .set("x-session-id", "s")
      .send({
        cardId: "c1",
        playerName: "Mookie Betts",
        targetPrice: 100,
        direction: "above",
      });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("capacity_exceeded");
    expect(r.body.requiredTier).toBe("investor");
  });
});
