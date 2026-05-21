/**
 * eBay Notifications webhook (PR D.5).
 *
 * Two responsibilities:
 *
 *   GET /api/ebay/webhook
 *     Marketplace Account Deletion / Closure challenge handshake.
 *     eBay calls this once at endpoint registration with ?challenge_code=...
 *     We must respond `{ challengeResponse: <hex sha256> }` where the digest
 *     is computed over: challenge_code + EBAY_WEBHOOK_VERIFICATION_TOKEN +
 *     <full endpoint URL>.
 *     Spec: https://developer.ebay.com/marketplace-account-deletion
 *
 *   POST /api/ebay/webhook
 *     Receives all notification topics for the registered endpoint.
 *     Topics handled in PR D.5:
 *       - MARKETPLACE_ACCOUNT_DELETION → look up the HobbyIQ userId by
 *         eBay username/userId in the notification payload, delete that
 *         user's token record (which severs further API access).
 *     All other topics (including ITEM_SOLD): logged + 200-OK stub. The
 *     real ITEM_SOLD handler ships in PR D.6 once the holding doc carries
 *     `ebayOfferId` / `ebayListingId` (data-model decision A from D.5
 *     halt review).
 *
 * Always responds 200 on POST. eBay's notification platform treats any
 * non-2xx as a delivery failure and retries with exponential backoff,
 * which would mask transient logic bugs as compliance violations.
 *
 * Auth: the GET endpoint is public (eBay can't sign challenge requests).
 * The POST endpoint validates by recomputing the SHA-256 of the request
 * body + verification token? No — eBay does NOT sign POST notification
 * bodies for marketplace-account-deletion. Authenticity is established
 * solely by the challenge handshake at registration time + the fact that
 * the endpoint URL is private to your developer account. We accept any
 * POST that parses as the documented schema.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import {
  deleteTokenRecord,
  findUserIdByEbayUserId,
} from "../services/ebay/ebayTokenStore.service.js";

const router = Router();

/**
 * Compute the eBay challenge response per the marketplace-account-deletion
 * spec: SHA-256 hex digest of (challengeCode + verificationToken + endpoint).
 *
 * Exported for unit tests.
 */
export function computeChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpoint: string,
): string {
  return crypto
    .createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");
}

/**
 * Resolve the registered endpoint URL exactly as it must match the value
 * configured in eBay's developer portal. Override via EBAY_WEBHOOK_ENDPOINT
 * (recommended in production) so we never depend on the request's Host
 * header — eBay computes the challenge using whatever string was registered,
 * not whatever Host header arrives.
 */
function resolveEndpointUrl(req: Request): string {
  const override = process.env.EBAY_WEBHOOK_ENDPOINT?.trim();
  if (override) return override;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol ?? "https";
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "";
  return `${proto}://${host}${req.baseUrl}${req.path}`;
}

// ---------------------------------------------------------------------------
// GET /api/ebay/webhook — challenge handshake
// ---------------------------------------------------------------------------

router.get("/", (req: Request, res: Response) => {
  const challengeCode = String(req.query.challenge_code ?? "").trim();
  if (!challengeCode) {
    res.status(400).json({ error: "Missing challenge_code query parameter." });
    return;
  }

  const verificationToken = process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN ?? "";
  if (!verificationToken) {
    console.error(
      "[ebayWebhook] EBAY_WEBHOOK_VERIFICATION_TOKEN is not set — challenge cannot be answered.",
    );
    res.status(500).json({ error: "Webhook verification token not configured." });
    return;
  }

  const endpoint = resolveEndpointUrl(req);
  const challengeResponse = computeChallengeResponse(
    challengeCode,
    verificationToken,
    endpoint,
  );

  res.status(200).json({ challengeResponse });
});

// ---------------------------------------------------------------------------
// POST /api/ebay/webhook — notification dispatcher
// ---------------------------------------------------------------------------

interface EbayNotificationEnvelope {
  metadata?: {
    topic?: string;
    schemaVersion?: string;
    deprecated?: boolean;
  };
  notification?: {
    notificationId?: string;
    eventDate?: string;
    publishDate?: string;
    publishAttemptCount?: number;
    data?: {
      username?: string;
      userId?: string;
      eiasToken?: string;
      [k: string]: unknown;
    };
  };
}

/**
 * Handle a MARKETPLACE_ACCOUNT_DELETION notification.
 *
 * eBay sends this when a user closes their account or revokes consent.
 * Compliance requires us to delete or anonymize all data tied to that user.
 * For PR D.5 the minimum compliant action is severing API access by
 * deleting the OAuth token record. (Holding data is HobbyIQ-owned content
 * created by the user inside our app; eBay's deletion mandate covers
 * eBay-sourced PII, which lives only in the token doc.)
 */
async function handleAccountDeletion(
  envelope: EbayNotificationEnvelope,
): Promise<{ matched: boolean; userId: string | null }> {
  const data = envelope.notification?.data ?? {};
  // Match in the same order we wrote on connect: username preferred, then
  // encrypted userId, then eiasToken as last resort.
  const candidates = [data.username, data.userId, data.eiasToken]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);

  for (const candidate of candidates) {
    const hobbyiqUserId = await findUserIdByEbayUserId(candidate);
    if (hobbyiqUserId) {
      await deleteTokenRecord(hobbyiqUserId);
      console.log(
        `[ebayWebhook] account-deletion: removed token for hobbyiq userId=${hobbyiqUserId} (matched ebay identifier)`,
      );
      return { matched: true, userId: hobbyiqUserId };
    }
  }

  console.log(
    "[ebayWebhook] account-deletion: no matching token record found (already deleted or never connected); ack 200",
  );
  return { matched: false, userId: null };
}

router.post("/", async (req: Request, res: Response) => {
  const envelope = (req.body ?? {}) as EbayNotificationEnvelope;
  const topic = envelope.metadata?.topic ?? "UNKNOWN";
  const notificationId = envelope.notification?.notificationId ?? "no-id";

  try {
    if (topic === "MARKETPLACE_ACCOUNT_DELETION") {
      await handleAccountDeletion(envelope);
    } else {
      // Includes ITEM_SOLD and any other topic we haven't wired yet.
      // Stubbed in PR D.5; real ITEM_SOLD handler ships in PR D.6.
      console.log(
        `[ebayWebhook] received topic=${topic} notificationId=${notificationId} (stub — no action taken)`,
      );
    }
  } catch (err: any) {
    // We swallow handler errors to a 200 because eBay retries non-2xx
    // aggressively — but we log them so App Insights surfaces real bugs.
    console.error(
      `[ebayWebhook] handler error for topic=${topic} notificationId=${notificationId}:`,
      err?.message ?? String(err),
    );
  }

  res.status(200).json({ received: true });
});

export default router;
