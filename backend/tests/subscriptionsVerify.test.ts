// CF-PAYMENTS-APPLE-1 (2026-06-03): integration tests for the
// /api/subscriptions/verify route + the underlying verifier service.
//
// We mock the Apple library at the @apple/app-store-server-library
// boundary so the verifier + API client return canned responses. The
// tests then exercise the FULL service chain (productId mapping,
// idempotent upsert, route-layer error mapping) without touching Apple.

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

// ─── Mock Apple lib ─────────────────────────────────────────────────────────
//
// vi.mock is hoisted ABOVE every top-level statement in this file, so the
// factory closure can't reference plain `const x = vi.fn()` — those run
// AFTER the factory. vi.hoisted() runs at the same hoisted phase so we
// can share the mock fns between the factory and the test bodies.
const { verifyAndDecodeTransaction, getAllSubscriptionStatuses } = vi.hoisted(() => ({
  verifyAndDecodeTransaction: vi.fn(),
  getAllSubscriptionStatuses: vi.fn(),
}));

vi.mock("@apple/app-store-server-library", () => ({
  Environment: {
    PRODUCTION: "Production",
    SANDBOX: "Sandbox",
    XCODE: "Xcode",
    LOCAL_TESTING: "LocalTesting",
  },
  Status: {
    ACTIVE: 1,
    EXPIRED: 2,
    BILLING_RETRY: 3,
    BILLING_GRACE_PERIOD: 4,
    REVOKED: 5,
  },
  // Class form (vi.fn().mockImplementation() returns an arrow which can't
  // be invoked with `new` — class form gives `new SignedDataVerifier(...)`
  // a real constructor that returns an instance with the mocked methods).
  SignedDataVerifier: class {
    verifyAndDecodeTransaction = verifyAndDecodeTransaction;
  },
  AppStoreServerAPIClient: class {
    getAllSubscriptionStatuses = getAllSubscriptionStatuses;
  },
}));

// ─── Mock auth ──────────────────────────────────────────────────────────────

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
    // setUserSubscriptionState is the persistence primitive — leave the
    // real implementation in place; it writes to authService's testMemStore.
  };
});

// Helper that pre-creates the user record in the in-memory store and
// returns the assigned userId. The /verify test then uses THAT userId
// (not a hand-rolled string) so setUserSubscriptionState can find the
// row to upsert.
async function ensureUser(label: string): Promise<string> {
  const authMod: any = await import("../src/services/authService.js");
  const username = `u${label}${Date.now()}`.slice(0, 30);
  const result = await authMod.registerUser({
    email: `${label}-${Date.now()}@example.com`,
    fullName: null,
    username,
    password: "ValidPass123!",
  });
  if (!result?.success || !result?.user?.userId) {
    throw new Error(`ensureUser(${label}) failed: ${JSON.stringify(result)}`);
  }
  return result.user.userId as string;
}

// ─── App boot ────────────────────────────────────────────────────────────────

let app: any;

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = null;

  // Required Apple env vars so getAppleConfig() doesn't throw at first
  // service call. Values are arbitrary — the lib is mocked.
  process.env.APP_STORE_ISSUER_ID = "test-issuer-id";
  process.env.APP_STORE_KEY_ID = "test-key-id";
  // Base64 of arbitrary PEM-shaped text (lib constructor is mocked).
  process.env.APP_STORE_PRIVATE_KEY_B64 = Buffer.from(
    "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----",
  ).toString("base64");
  process.env.APP_STORE_BUNDLE_ID = "com.hobbyiq.app";
  process.env.APP_STORE_APP_APPLE_ID = "1234567890";
  // Single dummy root cert (lib constructor is mocked; bytes are never
  // actually validated in these tests).
  process.env.APP_STORE_APPLE_ROOT_CERTS_B64 = Buffer.from("dummy-root-cert").toString("base64");

  // Reset Apple config cache so each test gets fresh mocks bound.
  const cfgMod: any = await import("../src/services/subscriptions/appleConfig.js");
  cfgMod._resetAppleConfigForTests();

  if (!app) {
    app = (await import("../src/app")).default;
  }
});

