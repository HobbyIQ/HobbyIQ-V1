import { Router } from "express";
import * as portfolio from "../services/portfolioiq/portfolioStore.service.js";
import { getConnectionStatus } from "../services/ebay/ebayAuth.service.js";
import { buildListingPreview, createListing, HoldingListingInput } from "../services/ebay/ebayListing.service.js";
import { requireSession } from "../middleware/requireSession.js";
import { requireEntitlement } from "../middleware/requireEntitlement.js";
import { requireCapacity } from "../middleware/requireCapacity.js";
import { requireRateLimited } from "../middleware/requireRateLimited.js";
// CF-PHASE-5-COLLECTION-VALUE (2026-06-17): /value-history route handler.
import {
  readValueHistory,
  computeChange30d,
  computeTopHoldings,
  computeSnapshotFromHoldings,
} from "../services/portfolioiq/portfolioValueHistory.service.js";
import { readUserDoc } from "../services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../types/portfolioiq.types.js";
// CF-EXPORT-BE (2026-06-21): holdings export → .xlsx/.csv. Ships the
// canonical 28-column schema CF-IMPORT-BE will consume as round-trip
// contract. See exportHoldings.service.ts for the column lock.
import { buildHoldingsExport, type ExportFormat } from "../services/portfolioiq/exportHoldings.service.js";
import { composePortfolioListResponse } from "../services/portfolioiq/responseAssembly.js";
// CF-IMPORT-BE (2026-06-21): preview + commit endpoints. File arrives as
// base64-encoded body (multipart not configured); preview is read-only,
// commit is idempotency-token-gated. See importService.ts.
// CF-IMPORT-VOLUME (2026-06-21): commit now passes the user's effective
// plan so capacity is re-enforced server-side, independent of the
// client-honored preview wouldExceed flag.
import {
  buildPreview,
  commitImport,
  readImportJobStatus,
  type CommitRequest,
} from "../services/portfolioiq/import/importService.js";
import type { FileFormat } from "../services/portfolioiq/import/fileParser.js";
import { effectivePlanFor } from "../config/entitlements.js";

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
// CF-PORTFOLIO-OPPORTUNITIES (2026-07-06, Drew): pull-side surface for
// action recommendations. Filters user's holdings by verdict, sorts
// each group by urgency + expected-delta magnitude, returns three
// tabs iOS can render as the "what should I do TODAY" screen.
router.get("/opportunities", portfolio.getPortfolioOpportunities);

router.get("/holdings", portfolio.getHoldings);

// CF-EXPORT-BE (2026-06-21): GET /api/portfolio/export?format=xlsx|csv
//   - format defaults to xlsx; "csv" supported (RFC-4180-ish).
//   - Reads holdings via the same composePortfolioListResponse wire path
//     getHoldings uses, so exported computed values match what the iOS
//     dashboard displays.
//   - Returns as attachment (Content-Disposition) — caller (iOS share
//     sheet, browser download) handles the file from the response.
router.get("/export", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const formatRaw = typeof req.query.format === "string" ? req.query.format.toLowerCase() : "xlsx";
    const format: ExportFormat = formatRaw === "csv" ? "csv" : "xlsx";

    const doc = await readUserDoc(userId);
    const items: PortfolioHolding[] = Object.values(doc.holdings ?? {});
    const wire = composePortfolioListResponse(items);
    const payload = buildHoldingsExport(wire, format);

    res.setHeader("Content-Type", payload.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
    res.setHeader("X-Holdings-Count", String(wire.length));
    res.send(payload.buffer);
  } catch (err) {
    next(err);
  }
});

// CF-IMPORT-BE (2026-06-21):
//   POST /api/portfolio/import/preview — read-only; parse + resolve + bucket.
//   POST /api/portfolio/import/commit  — write; idempotency-token-gated.
//
// File is base64-encoded in the body (multipart not configured; see
// app.ts:47 — 12mb json limit covers ~9MB raw file).
router.post("/import/preview", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const userTier = (req.user as { tier?: string } | undefined)?.tier ?? "free";
    const body = req.body as { file?: string; format?: string } | undefined;
    if (!body?.file || typeof body.file !== "string") {
      return res.status(400).json({ error: "Missing 'file' field (base64-encoded xlsx or csv body)" });
    }
    const formatRaw = String(body.format ?? "xlsx").toLowerCase();
    const format: FileFormat = formatRaw === "csv" ? "csv" : "xlsx";
    let fileBuffer: Buffer | string;
    if (format === "csv") {
      // Allow either base64 or plain text on CSV
      try {
        fileBuffer = Buffer.from(body.file, "base64").toString("utf8");
      } catch {
        fileBuffer = body.file;
      }
    } else {
      fileBuffer = Buffer.from(body.file, "base64");
    }

    const result = await buildPreview(userId, fileBuffer, format, userTier);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// CF-IMPORT-ASYNC (2026-06-21): status poll for jobs the preview kicked
// asynchronously (>40-row imports). Status semantics:
//   pending     — job created, not yet started
//   processing  — resolving in flight; progress.rowsProcessed advances
//   ready       — envelopes available; client proceeds to commit
//   failed      — resolver errored; errorMessage carries the reason
//   stale       — no progress within 10min; instance likely recycled,
//                 retry the import
router.get("/import/jobs/:jobId", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const jobId = String(req.params.jobId ?? "").trim();
    if (!jobId) return res.status(400).json({ error: "Missing jobId" });
    const job = await readImportJobStatus(userId, jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ ok: true, ...job });
  } catch (err) {
    next(err);
  }
});

