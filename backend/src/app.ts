import express from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import { getConfig } from "./config/env.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import healthRoutes from "./routes/health.routes.js";
import ingestHealthRoutes from "./routes/ingestHealth.routes.js";
import dataQualityHealthRoutes from "./routes/dataQualityHealth.routes.js";
import publicStatsRoutes from "./routes/publicStats.routes.js";
import publicSellerRoutes from "./routes/publicSeller.routes.js";
import marketplaceRoutes from "./routes/marketplace.routes.js";
import stripeRoutes from "./routes/stripe.routes.js";
import dailyPublishRoutes from "./routes/dailyPublish.routes.js";
import compiqRoutes from "./routes/compiq.routes.js";
import portfolioiqRoutes from "./routes/portfolioiq.routes.js";
import portfolioErpRoutes from "./routes/portfolioiq.erp.routes.js";
import buyeriqRoutes from "./routes/buyeriq.routes.js";
// CF-SELL-NOW-RADAR + CF-NOTABLE-SALES-FEED (Drew, 2026-07-17): two
// seller-intelligence surfaces on the ch_daily_sales corpus. Kept in a
// separate router file so PR #533 (parallel work on portfolioiq.routes)
// merges without conflict.
import sellRadarNotableSalesRoutes from "./routes/sellRadarNotableSales.routes.js";
import dailyiqRoutes from "./routes/dailyiq.routes.js";
import dailyiqActionPlanRoutes from "./routes/dailyiqActionPlan.routes.js";
import backtestRoutes from "./routes/backtest.routes.js";
import bulkSellComposerRoutes from "./routes/bulkSellComposer.routes.js";
import tradeTargetsRoutes from "./routes/tradeTargets.routes.js";
import communityRoutes from "./routes/community.routes.js";
import catalogAdditionsRoutes from "./routes/catalogAdditions.routes.js";
import ebayImportRematchRoutes from "./routes/ebayImportRematch.routes.js";
import canonicalFmvRoutes from "./routes/canonicalFmv.routes.js";
import listingRangeRoutes from "./routes/listingRange.routes.js";
import recentSalesRoutes from "./routes/recentSales.routes.js";
import marketMoversRoutes from "./routes/marketMovers.routes.js";
import marketIndexesRoutes from "./routes/marketIndexes.routes.js";
import playerDetailRoutes from "./routes/playerDetail.routes.js";
import prospectsBreakingOutRoutes from "./routes/prospectsBreakingOut.routes.js";
import cohortBacktestRoutes from "./routes/cohortBacktest.routes.js";
import weeklyHobbyIndexRoutes from "./routes/weeklyHobbyIndex.routes.js";
import setDetailRoutes from "./routes/setDetail.routes.js";
import priceSeriesRoutes from "./routes/priceSeries.routes.js";
import opsPoolHealthRoutes from "./routes/opsPoolHealth.routes.js";
import playeriqRoutes from "./routes/playeriq.routes.js";
import authRoutes from "./routes/auth.routes.js";
import waitlistRoutes from "./routes/waitlist.routes.js";
import onboardingRoutes from "./routes/onboarding.routes.js";
import messagingRoutes from "./routes/messaging.routes.js";
import ebayRoutes from "./routes/ebay.routes.js";
import ebayWebhookRoutes from "./routes/ebayWebhook.routes.js";
import tcaWebhookRoutes from "./routes/tcaWebhook.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import ocrRoutes from "./routes/ocr.routes.js";
import psaRoutes from "./routes/psa.routes.js";
// CF-WATCHLIST-UNIFY (2026-06-02): /api/watchlist (basic system) retired.
// /api/dailyiq/watchlist is the canonical system; mount preserved below.
// Requests to /api/watchlist will 404 (handled by the catch-all notFound
// middleware). iOS rewire from /api/watchlist -> /api/dailyiq/watchlist
// is blocking after this CF deploys.
import devicesRoutes from "./routes/devices.routes.js";
import alertsRoutes from "./routes/alerts.routes.js";
import alertsAdvancedRoutes from "./routes/alerts.advanced.routes.js";
import alertsHoldingMovesRoutes from "./routes/alerts.holdingMoves.routes.js";
import accountRoutes from "./routes/account.routes.js";
import opsRoutes from "./routes/ops.routes.js";
import searchRoutes from "./routes/search.routes.js";
import catalogSearchRoutes from "./routes/catalogSearch.routes.js";
// CF-CATALOG-FIRST (Drew, 2026-08-04): baseballcardpedia-derived
// product-structure served to iOS + web. GET /product-structure/:key
// direct read; GET /product-structure?year&setKey fallback query;
// GET /product-structure/list?year&brand enumeration.
import productStructureRoutes from "./routes/productStructure.routes.js";
// CF-SEARCH-ADMIN-ROUTES (2026-07-08, Drew): admin surface for the
// Cosmos-backed alias store — add/correct/reload aliases without a
// code deploy. Gated by ADMIN_API_TOKEN via requireAdmin middleware.
import searchAdminRoutes from "./routes/searchAdmin.routes.js";
import verifyQueueRoutes from "./routes/verifyQueue.routes.js";
// CF-CATALOG-FIRST (Drew, 2026-08-04): price-anomaly verification queue —
// list flagged comps, reassign to a different catalog slug, or confirm as
// real. Complements the alias-verify queue above.
import verifyCompsRoutes from "./routes/verifyComps.routes.js";
// CF-LABELER-ROUTES (2026-07-31, Drew): human-in-the-loop variant
// labeling admin surface. Shows CH catalog variants + images, Drew
// inputs canonical parallel, sold_comps rewritten by title-suffix.
import labelerRoutes from "./routes/labeler.routes.js";
// CF-CLEANLINESS-ROUTES (2026-08-01, Drew): pool cleanliness rollup
// dashboard. The number Drew calls when someone asks "how clean is
// the data?".
import cleanlinessRoutes from "./routes/cleanliness.routes.js";
// CF-FLAG-COMP-ROUTES (2026-08-01, Drew): user "this looks wrong"
// button — flags a sold_comp row into verify_queue for admin review.
// After N distinct users flag the same row, auto-quarantine kicks in.
import flagCompRoutes from "./routes/flagComp.routes.js";
// CF-QUARANTINE-ROUTES (2026-08-01, Drew): admin browser + resolver
// for all flagged (contaminated) sold_comp rows.
import quarantineRoutes from "./routes/quarantine.routes.js";
import catalogReviewRoutes from "./routes/catalogReview.routes.js";
import stagingPipelineRoutes from "./routes/stagingPipeline.routes.js";
// CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4): read-only query
// surface over the Cosmos reference-catalog container. Used by iOS
// structured-search form and internal CompIQ code paths.
import referenceRoutes from "./routes/reference.routes.js";
import entitlementsRoutes from "./routes/entitlements.routes.js";
import subscriptionsRoutes from "./routes/subscriptions.routes.js";
import rateLimit from "express-rate-limit";

