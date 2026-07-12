/**
 * eBay routes
 *
 * CF-PAYMENTS-A retrofit:
 *   - requireSession on every route EXCEPT the OAuth callback (browser
 *     redirect from eBay, no session cookie). The callback validates state
 *     instead.
 *   - All non-callback routes ALSO gated by requireEntitlement("ebayIntegration").
 *     Per the matrix this is investor+ (free / collector see 402).
 *
 * Auth / connection:
 *   GET  /api/ebay/status                  — is eBay connected for this user?
 *   GET  /api/ebay/connect/start           — returns the eBay OAuth URL
 *   GET  /api/ebay/connect/callback        — eBay redirects here after auth (PUBLIC)
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
  readUserDoc,
} from "../services/portfolioiq/portfolioStore.service.js";
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";

/**
 * CF-INVENTORY-PHOTOS-TO-LISTING (2026-07-05, Drew): when iOS calls
 * /listings/preview or /listings/publish with a `holdingId` but no
 * explicit `photos[]`, auto-hydrate photos from the holding doc.
 * User expectation: photos taken during inventory should be available
 * to the eBay listing composer without iOS having to plumb them
 * through explicitly.
 *
 * If iOS DID pass photos (or a partial override like just
 * imageFrontUrl), we don't overwrite — respect the explicit choice.
 * Only fires when photos is undefined AND both imageFrontUrl and
 * imageBackUrl are also undefined.
 */
async function hydratePhotosFromHolding(
  userId: string,
  input: Partial<HoldingListingInput>,
): Promise<Partial<HoldingListingInput>> {
  // CF-EBAY-REVIEW-QUEUE (2026-07-12): hydration now also pulls `team`
  // from the holding when iOS didn't override — Browse enrichment writes
  // team on the holding, and eBay item specifics accept it as a field.
  const hasExplicitPhotos =
    Array.isArray(input.photos) ||
    typeof input.imageFrontUrl === "string" ||
    typeof input.imageBackUrl === "string";
  const needsTeamHydration = typeof input.team !== "string" || !input.team.trim();
  const needsAnyHydration = !hasExplicitPhotos || needsTeamHydration;
  if (!needsAnyHydration) return input;
  if (typeof input.holdingId !== "string" || !input.holdingId.trim()) return input;

  try {
    const doc = await readUserDoc(userId);
    const holding = doc.holdings[input.holdingId] as unknown as Record<string, unknown> | undefined;
    if (!holding) return input;
    const patch: Partial<HoldingListingInput> = { ...input };
    if (!hasExplicitPhotos && Array.isArray(holding.photos) && holding.photos.length > 0) {
      patch.photos = [...(holding.photos as string[])];
    }
    if (needsTeamHydration && typeof holding.team === "string" && holding.team.trim()) {
      patch.team = (holding.team as string).trim();
    }
    return patch;
  } catch (err) {
    console.warn(
      `[ebay.hydratePhotos] readUserDoc failed for ${userId}/${input.holdingId}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
  return input;
}

const router = Router();

// The OAuth callback is a browser redirect from eBay — no session cookie
// is available. It validates state separately. Mount it FIRST so it doesn't
// accidentally fall under the gated middleware below.
router.get("/connect/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query as Record<string, string>;

  if (!code || !state) {
    res.status(400).send("Missing code or state parameter");
    return;
  }

  try {
    const record = await handleCallback(code, state);
    const appDeepLink = `hobbyiq://ebay/connected?ebayUser=${encodeURIComponent(record.ebayUserId)}`;
    res.redirect(302, appDeepLink);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const appDeepLink = `hobbyiq://ebay/error?message=${encodeURIComponent(msg)}`;
    res.redirect(302, appDeepLink);
  }
});

// Everything below requires a session AND the ebayIntegration entitlement
// (investor+ per the matrix).
router.use(requireSession);
router.use(requireEntitlement("ebayIntegration"));

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

router.get("/status", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const status = await getConnectionStatus(userId);
  res.json({ success: true, ...status });
});

// ---------------------------------------------------------------------------
// OAuth connect
// ---------------------------------------------------------------------------

router.get("/connect/start", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  try {
    const url = buildAuthUrl(userId);
    res.json({ success: true, authUrl: url });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.get("/connect/restart", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  try {
    await disconnect(userId);
    const url = buildAuthUrl(userId);
    res.json({ success: true, authUrl: url, reconnected: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.delete("/disconnect", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await disconnect(userId);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Seller policies
// ---------------------------------------------------------------------------

router.get("/policies", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  try {
    const policies = await getSellerPolicies(userId);
    res.json({ success: true, ...policies });
  } catch (err) {
    res.status(502).json({ success: false, error: err instanceof Error ? err.message : "eBay API error" });
  }
});

// ---------------------------------------------------------------------------
// Draft preview (no eBay calls)
// ---------------------------------------------------------------------------

router.post("/listings/preview", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const raw = req.body as Partial<HoldingListingInput>;
  if (!raw.holdingId || !raw.playerName || !raw.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }
  const input = await hydratePhotosFromHolding(userId, raw);

  const preview = await buildListingPreview(userId, input as HoldingListingInput);
  res.json({ success: true, preview });
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

router.post("/listings/publish", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const status = await getConnectionStatus(userId);
  if (!status.connected) {
    res.status(403).json({ success: false, error: "eBay account not connected. Please connect first." });
    return;
  }

  const raw = req.body as Partial<HoldingListingInput>;
  if (!raw.holdingId || !raw.playerName || !raw.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }
  const input = await hydratePhotosFromHolding(userId, raw);

  const result = await createListing(userId, input as HoldingListingInput);
  if (!result.success) {
    res.status(502).json(result);
    return;
  }
  // PR D.6: persist eBay listing back-references on the holding so the
  // ITEM_SOLD webhook can map a sale notification back to this holding.
  if (result.offerId && result.listingId) {
    try {
      await linkEbayListing(userId, String(input.holdingId), {
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
  const userId = req.user!.userId;

  const offerId = String(req.params.offerId);
  const input = req.body as Partial<HoldingListingInput>;
  if (!input.holdingId || !input.playerName || !input.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }

  const result = await reviseListing(userId, offerId, input as HoldingListingInput);
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
  const userId = req.user!.userId;

  const offerId = String(req.params.offerId);
  const result = await endListing(userId, offerId);
  if (!result.success) {
    res.status(502).json(result);
    return;
  }
  try {
    await unlinkEbayListingByOfferId(userId, offerId);
  } catch (err) {
    console.error("[ebay.end] unlinkEbayListingByOfferId failed:", err);
  }
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Get listing status
// ---------------------------------------------------------------------------

router.get("/listings/:offerId/status", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  try {
    const status = await getOfferStatus(userId, String(req.params.offerId));
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(502).json({ success: false, error: err instanceof Error ? err.message : "eBay API error" });
  }
});

export default router;