router.post("/import/commit", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const body = req.body as Partial<CommitRequest> | undefined;
    if (!body?.idempotencyToken || typeof body.idempotencyToken !== "string") {
      return res.status(400).json({ error: "Missing 'idempotencyToken'" });
    }
    if (!Array.isArray(body.envelopes)) {
      return res.status(400).json({ error: "Missing 'envelopes' array" });
    }
    const request: CommitRequest = {
      idempotencyToken: body.idempotencyToken,
      envelopes: body.envelopes,
      actions: body.actions,
    };
    const userPlan = effectivePlanFor(req.user!);
    const result = await commitImport(userId, request, userPlan);
    // 402 on capacity-rejected batches; everything else 200.
    if (result.capacityExceeded) {
      return res.status(402).json({ ok: false, error: "capacity_exceeded", ...result });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
router.get("/alerts", portfolio.getAlerts);
router.get("/health/score", portfolio.getPortfolioHealth);
// CF-PAYMENTS-A: analytics + insights are prediction-class features
// (collector+ per the matrix). 402 to free users.
router.get("/analytics/calibration", requireEntitlement("predictions"), portfolio.getCalibration);
router.get("/insights/weekly-brief", requireEntitlement("predictions"), portfolio.getWeeklyBrief);
router.post("/feedback/recommendation", portfolio.addRecommendationFeedback);
router.get("/ledger", portfolio.getLedger);
router.patch("/ledger/:id", portfolio.updateLedgerEntry);

// CF-PHASE-5-COLLECTION-VALUE (2026-06-17): collection-value card data.
// Level + range + HISTORICAL change only. No forecast/direction/momentum
// fields anywhere. Pure read; no rate limit.
router.get("/value-history", async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const [history, doc] = await Promise.all([
      readValueHistory(userId),
      readUserDoc(userId),
    ]);

    const items = Object.values(doc.holdings ?? {}) as PortfolioHolding[];
    const live = computeSnapshotFromHoldings(items);
    const topHoldings = computeTopHoldings(items, 5);

    // Headline is computed from the LIVE user doc so the iOS card always
    // matches the per-row prices iOS just rendered. The history series is the
    // persisted daily trail (point-per-day on displayableTotal).
    const change30d = computeChange30d(history);

    const historySeries = history.map((h) => ({
      date: h.date,
      total: h.displayableTotal,
    }));

    res.json({
      success: true,
      asOf: new Date().toISOString(),
      totalDisplayable: live.displayableTotal,
      rangeLow: live.rangeLow,
      rangeHigh: live.rangeHigh,
      observedValue: live.observedValue,
      estimatedValue: live.estimatedValue,
      observedCount: live.observedCount,
      estimatedCount: live.estimatedCount,
      pendingCount: live.pendingCount,
      totalCards: live.holdingCount,
      change30d,
      historySeries,
      topHoldings,
      framing: {
        isEstimate: true,
        note:
          "Range reflects comp-sufficiency. Observed holdings are point estimates within the band; estimated holdings carry the width.",
      },
    });
  } catch (err) {
    next(err);
  }
});

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
// CF-REGRADE-COST-ROLLIN (2026-07-06, iOS ask): atomic grade
// conversion — updates gradeCompany/gradeValue/certNumber and rolls
// grading cost into totalCostBasis in one commit. iOS "Mark as
// Graded" flow POSTs here after the user finishes the sheet.
router.post("/holdings/:id/regrade", portfolio.regradeHolding);
// CF-REGRADE-BATCH (2026-07-06): companion to single-holding /regrade.
// PSA bag-of-slabs use case — user gets 30 slabs back and marks them
// all in one request instead of 30 round trips.
router.post("/holdings/regrade-batch", portfolio.regradeHoldingsBatch);
// CF-PAYMENTS-B1: per-holding price refresh is a user-initiated FMV check
// (consumes 1 priceChecksPerDay slot; free=5/day, paid tiers unlimited).
router.post("/holdings/:id/refresh", requireRateLimited("priceChecksPerDay"), portfolio.refreshHolding);

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

export default router;
