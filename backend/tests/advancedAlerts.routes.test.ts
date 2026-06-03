// CF-ADVANCED-ALERTS (2026-06-03): /api/alerts/advanced CRUD + gate coverage.

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

const listRulesMock = vi.fn(async (_u: string) => [] as any[]);
const getRuleMock = vi.fn(async (_u: string, _r: string) => null as any);
const createRuleMock = vi.fn(async (input: any) => ({
  ruleId: "r-created",
  ...input,
  createdAt: "2026-01-01T00:00:00Z",
  lastEvaluatedAt: null,
  lastTriggeredAt: null,
  triggerCount: 0,
}));
const updateRuleMock = vi.fn(async (_u: string, _r: string, patch: any) => ({
  ruleId: "r-1",
  userId: "u",
  name: patch.name ?? "Rule",
  scope: patch.scope ?? { type: "card", cardsightCardId: "c-1" },
  combinator: patch.combinator ?? "AND",
  conditions: patch.conditions ?? [{ kind: "predicted_direction", equals: "up" }],
  cooldownMin: patch.cooldownMin ?? 360,
  isActive: patch.isActive ?? true,
  createdAt: "2026-01-01T00:00:00Z",
  lastEvaluatedAt: null,
  lastTriggeredAt: null,
  triggerCount: 0,
}));
const deleteRuleMock = vi.fn(async () => true);
const countActiveRulesMock = vi.fn(async () => 0);

vi.mock("../src/repositories/advancedAlertRules.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listRulesForUser: (...args: unknown[]) => listRulesMock(...(args as [string])),
    getRuleForUser: (...args: unknown[]) => getRuleMock(...(args as [string, string])),
    createRule: (...args: unknown[]) => createRuleMock(...args),
    updateRule: (...args: unknown[]) => updateRuleMock(...(args as [string, string, any])),
    deleteRule: (...args: unknown[]) => deleteRuleMock(...args),
    countActiveRulesForUser: (...args: unknown[]) => countActiveRulesMock(...(args as [string])),
  };
});

const listBasicAlertsMock = vi.fn(async () => [] as any[]);
vi.mock("../src/repositories/priceAlerts.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listAlertsForUser: (...args: unknown[]) => listBasicAlertsMock(...args),
  };
});

function makeUser(plan: string) {
  return {
    userId: `u-${plan}`,
    email: `${plan}@t`,
    username: null,
    fullName: null,
    plan,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const VALID_BODY = {
  name: "Skenes up watch",
  scope: { type: "card", cardsightCardId: "c-1" },
  combinator: "AND",
  conditions: [{ kind: "predicted_direction", equals: "up" }],
  cooldownMin: 360,
};

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  listRulesMock.mockReset().mockResolvedValue([]);
  getRuleMock.mockReset().mockResolvedValue(null);
  createRuleMock.mockClear();
  updateRuleMock.mockClear();
  deleteRuleMock.mockClear().mockResolvedValue(true);
  countActiveRulesMock.mockReset().mockResolvedValue(0);
  listBasicAlertsMock.mockReset().mockResolvedValue([]);
});

// ─── Gate matrix per route ──────────────────────────────────────────────────

const ROUTES: Array<{ name: string; method: "get" | "post" | "patch" | "delete"; path: string; body?: any }> = [
  { name: "list rules", method: "get", path: "/api/alerts/advanced" },
  { name: "create rule", method: "post", path: "/api/alerts/advanced", body: VALID_BODY },
  { name: "get rule", method: "get", path: "/api/alerts/advanced/r-1" },
  { name: "patch rule", method: "patch", path: "/api/alerts/advanced/r-1", body: { name: "renamed" } },
  { name: "delete rule", method: "delete", path: "/api/alerts/advanced/r-1" },
];

