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
// CF-PLAYER-TREND (Drew, 2026-07-17): read stored matched-cohort trends;
// fall through to on-demand compute when the nightly job hasn't run for
// this player yet.
import { readPlayerTrend } from "../services/portfolioiq/playerTrendStore.service.js";
import { computePlayerTrend } from "../services/portfolioiq/playerTrendCompute.service.js";
import type { PlayerSale } from "../types/playerTrend.types.js";
import { CosmosClient } from "@azure/cosmos";
// CF-GRADER-OUTCOMES (Drew, 2026-07-17): serve observed grade-outcome
// distributions per (family, grader). Feeds probability-weighted
// grade-worthy EV.
import {
  readFamilyOutcomes,
  readOutcome,
} from "../services/portfolioiq/graderOutcomeStore.service.js";
import { slugFamily as slugOutcomeFamily } from "../services/portfolioiq/graderOutcomeCompute.service.js";

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
// CF-GRADING-TIER-CATALOG (2026-07-06, Drew): server-hosted PSA/BGS/
// SGC/CGC grading service tiers + costs. iOS reads this to populate
// the "Mark as Graded" tier dropdown; user picks a tier and iOS pre-
// fills gradingCost. Also accepted on /regrade + /regrade-batch as
// gradingTierId — server resolves cost from the catalog when the
// caller sends the id instead of the raw dollar amount.
router.get("/grading-tiers", portfolio.getGradingTiers);

// CF-PLAYER-TREND (Drew, 2026-07-17): serves matched-cohort player
// momentum + velocity. Read-through: nightly-computed trend from
// player_trends container wins; if stale (>36h) or absent, computes
// on-demand from ch_daily_sales.
//
// Session required (same rate-limit + user context as other portfolio
// routes). No entitlement gate — this is a base-tier metric.
router.get(
  "/player-trend/:player",
  requireRateLimited("priceChecksPerDay"),
  async (req, res, next) => {
    try {
      const player = String(req.params.player ?? "").trim();
      if (!player) {
        return res.status(400).json({ error: "player path parameter required" });
      }

      const stored = await readPlayerTrend(player);
      const STALE_MS = 36 * 60 * 60 * 1000;
      const isFresh =
        stored && stored.computedAt &&
        Date.now() - Date.parse(stored.computedAt) < STALE_MS;

      if (isFresh) {
        return res.json({ ...stored, servedFrom: "nightly_cache" });
      }

      // On-demand fallback — query ch_daily_sales for this player's
      // recent sales and compute the trend.
      const cs = process.env.COSMOS_CONNECTION_STRING;
      if (!cs) {
        return res.status(503).json({
          error: "player-trend on-demand compute unavailable (no COSMOS_CONNECTION_STRING)",
        });
      }
      const client = new CosmosClient(cs);
      const container = client
        .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
        .container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");

      // Recent + prior window = 60d. Match the nightly's defaults.
      const cutoffIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const iter = container.items.query({
        query: `SELECT c.card_id, c.sale_date, c.price, c.year, c.card_set, c.variant, c.number
                FROM c WHERE c.player = @p AND c.sale_date >= @cutoff`,
        parameters: [
          { name: "@p", value: player },
          { name: "@cutoff", value: cutoffIso },
        ],
      }, { maxItemCount: 1000 });

      const rows: Array<Record<string, unknown>> = [];
      while (iter.hasMoreResults()) {
        const page = await iter.fetchNext();
        if (page.resources) rows.push(...(page.resources as Array<Record<string, unknown>>));
      }
      const sales: PlayerSale[] = rows
        .filter((r) => Number(r.price) > 0)
        .map((r) => ({
          cardId: String(r.card_id),
          saleDate: String(r.sale_date),
          price: Number(r.price),
          skuLabel: `${r.year ?? ""} ${r.card_set ?? ""} · ${r.variant ?? ""} · ${r.number ?? ""}`.trim(),
        }));

      const trend = computePlayerTrend(player, sales);
      return res.json({ ...trend, servedFrom: "on_demand" });
    } catch (err) {
      next(err);
    }
  },
);

