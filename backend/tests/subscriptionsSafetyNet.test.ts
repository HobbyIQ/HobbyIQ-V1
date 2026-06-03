// CF-PAYMENTS-APPLE-2 (2026-06-03): nightly safety-net tests.
//
// Mirrors the webhook test pattern: mock the Apple lib at the import
// boundary so getAllSubscriptionStatuses returns canned responses.
// Exercises the full reconcile-user flow without touching Apple.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

const { getAllSubscriptionStatuses, verifyAndDecodeTransaction, verifyAndDecodeNotification } =
  vi.hoisted(() => ({
    getAllSubscriptionStatuses: vi.fn(),
    verifyAndDecodeTransaction: vi.fn(),
    verifyAndDecodeNotification: vi.fn(),
  }));

vi.mock("@apple/app-store-server-library", () => ({
  Environment: { PRODUCTION: "Production", SANDBOX: "Sandbox", XCODE: "Xcode", LOCAL_TESTING: "LocalTesting" },
  Status: { ACTIVE: 1, EXPIRED: 2, BILLING_RETRY: 3, BILLING_GRACE_PERIOD: 4, REVOKED: 5 },
  SignedDataVerifier: class {
    verifyAndDecodeNotification = verifyAndDecodeNotification;
    verifyAndDecodeTransaction = verifyAndDecodeTransaction;
  },
  AppStoreServerAPIClient: class {
    getAllSubscriptionStatuses = getAllSubscriptionStatuses;
  },
}));

function seedAppleEnv() {
  process.env.APP_STORE_ISSUER_ID = "test-issuer-id";
  process.env.APP_STORE_KEY_ID = "test-key-id";
  process.env.APP_STORE_PRIVATE_KEY_B64 = Buffer.from("dummy").toString("base64");
  process.env.APP_STORE_BUNDLE_ID = "com.hobbyiq.app";
  process.env.APP_STORE_APP_APPLE_ID = "1234567890";
  process.env.APP_STORE_APPLE_ROOT_CERTS_B64 = Buffer.from("dummy-root").toString("base64");
}

beforeEach(async () => {
  vi.clearAllMocks();
  seedAppleEnv();
  const cfgMod: any = await import("../src/services/subscriptions/appleConfig.js");
  cfgMod._resetAppleConfigForTests();
  // The safety-net job scans every paid user in memStore — without
  // resetting between tests, prior test users still resolve to "paid"
  // and consume the mocked getAllSubscriptionStatuses queue out of order.
  const authMod: any = await import("../src/services/authService.js");
  authMod._resetMemStoreForTests();
});

// Register a user, plant a subscription state. Returns userId.
async function seedUser(opts: {
  label: string;
  plan: string;
  originalTransactionId: string;
  productId?: string;
  expiresAt?: string | null;
}): Promise<string> {
  const authMod: any = await import("../src/services/authService.js");
  const username = `s${opts.label}${Date.now()}`.slice(0, 30);
  const reg = await authMod.registerUser({
    email: `${opts.label}-${Date.now()}@example.com`,
    fullName: null,
    username,
    password: "ValidPass123!",
  });
  const userId = reg.user.userId as string;
  await authMod.setUserSubscriptionState(userId, opts.plan, {
    originalTransactionId: opts.originalTransactionId,
    expiresAt: opts.expiresAt ?? "2026-12-31T23:59:59.000Z",
    lastEventAt: "2026-06-03T00:00:00.000Z",
    environment: "Production",
    productId: opts.productId ?? "com.hobbyiq.collector.monthly",
  });
  return userId;
}

function appleStatusResponse(opts: {
  originalTransactionId: string;
  status: number;
  productId?: string;
  expiresMs?: number;
}) {
  return {
    environment: "Production",
    bundleId: "com.hobbyiq.app",
    data: [
      {
        subscriptionGroupIdentifier: "g1",
        lastTransactions: [
          {
            originalTransactionId: opts.originalTransactionId,
            status: opts.status,
            // The lib's LastTransactionsItem doesn't surface productId
            // directly — the safety-net's extractor falls through `any`
            // for cases where we can inject them in tests.
            productId: opts.productId,
            expiresDate: opts.expiresMs,
          },
        ],
      },
    ],
  };
}

// Lazy import so each test starts with a fresh module state where
// needed.
async function runJob() {
  const jobMod: any = await import("../src/jobs/subscriptionsSafetyNet.job.js");
  return jobMod.runSubscriptionsSafetyNetJob();
}

