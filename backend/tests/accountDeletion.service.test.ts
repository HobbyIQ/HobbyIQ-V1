// CF-ACCOUNT-DELETION (2026-06-04): orchestrator coverage.
//
// Mocks every per-container helper at module-load time so the test
// inspects the orchestration logic (call order, summary shape, Apple
// link handling) without touching Cosmos / Blob storage.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const deleteUserDocMock = vi.fn(async (_userId: string) => true);
vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteUserDoc: (...args: unknown[]) => deleteUserDocMock(...(args as [string])),
  };
});

const portfolioDeleteSummary = {
  existed: true, holdingCount: 3, ledgerCount: 5, tradeCount: 1, expensesEmbeddedCount: 0,
};
const deletePortfolioDocForUserMock = vi.fn(async (_uid: string) => portfolioDeleteSummary);
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deletePortfolioDocForUser: (...args: unknown[]) => deletePortfolioDocForUserMock(...(args as [string])),
  };
});

const deleteAllExpensesForUserMock = vi.fn(async (_uid: string) => 4);
vi.mock("../src/repositories/portfolioExpenses.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAllExpensesForUser: (...args: unknown[]) => deleteAllExpensesForUserMock(...(args as [string])),
  };
});

const deleteAllTaxFilingsForUserMock = vi.fn(async (_uid: string) => 2);
vi.mock("../src/repositories/taxFilings.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAllTaxFilingsForUser: (...args: unknown[]) => deleteAllTaxFilingsForUserMock(...(args as [string])),
  };
});

const deleteAllWatchlistEntriesForUserMock = vi.fn(async (_uid: string) => 7);
vi.mock("../src/services/dailyiq/watchlistStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAllWatchlistEntriesForUser: (...args: unknown[]) => deleteAllWatchlistEntriesForUserMock(...(args as [string])),
  };
});

const deleteAllAlertsForUserMock = vi.fn(async (_uid: string) => 3);
vi.mock("../src/repositories/priceAlerts.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAllAlertsForUser: (...args: unknown[]) => deleteAllAlertsForUserMock(...(args as [string])),
  };
});

const deleteAllRulesForUserMock = vi.fn(async (_uid: string) => 2);
vi.mock("../src/repositories/advancedAlertRules.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAllRulesForUser: (...args: unknown[]) => deleteAllRulesForUserMock(...(args as [string])),
  };
});

const deletePreferenceForUserMock = vi.fn(async (_uid: string) => true);
vi.mock("../src/repositories/alertPreferences.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deletePreferenceForUser: (...args: unknown[]) => deletePreferenceForUserMock(...(args as [string])),
  };
});

const deleteTokenRecordMock = vi.fn(async (_uid: string) => undefined);
vi.mock("../src/services/ebay/ebayTokenStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteTokenRecord: (...args: unknown[]) => deleteTokenRecordMock(...(args as [string])),
  };
});

const deleteAllTokensForUserMock = vi.fn(async (_uid: string) => 1);
vi.mock("../src/repositories/deviceToken.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAllTokensForUser: (...args: unknown[]) => deleteAllTokensForUserMock(...(args as [string])),
  };
});

const deleteAllBlobsForUserMock = vi.fn(async (_uid: string) => 11);
vi.mock("../src/services/photoStorage/photoStorage.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    deleteAllBlobsForUser: (...args: unknown[]) => deleteAllBlobsForUserMock(...(args as [string])),
  };
});

const anonymizePredictionLogForUserMock = vi.fn(async (_uid: string) => 9);
vi.mock("../src/services/compiq/predictionCorpus.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    anonymizePredictionLogForUser: (...args: unknown[]) => anonymizePredictionLogForUserMock(...(args as [string])),
  };
});

const anonymizeSubscriptionEventsForUserMock = vi.fn(async (_uid: string) => 2);
vi.mock("../src/services/subscriptions/subscriptionEventStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    anonymizeSubscriptionEventsForUser: (...args: unknown[]) => anonymizeSubscriptionEventsForUserMock(...(args as [string])),
  };
});

// ─── Import under test (after mocks) ────────────────────────────────────────

import { deleteAccountForUser } from "../src/services/accountDeletion/accountDeletion.service.js";
import type { AuthUser } from "../src/services/authService.js";

function makeUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: "u-1",
    email: "u1@t",
    username: null,
    fullName: null,
    plan: "investor",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  } as AuthUser;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleteAccountForUser — summary shape + delegation", () => {
  it("returns per-container counts matching mocked helpers", async () => {
    const result = await deleteAccountForUser(makeUser({ userId: "u-1" }));
    expect(result.success).toBe(true);
    expect(result.userId).toBe("u-1");
    expect(result.purged.portfolio_doc).toEqual(portfolioDeleteSummary);
    expect(result.purged.portfolio_expenses).toBe(4);
    expect(result.purged.tax_filings).toBe(2);
    expect(result.purged.dailyiq_watchlist).toBe(7);
    expect(result.purged.compiq_alerts).toBe(3);
    expect(result.purged.compiq_advanced_alert_rules).toBe(2);
    expect(result.purged.alert_preferences_doc_deleted).toBe(true);
    expect(result.purged.ebay_connections_token_deleted).toBe(true);
    expect(result.purged.device_tokens).toBe(1);
    expect(result.purged.photo_blobs).toBe(11);
    expect(result.purged.users_doc_deleted).toBe(true);
    expect(result.anonymized.prediction_log_rows_anonymized).toBe(9);
    expect(result.anonymized.subscription_events_rows_anonymized).toBe(2);
    expect(result.retained_no_pii.prediction_outcomes).toMatch(/no userId/);
    expect(result.retained_no_pii.webhook_events).toMatch(/no userId/);
  });

  it("invokes every purge helper with the user's id", async () => {
    await deleteAccountForUser(makeUser({ userId: "u-target" }));
    expect(deleteUserDocMock).toHaveBeenCalledWith("u-target");
    expect(deletePortfolioDocForUserMock).toHaveBeenCalledWith("u-target");
    expect(deleteAllExpensesForUserMock).toHaveBeenCalledWith("u-target");
    expect(deleteAllTaxFilingsForUserMock).toHaveBeenCalledWith("u-target");
    expect(deleteAllWatchlistEntriesForUserMock).toHaveBeenCalledWith("u-target");
    expect(deleteAllAlertsForUserMock).toHaveBeenCalledWith("u-target");
    expect(deleteAllRulesForUserMock).toHaveBeenCalledWith("u-target");
    expect(deletePreferenceForUserMock).toHaveBeenCalledWith("u-target");
    expect(deleteTokenRecordMock).toHaveBeenCalledWith("u-target");
    expect(deleteAllTokensForUserMock).toHaveBeenCalledWith("u-target");
    expect(deleteAllBlobsForUserMock).toHaveBeenCalledWith("u-target");
    expect(anonymizePredictionLogForUserMock).toHaveBeenCalledWith("u-target");
    expect(anonymizeSubscriptionEventsForUserMock).toHaveBeenCalledWith("u-target");
  });

  it("user doc deletion is the LAST call (session-invalidation timing)", async () => {
    const order: string[] = [];
    deleteUserDocMock.mockImplementationOnce(async () => { order.push("users"); return true; });
    deletePortfolioDocForUserMock.mockImplementationOnce(async () => { order.push("portfolio"); return portfolioDeleteSummary; });
    deleteAllBlobsForUserMock.mockImplementationOnce(async () => { order.push("photos"); return 0; });
    await deleteAccountForUser(makeUser());
    // users is the last call in the order array regardless of how many earlier ones ran
    expect(order[order.length - 1]).toBe("users");
  });

  it("anonymize calls happen BEFORE any destructive purge", async () => {
    const order: string[] = [];
    anonymizePredictionLogForUserMock.mockImplementationOnce(async () => { order.push("anon-pred"); return 0; });
    anonymizeSubscriptionEventsForUserMock.mockImplementationOnce(async () => { order.push("anon-subs"); return 0; });
    deleteAllAlertsForUserMock.mockImplementationOnce(async () => { order.push("purge-alerts"); return 0; });
    deletePortfolioDocForUserMock.mockImplementationOnce(async () => { order.push("purge-portfolio"); return portfolioDeleteSummary; });
    deleteUserDocMock.mockImplementationOnce(async () => { order.push("purge-users"); return true; });
    await deleteAccountForUser(makeUser());
    const anonIdx = Math.max(order.indexOf("anon-pred"), order.indexOf("anon-subs"));
    const firstPurgeIdx = Math.min(
      order.indexOf("purge-alerts"),
      order.indexOf("purge-portfolio"),
      order.indexOf("purge-users"),
    );
    expect(anonIdx).toBeLessThan(firstPurgeIdx);
  });
});

