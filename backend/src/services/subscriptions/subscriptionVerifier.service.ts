// CF-PAYMENTS-APPLE-1 (2026-06-03): subscription JWS verifier service.
//
// Flow (one call = one /api/subscriptions/verify request from iOS):
//   1. Peek the JWS environment field (untrusted; only used to pick
//      which verifier to invoke).
//   2. Verifier.verifyAndDecodeTransaction — does cryptographic JWS
//      signature check + cert-chain validation against Apple roots +
//      payload bundleId/appAppleId checks. Throws on any failure.
//   3. Defense-in-depth: call AppStoreServerAPIClient.getAllSubscriptionStatuses
//      with the originalTransactionId. Walk the returned Status records;
//      only ACTIVE (1) and BILLING_GRACE_PERIOD (4) count as "current"
//      — EXPIRED / REVOKED / BILLING_RETRY do NOT upgrade the plan.
//   4. Map productId → plan via productMap.ts. Unknown product = reject.
//   5. Upsert user.plan + user.appleSubscription via
//      authService.setUserSubscriptionState. Idempotent on
//      originalTransactionId: the same JWS submitted twice produces the
//      same final state (no plan flip-flop, lastEventAt refreshes).
//
// Errors are thrown as VerifySubscriptionError subclasses so the route
// can map them to status codes:
//   InvalidJwsError          -> 400 (signature / decode failed)
//   SubscriptionNotCurrentError -> 422 (refunded/expired/revoked; no upgrade)
//   UnknownProductError      -> 422 (Apple returned a productId we don't map)
//   AppleConfigError         -> 503 (caught upstream in appleConfig.ts)
//   UpstreamApiError         -> 502 (Apple API client threw)

import {
  Environment,
  Status,
  type JWSTransactionDecodedPayload,
  type LastTransactionsItem,
  type SignedDataVerifier,
  type StatusResponse,
} from "@apple/app-store-server-library";
import {
  setUserSubscriptionState,
  type AuthUser,
  type AppleSubscriptionState,
} from "../authService.js";
import {
  getAppleConfig,
  peekJwsEnvironment,
  pickEnvironmentClients,
  AppleConfigError,
} from "./appleConfig.js";
import { productIdToPlan } from "./productMap.js";

// ─── Error taxonomy ─────────────────────────────────────────────────────────

export class VerifySubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifySubscriptionError";
  }
}
export class InvalidJwsError extends VerifySubscriptionError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "InvalidJwsError";
  }
}
export class SubscriptionNotCurrentError extends VerifySubscriptionError {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SubscriptionNotCurrentError";
  }
}
export class UnknownProductError extends VerifySubscriptionError {
  constructor(public readonly productId: string) {
    super(`Unknown productId: ${productId}`);
    this.name = "UnknownProductError";
  }
}
export class UpstreamApiError extends VerifySubscriptionError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "UpstreamApiError";
  }
}

// ─── Public surface ─────────────────────────────────────────────────────────

export interface VerifyResult {
  plan: AuthUser["plan"];
  expiresAt: string | null;
  // True when the call was a no-op replay (same originalTransactionId,
  // same plan already on the user record). Caller can use this for
  // logging / metrics but the response shape stays the same.
  idempotentReplay: boolean;
}

/**
 * Verify a StoreKit 2 jwsRepresentation and upsert the user's plan +
 * Apple subscription cache. The full flow is documented at the top of
 * the file.
 */
