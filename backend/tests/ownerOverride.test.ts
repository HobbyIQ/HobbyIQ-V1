// CF-OWNER-OVERRIDE (2026-06-05): coverage for the server-side entitlement
// override end-to-end.
//
// Pins:
//   1. /api/entitlements/me resolves override > plan > free (display layer).
//   2. ENFORCEMENT — requireEntitlement gates on the EFFECTIVE plan, not
//      the raw `plan` field. A free user with entitlementOverride=
//      "pro_seller" reaches the handler on an investor+-gated route
//      (200, not 402). This is the load-bearing test.
//   3. setUserSubscriptionState (the Apple webhook path) DOES NOT clear
//      an existing entitlementOverride — mechanical: read-modify-write
//      of the full record preserves all unmodified fields.
//   4. setEntitlementOverride is idempotent + can be cleared by passing
//      null.

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

// Stub ebay connection so /api/ebay/status doesn't hit real services
// once the gate passes.
vi.mock("../src/services/ebay/ebayAuth.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/ebay/ebayAuth.service.js",
  );
  return {
    ...actual,
    getConnectionStatus: vi.fn(async () => ({ connected: false })),
  };
});

// Inject the per-test user into requireSession via getUserBySession.
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

let app: any;

beforeEach(async () => {
  currentUser = null;
  if (!app) {
    app = (await import("../src/app")).default;
  }
});