const config = getConfig();
const app = express();

// CF-CATALOG-RESOLVER (2026-07-13): register vendor sources at startup so
// resolveCard has plugins available on first call. Order matters —
// listVendorSources returns in registration order, and reconciliation logs
// list vendors in the same order. CH stays primary; sold-comps is the
// coverage-gap plug (see PR #397).
import { registerVendorSource } from "./services/compiq/catalogResolver.service.js";
import { cardhedgeVendorSource } from "./services/compiq/cardhedgeVendorSource.js";
import { soldCompsVendorSource } from "./services/compiq/soldCompsVendorSource.js";
import { cardsightVendorSource } from "./services/compiq/cardsightVendorSource.js";
import { isCardsightConfigured } from "./services/compiq/cardsightSlim.client.js";
registerVendorSource(cardhedgeVendorSource);
registerVendorSource(soldCompsVendorSource);
// CF-CARDSIGHT-RESTORE (2026-07-13): Cardsight registers unconditionally;
// its resolveCard returns null immediately when CARDSIGHT_API_KEY is
// unset. Once the key lands in App Service settings, the plugin
// activates on next restart. Log the config state at startup for
// operational visibility.
registerVendorSource(cardsightVendorSource);
console.log(JSON.stringify({
  event: "catalog_resolver_startup",
  source: "app",
  vendors: ["cardhedge", "sold-comps", "cardsight"],
  cardsightConfigured: isCardsightConfigured(),
}));

// Rate limiting — 200 req/min per IP
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please slow down." },
}));

// CF-COMPRESSION (Drew, 2026-07-25). Gzip every response over 1KB.
// Big win for the discovery/search endpoints (facets, groups, hit arrays)
// which routinely serialize to 50-200KB of JSON. Default level=6 is the
// standard latency/ratio balance; default filter already handles
// content-type (skips already-compressed responses like images).
app.use(compression({ threshold: 1024 }));

// CF-STRIPE-SUBSCRIPTIONS (Drew, 2026-07-27). Stripe webhook needs the
// RAW request body to verify the HMAC signature. Mount the whole
// /api/stripe subrouter BEFORE express.json() — the /checkout + /portal
// endpoints inside apply express.json themselves via the requireSession
// middleware chain, and the /webhook route uses express.raw() locally.
app.use("/api/stripe", stripeRoutes);

