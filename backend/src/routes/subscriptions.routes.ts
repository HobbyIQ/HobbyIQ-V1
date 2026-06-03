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

export default router;