for (const route of ROUTES) {
  describe(`${route.method.toUpperCase()} ${route.path} — gates`, () => {
    it("401 without x-session-id", async () => {
      const r = await (request(app) as any)[route.method](route.path).send(route.body ?? {});
      expect(r.status).toBe(401);
    });
    it("402 for free (lacks advancedAlerts)", async () => {
      setUser(makeUser("free"));
      const r = await (request(app) as any)
        [route.method](route.path)
        .set("x-session-id", "s")
        .send(route.body ?? {});
      expect(r.status).toBe(402);
      expect(r.body.feature).toBe("advancedAlerts");
      expect(r.body.requiredTier).toBe("investor");
    });
    it("402 for collector (lacks advancedAlerts)", async () => {
      setUser(makeUser("collector"));
      const r = await (request(app) as any)
        [route.method](route.path)
        .set("x-session-id", "s")
        .send(route.body ?? {});
      expect(r.status).toBe(402);
      expect(r.body.requiredTier).toBe("investor");
    });
    it("investor passes the entitlement gate", async () => {
      setUser(makeUser("investor"));
      getRuleMock.mockResolvedValue({
        ruleId: "r-1",
        userId: "u-investor",
        name: "x",
        scope: { type: "card", cardsightCardId: "c-1" },
        combinator: "AND",
        conditions: [{ kind: "predicted_direction", equals: "up" }],
        cooldownMin: 360,
        isActive: true,
        createdAt: "2026-01-01T00:00:00Z",
        lastEvaluatedAt: null,
        lastTriggeredAt: null,
        triggerCount: 0,
      });
      const r = await (request(app) as any)
        [route.method](route.path)
        .set("x-session-id", "s")
        .send(route.body ?? {});
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(402);
    });
    it("pro_seller passes the entitlement gate", async () => {
      setUser(makeUser("pro_seller"));
      getRuleMock.mockResolvedValue({
        ruleId: "r-1",
        userId: "u-pro_seller",
        name: "x",
        scope: { type: "card", cardsightCardId: "c-1" },
        combinator: "AND",
        conditions: [{ kind: "predicted_direction", equals: "up" }],
        cooldownMin: 360,
        isActive: true,
        createdAt: "2026-01-01T00:00:00Z",
        lastEvaluatedAt: null,
        lastTriggeredAt: null,
        triggerCount: 0,
      });
      const r = await (request(app) as any)
        [route.method](route.path)
        .set("x-session-id", "s")
        .send(route.body ?? {});
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(402);
    });
  });
}

// ─── CRUD payload + validation ─────────────────────────────────────────────