router.get("/holdings", portfolio.getHoldings);

// CF-GRADER-OUTCOMES (Drew, 2026-07-17): observed distribution of
// PSA/BGS/SGC/CGC tier outcomes for a family. Diagnostic (informs
// probability-weighted grade-worthy EV) — NOT a P(grade | submit)
// prediction. Includes an interpretation caveat in the response.
router.get(
  "/grader-outcomes/:family",
  requireRateLimited("priceChecksPerDay"),
  async (req, res, next) => {
    try {
      const familyKey = slugOutcomeFamily(String(req.params.family ?? "").trim());
      if (!familyKey) return res.status(400).json({ error: "family required" });
      const rows = await readFamilyOutcomes(familyKey);
      res.json({
        familyKey,
        graders: rows.map((r) => ({
          grader: r.grader,
          tierShares: r.tierShares,
          tierCounts: r.tierCounts,
          totalGradedSamples: r.totalGradedSamples,
          confidence: r.confidence,
          computedAt: r.computedAt,
        })),
        caveat: "Distribution reflects OUTCOMES observed on the sales market. Not P(tier | you submit).",
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/grader-outcomes/:family/:grader",
  requireRateLimited("priceChecksPerDay"),
  async (req, res, next) => {
    try {
      const familyKey = slugOutcomeFamily(String(req.params.family ?? "").trim());
      const grader = String(req.params.grader ?? "").trim();
      if (!familyKey || !grader) return res.status(400).json({ error: "family + grader required" });
      const row = await readOutcome(familyKey, grader);
      if (!row) return res.status(404).json({ error: "no outcome distribution for that (family, grader)" });
      res.json({
        ...row,
        caveat: "Distribution reflects OUTCOMES observed on the sales market. Not P(tier | you submit).",
      });
    } catch (err) {
      next(err);
    }
  },
);

// CF-VERDICT-FLIP-PUSH-PREFS-ROUTE (Drew, 2026-07-16, PR #500 follow-up):
// per-user notification opt-in + APNs device-token registration surface.
// iOS calls PATCH at app launch (device token) and from Settings (opt-in
// toggle). GET returns the current state without the raw device token
// value (masked to just presence) — no need to round-trip the token to
// the client after registration.
router.get("/preferences", async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: "no session userId" });
      return;
    }
    const doc = await readUserDoc(userId);
    res.json({
      success: true,
      preferences: {
        pushOnMajorFlip: doc.preferences?.pushOnMajorFlip === true,
      },
      apnsDevice: {
        registered: typeof doc.apnsDeviceToken === "string" && doc.apnsDeviceToken.length > 0,
        registeredAt: doc.apnsDeviceTokenUpdatedAt ?? null,
      },
    });
  } catch (err) { next(err); }
});

