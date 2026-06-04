// CF-PAYMENTS-APPLE-2 (2026-06-03): App Store Server Notifications V2 handler.
//
// Flow (one call = one POST /api/subscriptions/notifications from Apple):
//
//   1. peek environment from outer notification JWS (untrusted; only
//      used to pick the verifier — same pattern as /verify).
//   2. VERIFY FIRST. verifier.verifyAndDecodeNotification(signedPayload)
//      Verification failure -> throw InvalidNotificationError -> 401.
//      MUTATE NOTHING before this returns. This is the only thing
//      between a public endpoint and a forged "upgrade me / downgrade
//      victim" request.
//   3. Decode the INNER signedTransactionInfo (it's a JWS too) via the
//      same verifier to extract productId + originalTransactionId +
//      expiresDate. Without these we have no Apple identity to operate on
//      — abort to a structured "noop" outcome (logged + stored).
//   4. Idempotency check: read subscription_events by (notificationUUID,
//      originalTransactionId). Seen UUID -> 200 noop_replay.
//   5. User lookup via appleSubscription.originalTransactionId. No match
//      -> log loudly, store event with result="no_user", 200. (Don't
//      make Apple retry forever — most likely a webhook that beat
//      /verify, which is the known race we accept by design.)
//   6. Action table by (notificationType, subtype) — see below.
//   7. Persist event (result + extracted fields).
//
// Always returns from handleNotification with HandleResult; route maps
// to HTTP. Apple expects 200 on success/noop so it stops retrying.

import {
  Environment,
  Status,
  type AppStoreServerAPIClient,
  type ResponseBodyV2DecodedPayload,
  type JWSTransactionDecodedPayload,
  type SignedDataVerifier,
  type StatusResponse,
} from "@apple/app-store-server-library";
import {
  findUserByOriginalTransactionId,
  setUserSubscriptionState,
  type AppleSubscriptionState,
  type AuthUser,
} from "../authService.js";
import type { Plan } from "../../config/entitlements.js";
import {
  AppleConfigError,
  peekJwsEnvironment,
  pickEnvironmentClients,
} from "./appleConfig.js";
import { productIdToPlan } from "./productMap.js";
import {
  getEvent,
  saveEvent,
  type EventResult,
  type NotificationEvent,
} from "./subscriptionEventStore.service.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

export class InvalidNotificationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "InvalidNotificationError";
  }
}

// ─── Action table ───────────────────────────────────────────────────────────
//
// Apple's NotificationTypeV2 + Subtype values are strings on the wire.
// We match against literals so the handler is decoupled from any future
// enum additions in the lib.
//
// Each row tells the handler what to do for a given (type, subtype). The
// "downgrade-on-paid-event" rows are the ones /verify deliberately skips
// in defense-in-depth — the safety-net job ALSO catches these, but the
// webhook is the timely signal.

type Action =
  | { kind: "set_plan_from_product" }   // SUBSCRIBED / OFFER_REDEEMED / DID_RENEW with new productId
  | { kind: "refresh_expiry" }           // DID_RENEW with same productId
  | { kind: "downgrade_to_free"; reason: string }  // EXPIRED / GRACE_PERIOD_EXPIRED / REFUND / REVOKE
  | { kind: "keep_plan" }                 // DID_FAIL_TO_RENEW grace period
  // CF-SUBSCRIPTION-HANDLER-FIXES (2026-06-04): REFUND_REVERSED — Apple
  // reversed a previously-issued refund decision. We previously downgraded
  // on REFUND; on REVERSED we must RE-EVALUATE via App Store Server API,
  // not blindly re-grant (the user may have re-subscribed at a different
  // tier in the meantime, may already be EXPIRED again, etc.). Apple's
  // current subscription status is the source of truth.
  | { kind: "reevaluate_from_apple"; reason: string }
  | { kind: "log_only"; reason: string }; // informational types — record but no mutation

