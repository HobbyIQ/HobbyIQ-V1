// CF-ACCOUNT-DELETION (2026-06-04): DELETE /api/account route coverage.
// Gates 401 (no session) + 400 (no/wrong confirm token) + 200 (purge fires).

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

// Stub the orchestrator so this suite focuses on gates + body validation.
const deleteAccountForUserMock = vi.fn(async (user: any) => ({
  success: true,
  userId: user.userId,
  deletedAt: "2026-06-04T00:00:00.000Z",
  failures: [],
  purged: {
    portfolio_doc: { existed: true, holdingCount: 1, ledgerCount: 0, tradeCount: 0, expensesEmbeddedCount: 0 },
    portfolio_expenses: 0,
    tax_filings: 0,
    dailyiq_watchlist: 0,
    compiq_alerts: 0,
    compiq_advanced_alert_rules: 0,
    alert_preferences_doc_deleted: false,
    ebay_connections_token_deleted: false,
    device_tokens: 0,
    photo_blobs: 0,
    users_doc_deleted: true,
  },
  anonymized: { prediction_log_rows_anonymized: 0, subscription_events_rows_anonymized: 0 },
  retained_no_pii: {
    prediction_outcomes: "no userId field on the row schema; not affected",
    webhook_events: "no userId field on the row schema; not affected",
  },
  appleSubscription: { wasLinked: false },
}));
vi.mock("../src/services/accountDeletion/accountDeletion.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAccountForUser: (...args: unknown[]) => deleteAccountForUserMock(...(args as [any])),
  };
});

function makeUser(plan: string = "investor") {
  return { userId: "u-1", email: "u@t", plan, createdAt: "2026-01-01T00:00:00Z" };
}

let app: any;
beforeAll(async () => { app = (await import("../src/app")).default; });

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  deleteAccountForUserMock.mockClear();
});

describe("DELETE /api/account — gates", () => {
  it("401 when no x-session-id", async () => {
    const r = await request(app).delete("/api/account").send({ confirm: "DELETE_MY_ACCOUNT" });
    expect(r.status).toBe(401);
    expect(deleteAccountForUserMock).not.toHaveBeenCalled();
  });

  it("400 when body missing confirm token", async () => {
    setUser(makeUser());
    const r = await request(app).delete("/api/account").set("x-session-id", "s").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Confirmation required");
    expect(deleteAccountForUserMock).not.toHaveBeenCalled();
  });

  it("400 when confirm token is wrong value", async () => {
    setUser(makeUser());
    const r = await request(app).delete("/api/account").set("x-session-id", "s").send({ confirm: "delete" });
    expect(r.status).toBe(400);
    expect(deleteAccountForUserMock).not.toHaveBeenCalled();
  });

  it("200 with full purge summary on valid call", async () => {
    setUser(makeUser());
    const r = await request(app)
      .delete("/api/account")
      .set("x-session-id", "s")
      .send({ confirm: "DELETE_MY_ACCOUNT" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.userId).toBe("u-1");
    expect(r.body.purged.users_doc_deleted).toBe(true);
    expect(r.body.anonymized.prediction_log_rows_anonymized).toBe(0);
    expect(r.body.retained_no_pii.prediction_outcomes).toMatch(/no userId/);
    expect(deleteAccountForUserMock).toHaveBeenCalledTimes(1);
  });

  it("orchestrator throw -> 500", async () => {
    setUser(makeUser());
    deleteAccountForUserMock.mockRejectedValueOnce(new Error("kaboom"));
    const r = await request(app)
      .delete("/api/account")
      .set("x-session-id", "s")
      .send({ confirm: "DELETE_MY_ACCOUNT" });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("Account deletion failed");
  });
});

describe("Idempotency", () => {
  it("second call after first 200 returns 401 (session invalid because user doc is gone)", async () => {
    setUser(makeUser());
    const r1 = await request(app)
      .delete("/api/account")
      .set("x-session-id", "s")
      .send({ confirm: "DELETE_MY_ACCOUNT" });
    expect(r1.status).toBe(200);

    // Simulate the session-invalidation: user lookup now returns null
    setUser(null);
    const r2 = await request(app)
      .delete("/api/account")
      .set("x-session-id", "s")
      .send({ confirm: "DELETE_MY_ACCOUNT" });
    expect(r2.status).toBe(401);
    expect(deleteAccountForUserMock).toHaveBeenCalledTimes(1);
  });
});
