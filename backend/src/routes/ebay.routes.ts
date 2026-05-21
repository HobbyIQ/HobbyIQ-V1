/**
 * eBay routes
 *
 * All endpoints require the user to be authenticated via x-session-id header
 * (same pattern as other HobbyIQ routes).
 *
 * Auth / connection:
 *   GET  /api/ebay/status                  — is eBay connected for this user?
 *   GET  /api/ebay/connect/start           — returns the eBay OAuth URL
 *   GET  /api/ebay/connect/callback        — eBay redirects here after auth
 *   DELETE /api/ebay/disconnect            — remove stored tokens
 *
 * Policies:
 *   GET  /api/ebay/policies                — seller's payment/fulfillment/return policies
 *
 * Listings:
 *   POST /api/ebay/listings/preview        — build a draft without posting to eBay
 *   POST /api/ebay/listings/publish        — create inventory item + offer + publish
 *   PUT  /api/ebay/listings/:offerId/revise  — update price/qty on live listing
 *   POST /api/ebay/listings/:offerId/end   — delist
 *   GET  /api/ebay/listings/:offerId/status — get live status from eBay
 */

import { Router, Request, Response } from "express";
import { getUserBySession } from "../services/authService.js";
import {
  buildAuthUrl,
  handleCallback,
  getConnectionStatus,
  disconnect,
} from "../services/ebay/ebayAuth.service.js";
import {
  buildListingPreview,
  createListing,
  reviseListing,
  endListing,
  getOfferStatus,
  getSellerPolicies,
  HoldingListingInput,
} from "../services/ebay/ebayListing.service.js";
import {
  linkEbayListing,
  unlinkEbayListingByOfferId,
} from "../services/portfolioiq/portfolioStore.service.js";

const router = Router();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function resolveUser(req: Request, res: Response): Promise<{ userId: string } | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: "Missing x-session-id header" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid or expired session" });
    return null;
  }
  return { userId: user.userId };
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

router.get("/status", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const status = await getConnectionStatus(ctx.userId);
  res.json({ success: true, ...status });
});

// ---------------------------------------------------------------------------
// OAuth connect
// ---------------------------------------------------------------------------

router.get("/connect/start", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  try {
    const url = buildAuthUrl(ctx.userId);
    // Return URL; the app opens it in a SFSafariViewController / ASWebAuthSession
    res.json({ success: true, authUrl: url });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.get("/connect/restart", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  try {
    // Force a clean reconnect flow by dropping existing tokens first.
    await disconnect(ctx.userId);
    const url = buildAuthUrl(ctx.userId);
    res.json({ success: true, authUrl: url, reconnected: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
});

/**
 * eBay redirects the browser here after the user authorises.
 * The iOS app should register this as a Universal Link / custom URL scheme
 * or handle the redirect in ASWebAuthenticationSession.
 */
router.get("/connect/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query as Record<string, string>;

  if (!code || !state) {
    res.status(400).send("Missing code or state parameter");
    return;
  }

  try {
    const record = await handleCallback(code, state);
    // Deep-link back to the app with success; replace scheme as needed
    const appDeepLink = `hobbyiq://ebay/connected?ebayUser=${encodeURIComponent(record.ebayUserId)}`;
    res.redirect(302, appDeepLink);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const appDeepLink = `hobbyiq://ebay/error?message=${encodeURIComponent(msg)}`;
    res.redirect(302, appDeepLink);
  }
});

router.delete("/disconnect", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;
  await disconnect(ctx.userId);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Seller policies
// ---------------------------------------------------------------------------

router.get("/policies", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  try {
    const policies = await getSellerPolicies(ctx.userId);
    res.json({ success: true, ...policies });
  } catch (err) {
    res.status(502).json({ success: false, error: err instanceof Error ? err.message : "eBay API error" });
  }
});

// ---------------------------------------------------------------------------
// Draft preview (no eBay calls)
// ---------------------------------------------------------------------------

router.post("/listings/preview", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const input = req.body as Partial<HoldingListingInput>;
  if (!input.holdingId || !input.playerName || !input.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }

  const preview = await buildListingPreview(ctx.userId, input as HoldingListingInput);
  res.json({ success: true, preview });
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

router.post("/listings/publish", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const status = await getConnectionStatus(ctx.userId);
  if (!status.connected) {
    res.status(403).json({ success: false, error: "eBay account not connected. Please connect first." });
    return;
  }

  const input = req.body as Partial<HoldingListingInput>;
  if (!input.holdingId || !input.playerName || !input.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }

  const result = await createListing(ctx.userId, input as HoldingListingInput);
  if (!result.success) {
    res.status(502).json(result);
    return;
  }
  // PR D.6: persist eBay listing back-references on the holding so the
  // ITEM_SOLD webhook can map a sale notification back to this holding.
  // Best-effort: failure to link should not fail the publish response,
  // since the listing is already live on eBay.
  if (result.offerId && result.listingId) {
    try {
      await linkEbayListing(ctx.userId, String(input.holdingId), {
        offerId: result.offerId,
        listingId: result.listingId,
        publishedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[ebay.publish] linkEbayListing failed:", err);
    }
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// Revise
// ---------------------------------------------------------------------------

router.put("/listings/:offerId/revise", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const offerId = String(req.params.offerId);
  const input = req.body as Partial<HoldingListingInput>;
  if (!input.holdingId || !input.playerName || !input.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }

  const result = await reviseListing(ctx.userId, offerId, input as HoldingListingInput);
  if (!result.success) {
    res.status(502).json(result);
    return;
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// End listing
// ---------------------------------------------------------------------------

router.post("/listings/:offerId/end", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const offerId = String(req.params.offerId);
  const result = await endListing(ctx.userId, offerId);
  if (!result.success) {
    res.status(502).json(result);
    return;
  }
  // PR D.6: clear eBay listing back-references on the linked holding.
  // Best-effort: failure to unlink should not fail the end-listing
  // response, since the listing is already removed from eBay.
  try {
    await unlinkEbayListingByOfferId(ctx.userId, offerId);
  } catch (err) {
    console.error("[ebay.end] unlinkEbayListingByOfferId failed:", err);
  }
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Get listing status
// ---------------------------------------------------------------------------

router.get("/listings/:offerId/status", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  try {
    const status = await getOfferStatus(ctx.userId, String(req.params.offerId));
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(502).json({ success: false, error: err instanceof Error ? err.message : "eBay API error" });
  }
});

export default router;