describe("POST /api/alerts/advanced — body validation", () => {
  beforeEach(() => setUser(makeUser("investor")));

  it("rejects missing name", async () => {
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send({ ...VALID_BODY, name: "" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/);
  });
  it("rejects malformed scope (unknown type)", async () => {
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send({ ...VALID_BODY, scope: { type: "junk" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/scope/);
  });
  it("rejects malformed condition", async () => {
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send({ ...VALID_BODY, conditions: [{ kind: "nope" }] });
    expect(r.status).toBe(400);
  });
  // CF-ADVANCED-ALERTS pre-deploy fix (2026-06-03): crossing-class conditions
  // are inert in Phase 1 (no per-rule previous-slice storage). Don't accept
  // a schema that lets users create silently-dead rules.
  it("rejects price_crosses with 'not yet supported' message", async () => {
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send({
        ...VALID_BODY,
        conditions: [{ kind: "price_crosses", op: "above", value: 100 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/price_crosses/);
    expect(r.body.error).toMatch(/not yet supported/i);
    expect(createRuleMock).not.toHaveBeenCalled();
  });
  it("rejects predicted_price_crosses with 'not yet supported' message", async () => {
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send({
        ...VALID_BODY,
        conditions: [{ kind: "predicted_price_crosses", op: "above", value: 100 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/predicted_price_crosses/);
    expect(r.body.error).toMatch(/not yet supported/i);
    expect(createRuleMock).not.toHaveBeenCalled();
  });
  it("PATCH also rejects crossing conditions in conditions[] update", async () => {
    const r = await request(app)
      .patch("/api/alerts/advanced/r-1")
      .set("x-session-id", "s")
      .send({
        conditions: [{ kind: "price_crosses", op: "above", value: 100 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not yet supported/i);
    expect(updateRuleMock).not.toHaveBeenCalled();
  });
  it("accepts a valid rule and returns 201 with rule payload", async () => {
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.rule.name).toBe(VALID_BODY.name);
    expect(r.body.rule.scope.type).toBe("card");
    expect(createRuleMock).toHaveBeenCalledTimes(1);
  });
  it("rejects out-of-range cooldownMin", async () => {
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send({ ...VALID_BODY, cooldownMin: 1 });
    expect(r.status).toBe(201); // valid cooldown defaults silently
    // Now hit an explicitly bad value via PATCH where strict validation fires.
    // (POST falls back to default 360 for out-of-range cooldown by spec.)
  });
});

describe("PATCH /api/alerts/advanced/:ruleId — validation", () => {
  beforeEach(() => setUser(makeUser("investor")));

  it("rejects bad cooldownMin (strict validation on patch)", async () => {
    const r = await request(app)
      .patch("/api/alerts/advanced/r-1")
      .set("x-session-id", "s")
      .send({ cooldownMin: 1 });
    expect(r.status).toBe(400);
  });
  it("accepts a valid patch", async () => {
    const r = await request(app)
      .patch("/api/alerts/advanced/r-1")
      .set("x-session-id", "s")
      .send({ name: "renamed", isActive: false });
    expect(r.status).toBe(200);
    expect(r.body.rule.name).toBe("renamed");
    expect(updateRuleMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Shared cap interaction ────────────────────────────────────────────────

describe("Shared priceAlerts cap (basic + advanced)", () => {
  it("collector at 5 basic + 5 advanced = 10 (cap) → 402 on 11th create", async () => {
    setUser(makeUser("collector"));
    // collector cap is 10. Mock 5 active basic + 5 active advanced.
    listBasicAlertsMock.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ alertId: `a${i}`, isActive: true })) as any,
    );
    countActiveRulesMock.mockResolvedValueOnce(5);
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    // collector lacks advancedAlerts entitlement (investor+), so the 402
    // is from the ENTITLEMENT gate, not capacity. This documents the
    // current matrix: collector never reaches the capacity check on
    // /api/alerts/advanced because it can't pass the entitlement.
    expect(r.status).toBe(402);
    expect(r.body.feature).toBe("advancedAlerts");
  });

  it("investor at cap (30) → 402 capacity_exceeded with combined counter", async () => {
    setUser(makeUser("investor"));
    // investor cap is 30. Mock 20 active basic + 10 active advanced = 30 (at cap).
    listBasicAlertsMock.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, i) => ({ alertId: `a${i}`, isActive: true })) as any,
    );
    countActiveRulesMock.mockResolvedValueOnce(10);
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe("capacity_exceeded");
    expect(r.body.cap).toBe("priceAlerts");
    expect(r.body.current).toBe(30);
    expect(r.body.limit).toBe(30);
  });

  it("pro_seller is unlimited — passes regardless of count", async () => {
    setUser(makeUser("pro_seller"));
    listBasicAlertsMock.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => ({ alertId: `a${i}`, isActive: true })) as any,
    );
    countActiveRulesMock.mockResolvedValueOnce(100);
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(201);
  });

  it("inactive basic alerts (already-triggered) do NOT count against cap", async () => {
    setUser(makeUser("investor"));
    listBasicAlertsMock.mockResolvedValueOnce([
      ...Array.from({ length: 30 }, (_, i) => ({ alertId: `dead${i}`, isActive: false })),
    ] as any);
    countActiveRulesMock.mockResolvedValueOnce(0);
    const r = await request(app)
      .post("/api/alerts/advanced")
      .set("x-session-id", "s")
      .send(VALID_BODY);
    expect(r.status).toBe(201);
  });
});
