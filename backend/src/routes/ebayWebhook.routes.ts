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
import {
  captureEvent,
  eventExists,
  markEventError,
  markEventProcessed,
} from "../services/ebay/ebayWebhookEvents.service.js";
import {
  findHoldingByEbayOfferIdAcrossUsers,
  markHoldingSoldFromEbay,
} from "../services/portfolioiq/portfolioStore.service.js";

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
      // MARKETPLACE_ACCOUNT_DELETION fields
      username?: string;
      userId?: string;
      eiasToken?: string;
      // ITEM_SOLD fields (eBay Sell Notification API). The exact shape
      // varies by topic version; we tolerate either snake/camel and
      // either top-level or nested-in-line-item placements.
      offerId?: string;
      legacyItemId?: string;
      listingId?: string;
      orderId?: string;
      legacyOrderId?: string;
      saleDate?: string;
      buyer?: { username?: string };
      lineItems?: Array<{
        offerId?: string;
        legacyItemId?: string;
        listingId?: string;
        quantity?: number;
        lineItemCost?: { value?: string | number; currency?: string };
        total?: { value?: string | number; currency?: string };
      }>;
      [k: string]: unknown;
    };
  };
}

/**
 * Pull the canonical ebayOfferId out of an ITEM_SOLD envelope. eBay places
 * it either at `data.offerId` or on the first lineItem. Returns null if
 * nothing usable is present (so the caller can record an error and still
 * ack 200).
 */
function extractOfferId(env: EbayNotificationEnvelope): string | null {
  const data = env.notification?.data ?? {};
  const direct = typeof data.offerId === "string" ? data.offerId.trim() : "";
  if (direct) return direct;
  const li = Array.isArray(data.lineItems) ? data.lineItems[0] : undefined;
  const fromLine = typeof li?.offerId === "string" ? li.offerId.trim() : "";
  return fromLine || null;
}

/**
 * Pull a usable order identifier. Prefer the modern `orderId`; fall back
 * to `legacyOrderId`. Returns "" if neither is present.
 */
function extractOrderId(env: EbayNotificationEnvelope): string {
  const data = env.notification?.data ?? {};
  const a = typeof data.orderId === "string" ? data.orderId.trim() : "";
  if (a) return a;
  const b = typeof data.legacyOrderId === "string" ? data.legacyOrderId.trim() : "";
  return b;
}

function extractListingId(env: EbayNotificationEnvelope): string | null {
  const data = env.notification?.data ?? {};
  const top = typeof data.listingId === "string" ? data.listingId.trim() : "";
  if (top) return top;
  const legacy = typeof data.legacyItemId === "string" ? data.legacyItemId.trim() : "";
  if (legacy) return legacy;
  const li = Array.isArray(data.lineItems) ? data.lineItems[0] : undefined;
  const liListing = typeof li?.listingId === "string" ? li.listingId.trim() : "";
  if (liListing) return liListing;
  const liLegacy = typeof li?.legacyItemId === "string" ? li.legacyItemId.trim() : "";
  return liLegacy || null;
}

function extractQuantitySold(env: EbayNotificationEnvelope): number {
  const data = env.notification?.data ?? {};
  const li = Array.isArray(data.lineItems) ? data.lineItems[0] : undefined;
  const q = Number(li?.quantity);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}

function extractUnitSalePrice(env: EbayNotificationEnvelope): number {
  const data = env.notification?.data ?? {};
  const li = Array.isArray(data.lineItems) ? data.lineItems[0] : undefined;
  // Prefer per-unit lineItemCost; fall back to total / quantity.
  const unit = Number(li?.lineItemCost?.value);
  if (Number.isFinite(unit) && unit > 0) return unit;
  const total = Number(li?.total?.value);
  const qty = extractQuantitySold(env);
  if (Number.isFinite(total) && total > 0 && qty > 0) return total / qty;
  return 0;
}