async function readPlan(userId: string): Promise<string> {
  // Read via the reconcilable-users predicate so free users with an
  // appleSubscription still resolve here (the restore test seeds one
  // such user and asserts the plan post-restore).
  const authMod: any = await import("../src/services/authService.js");
  const candidates = await authMod.findReconcilableUsers(365);
  const hit = candidates.find((u: any) => u.userId === userId);
  if (hit) return hit.plan;
  return "free";
}

async function readAppleSubscription(userId: string): Promise<any> {
  const authMod: any = await import("../src/services/authService.js");
  const candidates = await authMod.findReconcilableUsers(365);
  return candidates.find((u: any) => u.userId === userId)?.appleSubscription ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("runSubscriptionsSafetyNetJob — reconcile scenarios", () => {
  it("paid user with Apple status=EXPIRED -> downgraded to free, Apple link PRESERVED", async () => {
    const userId = await seedUser({
      label: "exp",
      plan: "collector",
      originalTransactionId: "tx-safety-EXPIRED",
      expiresAt: "2026-12-31T23:59:59.000Z",
    });
    getAllSubscriptionStatuses.mockResolvedValueOnce(
      appleStatusResponse({
        originalTransactionId: "tx-safety-EXPIRED",
        status: 2, // EXPIRED
        productId: "com.hobbyiq.collector.monthly",
      }),
    );
    const summary = await runJob();
    expect(summary.reconciled).toBeGreaterThanOrEqual(1);
    expect(await readPlan(userId)).toBe("free");
    // CF-PAYMENTS-APPLE-2-FIX: downgrade MUST preserve the Apple link
    // so the user stays in the next nightly's lookback window.
    const apple = await readAppleSubscription(userId);
    expect(apple).not.toBeNull();
    expect(apple.originalTransactionId).toBe("tx-safety-EXPIRED");
    expect(apple.expiresAt).not.toBeNull();
  });

  it("CF-PAYMENTS-APPLE-2-FIX — free user with recent appleSubscription + Apple ACTIVE -> RESTORED to productId's plan", async () => {
    // User lapsed 5 days ago — within the 40-day lookback window.
    // Their last known productId was collector, but Apple now says
    // they're on investor (refund-reversed an upgrade, or a webhook
    // missed). The bidirectional safety-net restores them.
    const recentExpiresAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const userId = await seedUser({
      label: "restore",
      plan: "free", // CURRENTLY FREE — would have been excluded by the old "paid only" predicate
      originalTransactionId: "tx-safety-RESTORE",
      productId: "com.hobbyiq.collector.monthly",
      expiresAt: recentExpiresAt,
    });

    getAllSubscriptionStatuses.mockResolvedValueOnce(
      appleStatusResponse({
        originalTransactionId: "tx-safety-RESTORE",
        status: 1, // ACTIVE
        productId: "com.hobbyiq.investor.monthly",
        expiresMs: Date.UTC(2027, 0, 31),
      }),
    );

    const summary = await runJob();
    expect(summary.reconciled).toBeGreaterThanOrEqual(1);
    // RESTORED — plan upgraded from free to investor (Apple's authoritative product).
    expect(await readPlan(userId)).toBe("investor");
    const apple = await readAppleSubscription(userId);
    expect(apple.productId).toBe("com.hobbyiq.investor.monthly");
    expect(apple.expiresAt).toBe(new Date(Date.UTC(2027, 0, 31)).toISOString());
  });

  it("CF-PAYMENTS-APPLE-2-FIX — free user with STALE appleSubscription (>40 days) is NOT scanned", async () => {
    // Lapsed 60 days ago — outside the lookback window. The predicate
    // should exclude this user from the scan entirely.
    const staleExpiresAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
    await seedUser({
      label: "stale",
      plan: "free",
      originalTransactionId: "tx-safety-STALE",
      productId: "com.hobbyiq.collector.monthly",
      expiresAt: staleExpiresAt,
    });

    // Apple API should NOT be called for this user. We don't queue a
    // mock response; if reconcileUser ran it'd get `undefined` and
    // throw, surfacing as `errors=1`.
    const summary = await runJob();
    expect(summary.errors).toBe(0);
    // Nothing reconciled either — the user wasn't in the scan set.
    expect(summary.totalScanned).toBe(0);
  });

  it("paid user with Apple status=REVOKED -> downgraded to free", async () => {
    const userId = await seedUser({
      label: "rvk",
      plan: "investor",
      originalTransactionId: "tx-safety-REVOKED",
    });
    getAllSubscriptionStatuses.mockResolvedValueOnce(
      appleStatusResponse({
        originalTransactionId: "tx-safety-REVOKED",
        status: 5, // REVOKED
        productId: "com.hobbyiq.investor.monthly",
      }),
    );
    await runJob();
    expect(await readPlan(userId)).toBe("free");
  });

  it("paid user with Apple status=ACTIVE + matching plan -> unchanged", async () => {
    const userId = await seedUser({
      label: "noop",
      plan: "collector",
      originalTransactionId: "tx-safety-ACTIVE-MATCH",
      productId: "com.hobbyiq.collector.monthly",
      expiresAt: "2026-12-31T23:59:59.000Z",
    });
    // Same expiresAt + same productId -> unchanged.
    getAllSubscriptionStatuses.mockResolvedValueOnce(
      appleStatusResponse({
        originalTransactionId: "tx-safety-ACTIVE-MATCH",
        status: 1, // ACTIVE
        productId: "com.hobbyiq.collector.monthly",
        expiresMs: Date.UTC(2026, 11, 31, 23, 59, 59),
      }),
    );
    const summary = await runJob();
    expect(summary.unchanged).toBeGreaterThanOrEqual(1);
    expect(await readPlan(userId)).toBe("collector");
  });

  it("paid user with Apple status=ACTIVE + different plan -> plan updated (Apple authoritative)", async () => {
    const userId = await seedUser({
      label: "upg",
      plan: "collector",
      originalTransactionId: "tx-safety-INGROUP-CHANGE",
      productId: "com.hobbyiq.collector.monthly",
    });
    getAllSubscriptionStatuses.mockResolvedValueOnce(
      appleStatusResponse({
        originalTransactionId: "tx-safety-INGROUP-CHANGE",
        status: 1, // ACTIVE
        // Apple says the customer is now on investor (in-group tier
        // change). The webhook missed.
        productId: "com.hobbyiq.investor.monthly",
        expiresMs: Date.UTC(2027, 5, 30),
      }),
    );
    const summary = await runJob();
    expect(summary.reconciled).toBeGreaterThanOrEqual(1);
    expect(await readPlan(userId)).toBe("investor");
  });

  it("paid user with no Apple record (status entry missing) -> downgraded to free", async () => {
    const userId = await seedUser({
      label: "ghost",
      plan: "pro_seller",
      originalTransactionId: "tx-safety-GHOST",
    });
    getAllSubscriptionStatuses.mockResolvedValueOnce({
      environment: "Production",
      bundleId: "com.hobbyiq.app",
      data: [], // no groups, no entries
    });
    await runJob();
    expect(await readPlan(userId)).toBe("free");
  });

  it("Apple API throws for one user -> error counted, other users still reconciled", async () => {
    const userA = await seedUser({
      label: "err",
      plan: "collector",
      originalTransactionId: "tx-safety-ERROR-1",
    });
    const userB = await seedUser({
      label: "ok",
      plan: "collector",
      originalTransactionId: "tx-safety-ERROR-2",
    });
    // First user throws, second user succeeds with EXPIRED.
    getAllSubscriptionStatuses
      .mockRejectedValueOnce(new Error("Apple 500"))
      .mockResolvedValueOnce(
        appleStatusResponse({
          originalTransactionId: "tx-safety-ERROR-2",
          status: 2,
          productId: "com.hobbyiq.collector.monthly",
        }),
      );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const summary = await runJob();
    expect(summary.errors).toBe(1);
    expect(summary.reconciled).toBeGreaterThanOrEqual(1);
    expect(await readPlan(userB)).toBe("free");
    // userA still has the original plan since the API call errored.
    expect(await readPlan(userA)).toBe("collector");
    errSpy.mockRestore();
  });

  it("logs done-line with totalScanned + reconciled + unchanged + errors", async () => {
    await seedUser({
      label: "log",
      plan: "investor",
      originalTransactionId: "tx-safety-LOG",
    });
    getAllSubscriptionStatuses.mockResolvedValueOnce(
      appleStatusResponse({
        originalTransactionId: "tx-safety-LOG",
        status: 1,
        productId: "com.hobbyiq.investor.monthly",
        expiresMs: Date.UTC(2026, 11, 31, 23, 59, 59),
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runJob();
    const doneLog = logSpy.mock.calls.find((c) =>
      String(c[0] ?? "").includes("[subscriptionsSafetyNet] done"),
    );
    expect(doneLog).toBeDefined();
    expect(String(doneLog![0])).toMatch(/totalScanned=\d+ reconciled=\d+ unchanged=\d+ errors=\d+/);
    logSpy.mockRestore();
  });
});
