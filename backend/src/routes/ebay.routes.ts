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
  const needsAspectsHydration = !input.ebayItemAspects || Object.keys(input.ebayItemAspects).length === 0;
  const needsAnyHydration = !hasExplicitPhotos || needsTeamHydration || needsAspectsHydration;
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
    // CF-EBAY-ASPECTS-MERGE (Drew, 2026-07-20). Hydrate ebayItemAspects
    // from the holding when iOS didn't pass them explicitly. Required
    // for the Sports Trading Cards category to pass eBay's Sell
    // Inventory validation (League, Type, Country/Region of
    // Manufacture, Year Manufactured are enforced).
    if (needsAspectsHydration
        && holding.ebayItemAspects
        && typeof holding.ebayItemAspects === "object") {
      patch.ebayItemAspects = holding.ebayItemAspects as Record<string, string>;
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
// CF-LISTING-REVIEW-PREPARE (Drew, 2026-07-20).
// GET the shaped payload iOS renders on the Listing Review screen —
// pre-filled from the holding, auto-defaults where sensible, flagged
// for what's still missing before eBay accepts a publish. Never
// touches eBay; just structures data.
// ---------------------------------------------------------------------------

const SPORT_TO_LEAGUE: Record<string, string> = {
  baseball: "Major League Baseball (MLB)",
  football: "National Football League (NFL)",
  basketball: "National Basketball Association (NBA)",
  hockey: "National Hockey League (NHL)",
  soccer: "Major League Soccer (MLS)",
};

router.post("/listings/prepare", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { holdingId } = (req.body ?? {}) as { holdingId?: string };
  if (!holdingId || typeof holdingId !== "string" || !holdingId.trim()) {
    res.status(400).json({ success: false, error: "holdingId is required" });
    return;
  }
  try {
    const doc = await readUserDoc(userId);
    const h = doc.holdings?.[holdingId.trim()] as unknown as Record<string, unknown> | undefined;
    if (!h) {
      res.status(404).json({ success: false, error: "Holding not found" });
      return;
    }

    const sport = (typeof h.sport === "string" && h.sport.trim())
      ? String(h.sport).trim().toLowerCase()
      : "baseball";
    const cardYear = typeof h.cardYear === "number" ? h.cardYear : null;
    const gradeCompany = typeof h.gradeCompany === "string" ? h.gradeCompany : null;
    const gradeValue = typeof h.gradeValue === "number"
      ? String(h.gradeValue)
      : (typeof h.grade === "string" ? h.grade : null);
    const isGraded = !!gradeCompany && gradeCompany.toLowerCase() !== "raw" && !!gradeValue;

    const photosRaw = Array.isArray(h.photos) ? (h.photos as string[]) : [];
    const photos = photosRaw
      .filter((u) => typeof u === "string" && /^https:\/\//i.test(u))
      .slice(0, 12);

    // Existing captured aspects — used ONLY for the category-meta fields.
    // Card-identity aspects come from the holding's authoritative fields.
    const captured = (h.ebayItemAspects && typeof h.ebayItemAspects === "object")
      ? (h.ebayItemAspects as Record<string, string>)
      : {};

    const priceCents = (() => {
      const guess = (h.predictedPrice ?? h.fairMarketValue ?? h.estimatedValue) as number | undefined;
      if (typeof guess === "number" && guess > 0) return Math.round(guess * 100);
      return 0;
    })();

    const titleSuggested = (() => {
      const parts: string[] = [];
      if (cardYear) parts.push(String(cardYear));
      if (h.setName ?? h.product) parts.push(String(h.setName ?? h.product));
      if (h.parallel) parts.push(String(h.parallel));
      if (h.playerName) parts.push(String(h.playerName));
      if (h.cardNumber) parts.push(`#${String(h.cardNumber).replace(/^#+/, "")}`);
      return parts.join(" ").trim().slice(0, 80);
    })();

    const identity = {
      playerName: (typeof h.playerName === "string" ? h.playerName : null) as string | null,
      cardYear,
      setName: (typeof h.setName === "string" ? h.setName : null) as string | null,
      parallel: (typeof h.parallel === "string" ? h.parallel : null) as string | null,
      cardNumber: (typeof h.cardNumber === "string" ? h.cardNumber : null) as string | null,
      isAuto: h.isAuto === true,
      isRookie: (h as { isRookie?: boolean }).isRookie === true,
      team: (typeof h.team === "string" ? h.team : null) as string | null,
      sport: sport.charAt(0).toUpperCase() + sport.slice(1),
    };

    const condition = {
      isGraded,
      gradingCompany: isGraded ? gradeCompany : null,
      grade: isGraded ? gradeValue : null,
      certNumber: (typeof h.certNumber === "string" ? h.certNumber : null) as string | null,
      conditionEstimate: (typeof h.conditionEstimate === "string" ? h.conditionEstimate : null) as string | null,
      conditionNotes: (typeof h.conditionNotes === "string" ? h.conditionNotes : null) as string | null,
    };

    const categoryAspects = {
      league: captured["League"] ?? (SPORT_TO_LEAGUE[sport] ?? null),
      type: captured["Type"] ?? "Sports Trading Card",
      countryOfManufacture: captured["Country/Region of Manufacture"]
        ?? captured["Country of Origin"]
        ?? captured["Country/Region of Origin"]
        ?? "United States",
      yearManufactured: (() => {
        const raw = captured["Year Manufactured"];
        if (raw) { const n = parseInt(raw, 10); if (Number.isFinite(n)) return n; }
        return cardYear;
      })(),
      season: (() => {
        const raw = captured["Season"];
        if (raw) { const n = parseInt(raw, 10); if (Number.isFinite(n)) return n; }
        return cardYear;
      })(),
      language: captured["Language"] ?? "English",
    };

    const listing = {
      quantity: 1,
      priceCents,
      bestOfferEnabled: false,
      bestOfferMinPriceCents: null as number | null,
      description: (typeof h.ebayShortDescription === "string" ? h.ebayShortDescription : titleSuggested),
      titleSuggested,
    };

    // Validation — what's still needed before eBay will accept the payload
    const requiredMissing: string[] = [];
    const warnings: string[] = [];

    if (photos.length === 0) requiredMissing.push("photos");
    if (!identity.playerName) requiredMissing.push("identity.playerName");
    if (!identity.cardYear) requiredMissing.push("identity.cardYear");
    if (!identity.setName) requiredMissing.push("identity.setName");
    if (!categoryAspects.league) requiredMissing.push("categoryAspects.league");
    if (!categoryAspects.type) requiredMissing.push("categoryAspects.type");
    if (!categoryAspects.countryOfManufacture) requiredMissing.push("categoryAspects.countryOfManufacture");
    if (!categoryAspects.yearManufactured) requiredMissing.push("categoryAspects.yearManufactured");
    if (!listing.priceCents || listing.priceCents <= 0) requiredMissing.push("listing.priceCents");
    if (!listing.titleSuggested) requiredMissing.push("listing.title");
    else if (listing.titleSuggested.length > 80) warnings.push("Title exceeds eBay's 80-char cap and will be truncated");

    if (isGraded && !gradeValue) requiredMissing.push("condition.grade");
    if (!isGraded && !condition.conditionEstimate) warnings.push("Raw condition not set; will default to 'Near Mint'");

    // Contradiction warnings (from the Judge-style dirty-capture pattern)
    if (!identity.isAuto) {
      for (const k of ["Autograph Format", "Autograph Authentication", "Signed By"]) {
        if (captured[k]) warnings.push(`Captured "${k}" ignored — holding is not marked auto`);
      }
    }
    if (!isGraded && captured["Grade"]) {
      warnings.push(`Captured "Grade: ${captured["Grade"]}" ignored — holding is raw`);
    }

    res.json({
      success: true,
      holdingId: holdingId.trim(),
      identity,
      condition,
      categoryAspects,
      photos,
      listing,
      validation: {
        requiredMissing,
        warnings,
        readyToPublish: requiredMissing.length === 0,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "prepare failed",
    });
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