function extractSaleConfirmedAt(env: EbayNotificationEnvelope): string {
  const data = env.notification?.data ?? {};
  const a = typeof data.saleDate === "string" ? data.saleDate.trim() : "";
  if (a) return a;
  const b = env.notification?.eventDate ?? "";
  return b || new Date().toISOString();
}

/**
 * Handle an ITEM_SOLD notification from eBay's Sell Notification API.
 *
 * EBAY-POLL-INGESTION-C1 (2026-06-01) — DORMANT IN PROD. Sale ingestion
 * is now poll-based via `pollEbayOrdersForUser` (1h cadence, scheduled
 * job at jobs/ebayOrderPoll.job.ts). This handler is no longer the
 * primary signal; the eBay developer portal subscription for ITEM_SOLD
 * is not active. It remains wired as:
 *   - Belt-and-suspenders for accidental ITEM_SOLD POSTs (race-safe with
 *     the poll path because markHoldingSoldFromEbay is idempotent on
 *     (holdingId, ebayOrderId) — whichever path arrives second returns
 *     marked-sold-deduped).
 *   - Reference for the documented data shape (the envelope schema below
 *     mirrors what getOrders line items expose, modulo the offerId
 *     difference — see ebayOrderPoll.service.ts join-key comment).
 *
 * The MARKETPLACE_ACCOUNT_DELETION handler in this file is unchanged
 * and remains compliance-required regardless of which ingestion path is
 * primary.
 *
 * Flow (capture-before-process is performed by the caller):
 *   1. Extract ebayOfferId from envelope.
 *   2. Cross-user lookup of the holding linked to that offerId.
 *   3. If found → call markHoldingSoldFromEbay with sale data.
 *   4. If missing offer / not found / mark fails → markEventError, but
 *      still return 200 to eBay (acks are non-negotiable; replay tooling
 *      reads the captured envelope from webhook_events).
 *
 * NOTE on suppliesCost / gradingCost: PortfolioHolding does NOT carry a
 * gradingCost or suppliesCost field on the holding doc (verified in
 * src/types/portfolioiq.types.ts as of PR D.6). We pass null for both so
 * the ledger entry records "unknown — needs reconciliation". Future
 * PR E UX will expose a sale-time reconciliation form where the user
 * enters the actual grading/supplies cost; do NOT default these to 0
 * and do NOT invent a holding-level field here.
 */
