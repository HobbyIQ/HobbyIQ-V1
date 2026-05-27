import { Router } from "express";
import * as portfolio from "../services/portfolioiq/portfolioStore.service.js";
import { getUserBySession } from "../services/authService.js";
import { getConnectionStatus } from "../services/ebay/ebayAuth.service.js";
import { buildListingPreview, createListing, HoldingListingInput } from "../services/ebay/ebayListing.service.js";
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

export default router;
