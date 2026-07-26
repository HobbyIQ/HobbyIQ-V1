// CF-PAYMENTS-APPLE-1 (2026-06-03): subscription verification route.
//
//   POST /api/subscriptions/verify
//     requireSession (ties Apple transaction to the HobbyIQ user)
//     body: { jwsRepresentation: string }
//     200: { success: true, plan, expiresAt }
//     400: { success: false, error: "invalid_jws", reason? }
//          - body missing jwsRepresentation
//          - JWS signature / cert-chain validation failed
//          - decoded payload missing productId or originalTransactionId
//     422: { success: false, error: "subscription_not_current" | "unknown_product", reason? }
//          - Apple confirms the txn is EXPIRED / REVOKED / refunded -> no upgrade
//          - productId doesn't match any HobbyIQ tier (ops-signal: Drew may
//            have added a product but forgotten the productMap update)
//     502: { success: false, error: "upstream_error" }
//          - App Store Server API call threw (network / Apple-side outage)
//     503: { success: false, error: "payments_not_configured" }
//          - Required App Settings missing (no APP_STORE_PRIVATE_KEY_B64,
//            etc.) — backend boots without payments, this surface tells
//            iOS to retry later vs treating it as a hard 500.
//
// Idempotency: safe to call repeatedly with the same JWS (iOS launch,
// Transaction.updates, restore). Same originalTransactionId + same plan
// produces the same final user record state.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import {
  verifyAndUpsertSubscription,
  InvalidJwsError,
  SubscriptionNotCurrentError,
  UnknownProductError,
  UpstreamApiError,
} from "../services/subscriptions/subscriptionVerifier.service.js";
import {
  handleNotification,
  InvalidNotificationError,
} from "../services/subscriptions/notificationHandler.service.js";
import { AppleConfigError } from "../services/subscriptions/appleConfig.js";

const router = Router();

