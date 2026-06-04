import * as appInsights from "applicationinsights";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import app from "./app.js";
import { startDailyJobs } from "./jobs/dailyiq.job.js";
import { startPortfolioRepriceJob } from "./jobs/portfolioReprice.job.js";
import { startPriceAlertEvaluatorJob } from "./jobs/priceAlertEvaluator.job.js";
import { startAdvancedAlertsEvaluatorJob } from "./services/advancedAlerts/ruleEvaluator.js";
import { startEbayOrderPollJob } from "./jobs/ebayOrderPoll.job.js";
import { startInventoryRefreshJob } from "./jobs/cardsightInventoryRefresh.job.js";
import { startSubscriptionsSafetyNetJob } from "./jobs/subscriptionsSafetyNet.job.js";
import { startPredictionOutcomesCaptureJob } from "./jobs/predictionOutcomesCapture.job.js";
import { startCacheHitRateEmit } from "./services/shared/cache.service.js";
import { startGetPricingBudgetEmit } from "./services/compiq/cardsight.client.js";
import { startEbayFinancesEnrichmentJob } from "./jobs/ebayFinancesEnrichment.job.js";
import { warmResolveCardIdCache } from "./services/compiq/cardsight.mapper.js";
import { warmCompsByPlayerCache } from "./services/compiq/compsByPlayer.service.js";

// Initialize App Insights — must be called before the server handles requests.
// The Azure App Service agent (ApplicationInsightsAgent_EXTENSION_VERSION=~3)
// handles deep instrumentation; this SDK call enables custom telemetry and live metrics.
//
// CF-APPINSIGHTS-FETCH-INSTRUMENTATION: the v3 SDK + agent extension only hook
// Node's legacy http/https modules (Cosmos, fn-compiq Azure SDK, IMDS). Calls
// via the global fetch API (Node 18+, undici-backed) are NOT auto-instrumented
// -- empirically confirmed by CF-CARDSIGHT-GRADE-ID-PATTERN Phase 3.4 telemetry
// gap (zero Cardsight deps despite 28+ comps returned). Adding
// @opentelemetry/instrumentation-undici restores fetch visibility by hooking
// undici's diagnostics_channel. Registers AFTER appInsights.start() so the
// instrumentation picks up the v3 SDK's global tracer provider.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  try {
    appInsights
      .setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoCollectConsole(true, true)
      .setSendLiveMetrics(true)
      .start();
    registerInstrumentations({
      instrumentations: [new UndiciInstrumentation()],
    });
    console.log("[AppInsights] Telemetry active (undici fetch instrumentation registered)");
  } catch (err: any) {
    console.warn("[AppInsights] Init failed:", err.message);
  }
}

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`HobbyIQ API listening on port ${port}`);
  try {
    startDailyJobs();
  } catch (err: any) {
    console.error("[server] startDailyJobs failed:", err?.message ?? err);
  }
  try {
    startPortfolioRepriceJob();
  } catch (err: any) {
    console.error("[server] startPortfolioRepriceJob failed:", err?.message ?? err);
  }
  try {
    startPriceAlertEvaluatorJob();
  } catch (err: any) {
    console.error("[server] startPriceAlertEvaluatorJob failed:", err?.message ?? err);
  }
  // CF-ADVANCED-ALERTS (2026-06-03): separate timer at default 4h cadence.
  // Decoupled from the 30-min basic-alert cycle so the advanced-rule fan-out
  // doesn't burn the getPricing budget. Same APNs no-op semantics; same
  // ADVANCED_ALERTS_EVALUATOR_DISABLE kill switch.
  try {
    startAdvancedAlertsEvaluatorJob();
  } catch (err: any) {
    console.error(
      "[server] startAdvancedAlertsEvaluatorJob failed:",
      err?.message ?? err,
    );
  }
  try {
    startEbayOrderPollJob();
  } catch (err: any) {
    console.error("[server] startEbayOrderPollJob failed:", err?.message ?? err);
  }
  // CF-SCANNING-B5b (2026-06-03): daily Cardsight identifiable-set snapshot
  // refresh. Defaults to 04:30 PT — fires before any user traffic spikes.
  try {
    startInventoryRefreshJob();
  } catch (err: any) {
    console.error("[server] startInventoryRefreshJob failed:", err?.message ?? err);
  }
  // CF-PAYMENTS-APPLE-2 (2026-06-03): nightly subscription safety-net.
  // Catches App Store Server Notifications V2 events Apple failed to
  // deliver. Defaults to 05:15 PT — after the inventory refresh, before
  // DailyIQ at 06:00.
  try {
    startSubscriptionsSafetyNetJob();
  } catch (err: any) {
    console.error("[server] startSubscriptionsSafetyNetJob failed:", err?.message ?? err);
  }
  // CF-ML-MOAT-OUTCOMES (2026-06-03): daily prediction-outcome capture.
  // Re-queries Cardsight for post-prediction sales, producing
  // (features, predicted, actual) training tuples. Defaults to 05:45 PT —
  // after safety-net (05:15), before DailyIQ (06:00).
  try {
    startPredictionOutcomesCaptureJob();
  } catch (err: any) {
    console.error("[server] startPredictionOutcomesCaptureJob failed:", err?.message ?? err);
  }
  try {
    startCacheHitRateEmit();
  } catch (err: any) {
    console.error("[server] startCacheHitRateEmit failed:", err?.message ?? err);
  }
  // CF-OPS-HARDENING-1a (2026-06-04): hourly Cardsight getPricing budget
  // delta emit. Feeds Azure Monitor log-search alerts at 75/90/100% of
  // the 100k/mo soft quota.
  try {
    startGetPricingBudgetEmit();
  } catch (err: any) {
    console.error("[server] startGetPricingBudgetEmit failed:", err?.message ?? err);
  }
  // CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): 6h cadence; shadow
  // mode default ON. Switches to active when EBAY_FINANCES_ENRICHMENT_SHADOW=
  // false (deploy-time env var change; no code change). First run +120s
  // post-boot — keeps it out of the cold-start critical path.
  try {
    startEbayFinancesEnrichmentJob();
  } catch (err: any) {
    console.error("[server] startEbayFinancesEnrichmentJob failed:", err?.message ?? err);
  }
  // Phase 1 CH-removal-v2 fix (commit 8d6d769): prime the resolveCardId LRU
  // cache for popular cards so the first iOS request after a container
  // restart doesn't pay the multi-candidate disambiguation cold-path.
  // Fire-and-forget — failure is non-fatal (queries still resolve, just slow
  // on first hit per card).
  //
  // MCP rewire Phase 1: warm the aggregate-cache after resolveCardId warming
  // completes (NOT in parallel — both share Cardsight rate-limit headroom).
  // ~50s additional cold-path on top of resolveCardId's ~3-4 min.
  warmResolveCardIdCache()
    .catch((err) => {
      console.warn("[server] warmResolveCardIdCache failed:", err?.message ?? err);
    })
    .finally(() => {
      warmCompsByPlayerCache().catch((err) => {
        console.warn("[server] warmCompsByPlayerCache failed:", err?.message ?? err);
      });
    });
});