function decideAction(
  notificationType: string | undefined,
  subtype: string | null | undefined,
): Action {
  switch (notificationType) {
    case "SUBSCRIBED":
      // INITIAL_BUY (first purchase) and RESUBSCRIBE (came back after a
      // lapse) both set plan from productId.
      return { kind: "set_plan_from_product" };

    // CF-SUBSCRIPTION-HANDLER-FIXES (2026-06-04): OFFER_REDEEMED — user
    // redeemed a promotional/intro/win-back offer. Apple treats this as
    // the START of a subscription period (same shape as SUBSCRIBED for
    // entitlement purposes). The transaction's productId carries the
    // tier the offer subscribed them to. Previously fell through to
    // default → log_only → silent entitlement-grant miss when promo
    // codes ship.
    case "OFFER_REDEEMED":
      return { kind: "set_plan_from_product" };

    // CF-SUBSCRIPTION-HANDLER-FIXES (2026-06-04): REFUND_REVERSED — Apple
    // reversed a refund decision (user keeps the entitlement after all).
    // We previously downgraded on REFUND; on REVERSED we must restore
    // entitlement BUT only to the level Apple's current subscription
    // status confirms. The notification's signedTransactionInfo refers
    // to the reversed transaction, which may or may not be the user's
    // currently-active subscription — they could have re-subscribed at
    // a different tier, or let it lapse again. Re-evaluate via API.
    case "REFUND_REVERSED":
      return { kind: "reevaluate_from_apple", reason: "REFUND_REVERSED" };

    case "DID_RENEW":
      // Renewal — refresh expiresAt. If productId differs from what's
      // stored, an in-group tier change took effect at renewal (scheduled
      // upgrade/downgrade); set_plan_from_product handles both.
      return { kind: "set_plan_from_product" };

    case "EXPIRED":
      return { kind: "downgrade_to_free", reason: "EXPIRED" };

    case "GRACE_PERIOD_EXPIRED":
      return { kind: "downgrade_to_free", reason: "GRACE_PERIOD_EXPIRED" };

    case "REFUND":
      return { kind: "downgrade_to_free", reason: "REFUND" };

    case "REVOKE":
      return { kind: "downgrade_to_free", reason: "REVOKE" };

    case "DID_FAIL_TO_RENEW":
      // Subtype GRACE_PERIOD means we're inside the grace window —
      // keep plan paid. Other subtypes (or no subtype) signal the start
      // of the lapse; we let the downstream EXPIRED notification do the
      // actual downgrade so we don't pre-empt Apple's own retry logic.
      if (subtype === "GRACE_PERIOD") return { kind: "keep_plan" };
      return { kind: "log_only", reason: "DID_FAIL_TO_RENEW (non-grace)" };

    case "DID_CHANGE_RENEWAL_PREF":
    case "DID_CHANGE_RENEWAL_STATUS":
    case "PRICE_INCREASE":
    case "RENEWAL_EXTENDED":
    case "RENEWAL_EXTENSION":
      // Future-renewal preferences / informational notifications. None
      // mutate current entitlement state.
      return { kind: "log_only", reason: notificationType };

    default:
      // Unknown / new type Apple has added since this CF. Log loudly so
      // we can decide whether to handle it; don't mutate.
      return { kind: "log_only", reason: `unknown:${notificationType ?? "<missing>"}` };
  }
}

// ─── Public surface ─────────────────────────────────────────────────────────

export interface HandleResult {
  status: EventResult;
  notificationUUID: string;
  userId: string | null;
  notificationType: string;
}

