import { Router } from "express";
import * as portfolio from "../services/portfolioiq/portfolioStore.service.js";
import { getConnectionStatus } from "../services/ebay/ebayAuth.service.js";
import { buildListingPreview, createListing, HoldingListingInput } from "../services/ebay/ebayListing.service.js";
import {
  identifyCardByBlobUrl,
  identifyCardWithCertExtraction,
  IdentifyBlobDownloadError,
  CardsightApiError,
  CardsightTimeoutError,
  CardsightValidationError,
} from "../services/cardsight/identify.service.js";
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";
import { requireCapacity } from "../middleware/requireCapacity.js";

const router = Router();

// /health is the only public route in this router. Declare it BEFORE the
// blanket router.use(requireSession) so it remains reachable without auth.
router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "PortfolioIQ", timestamp: new Date().toISOString() });
});

// CF-PAYMENTS-A: every other route below requires a valid session. The
// downstream portfolio.* handlers read req.user via the in-service
// requireUser() helper (now prefers req.user; falls back to header path
// for legacy compatibility — see portfolioStore.service.ts).
router.use(requireSession);

// GET /api/portfolio — combined holdings + summary for the iOS dashboard.
router.get("/", portfolio.getPortfolioWithSummary);

router.get("/holdings", portfolio.getHoldings);
router.get("/alerts", portfolio.getAlerts);
router.get("/health/score", portfolio.getPortfolioHealth);
// CF-PAYMENTS-A: analytics + insights are prediction-class features
// (collector+ per the matrix). 402 to free users.
router.get("/analytics/calibration", requireEntitlement("predictions"), portfolio.getCalibration);
router.get("/insights/weekly-brief", requireEntitlement("predictions"), portfolio.getWeeklyBrief);
router.post("/feedback/recommendation", portfolio.addRecommendationFeedback);
router.get("/ledger", portfolio.getLedger);
router.patch("/ledger/:id", portfolio.updateLedgerEntry);

// CF-PAYMENTS-A: POST /holdings is the cap-counted write. requireCapacity
// reads the current holding count and 402s if creating one more would
// exceed the plan's holdingsCap. Free=25, collector=250, investor+
// unlimited.
router.post(
  "/holdings",
  requireCapacity("holdingsCap", portfolio.countHoldingsForUser),
  portfolio.addHolding,
);
router.get("/holdings/:id", portfolio.getHoldingById);
router.get("/holdings/:id/history", portfolio.getHoldingPriceHistory);
router.put("/holdings/:id", portfolio.updateHolding);
router.patch("/holdings/:id", portfolio.updateHolding);
router.delete("/holdings/:id", portfolio.deleteHolding);
router.post("/holdings/:id/sell", portfolio.sellHolding);
router.post("/holdings/:id/refresh", portfolio.refreshHolding);

// CF-PAYMENTS-A: per-holding eBay surfaces — investor+ via ebayIntegration.
router.post(
  "/holdings/:id/ebay/draft",
  requireEntitlement("ebayIntegration"),
  async (req, res) => {
    const userId = req.user!.userId;

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
  },
);
router.post(
  "/holdings/:id/ebay/listing",
  requireEntitlement("ebayIntegration"),
  async (req, res) => {
    const userId = req.user!.userId;

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
  },
);

// CF-PAYMENTS-A: batch reprice is a prediction-class operation (collector+).
router.post("/reprice/batch", requireEntitlement("predictions"), portfolio.runBatchReprice);

// CF-CARDSIGHT-IDENTIFY-INTEGRATION: POST /api/portfolio/identify
//
// CF-PAYMENTS-A note: scansPerMonth cap is NOT enforced here yet — that's a
// time-windowed counter deferred to Phase B (see HALT usage-counter
// proposal). Phase A only attaches requireSession; the per-scan cap will
// land via requireCapacity("scansPerMonth", countScansThisMonthForUser)
// once the storage model is approved.
router.post("/identify", async (req, res) => {
  const userId = req.user!.userId;

  const body = (req.body ?? {}) as {
    blobUrl?: unknown;
    blobName?: unknown;
    extractCert?: unknown;
  };
  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl.trim() : "";
  const blobName = typeof body.blobName === "string" ? body.blobName.trim() : undefined;
  if (!blobUrl) {
    res.status(400).json({ success: false, error: "blobUrl is required" });
    return;
  }

  // CF-GRADED-SCAN-B1+B2 (2026-06-02): opt-in cert-number OCR extraction.
  const extractCert =
    body.extractCert === true ||
    String(req.query.withCertExtraction ?? "").toLowerCase() === "true";

  // Touch userId to keep the binding load-bearing for future scan-counter
  // wiring (Phase B) without changing the response shape today.
  void userId;

  try {
    if (extractCert) {
      const wrapped = await identifyCardWithCertExtraction(blobUrl, blobName);
      res.status(200).json(wrapped);
      return;
    }
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
    console.error("[portfolioiq.identify] unexpected error:", err);
    res.status(500).json({
      success: false,
      error: "Internal error during identify",
    });
  }
});

export default router;