// Convenience: stub Apple verifier + status API to a "happy path" return.
function stubHappyPath(opts: {
  productId: string;
  originalTransactionId: string;
  environment: "Sandbox" | "Production";
  expiresMs?: number;
  status?: number;
}) {
  verifyAndDecodeTransaction.mockResolvedValueOnce({
    productId: opts.productId,
    originalTransactionId: opts.originalTransactionId,
    expiresDate: opts.expiresMs ?? Date.UTC(2026, 11, 31, 23, 59, 59),
    environment: opts.environment,
    transactionId: opts.originalTransactionId,
  });
  getAllSubscriptionStatuses.mockResolvedValueOnce({
    environment: opts.environment,
    bundleId: "com.hobbyiq.app",
    data: [
      {
        subscriptionGroupIdentifier: "group-1",
        lastTransactions: [
          {
            originalTransactionId: opts.originalTransactionId,
            status: opts.status ?? 1, // ACTIVE
            signedTransactionInfo: "stub-jws",
          },
        ],
      },
    ],
  });
}

const makeAuthUser = (plan: string, userId: string) => ({
  userId,
  email: `${userId}@t`,
  username: null,
  fullName: null,
  plan,
  createdAt: "2026-01-01T00:00:00Z",
});

// ─────────────────────────────────────────────────────────────────────────────
// 401 — requireSession
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/subscriptions/verify — auth", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy paths — sandbox + production
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/subscriptions/verify — happy paths", () => {
  it("valid SANDBOX JWS for collector productId upserts plan=collector", async () => {
    const uid_alice = await ensureUser("alice"); setUser(makeAuthUser("free", uid_alice));
    stubHappyPath({
      productId: "com.hobbyiq.collector.monthly",
      originalTransactionId: "tx-sandbox-001",
      environment: "Sandbox",
    });

    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true,
      plan: "collector",
      expiresAt: new Date(Date.UTC(2026, 11, 31, 23, 59, 59)).toISOString(),
    });
    // Defense-in-depth call MUST happen.
    expect(getAllSubscriptionStatuses).toHaveBeenCalledWith("tx-sandbox-001");
  });

  it("valid PRODUCTION JWS for investor productId upserts plan=investor", async () => {
    const uid_bob = await ensureUser("bob"); setUser(makeAuthUser("free", uid_bob));
    stubHappyPath({
      productId: "com.hobbyiq.investor.monthly",
      originalTransactionId: "tx-prod-002",
      environment: "Production",
    });

    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });

    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("investor");
  });

  it("valid JWS for proseller productId upserts plan=pro_seller", async () => {
    const uid_carol = await ensureUser("carol"); setUser(makeAuthUser("free", uid_carol));
    stubHappyPath({
      productId: "com.hobbyiq.proseller.monthly",
      originalTransactionId: "tx-prod-003",
      environment: "Production",
    });

    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });

    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("pro_seller");
  });

  it("BILLING_GRACE_PERIOD (status=4) is treated as current — plan upgraded", async () => {
    const uid_dave = await ensureUser("dave"); setUser(makeAuthUser("free", uid_dave));
    stubHappyPath({
      productId: "com.hobbyiq.collector.monthly",
      originalTransactionId: "tx-grace-004",
      environment: "Sandbox",
      status: 4, // BILLING_GRACE_PERIOD
    });
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe("collector");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/subscriptions/verify — idempotency", () => {
  it("same originalTransactionId twice produces one effective upsert (plan stable)", async () => {
    const uid_erin = await ensureUser("erin"); setUser(makeAuthUser("free", uid_erin));
    // Stub the happy path TWICE so the verifier + status API succeed
    // on both calls. iOS legitimately calls /verify on launch +
    // Transaction.updates + restore — the responses must be consistent.
    stubHappyPath({
      productId: "com.hobbyiq.investor.monthly",
      originalTransactionId: "tx-replay-005",
      environment: "Production",
    });
    stubHappyPath({
      productId: "com.hobbyiq.investor.monthly",
      originalTransactionId: "tx-replay-005",
      environment: "Production",
    });

    const r1 = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws.1" });
    const r2 = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws.2" });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both responses agree on plan + expiresAt.
    expect(r1.body.plan).toBe("investor");
    expect(r2.body.plan).toBe("investor");
    expect(r1.body.expiresAt).toBe(r2.body.expiresAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-group tier change (upgrade / downgrade within the same subscription
// group preserves originalTransactionId; only productId changes).
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/subscriptions/verify — in-group tier change", () => {
  it("same originalTransactionId, different productId -> plan UPDATES (not no-op)", async () => {
    const uid = await ensureUser("nina");
    setUser(makeAuthUser("free", uid));

    // Verify #1: user buys Collector. Apple assigns originalTransactionId
    // "tx-UPGRADE" — that ID is stable across in-group tier changes for
    // the lifetime of the subscription group.
    const expires1 = Date.UTC(2026, 11, 31, 23, 59, 59);
    stubHappyPath({
      productId: "com.hobbyiq.collector.monthly",
      originalTransactionId: "tx-UPGRADE",
      environment: "Production",
      expiresMs: expires1,
    });
    const r1 = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws.1" });
    expect(r1.status).toBe(200);
    expect(r1.body.plan).toBe("collector");
    expect(r1.body.expiresAt).toBe(new Date(expires1).toISOString());

    // Update the in-test "current user" projection to reflect what
    // requireSession would now load after r1's upsert. The actual Cosmos
    // memstore was written by r1's setUserSubscriptionState; we mirror
    // here so the next request's req.user starts from the same shape iOS
    // would carry post-purchase.
    setUser(makeAuthUser("collector", uid));

    // Verify #2: same user upgrades to Investor. Apple keeps
    // originalTransactionId="tx-UPGRADE" and changes productId. The
    // expiresDate also shifts (new billing cycle anchor for the group).
    const expires2 = Date.UTC(2027, 0, 15, 12, 0, 0);
    stubHappyPath({
      productId: "com.hobbyiq.investor.monthly",
      originalTransactionId: "tx-UPGRADE",
      environment: "Production",
      expiresMs: expires2,
    });
    const r2 = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws.2" });

    expect(r2.status).toBe(200);
    // Plan UPDATED — the writer must NOT short-circuit on "same
    // originalTransactionId" alone; idempotency hinges on the
    // (txnId + productId) pair, not txnId alone.
    expect(r2.body.plan).toBe("investor");
    // expiresAt reflects the new productId's billing cycle, not the
    // stale Collector cycle.
    expect(r2.body.expiresAt).toBe(new Date(expires2).toISOString());
    expect(r2.body.expiresAt).not.toBe(r1.body.expiresAt);

    // Read the persisted record directly via the auth surface to
    // confirm the appleSubscription snapshot updated atomically (not
    // half-written with stale productId).
    const authMod: any = await import("../src/services/authService.js");
    const stored = await authMod.getUserBySession.getMockImplementation()?.();
    // The mock returns whatever currentUser is; for a stronger check,
    // peek the memStore through a fresh session lookup. Easier: hit
    // /api/auth/session and read user.appleSubscription.
    void stored;

    // Direct read via the registered user — fetch fresh AuthUser by
    // signing in with the stored creds the registerUser helper used.
    // Simpler path: query the in-memory authService directly. Since
    // we mocked getUserBySession, use the real registerUser/findById
    // path via a small private peek.
    // (Skipped — assertions on r2.body are sufficient because the
    // route echoes the post-write state. If the writer had silently
    // refused the plan change, r2.body.plan would still be "collector".)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths — 400 / 422 / 502
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/subscriptions/verify — failure paths", () => {
  it("400 when body.jwsRepresentation is missing", async () => {
    const uid_fred = await ensureUser("fred"); setUser(makeAuthUser("free", uid_fred));
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_jws");
    expect(verifyAndDecodeTransaction).not.toHaveBeenCalled();
  });

  it("400 when verifier throws (malformed / tampered JWS) — no plan change", async () => {
    const uid_greta = await ensureUser("greta"); setUser(makeAuthUser("free", uid_greta));
    verifyAndDecodeTransaction.mockRejectedValueOnce(
      new Error("Invalid signature; certificate chain broken"),
    );
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "tampered.jws" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_jws");
    // The status API call MUST NOT have happened — fail fast on JWS verify.
    expect(getAllSubscriptionStatuses).not.toHaveBeenCalled();
  });

  it("422 subscription_not_current when status=EXPIRED — plan NOT upgraded", async () => {
    const uid_hank = await ensureUser("hank"); setUser(makeAuthUser("free", uid_hank));
    stubHappyPath({
      productId: "com.hobbyiq.collector.monthly",
      originalTransactionId: "tx-expired-006",
      environment: "Sandbox",
      status: 2, // EXPIRED
    });
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("subscription_not_current");
  });

  it("422 subscription_not_current when status=REVOKED (refund) — plan NOT upgraded", async () => {
    const uid_ivy = await ensureUser("ivy"); setUser(makeAuthUser("free", uid_ivy));
    stubHappyPath({
      productId: "com.hobbyiq.investor.monthly",
      originalTransactionId: "tx-revoked-007",
      environment: "Production",
      status: 5, // REVOKED
    });
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("subscription_not_current");
  });

  it("422 subscription_not_current when Apple returns no status entry for the txn", async () => {
    const uid_jane = await ensureUser("jane"); setUser(makeAuthUser("free", uid_jane));
    verifyAndDecodeTransaction.mockResolvedValueOnce({
      productId: "com.hobbyiq.collector.monthly",
      originalTransactionId: "tx-ghost-008",
      expiresDate: Date.UTC(2026, 11, 31),
      environment: "Sandbox",
    });
    getAllSubscriptionStatuses.mockResolvedValueOnce({
      environment: "Sandbox",
      bundleId: "com.hobbyiq.app",
      data: [], // no group entries
    });
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("subscription_not_current");
  });

  it("422 unknown_product when productId isn't mapped", async () => {
    const uid_kate = await ensureUser("kate"); setUser(makeAuthUser("free", uid_kate));
    stubHappyPath({
      productId: "com.hobbyiq.mystery.tier",
      originalTransactionId: "tx-mystery-009",
      environment: "Production",
    });
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("unknown_product");
    expect(r.body.productId).toBe("com.hobbyiq.mystery.tier");
  });

  it("502 upstream_error when App Store Server API throws", async () => {
    const uid_liam = await ensureUser("liam"); setUser(makeAuthUser("free", uid_liam));
    verifyAndDecodeTransaction.mockResolvedValueOnce({
      productId: "com.hobbyiq.collector.monthly",
      originalTransactionId: "tx-upstream-010",
      expiresDate: Date.UTC(2026, 11, 31),
      environment: "Sandbox",
    });
    getAllSubscriptionStatuses.mockRejectedValueOnce(new Error("Apple 500"));
    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("upstream_error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 503 — payments not configured
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/subscriptions/verify — 503 when config missing", () => {
  it("returns payments_not_configured when APP_STORE_PRIVATE_KEY_B64 is absent", async () => {
    const uid_matt = await ensureUser("matt"); setUser(makeAuthUser("free", uid_matt));
    delete process.env.APP_STORE_PRIVATE_KEY_B64;
    const cfgMod: any = await import("../src/services/subscriptions/appleConfig.js");
    cfgMod._resetAppleConfigForTests();

    const r = await request(app)
      .post("/api/subscriptions/verify")
      .set("x-session-id", "s")
      .send({ jwsRepresentation: "ey.stub.jws" });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("payments_not_configured");
  });
});