router.patch("/preferences", async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: "no session userId" });
      return;
    }
    const body = (req.body ?? {}) as {
      pushOnMajorFlip?: unknown;
      apnsDeviceToken?: unknown;
    };

    // Nothing to write is a 400 — otherwise a malformed body silently
    // no-ops and iOS thinks the write landed.
    const patchesPush = Object.prototype.hasOwnProperty.call(body, "pushOnMajorFlip");
    const patchesToken = Object.prototype.hasOwnProperty.call(body, "apnsDeviceToken");
    if (!patchesPush && !patchesToken) {
      res.status(400).json({
        success: false,
        error: "body must include at least one of pushOnMajorFlip, apnsDeviceToken",
      });
      return;
    }

    const input: { pushOnMajorFlip?: boolean; apnsDeviceToken?: string | null } = {};

    if (patchesPush) {
      if (typeof body.pushOnMajorFlip !== "boolean") {
        res.status(400).json({ success: false, error: "pushOnMajorFlip must be boolean" });
        return;
      }
      input.pushOnMajorFlip = body.pushOnMajorFlip;
    }

    if (patchesToken) {
      // APNs tokens are hex strings 64-200 chars; null explicitly clears
      // the registration (iOS logs out or revokes permission).
      const raw = body.apnsDeviceToken;
      if (raw === null) {
        input.apnsDeviceToken = null;
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          input.apnsDeviceToken = null;
        } else if (trimmed.length < 32 || trimmed.length > 256 || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
          res.status(400).json({
            success: false,
            error: "apnsDeviceToken must be 32-256 chars, alphanumeric + . _ -",
          });
          return;
        } else {
          input.apnsDeviceToken = trimmed;
        }
      } else {
        res.status(400).json({ success: false, error: "apnsDeviceToken must be string or null" });
        return;
      }
    }

    await portfolio.setUserPushPreference(userId, input);

    // Echo the effective state so iOS can update its cached copy
    // without a follow-up GET.
    const doc = await readUserDoc(userId);
    res.json({
      success: true,
      preferences: {
        pushOnMajorFlip: doc.preferences?.pushOnMajorFlip === true,
      },
      apnsDevice: {
        registered: typeof doc.apnsDeviceToken === "string" && doc.apnsDeviceToken.length > 0,
        registeredAt: doc.apnsDeviceTokenUpdatedAt ?? null,
      },
    });
  } catch (err) { next(err); }
});

// CF-SIGNAL-WEIGHTED-TOTALS (Drew, 2026-07-13, PR #430): three portfolio
// valuations side-by-side (gross MV / trend-adjusted / fees-adjusted) +
// breakdown by verdict class (bull / static / bear).
router.get("/signal-weighted-totals", async (req, res, next) => {
  try {
    const userId = (req as any).session?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: "no session userId" });
      return;
    }
    const { buildSignalWeightedTotals } = await import(
      "../services/portfolioiq/signalWeightedTotals.service.js"
    );
    const result = await buildSignalWeightedTotals(userId);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// CF-WATCHLIST-BULL-CANDIDATES (Drew, 2026-07-13, PR #429): surface
// watchlisted players whose supply signal is bullish so users see a
// "buy candidates" list right in the app.
router.get("/watchlist-bull-candidates", async (req, res, next) => {
  try {
    const userId = (req as any).session?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: "no session userId" });
      return;
    }
    const { buildWatchlistBullCandidates } = await import(
      "../services/portfolioiq/watchlistBullCandidates.service.js"
    );
    const result = await buildWatchlistBullCandidates(userId);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// CF-PORTFOLIO-SUPPLY-DEMAND-SUMMARY (Drew, 2026-07-13, PR #426):
// aggregate the supply/demand signal across every holding for the
// authed user. Returns portfolio-level bias + breakdown + top movers +
// full per-holding list. iOS renders as a dashboard on Portfolio Home.
router.get("/supply-demand-summary", async (req, res, next) => {
  try {
    const userId = (req as any).session?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: "no session userId" });
      return;
    }
    const { buildPortfolioSupplyDemandSummary } = await import(
      "../services/portfolioiq/supplyDemandSummary.service.js"
    );
    const summary = await buildPortfolioSupplyDemandSummary(userId);
    res.json({ success: true, ...summary });
  } catch (err) {
    next(err);
  }
});

// CF-EBAY-REVIEW-QUEUE (2026-07-12): pending eBay auto-created holdings
// awaiting user confirmation. iOS renders this as the review queue.
router.get("/holdings/pending-review", portfolio.getPendingReviewHoldings);