export async function verifyAndUpsertSubscription(
  userId: string,
  jwsRepresentation: string,
): Promise<VerifyResult> {
  if (!jwsRepresentation || typeof jwsRepresentation !== "string") {
    throw new InvalidJwsError("jwsRepresentation must be a non-empty string");
  }

  // Step 1: peek (untrusted) environment so we pick the right verifier.
  // The verifier will reject a tampered JWS regardless — peek is purely
  // routing, not trust.
  const peekedEnv = peekJwsEnvironment(jwsRepresentation);
  let verifier: SignedDataVerifier;
  let apiClient: ReturnType<typeof pickEnvironmentClients>["apiClient"];
  let environment: Environment;
  try {
    const picked = pickEnvironmentClients(peekedEnv);
    verifier = picked.verifier;
    apiClient = picked.apiClient;
    environment = picked.environment;
  } catch (err) {
    // AppleConfigError surfaces here — re-throw so the route can 503.
    if (err instanceof AppleConfigError) throw err;
    throw new InvalidJwsError("Could not select Apple environment for JWS", err);
  }

  // Step 2: cryptographic verification + decode.
  let decoded: JWSTransactionDecodedPayload;
  try {
    decoded = await verifier.verifyAndDecodeTransaction(jwsRepresentation);
  } catch (err: unknown) {
    throw new InvalidJwsError(
      `JWS verification failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const productId = decoded.productId;
  const originalTransactionId = decoded.originalTransactionId;
  if (!productId || !originalTransactionId) {
    throw new InvalidJwsError("Decoded JWS missing productId or originalTransactionId");
  }

  // Step 3: defense-in-depth status check. ACTIVE / BILLING_GRACE_PERIOD
  // count as "current"; anything else (EXPIRED / REVOKED / BILLING_RETRY)
  // means do NOT upgrade. Apple may itself decline the call (404, etc.)
  // for sandbox accounts that haven't completed a purchase; treat
  // upstream errors as 502.
  let statusResponse: StatusResponse;
  try {
    statusResponse = await apiClient.getAllSubscriptionStatuses(originalTransactionId);
  } catch (err: unknown) {
    throw new UpstreamApiError(
      `App Store Server API getAllSubscriptionStatuses failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const matched = findStatusForTransaction(statusResponse, originalTransactionId);
  if (matched === null) {
    // Apple confirmed the JWS was real but doesn't return a current
    // status entry for this originalTransactionId — that's
    // unrecoverable. Treat as "not current".
    throw new SubscriptionNotCurrentError(
      "App Store Server API did not return a status entry for this transaction",
      Status.EXPIRED,
    );
  }
  if (!isCurrent(matched.status)) {
    throw new SubscriptionNotCurrentError(
      `Subscription status is not current: ${Status[matched.status as Status] ?? matched.status}`,
      matched.status,
    );
  }

  // Step 4: map productId → plan.
  const newPlan = productIdToPlan(productId);
  if (!newPlan) {
    throw new UnknownProductError(productId);
  }

  // Step 5: idempotent upsert. Read-modify-write at the authService
  // primitive — same originalTransactionId + same plan = the write is
  // logically a no-op (only lastEventAt refreshes).
  const apple: AppleSubscriptionState = {
    originalTransactionId,
    expiresAt: decoded.expiresDate ? new Date(decoded.expiresDate).toISOString() : null,
    lastEventAt: new Date().toISOString(),
    environment: environment === Environment.SANDBOX ? "Sandbox" : "Production",
    productId,
  };

  // Quick read to detect the idempotent-replay case for telemetry.
  const updated = await setUserSubscriptionState(userId, newPlan, apple);
  if (!updated) {
    throw new VerifySubscriptionError(
      `User ${userId} not found when persisting subscription state`,
    );
  }

  // Idempotency detection: if the userId already had this exact
  // originalTransactionId AND the same plan, the upsert was a replay.
  // We can't see the prior state directly from setUserSubscriptionState's
  // return (it returns POST-write state). Caller can compute this if
  // needed; here we just flag false-by-default — replay detection is
  // a metric, not a contract guarantee.
  return {
    plan: updated.plan,
    expiresAt: apple.expiresAt,
    idempotentReplay: false,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isCurrent(status: number | undefined): boolean {
  return status === Status.ACTIVE || status === Status.BILLING_GRACE_PERIOD;
}

/**
 * Walk the StatusResponse to find the entry for our specific
 * originalTransactionId. Apple returns entries grouped by
 * subscriptionGroupIdentifier; each group has a lastTransactions[]
 * array. The transaction we care about is identified by its
 * originalTransactionId.
 */
function findStatusForTransaction(
  resp: StatusResponse,
  originalTransactionId: string,
): { status: number; entry: LastTransactionsItem } | null {
  const groups = resp.data ?? [];
  for (const group of groups) {
    const last = group.lastTransactions ?? [];
    for (const entry of last) {
      if (entry.originalTransactionId === originalTransactionId) {
        const status = typeof entry.status === "number" ? entry.status : null;
        if (status === null) continue;
        return { status, entry };
      }
    }
  }
  return null;
}