async function handleItemSold(
  envelope: EbayNotificationEnvelope,
  notificationId: string,
): Promise<{ matched: boolean; result: string; error?: string }> {
  const offerId = extractOfferId(envelope);
  if (!offerId) {
    const error = "ITEM_SOLD: envelope missing ebayOfferId — cannot route to a holding";
    console.warn(`[ebayWebhook] ${error} notificationId=${notificationId}`);
    return { matched: false, result: "no-offer-id", error };
  }

  const ebayOrderId = extractOrderId(envelope);
  if (!ebayOrderId) {
    const error = `ITEM_SOLD: envelope missing orderId for ebayOfferId=${offerId}`;
    console.warn(`[ebayWebhook] ${error} notificationId=${notificationId}`);
    return { matched: false, result: "no-order-id", error };
  }

  const match = await findHoldingByEbayOfferIdAcrossUsers(offerId);
  if (!match) {
    // Realistic race: user ended a listing milliseconds before eBay
    // processed the sale, OR the offer was created outside HobbyIQ. The
    // raw envelope is preserved in webhook_events for manual recovery.
    const error = `no holding found with ebayOfferId=${offerId} — possible race with end-listing or unknown offerId`;
    console.warn(`[ebayWebhook] ${error} notificationId=${notificationId}`);
    return { matched: false, result: "holding-not-found", error };
  }

  const result = await markHoldingSoldFromEbay(match.userId, match.holdingId, {
    ebayOrderId,
    ebayOfferId: offerId,
    ebayListingId: extractListingId(envelope),
    ebayBuyerUsername: envelope.notification?.data?.buyer?.username ?? null,
    saleConfirmedAt: extractSaleConfirmedAt(envelope),
    quantitySold: extractQuantitySold(envelope),
    unitSalePrice: extractUnitSalePrice(envelope),
    // Granular fees: ITEM_SOLD does not include eBay fee detail.
    // Those arrive via separate finance/payout APIs and reconcile later.
    finalValueFee: null,
    paymentProcessingFee: null,
    promotedListingFee: null,
    adFee: null,
    otherFees: null,
    netPayout: null,
    actualShippingCost: null,
    // suppliesCost / gradingCost are user-entered HobbyIQ-side values
    // reconciled in a future PR E UX. We do NOT default to 0 (would
    // misrepresent "unknown" as "free") and we do NOT invent a holding
    // field. Pass null to record "unknown" and trigger
    // needsReconciliation downstream.
    suppliesCost: null,
    gradingCost: null,
  });

  if (result.status === "marked-sold" || result.status === "marked-sold-deduped") {
    console.log(
      `[ebayWebhook] ITEM_SOLD: status=${result.status} userId=${match.userId} holdingId=${match.holdingId} ebayOrderId=${ebayOrderId} notificationId=${notificationId}`,
    );
    return { matched: true, result: result.status };
  }

  const error = `ITEM_SOLD: markHoldingSoldFromEbay returned status=${result.status}${
    result.status === "invalid-input" ? ` reason=${result.reason}` : ""
  } for userId=${match.userId} holdingId=${match.holdingId}`;
  console.warn(`[ebayWebhook] ${error} notificationId=${notificationId}`);
  return { matched: false, result: result.status, error };
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
  const notificationId = String(envelope.notification?.notificationId ?? "").trim();
  const eventDate = envelope.notification?.eventDate;

  // Capture-before-process. If we have no notificationId we still ack 200
  // (eBay would otherwise retry endlessly), but we cannot dedupe or
  // persist for replay. This should not happen in production envelopes.
  if (!notificationId) {
    console.warn(`[ebayWebhook] received topic=${topic} with no notificationId — ack 200 without capture`);
    res.status(200).json({ received: true });
    return;
  }

  try {
    // Idempotency: if eBay redelivers a notificationId we've already
    // captured, skip the topic handler and ack 200.
    if (await eventExists(notificationId)) {
      console.log(
        `[ebayWebhook] dedup: notificationId=${notificationId} topic=${topic} already captured — ack 200`,
      );
      res.status(200).json({ received: true });
      return;
    }

    const capture = await captureEvent({
      notificationId,
      topic,
      eventDate,
      envelope,
    });
    if (capture.duplicate) {
      console.log(
        `[ebayWebhook] dedup-on-write: notificationId=${notificationId} topic=${topic} — ack 200`,
      );
      res.status(200).json({ received: true });
      return;
    }

    if (topic === "MARKETPLACE_ACCOUNT_DELETION") {
      const r = await handleAccountDeletion(envelope);
      await markEventProcessed(notificationId, {
        action: r.matched ? "token-deleted" : "no-match",
        userId: r.userId,
      });
    } else if (topic === "ITEM_SOLD") {
      const r = await handleItemSold(envelope, notificationId);
      if (r.error) {
        await markEventError(notificationId, r.error);
      } else {
        await markEventProcessed(notificationId, {
          action: r.result,
          matched: r.matched,
        });
      }
    } else {
      // Topic we haven't wired yet — capture is sufficient for replay.
      console.log(
        `[ebayWebhook] received topic=${topic} notificationId=${notificationId} (no handler — captured for replay)`,
      );
      await markEventProcessed(notificationId, { action: "no-handler", topic });
    }
  } catch (err: any) {
    // We swallow handler errors to a 200 because eBay retries non-2xx
    // aggressively — but we log them so App Insights surfaces real bugs.
    const msg = err?.message ?? String(err);
    console.error(
      `[ebayWebhook] handler error for topic=${topic} notificationId=${notificationId}:`,
      msg,
    );
    await markEventError(notificationId, msg);
  }

  res.status(200).json({ received: true });
});

export default router;