// CF-PAYMENTS-APPLE-2: POST /api/subscriptions/notifications is PUBLIC.
// Apple posts directly — there's no x-session-id. The defense is JWS
// signature + cert-chain validation BEFORE any mutation. Mounted
// BEFORE router.use(requireSession) below so it stays public.
router.post("/notifications", async (req: Request, res: Response) => {
  const signedPayload =
    typeof req.body?.signedPayload === "string" ? req.body.signedPayload.trim() : "";
  if (!signedPayload) {
    // Apple always sends `signedPayload`; missing it is either a bad
    // request or a probe. 400 — NOT 401 so we don't mask a config bug
    // as a security failure.
    res.status(400).json({ success: false, error: "signedPayload is required" });
    return;
  }

  try {
    const result = await handleNotification(signedPayload);
    // Always 200 on processed (incl. noop_replay / no_user / log_only)
    // so Apple stops retrying. Audit-grade detail lives in
    // subscription_events; the wire response is intentionally terse so
    // we don't leak processing detail to a forger who somehow got past
    // verification.
    res.json({ success: true });
    console.log(
      `[subscriptions.notifications] result=${result.status} type=${result.notificationType} uuid=${result.notificationUUID} userId=${result.userId ?? "none"}`,
    );
  } catch (err: unknown) {
    if (err instanceof AppleConfigError) {
      console.error("[subscriptions.notifications] payments not configured:", err.message);
      res.status(503).json({ success: false, error: "payments_not_configured" });
      return;
    }
    if (err instanceof InvalidNotificationError) {
      // Verification failure: forged / tampered / wrong-env JWS, or
      // missing notificationUUID after a successful verify.
      // 401 — explicit "do not retry" signal to anyone replaying
      // garbage at us. NO mutation happens before reaching here.
      console.warn("[subscriptions.notifications] verification failed:", err.message);
      res.status(401).json({ success: false, error: "invalid_notification" });
      return;
    }
    console.error("[subscriptions.notifications] unexpected error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

// All routes below this point require a session.
router.use(requireSession);

router.post("/verify", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const jws =
    typeof req.body?.jwsRepresentation === "string"
      ? req.body.jwsRepresentation.trim()
      : "";
  if (!jws) {
    res.status(400).json({
      success: false,
      error: "invalid_jws",
      reason: "jwsRepresentation is required",
    });
    return;
  }

  try {
    const result = await verifyAndUpsertSubscription(userId, jws);
    res.json({
      success: true,
      plan: result.plan,
      expiresAt: result.expiresAt,
    });
  } catch (err: unknown) {
    if (err instanceof AppleConfigError) {
      console.error("[subscriptions.verify] payments not configured:", err.message);
      res.status(503).json({
        success: false,
        error: "payments_not_configured",
      });
      return;
    }
    if (err instanceof InvalidJwsError) {
      res.status(400).json({
        success: false,
        error: "invalid_jws",
        reason: err.message,
      });
      return;
    }
    if (err instanceof SubscriptionNotCurrentError) {
      res.status(422).json({
        success: false,
        error: "subscription_not_current",
        reason: err.message,
      });
      return;
    }
    if (err instanceof UnknownProductError) {
      // Production-only ops alert: a verified Apple JWS carried a
      // productId we don't recognize. Either Drew added a new Apple
      // product without updating productMap.ts, or someone is replaying
      // a JWS from a different app. Log loudly, return 422.
      console.error(
        `[subscriptions.verify] UNKNOWN PRODUCTID on verified JWS: ${err.productId} (user=${userId})`,
      );
      res.status(422).json({
        success: false,
        error: "unknown_product",
        productId: err.productId,
      });
      return;
    }
    if (err instanceof UpstreamApiError) {
      console.error("[subscriptions.verify] upstream error:", err.message);
      res.status(502).json({
        success: false,
        error: "upstream_error",
      });
      return;
    }
    console.error("[subscriptions.verify] unexpected error:", err);
    res.status(500).json({
      success: false,
      error: "internal_error",
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CF-REFERRAL-LOOP (Drew, 2026-07-26). Free-month for both parties.
// See backend/src/services/subscriptions/referralCode.service.ts.
// ═════════════════════════════════════════════════════════════════════════════

import {
  getReferrerStats,
  redeemReferralCode,
  recordRefereeSubscribed,
} from "../services/subscriptions/referralCode.service.js";

/**
 * GET /api/subscriptions/my-referral-code
 * Returns the caller's referral code + stats. Auto-creates the code on
 * first call (idempotent). Auth: requireSession.
 */
router.get("/my-referral-code", requireSession, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, error: "no-session" }); return; }
  try {
    const stats = await getReferrerStats(userId);
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error("[subscriptions.my-referral-code] error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

/**
 * POST /api/subscriptions/apply-referral
 * Redeems a referral code for the calling user.
 * Body: { code: string }
 * Returns: { success, status, code, message? }
 * Status values: 'redeemed' | 'self-redemption' | 'code-not-found' |
 *                'already-redeemed' | 'error'
 * Auth: requireSession.
 */
router.post("/apply-referral", requireSession, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ success: false, error: "no-session" }); return; }
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!code || code.length < 4 || code.length > 20) {
    res.status(400).json({ success: false, error: "code-required" });
    return;
  }
  try {
    const result = await redeemReferralCode({ code, refereeUserId: userId });
    if (result.status === "redeemed") {
      res.json({ success: true, ...result });
    } else if (result.status === "code-not-found") {
      res.status(404).json({ success: false, ...result });
    } else if (result.status === "self-redemption") {
      res.status(400).json({ success: false, ...result });
    } else if (result.status === "already-redeemed") {
      res.status(409).json({ success: false, ...result });
    } else {
      res.status(500).json({ success: false, ...result });
    }
  } catch (err) {
    console.error("[subscriptions.apply-referral] error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

/**
 * Internal: called by the subscriptions verify path after a paid-plan
 * signup confirms. Exported here as a separate route mainly so the ops
 * team can trigger it manually when reconciling a webhook that arrived
 * out-of-order. Guarded by admin key.
 */
router.post("/mark-referee-subscribed", async (req: Request, res: Response) => {
  const adminKey = req.header("x-admin-key") ?? "";
  const expected = process.env.BACKEND_ADMIN_KEY ?? "";
  if (!expected || adminKey !== expected) {
    res.status(401).json({ success: false, error: "unauthorized" });
    return;
  }
  const refereeUserId = typeof req.body?.refereeUserId === "string" ? req.body.refereeUserId : "";
  if (!refereeUserId) { res.status(400).json({ success: false, error: "refereeUserId required" }); return; }
  try {
    const marked = await recordRefereeSubscribed(refereeUserId);
    res.json({ success: true, marked });
  } catch (err) {
    console.error("[subscriptions.mark-referee-subscribed] error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

export default router;
