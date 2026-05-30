import { Router } from "express";
import * as portfolio from "../services/portfolioiq/portfolioStore.service.js";
import { getUserBySession } from "../services/authService.js";
import { getConnectionStatus } from "../services/ebay/ebayAuth.service.js";
import { buildListingPreview, createListing, HoldingListingInput } from "../services/ebay/ebayListing.service.js";
import {
  identifyCardByBlobUrl,
  IdentifyBlobDownloadError,
  CardsightApiError,
  CardsightTimeoutError,
  CardsightValidationError,
} from "../services/cardsight/identify.service.js";
const router = Router();

async function resolveUserIdFromHeader(sessionHeader: unknown): Promise<string | null> {
  const sessionId = String(sessionHeader ?? "").trim();
  if (!sessionId) return null;
  const user = await getUserBySession(sessionId);
  return user?.userId ?? null;
}

router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "PortfolioIQ", timestamp: new Date().toISOString() });
});

// GET /api/portfolio — combined holdings + summary for the iOS dashboard.
router.get("/", portfolio.getPortfolioWithSummary);

router.get("/holdings", portfolio.getHoldings);
router.get("/alerts", portfolio.getAlerts);
router.get("/health/score", portfolio.getPortfolioHealth);
router.get("/analytics/calibration", portfolio.getCalibration);
router.get("/insights/weekly-brief", portfolio.getWeeklyBrief);
router.post("/feedback/recommendation", portfolio.addRecommendationFeedback);
router.get("/ledger", portfolio.getLedger);
router.patch("/ledger/:id", portfolio.updateLedgerEntry);
router.post("/holdings", portfolio.addHolding);
router.get("/holdings/:id", portfolio.getHoldingById);
router.get("/holdings/:id/history", portfolio.getHoldingPriceHistory);
router.put("/holdings/:id", portfolio.updateHolding);
router.patch("/holdings/:id", portfolio.updateHolding);
router.delete("/holdings/:id", portfolio.deleteHolding);
router.post("/holdings/:id/sell", portfolio.sellHolding);
router.post("/holdings/:id/refresh", portfolio.refreshHolding);
router.post("/holdings/:id/ebay/draft", async (req, res) => {
  const userId = await resolveUserIdFromHeader(req.headers["x-session-id"]);
  if (!userId) {
    res.status(401).json({ success: false, error: "Missing or invalid x-session-id header" });
    return;
  }

  const status = await getConnectionStatus(userId);
  if (!status.connected) {
    res.status(403).json({ success: false, error: "eBay account not connected. Please connect first." });
    return;
  }

  const holdingId = String(req.params.id ?? "").trim();
  const input = { ...(req.body ?? {}), holdingId } as Partial<HoldingListingInput>;
  if (!input.holdingId || !input.playerName || !input.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }

  const preview = await buildListingPreview(userId, input as HoldingListingInput);
  res.json({ success: true, preview });
});
router.post("/holdings/:id/ebay/listing", async (req, res) => {
  const userId = await resolveUserIdFromHeader(req.headers["x-session-id"]);
  if (!userId) {
    res.status(401).json({ success: false, error: "Missing or invalid x-session-id header" });
    return;
  }

  const status = await getConnectionStatus(userId);
  if (!status.connected) {
    res.status(403).json({ success: false, error: "eBay account not connected. Please connect first." });
    return;
  }

  const holdingId = String(req.params.id ?? "").trim();
  const input = { ...(req.body ?? {}), holdingId } as Partial<HoldingListingInput>;
  if (!input.holdingId || !input.playerName || !input.listingPrice) {
    res.status(400).json({ success: false, error: "holdingId, playerName, and listingPrice are required" });
    return;
  }

  const result = await createListing(userId, input as HoldingListingInput);
  if (!result.success) {
    res.status(502).json(result);
    return;
  }
  res.json(result);
});
router.post("/reprice/batch", portfolio.runBatchReprice);

// CF-CARDSIGHT-IDENTIFY-INTEGRATION: POST /api/portfolio/identify
//
// Two-step pattern: iOS first PUTs an image to Azure Blob via the existing
// /api/uploads/card-photo SAS flow, then POSTs { blobUrl } here to identify
// the card + grade. Response shape pass-through verbatim from Cardsight so
// iOS can decide UX from `success`, `detections`, and `messages` fields.
//
// Important: Cardsight's `success: false` is NOT an error -- the API returns
// 200 with success:false when image quality is insufficient or no card is
// detected. We forward those 200s unchanged. Only true upstream failures
// (timeout, persistent 5xx, blob storage failure) map to 5xx; only true
// validation issues (image dimensions too small per Cardsight) map to 400.
router.post("/identify", async (req, res) => {
  const userId = await resolveUserIdFromHeader(req.headers["x-session-id"]);
  if (!userId) {
    res.status(401).json({ success: false, error: "Missing or invalid x-session-id header" });
    return;
  }

  const body = (req.body ?? {}) as { blobUrl?: unknown; blobName?: unknown };
  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl.trim() : "";
  const blobName = typeof body.blobName === "string" ? body.blobName.trim() : undefined;
  if (!blobUrl) {
    res.status(400).json({ success: false, error: "blobUrl is required" });
    return;
  }

  try {
    const result = await identifyCardByBlobUrl(blobUrl, blobName);
    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof CardsightValidationError) {
      res.status(400).json({
        success: false,
        error: err.message,
        code: err.code,
        requestId: err.requestId,
      });
      return;
    }
    if (err instanceof CardsightTimeoutError) {
      res.status(504).json({
        success: false,
        error: "Cardsight identify timed out",
      });
      return;
    }
    if (err instanceof CardsightApiError) {
      res.status(502).json({
        success: false,
        error: "Cardsight identify upstream error",
        upstream_status: err.status,
        requestId: err.requestId,
      });
      return;
    }
    if (err instanceof IdentifyBlobDownloadError) {
      res.status(502).json({
        success: false,
        error: "Failed to download image blob for identify",
      });
      return;
    }
    // Unknown error -- log + 500.
    console.error("[portfolioiq.identify] unexpected error:", err);
    res.status(500).json({
      success: false,
      error: "Internal error during identify",
    });
  }
});

export default router;