describe("Apple subscription handling", () => {
  it("user with appleSubscription -> wasLinked=true + cancellation message + URL", async () => {
    const result = await deleteAccountForUser(makeUser({
      appleSubscription: {
        originalTransactionId: "OTXN-123",
        expiresAt: "2026-12-01T00:00:00Z",
        lastEventAt: "2026-06-01T00:00:00Z",
        environment: "Sandbox",
        productId: "com.example.investor.monthly",
      },
    }));
    if (!result.appleSubscription.wasLinked) {
      throw new Error("expected wasLinked=true");
    }
    expect(result.appleSubscription.originalTransactionId).toBe("OTXN-123");
    expect(result.appleSubscription.billingActionRequired).toBe(true);
    expect(result.appleSubscription.message).toMatch(/iOS Settings/);
    expect(result.appleSubscription.message).toMatch(/Apple ID/);
    expect(result.appleSubscription.cancellationInstructionsUrl).toMatch(/^https:\/\//);
  });

  it("user without appleSubscription -> wasLinked=false", async () => {
    const result = await deleteAccountForUser(makeUser({ appleSubscription: undefined }));
    expect(result.appleSubscription.wasLinked).toBe(false);
  });
});

describe("Error tolerance — one container failure doesn't strand the purge", () => {
  it("photo blob delete returning 0 doesn't break the summary", async () => {
    deleteAllBlobsForUserMock.mockResolvedValueOnce(0);
    const result = await deleteAccountForUser(makeUser());
    expect(result.success).toBe(true);
    expect(result.purged.photo_blobs).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("ebay token throwing is caught + reported as not-deleted + tagged [ebay]", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteTokenRecordMock.mockRejectedValueOnce(new Error("transient cosmos"));
    const result = await deleteAccountForUser(makeUser());
    expect(result.success).toBe(true);
    expect(result.purged.ebay_connections_token_deleted).toBe(false);
    // Subsequent steps still ran:
    expect(result.purged.users_doc_deleted).toBe(true);
    // Failure surfaced in summary.
    expect(result.failures).toContain("ebay_connections_token");
    // [ebay] umbrella tag landed for Group-B alert pickup.
    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const tagged = lines.find((l) =>
      l.includes("[ebay][accountDeletion] purge step 'ebay_connections_token' failed:"),
    );
    expect(tagged).toBeDefined();
    errSpy.mockRestore();
  });
});

describe("CF-PUSH-A+B+C STEP 0: subsystem-tagged error log + failures[] on container purge failure", () => {
  it("Cosmos container failure emits [cosmos][accountDeletion] error AND surfaces in summary.failures", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Simulate a Cosmos hiccup in compiq_alerts purge.
    deleteAllAlertsForUserMock.mockRejectedValueOnce(new Error("Cosmos 503"));
    const result = await deleteAccountForUser(makeUser({ userId: "u-cosmos-fail" }));

    // Orchestrator did not throw; the purge completed.
    expect(result.success).toBe(true);
    // Failed step landed in summary.failures (so the route response carries it).
    expect(result.failures).toContain("compiq_alerts");
    // Failed step's count is 0 (fallback returned).
    expect(result.purged.compiq_alerts).toBe(0);
    // Subsequent steps still ran (users_doc_deleted is the LAST step).
    expect(result.purged.users_doc_deleted).toBe(true);

    // The [cosmos][accountDeletion] tag landed in console.error for the
    // Group-B per-subsystem error-spike alert to match.
    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const tagged = lines.find((l) =>
      l.includes("[cosmos][accountDeletion] purge step 'compiq_alerts' failed:"),
    );
    expect(
      tagged,
      `expected '[cosmos][accountDeletion] purge step compiq_alerts failed' log line; got ${JSON.stringify(lines)}`,
    ).toBeDefined();
    errSpy.mockRestore();
  });

  it("Apple anonymize failure tags [cosmos][apple][accountDeletion]", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    anonymizeSubscriptionEventsForUserMock.mockRejectedValueOnce(new Error("Cosmos timeout"));
    const result = await deleteAccountForUser(makeUser());
    expect(result.success).toBe(true);
    expect(result.failures).toContain("anonymize_subscription_events");
    expect(result.anonymized.subscription_events_rows_anonymized).toBe(0);

    const lines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const tagged = lines.find((l) => l.includes("[cosmos][apple][accountDeletion]"));
    expect(tagged).toBeDefined();
    errSpy.mockRestore();
  });

  it("multiple failures all land in failures[]; purge still completes", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteAllAlertsForUserMock.mockRejectedValueOnce(new Error("a"));
    deleteAllRulesForUserMock.mockRejectedValueOnce(new Error("b"));
    deletePreferenceForUserMock.mockRejectedValueOnce(new Error("c"));
    const result = await deleteAccountForUser(makeUser());
    expect(result.success).toBe(true);
    expect(result.failures.sort()).toEqual(
      ["alert_preferences", "compiq_advanced_alert_rules", "compiq_alerts"].sort(),
    );
    // Each failure tagged separately.
    expect(errSpy).toHaveBeenCalledTimes(3);
    // Subsequent steps still ran.
    expect(result.purged.users_doc_deleted).toBe(true);
    errSpy.mockRestore();
  });

  it("clean purge -> failures is an empty array", async () => {
    const result = await deleteAccountForUser(makeUser());
    expect(result.failures).toEqual([]);
  });
});