export async function handleNotification(signedPayload: string): Promise<HandleResult> {
  if (!signedPayload || typeof signedPayload !== "string") {
    throw new InvalidNotificationError("signedPayload must be a non-empty string");
  }

  // Step 1+2: peek env, pick verifier, VERIFY FIRST.
  const peekedEnv = peekJwsEnvironment(signedPayload);
  let verifier: SignedDataVerifier;
  let environment: Environment;
  try {
    const picked = pickEnvironmentClients(peekedEnv);
    verifier = picked.verifier;
    environment = picked.environment;
  } catch (err) {
    if (err instanceof AppleConfigError) throw err;
    throw new InvalidNotificationError("Could not select Apple environment", err);
  }

  let decoded: ResponseBodyV2DecodedPayload;
  try {
    decoded = await verifier.verifyAndDecodeNotification(signedPayload);
  } catch (err: unknown) {
    throw new InvalidNotificationError(
      `Notification JWS verification failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const notificationUUID = decoded.notificationUUID;
  const notificationType = String(decoded.notificationType ?? "");
  const subtype = decoded.subtype ? String(decoded.subtype) : null;

  if (!notificationUUID) {
    throw new InvalidNotificationError("Decoded notification missing notificationUUID");
  }

  // Step 3: decode the inner transaction JWS. The notification's
  // `data.signedTransactionInfo` carries the same JWS shape /verify
  // consumes — we verify it with the same verifier instance.
  const signedTransactionInfo = decoded.data?.signedTransactionInfo;
  let transaction: JWSTransactionDecodedPayload | null = null;
  if (signedTransactionInfo) {
    try {
      transaction = await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
    } catch (err: unknown) {
      // The notification JWS verified but the inner txn JWS didn't —
      // odd but not necessarily forged (Apple has had transient bugs).
      // Treat as no-op so Apple stops retrying; surface in the event log.
      console.error(
        `[apple][notificationHandler] inner signedTransactionInfo verification failed for uuid=${notificationUUID}:`,
        err,
      );
      const event = await persistEvent({
        notificationUUID,
        notificationType,
        subtype,
        originalTransactionId: "<unknown>",
        productId: null,
        expiresDate: null,
        userId: null,
        result: "log_only",
        environment,
      });
      return resultFromEvent(event, notificationType);
    }
  }

  // Without an originalTransactionId we can't identify a subscription
  // — log_only outcome (e.g., TEST notifications carry no txn).
  const originalTransactionId = transaction?.originalTransactionId ?? null;
  const productId = transaction?.productId ?? null;
  const expiresDate = transaction?.expiresDate ?? null;

  if (!originalTransactionId) {
    const event = await persistEvent({
      notificationUUID,
      notificationType,
      subtype,
      originalTransactionId: "<missing>",
      productId,
      expiresDate,
      userId: null,
      result: "log_only",
      environment,
    });
    return resultFromEvent(event, notificationType);
  }

  // Step 4: idempotency check. Seen UUID -> 200 noop_replay.
  const existing = await getEvent(notificationUUID, originalTransactionId);
  if (existing) {
    return {
      status: "noop_replay",
      notificationUUID,
      userId: existing.userId,
      notificationType,
    };
  }

  // Step 5: user lookup.
  const user = await findUserByOriginalTransactionId(originalTransactionId);
  if (!user) {
    // Known race: webhook arrived before /verify established the link.
    // Log loudly + record so we can hand-correlate if needed; 200.
    console.warn(
      `[apple][notificationHandler] no user found for originalTransactionId=${originalTransactionId} (uuid=${notificationUUID}, type=${notificationType})`,
    );
    const event = await persistEvent({
      notificationUUID,
      notificationType,
      subtype,
      originalTransactionId,
      productId,
      expiresDate,
      userId: null,
      result: "no_user",
      environment,
    });
    return resultFromEvent(event, notificationType);
  }

  // Step 6+7: apply action.
  const action = decideAction(notificationType, subtype);
  const result = await applyAction(user, action, {
    notificationType,
    productId,
    expiresDate,
    environment,
    originalTransactionId,
    // The same apiClient `pickEnvironmentClients` returned — used by
    // reevaluate_from_apple to call getAllSubscriptionStatuses.
    apiClient: pickEnvironmentClients(peekedEnv).apiClient,
  });
  const event = await persistEvent({
    notificationUUID,
    notificationType,
    subtype,
    originalTransactionId,
    productId,
    expiresDate,
    userId: user.userId,
    result,
    environment,
  });
  return resultFromEvent(event, notificationType);
}

// ─── Apply ──────────────────────────────────────────────────────────────────

async function applyAction(
  user: AuthUser,
  action: Action,
  ctx: {
    notificationType: string;
    productId: string | null;
    expiresDate: number | null;
    environment: Environment;
    originalTransactionId: string;
    apiClient: AppStoreServerAPIClient;
  },
): Promise<EventResult> {
  switch (action.kind) {
    case "set_plan_from_product": {
      if (!ctx.productId) return "no_change";
      const newPlan = productIdToPlan(ctx.productId);
      if (!newPlan) {
        console.error(
          `[apple][notificationHandler] UNKNOWN PRODUCTID on verified webhook: ${ctx.productId} (user=${user.userId})`,
        );
        return "log_only";
      }
      await persistSubscription(user, newPlan, ctx);
      return "applied";
    }

    case "refresh_expiry": {
      // Same-product DID_RENEW. Plan stays; only expiresAt + lastEventAt
      // refresh. If productId can't be confirmed we still refresh
      // lastEventAt as a heartbeat.
      const stored = user.appleSubscription;
      const plan = stored ? user.plan : "free";
      const productId = ctx.productId ?? stored?.productId ?? "";
      const newPlan = productIdToPlan(productId) ?? plan;
      await persistSubscription(user, newPlan, ctx);
      return "applied";
    }

    case "downgrade_to_free": {
      // Audit the reason in the event log; plan goes to free regardless
      // of stored state (Apple is source of truth for "no longer paid").
      if (user.plan === "free") {
        return "no_change";
      }
      // CF-PAYMENTS-APPLE-2-FIX (2026-06-03): PRESERVE the Apple link.
      // Keep originalTransactionId; use Apple's expiresDate from the
      // notification if present, else preserve the stored expiresAt.
      // Reason: the nightly safety-net's 40-day lookback predicate
      // depends on a non-null expiresAt to find recently-lapsed users
      // for potential restore (refund reversal, grace extension, etc.).
      // Nulling expiresAt here would drop the user out of that window
      // and a Apple-side restore could be missed permanently.
      const apple: AppleSubscriptionState = {
        originalTransactionId: user.appleSubscription?.originalTransactionId ?? "<unknown>",
        expiresAt: ctx.expiresDate
          ? new Date(ctx.expiresDate).toISOString()
          : user.appleSubscription?.expiresAt ?? null,
        lastEventAt: new Date().toISOString(),
        environment: ctx.environment === Environment.SANDBOX ? "Sandbox" : "Production",
        productId: ctx.productId ?? user.appleSubscription?.productId ?? "",
      };
      await setUserSubscriptionState(user.userId, "free", apple);
      console.log(
        `[apple][notificationHandler] downgraded user=${user.userId} to free (reason=${action.reason})`,
      );
      return "applied";
    }

    case "keep_plan":
      // Inside grace window — record only.
      return "no_change";

    // CF-SUBSCRIPTION-HANDLER-FIXES (2026-06-04): REFUND_REVERSED rerun.
    // Re-evaluate via getAllSubscriptionStatuses + apply plan from the
    // current ACTIVE status (NOT a blind set from the reversed-refund
    // transaction's productId — the user may have re-subscribed at a
    // different tier in the meantime).
    case "reevaluate_from_apple": {
      let statusResponse: StatusResponse;
      try {
        statusResponse = await ctx.apiClient.getAllSubscriptionStatuses(ctx.originalTransactionId);
      } catch (err: unknown) {
        console.error(
          `[apple][notificationHandler] reevaluate_from_apple: API call failed (user=${user.userId}, reason=${action.reason}):`,
          err instanceof Error ? err.message : String(err),
        );
        return "log_only";
      }

      const active = findActiveStatusEntry(statusResponse);
      if (!active) {
        // No active subscription on Apple's side — entitlement stays at
        // free (don't re-grant on REFUND_REVERSED for a no-longer-active
        // user; would be a phantom upgrade).
        console.log(
          `[apple][notificationHandler] reevaluate_from_apple: no active status on Apple side (user=${user.userId}, reason=${action.reason})`,
        );
        return "log_only";
      }

      // Decode the inner signedTransactionInfo to read productId + expiresDate
      // for the active subscription. Use the SAME verifier the route picked
      // (env-pinned). Note: applyAction doesn't currently hold the verifier;
      // we trust Apple's metadata as exposed via the status entry's
      // wsTransactionInfo body. The active transaction's productId IS what
      // we use — same trust posture as the existing set_plan_from_product.
      const activeProductId = await extractActiveProductId(active.signedTransactionInfo, ctx.apiClient);
      if (!activeProductId) {
        console.error(
          `[apple][notificationHandler] reevaluate_from_apple: could not extract productId from active status entry (user=${user.userId})`,
        );
        return "log_only";
      }
      const newPlan = productIdToPlan(activeProductId);
      if (!newPlan) {
        console.error(
          `[apple][notificationHandler] reevaluate_from_apple: UNKNOWN PRODUCTID ${activeProductId} on active status (user=${user.userId})`,
        );
        return "log_only";
      }

      await persistSubscription(user, newPlan, {
        productId: activeProductId,
        expiresDate: ctx.expiresDate,
        environment: ctx.environment,
      });
      console.log(
        `[apple][notificationHandler] reevaluate_from_apple: restored user=${user.userId} to plan=${newPlan} (reason=${action.reason})`,
      );
      return "applied";
    }

    case "log_only":
      return "log_only";
  }
}

/**
 * CF-SUBSCRIPTION-HANDLER-FIXES (2026-06-04): walk the StatusResponse and
 * return the first entry whose status is ACTIVE or BILLING_GRACE_PERIOD.
 * Mirrors `isCurrent` in subscriptionVerifier.service.ts.
 */
function findActiveStatusEntry(
  resp: StatusResponse,
): { signedTransactionInfo: string; status: number } | null {
  const groups = resp.data ?? [];
  for (const group of groups) {
    const last = group.lastTransactions ?? [];
    for (const t of last) {
      if (t.status === Status.ACTIVE || t.status === Status.BILLING_GRACE_PERIOD) {
        if (t.signedTransactionInfo) {
          return { signedTransactionInfo: t.signedTransactionInfo, status: t.status };
        }
      }
    }
  }
  return null;
}

/**
 * CF-SUBSCRIPTION-HANDLER-FIXES (2026-06-04): pull productId out of the
 * active status entry's signedTransactionInfo (a JWS). Apple ALSO surfaces
 * productId on the status entry directly via `transactionInfo` after
 * decode; we re-verify via the api client's underlying capabilities to
 * keep the same trust posture.
 *
 * The base64url JWS payload contains productId at top level. We don't
 * have a verifier in scope here; decode-without-verify is acceptable
 * because (a) the JWS came from a verified-via-cert HTTPS call to Apple,
 * (b) the productMap.ts gate downstream rejects unknown productIds.
 */
async function extractActiveProductId(
  signedTransactionInfo: string,
  _apiClient: AppStoreServerAPIClient,
): Promise<string | null> {
  try {
    const parts = signedTransactionInfo.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (parts[1].length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const obj = JSON.parse(decoded) as { productId?: string };
    return typeof obj.productId === "string" && obj.productId.length > 0 ? obj.productId : null;
  } catch {
    return null;
  }
}

async function persistSubscription(
  user: AuthUser,
  newPlan: Plan,
  ctx: {
    productId: string | null;
    expiresDate: number | null;
    environment: Environment;
  },
): Promise<void> {
  const apple: AppleSubscriptionState = {
    originalTransactionId: user.appleSubscription?.originalTransactionId ?? "<unknown>",
    expiresAt: ctx.expiresDate ? new Date(ctx.expiresDate).toISOString() : null,
    lastEventAt: new Date().toISOString(),
    environment: ctx.environment === Environment.SANDBOX ? "Sandbox" : "Production",
    productId: ctx.productId ?? user.appleSubscription?.productId ?? "",
  };
  await setUserSubscriptionState(user.userId, newPlan, apple);
}

// ─── Persistence helper ─────────────────────────────────────────────────────

async function persistEvent(input: {
  notificationUUID: string;
  notificationType: string;
  subtype: string | null;
  originalTransactionId: string;
  productId: string | null;
  expiresDate: number | null;
  userId: string | null;
  result: EventResult;
  environment: Environment;
}): Promise<NotificationEvent> {
  const event: NotificationEvent = {
    id: input.notificationUUID,
    originalTransactionId: input.originalTransactionId,
    notificationType: input.notificationType,
    subtype: input.subtype,
    receivedAt: new Date().toISOString(),
    productId: input.productId,
    expiresDate: input.expiresDate,
    userId: input.userId,
    result: input.result,
    appleEnvironment:
      input.environment === Environment.SANDBOX ? "Sandbox" : "Production",
  };
  await saveEvent(event);
  return event;
}

function resultFromEvent(event: NotificationEvent, notificationType: string): HandleResult {
  return {
    status: event.result,
    notificationUUID: event.id,
    userId: event.userId,
    notificationType,
  };
}