const makeUser = (over: Partial<any>) => ({
  userId: "u-test",
  email: "u@t",
  username: null,
  fullName: null,
  plan: "free" as const,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

// ─── /api/entitlements/me ─────────────────────────────────────────────────

describe("CF-OWNER-OVERRIDE: /api/entitlements/me resolution order", () => {
  it("override 'pro_seller' wins over plan 'free' (display layer)", async () => {
    setUser(makeUser({ plan: "free", entitlementOverride: "pro_seller" }));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("pro_seller");
    expect(r.body.features).toContain("trendIQLayer3Full");
    expect(r.body.features).toContain("erpReconciliation");
    expect(r.body.caps.holdingsCap).toBe("unlimited");
  });

  it("override 'pro_seller' wins over Apple-derived plan 'investor'", async () => {
    setUser(makeUser({ plan: "investor", entitlementOverride: "pro_seller" }));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("pro_seller");
  });

  it("no override → falls through to Apple-derived plan", async () => {
    setUser(makeUser({ plan: "investor", entitlementOverride: null }));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("investor");
  });

  it("no override + plan 'free' → free", async () => {
    setUser(makeUser({ plan: "free" }));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("free");
    expect(r.body.features).toEqual([]);
  });

  it("override with an unknown literal → defensively falls through to plan", async () => {
    setUser(makeUser({ plan: "collector", entitlementOverride: "garbage" as any }));
    const r = await request(app)
      .get("/api/entitlements/me")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("collector");
  });
});

// ─── ENFORCEMENT — the load-bearing test ──────────────────────────────────

describe("CF-OWNER-OVERRIDE: enforcement layer — overridden user actually reaches the handler", () => {
  it("free user (no override) → /api/ebay/status returns 402 (ebayIntegration is investor+)", async () => {
    setUser(makeUser({ plan: "free" }));
    const r = await request(app)
      .get("/api/ebay/status")
      .set("x-session-id", "s");
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("subscription_required");
    expect(r.body.currentTier).toBe("free");
  });

  it("free user WITH override='pro_seller' → /api/ebay/status returns 200 (reaches handler)", async () => {
    // This is the proof the comp ACTUALLY UNLOCKS THE FEATURE on the
    // backend — not just the UI matrix. If this assertion ever flips to
    // 402, the enforcement-layer wiring of effectivePlanFor has been
    // bypassed and comped owners will hit a UI-unlocked / API-locked
    // half-state.
    setUser(makeUser({ plan: "free", entitlementOverride: "pro_seller" }));
    const r = await request(app)
      .get("/api/ebay/status")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body).toBeDefined();
  });

  it("402 response reports the EFFECTIVE tier (not the raw plan) on currentTier", async () => {
    // For visibility: an overridden user who somehow hits a route
    // gated above their override tier should still see the effective
    // tier in currentTier — keeps display + enforcement consistent.
    setUser(makeUser({ plan: "free", entitlementOverride: "collector" }));
    const r = await request(app)
      .get("/api/ebay/status")  // investor+ gated
      .set("x-session-id", "s");
    expect(r.status).toBe(402);
    expect(r.body.currentTier).toBe("collector");  // effective, not "free"
  });
});

// ─── Webhook-no-clear (mechanical) + idempotency ──────────────────────────

describe("CF-OWNER-OVERRIDE: setUserSubscriptionState preserves override", () => {
  it("Apple webhook plan flip does NOT clear an existing entitlementOverride", async () => {
    const authMod: any = await vi.importActual<any>(
      "../src/services/authService.js",
    );

    // Seed a fresh user, claim override.
    const username = `o${Date.now()}`.slice(0, 30);
    const reg = await authMod.registerUser({
      email: `owner-${Date.now()}@example.com`,
      username,
      password: "ValidPass123!",
    });
    expect(reg.success).toBe(true);
    const userId = reg.user.userId as string;

    const withOverride = await authMod.setEntitlementOverride(
      userId,
      "pro_seller",
      { username },
    );
    expect(withOverride?.entitlementOverride).toBe("pro_seller");

    // Simulate an Apple-side subscription update arriving via the
    // webhook → notificationHandler → setUserSubscriptionState path.
    // This is the exact write the webhook performs.
    const afterWebhook = await authMod.setUserSubscriptionState(
      userId,
      "investor",
      {
        originalTransactionId: "TXN-XYZ",
        expiresAt: "2026-12-31T23:59:59.000Z",
        lastEventAt: "2026-06-05T00:00:00.000Z",
        environment: "Production",
        productId: "com.hobbyiq.investor.monthly",
      },
    );

    // Plan moved to investor (Apple's truth) but override survives.
    expect(afterWebhook?.plan).toBe("investor");
    expect(afterWebhook?.entitlementOverride).toBe("pro_seller");

    // And the effective resolver still says pro_seller.
    const { effectivePlanFor } = await import("../src/config/entitlements.js");
    expect(effectivePlanFor(afterWebhook!)).toBe("pro_seller");
  });

  it("setEntitlementOverride is idempotent (re-running with same args is a no-op write)", async () => {
    const authMod: any = await vi.importActual<any>(
      "../src/services/authService.js",
    );
    const username = `i${Date.now()}`.slice(0, 30);
    const reg = await authMod.registerUser({
      email: `idem-${Date.now()}@example.com`,
      username,
      password: "ValidPass123!",
    });
    const userId = reg.user.userId as string;

    const r1 = await authMod.setEntitlementOverride(userId, "pro_seller", { username });
    const r2 = await authMod.setEntitlementOverride(userId, "pro_seller", { username });
    expect(r1?.entitlementOverride).toBe("pro_seller");
    expect(r2?.entitlementOverride).toBe("pro_seller");
    expect(r2?.userId).toBe(userId);
  });

  it("setEntitlementOverride(userId, null) clears the override", async () => {
    const authMod: any = await vi.importActual<any>(
      "../src/services/authService.js",
    );
    const username = `c${Date.now()}`.slice(0, 30);
    const reg = await authMod.registerUser({
      email: `clear-${Date.now()}@example.com`,
      username,
      password: "ValidPass123!",
    });
    const userId = reg.user.userId as string;

    await authMod.setEntitlementOverride(userId, "pro_seller", { username });
    const cleared = await authMod.setEntitlementOverride(userId, null);
    expect(cleared?.entitlementOverride).toBeNull();
  });

  it("findUserByEmail round-trips through to the AuthUser projection (with override)", async () => {
    const authMod: any = await vi.importActual<any>(
      "../src/services/authService.js",
    );
    const email = `lookup-${Date.now()}@example.com`;
    const username = `l${Date.now()}`.slice(0, 30);
    const reg = await authMod.registerUser({ email, username, password: "ValidPass123!" });
    await authMod.setEntitlementOverride(reg.user.userId, "pro_seller", { username });

    const found = await authMod.findUserByEmail(email);
    expect(found?.userId).toBe(reg.user.userId);
    expect(found?.entitlementOverride).toBe("pro_seller");
  });
});

// ─── effectivePlanFor unit ────────────────────────────────────────────────

describe("CF-OWNER-OVERRIDE: effectivePlanFor unit behavior", () => {
  it("override beats plan", async () => {
    const { effectivePlanFor } = await import("../src/config/entitlements.js");
    expect(effectivePlanFor({ plan: "free", entitlementOverride: "pro_seller" })).toBe("pro_seller");
  });
  it("null override → plan", async () => {
    const { effectivePlanFor } = await import("../src/config/entitlements.js");
    expect(effectivePlanFor({ plan: "investor", entitlementOverride: null })).toBe("investor");
  });
  it("undefined override → plan", async () => {
    const { effectivePlanFor } = await import("../src/config/entitlements.js");
    expect(effectivePlanFor({ plan: "investor" })).toBe("investor");
  });
  it("unknown override literal → plan", async () => {
    const { effectivePlanFor } = await import("../src/config/entitlements.js");
    expect(effectivePlanFor({ plan: "collector", entitlementOverride: "garbage" as any })).toBe("collector");
  });
});