// CF-TCA-WEBHOOK-RAW-BODY (Drew, 2026-08-02). Same pattern as Stripe —
// TCA signs the raw JSON body with HMAC-SHA256, so the route MUST see
// the untouched Buffer. Mounted BEFORE the global express.json() so
// the router's local express.raw() applies without contention.
app.use("/api/tca", tcaWebhookRoutes);

app.use(express.json({ limit: "12mb" }));
// CF-FINALIZE (2026-06-03): config.CORS_ALLOWED_ORIGINS is now pre-parsed
// to boolean | "*" | string[]. The `|| "*"` fallback was the source of
// the malformed `Access-Control-Allow-Origin: false` echo when the env
// var was set to the literal string "false". cors() with `origin: false`
// emits NO ACAO header — cross-origin browser requests are rejected
// silently; iOS-native (no Origin header) is unaffected.
app.use(cors({
  origin: config.CORS_ALLOWED_ORIGINS,
}));
app.use(requestLogger);

// CF-REQUEST-CONTEXT (Drew, 2026-07-23, issue #722 signals phase 2):
// stash per-request userId in AsyncLocalStorage so vendor client hooks
// can attribute persistence events to the authenticated user without
// threading userId through every function signature. Runs on every
// request; the middleware itself never rejects, so unauthenticated
// paths (health, public routes) just see userId = null.
import { requestContextMiddleware } from "./services/portfolioiq/requestContext.service.js";
app.use(requestContextMiddleware);

// Publicly serve uploaded card photos saved by the uploads API.
app.use("/uploads", express.static(path.join(process.cwd(), ".data", "uploads")));