// CF-CARDID-SUGGESTER (2026-07-12, moved off ERP router 2026-07-14):
// batch-generate cardId suggestions for the caller's pending-review
// holdings. Session-only — matches dry-run-suggest below. Verify-before-
// price is fundamental UX, not a Pro-only feature; free/collector/
// investor tiers all need it. Was on the ERP router (Pro Seller only)
// which locked out most users from the review-queue workflow.
router.post("/holdings/generate-suggestions", async (req, res, next) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: "session required" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const force = body.force === true;
    const { generateCardIdSuggestions } = await import(
      "../services/portfolioiq/cardIdSuggester.service.js"
    );
    const summary = await generateCardIdSuggestions(userId, { force });
    res.json({ success: true, ...summary });
  } catch (err: any) {
    console.error("[portfolio] /holdings/generate-suggestions failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: err?.message ?? "Suggestion generation failed" });
  }
});

// CF-EDIT-SHEET-DRY-RUN-SUGGEST (Drew, 2026-07-14): stateless suggester
// run for the iOS "verify card" edit sheet. Takes edited holding fields
// in the request body (NOT from Cosmos), runs the multi-vendor
// suggester against them, returns { suggestion, normalized }. Persists
// nothing.
//
// iOS fires this on every "Search again" tap as the user edits fields
// — each call returns a fresh suggestion so pre-fill updates in real
// time. When the user hits Confirm, the existing
// /api/portfolio/erp/holdings/:id/confirm endpoint commits the chosen
// cardId + edits.
//
// Session-only (no entitlement gate): verify-before-price is the
// fundamental purchase-import UX, not a premium feature. Server-side
// cost matches one batch cell (~600ms end-to-end for both vendors).
router.post("/holdings/dry-run-suggest", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const holdingLike = {
      id: "dry-run",
      playerName: typeof body.playerName === "string" ? body.playerName : null,
      cardYear: typeof body.cardYear === "number" ? body.cardYear : null,
      setName: typeof body.setName === "string" ? body.setName : null,
      parallel: typeof body.parallel === "string" ? body.parallel : null,
      cardNumber: typeof body.cardNumber === "string" ? body.cardNumber : null,
      isAuto: typeof body.isAuto === "boolean" ? body.isAuto : null,
      isRookie: typeof body.isRookie === "boolean" ? body.isRookie : undefined,
    } as any;

    if (!holdingLike.playerName || holdingLike.playerName.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "playerName is required for suggestion",
        suggestion: null,
      });
    }

    const { suggestCardIdForHolding } = await import(
      "../services/portfolioiq/cardIdSuggester.service.js"
    );
    const { normalizeHoldingFields } = await import(
      "../services/portfolioiq/holdingFieldNormalizer.service.js"
    );

    // Return normalized fields so iOS can show the user WHY a field
    // was auto-cleaned (year-doubling stripped, subset word removed,
    // etc.) — transparency for the edit sheet.
    const normalized = normalizeHoldingFields({
      playerName: holdingLike.playerName,
      cardYear: holdingLike.cardYear,
      setName: holdingLike.setName,
      parallel: holdingLike.parallel,
      cardNumber: holdingLike.cardNumber,
      isAuto: holdingLike.isAuto,
    });

    const suggestion = await suggestCardIdForHolding(holdingLike);
    res.json({
      success: true,
      suggestion,
      normalized: {
        fields: normalized.fields,
        changes: normalized.changes,
      },
    });
  } catch (err: any) {
    console.error("[portfolio] /holdings/dry-run-suggest failed:", err?.message ?? err);
    res.status(500).json({
      success: false,
      error: err?.message ?? "Dry-run suggestion failed",
      suggestion: null,
    });
  }
});

// CF-EBAY-SOLD-COMPS-QUERY (2026-07-12): market intelligence from our own
// sold pool. Query by year/set/parallel/grade/player/cardNumber/isAuto/
// cardId; returns matches ranked by aspect density + recency + aggregate
// stats (min/max/median/mean). iOS renders on card detail as "recent
// comps."
router.get("/sold-comps", async (req, res, next) => {
  try {
    const { querySoldComps } = await import(
      "../services/portfolioiq/ebaySoldComps.service.js"
    );
    const q = req.query as Record<string, string | undefined>;
    const parsedYear = q.year ? parseInt(q.year, 10) : undefined;
    const parsedLimit = q.limit ? parseInt(q.limit, 10) : undefined;
    const parsedIsAuto =
      q.isAuto === "true" ? true : q.isAuto === "false" ? false : undefined;
    const result = await querySoldComps({
      year: Number.isFinite(parsedYear) ? parsedYear : undefined,
      set: q.set,
      parallel: q.parallel,
      grade: q.grade,
      playerName: q.playerName,
      cardNumber: q.cardNumber,
      isAuto: parsedIsAuto,
      cardId: q.cardId,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    next(err);
  }
});

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

// CF-USER-COMPS-SOFT-DELETE (Drew, 2026-07-15): flag a comp in the
// shared sold_comps pool as wrong. Engine skips flagged comps during
// FMV aggregation but preserves the provenance record for audit.
// Body: { cardId: string, compId: string, reason?: string }
// Auth: session-required (already enforced by router.use above). Trust
// boundary — future enhancement: check that the flagger is either the
// contributor OR has a reputation score above threshold OR is ops.
router.post("/comps/flag-wrong", async (req, res, next) => {
  try {
    const { cardId, compId, reason } = req.body ?? {};
    if (typeof cardId !== "string" || !cardId.trim()) {
      return res.status(400).json({ success: false, error: "cardId required" });
    }
    if (typeof compId !== "string" || !compId.trim()) {
      return res.status(400).json({ success: false, error: "compId required" });
    }
    const flaggedByUserId = (req as any).userId ?? "";
    if (!flaggedByUserId) {
      return res.status(401).json({ success: false, error: "session required" });
    }
    const { flagCompAsWrong, readCompsByCardId } = await import(
      "../services/portfolioiq/soldCompsStore.service.js"
    );
    // Look up the contributor BEFORE flagging so we can bump their
    // reputation counter — the read is partition-hit (cheap).
    let contributorUserId: string | null = null;
    try {
      const rows = await readCompsByCardId({ cardId: cardId.trim() });
      const target = rows.find((r) => r.id === compId.trim());
      contributorUserId = target?.contributorUserId ?? null;
    } catch {
      // non-fatal — flag can still proceed without contributor lookup
    }
    const result = await flagCompAsWrong({
      cardId: cardId.trim(),
      compId: compId.trim(),
      flaggedByUserId,
      reason: typeof reason === "string" ? reason : undefined,
    });
    // CF-USER-REPUTATION (Drew, 2026-07-15): only bump on successful
    // flags to avoid rewarding failed API calls. Fire-and-forget.
    if (result.status === "flagged") {
      void (async () => {
        try {
          const { bumpUserStats } = await import(
            "../services/portfolioiq/userReputation.service.js"
          );
          await bumpUserStats({ userId: flaggedByUserId, flagsIssued: 1 });
          if (contributorUserId && contributorUserId !== flaggedByUserId) {
            await bumpUserStats({ userId: contributorUserId, flagsAgainst: 1 });
          }
        } catch {
          // swallow — reputation update is auxiliary
        }
      })();
    }
    const status =
      result.status === "flagged" ? 200 :
      result.status === "not-found" ? 404 :
      result.status === "no-store" ? 503 : 500;
    return res.status(status).json({ success: result.status === "flagged", ...result });
  } catch (err) { next(err); }
});
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

// CF-HELD-EXPENSES (2026-07-12): expenses incurred WHILE holding a card
// (grading, supplies, storage). Each write rolls into totalCostBasis so
// realized-P&L math on the eventual sale reflects true all-in cost. Same
// integer-math pattern as the existing regrade flow.
router.get("/holdings/:id/expenses", portfolio.listHeldExpensesHandler);
router.post("/holdings/:id/expenses", portfolio.addHeldExpenseHandler);
router.delete("/holdings/:id/expenses/:expenseId", portfolio.deleteHeldExpenseHandler);

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