app.use("/api/health", healthRoutes);
app.use("/api/health", ingestHealthRoutes);
app.use("/api/health", dataQualityHealthRoutes);
app.use("/api/stats", publicStatsRoutes);
app.use("/api/public", publicSellerRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/daily", dailyPublishRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/waitlist", waitlistRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/messages", messagingRoutes);
app.use("/api/compiq", compiqRoutes);
// CF-CANONICAL-FMV (Drew, 2026-07-18): single source of truth FMV
// pipeline. Every consumer should call this. Behind
// CANONICAL_FMV_ENABLED=true feature flag.
app.use("/api/compiq", canonicalFmvRoutes);
// CF-LISTING-RANGE (Drew, 2026-07-18): "currently listing on eBay"
// IQR range for a specific (cardId, parallel, grade). Card Detail
// renders this under the FMV headline.
app.use("/api/compiq", listingRangeRoutes);
app.use("/api/compiq", recentSalesRoutes);
app.use("/api/compiq", marketMoversRoutes);
app.use("/api/compiq", marketIndexesRoutes);
app.use("/api", playerDetailRoutes);
app.use("/api/dailyiq", prospectsBreakingOutRoutes);
app.use("/api/compiq", cohortBacktestRoutes);
app.use("/api/insights", weeklyHobbyIndexRoutes);
app.use("/api/compiq", setDetailRoutes);
app.use("/api/compiq", priceSeriesRoutes);
app.use("/api/portfolio", opsPoolHealthRoutes);
app.use("/api/portfolioiq", portfolioiqRoutes);
// CF-BUYERIQ (Drew, 2026-07-31). Buying checklist for card shows.
// Session-gated only; every plan gets it.
app.use("/api/buyeriq", buyeriqRoutes);
// CF-ERP-RECONCILIATION (2026-06-03): /api/portfolio/erp MUST mount BEFORE
// /api/portfolio so the ERP sub-router's path tree is reachable. Same
// mount-order pattern as /api/alerts/advanced.
app.use("/api/portfolio/erp", portfolioErpRoutes);
// CF-EBAY-IMPORT-REMATCH-ADMIN-MOUNT (Drew, 2026-07-18): mount the
// rematch routes FIRST among /api/portfolio routers because every
// other /api/portfolio mount (sellRadarNotableSalesRoutes,
// portfolioiqRoutes, bulkSellComposerRoutes, tradeTargetsRoutes) has a
// blanket router.use(requireSession) that rejects with 401 when there's
// no x-session-id header — the request never falls through to the next
// router at the app level once a session middleware rejects. Mounting
// ebayImportRematchRoutes first lets its own requireAdmin fire on the
// admin batch backfill path before any session gate intercepts.
app.use("/api/portfolio", ebayImportRematchRoutes);
// CF-SELL-NOW-RADAR + CF-NOTABLE-SALES-FEED: mount BEFORE the general
// /api/portfolio → portfolioiqRoutes so the two dedicated endpoints
// resolve to their handlers cleanly.
app.use("/api/portfolio", sellRadarNotableSalesRoutes);
app.use("/api/portfolio", portfolioiqRoutes);
// CF-DAILYIQ-ACTION-PLAN (2026-07-17): mount action-plan routes first
// so its clean, minimal-import file resolves before dailyiq.routes'
// legacy broken imports would be walked.
// CF-DAILYIQ-CASE-CLEANUP (Drew, 2026-07-19): dropped the /api/dailyIQ
// and /api/daily case-variant mounts. iOS/backend audit confirmed
// iOS only calls /api/dailyiq — those extra mounts were noise +
// attack surface (anyone could enumerate them).
app.use("/api/dailyiq", dailyiqActionPlanRoutes);
app.use("/api/backtest", backtestRoutes);
app.use("/api/portfolio", bulkSellComposerRoutes);
app.use("/api/portfolio", tradeTargetsRoutes);
app.use("/api/community", communityRoutes);
app.use("/api/catalog", catalogAdditionsRoutes);
app.use("/api/dailyiq", dailyiqRoutes);
app.use("/api/playeriq", playeriqRoutes);
app.use("/api/ebay/webhook", ebayWebhookRoutes);
// /api/tca is mounted BEFORE express.json() above — do NOT re-mount here.
app.use("/api/ebay", ebayRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/internal/ocr", ocrRoutes);
app.use("/api/psa", psaRoutes);
// CF-WATCHLIST-UNIFY: /api/watchlist mount removed; route returns 404 via
// the notFound handler. /api/dailyiq/watchlist is canonical.
app.use("/api/devices", devicesRoutes);
// Order matters: /api/alerts/advanced MUST mount BEFORE /api/alerts so the
// advanced subrouter's path tree is reachable. Express matches in mount
// order; mounting /api/alerts first would let alertsRoutes consume
// /api/alerts/advanced before it ever reaches alertsAdvancedRoutes.
app.use("/api/alerts/advanced", alertsAdvancedRoutes);
// CF-USER-PRICE-ALERTS (Drew, 2026-09-02): same mount-order rule as
// /api/alerts/advanced above — the subrouter MUST precede /api/alerts or
// alertsRoutes consumes the path first.
app.use("/api/alerts/holding-moves", alertsHoldingMovesRoutes);
app.use("/api/alerts", alertsRoutes);
app.use("/api/ops", opsRoutes);
app.use("/api/search", searchRoutes);
// CF-CATALOG-FIRST-SEARCH (Drew, 2026-08-04). Direct card_catalog
// search returning canonical entries + attached salesSummary. Callers
// use this BEFORE hitting the vendor-fanout search for the "our data
// first" experience.
app.use("/api/catalog", catalogSearchRoutes);
// CF-CATALOG-FIRST product-structure mount. Must come AFTER
// catalogSearchRoutes so /search doesn't shadow it (they don't collide
// today but keep the order stable for future path additions).
app.use("/api/catalog/product-structure", productStructureRoutes);
// CF-SEARCH-ADMIN (2026-07-08, Drew): mount admin surface after the
// user-facing /api/search so path resolution can't shadow user routes.
app.use("/api/admin", searchAdminRoutes);
// CF-VERIFY-QUEUE-ROUTES (Drew, 2026-07-28): human-in-the-loop verify
// queue + pool-level data-quality report. Both admin-gated.
app.use("/api", verifyQueueRoutes);
// CF-CATALOG-FIRST (Drew, 2026-08-04): price-anomaly reassign queue at
// /api/verify/comps/*. Admin-gated via ADMIN_USER_IDS.
app.use("/api/verify", verifyCompsRoutes);
// CF-LABELER-ROUTES (Drew, 2026-07-31): variant labeling admin surface.
app.use("/api", labelerRoutes);
// CF-CLEANLINESS-ROUTES (Drew, 2026-08-01): pool cleanliness dashboard.
app.use("/api", cleanlinessRoutes);
// CF-FLAG-COMP-ROUTES (Drew, 2026-08-01): user "flag this comp" endpoint.
app.use("/api", flagCompRoutes);
// CF-QUARANTINE-ROUTES (Drew, 2026-08-01): admin quarantine browser.
app.use("/api", quarantineRoutes);
// CF-CATALOG-REVIEW-ROUTES (Drew, 2026-08-08): admin review of user-
// seeded catalog entries + vendor-unmatched staging.
app.use("/api/admin", catalogReviewRoutes);
// CF-STAGING-PIPELINE-ROUTES (Drew, 2026-07-28): admin triggers for
// the data-clean → image-verify → promotion jobs + a live health
// counter over staging status buckets.
app.use("/api", stagingPipelineRoutes);
app.use("/api/reference", referenceRoutes);
app.use("/api/entitlements", entitlementsRoutes);
app.use("/api/subscriptions", subscriptionsRoutes);
// CF-ACCOUNT-DELETION (2026-06-04): Apple Guideline 5.1.1(v) compliance.
app.use("/api/account", accountRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
