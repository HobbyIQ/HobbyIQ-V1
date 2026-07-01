import * as appInsights from "applicationinsights";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import app from "./app.js";
import { startDailyJobs } from "./jobs/dailyiq.job.js";
import { startPortfolioRepriceJob } from "./jobs/portfolioReprice.job.js";
import { startPriceAlertEvaluatorJob } from "./jobs/priceAlertEvaluator.job.js";
import { startAdvancedAlertsEvaluatorJob } from "./services/advancedAlerts/ruleEvaluator.js";
import { startEbayOrderPollJob } from "./jobs/ebayOrderPoll.job.js";
import { startChDeltaPollJob } from "./jobs/chDeltaPoll.job.js";
import { startMatchedCohortJob } from "./jobs/matchedCohortMomentum.job.js";
import { startSubscriptionsSafetyNetJob } from "./jobs/subscriptionsSafetyNet.job.js";
import { startCacheHitRateEmit } from "./services/shared/cache.service.js";
import { startEbayFinancesEnrichmentJob } from "./jobs/ebayFinancesEnrichment.job.js";
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
  // CF-CH-DELTA-POLL-FOUNDATION (2026-06-30): observation-only CardHedge
  // price-updates delta poll. Dormant unless both CARD_HEDGE_CLIENT_ID
  // (Drew registers with CH) AND CH_DELTA_POLL_ENABLED=true. Logs poll
  // cycles + update counts; downstream wiring (subscribe holdings,
  // trigger reprice) is a follow-up CF.
  try {
    startChDeltaPollJob();
  } catch (err: any) {
    console.error("[server] startChDeltaPollJob failed:", err?.message ?? err);
  }
  // CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01): nightly refresh of
  // mix-bias-free per-player momentum. Gated by MATCHED_COHORT_JOB_ENABLED.
  // No-op when off. Populates a Redis cache read by getPlayerTrendSnapshot.
  try {
    startMatchedCohortJob();
  } catch (err: any) {
    console.error("[server] startMatchedCohortJob failed:", err?.message ?? err);
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
  try {
    startCacheHitRateEmit();
  } catch (err: any) {
    console.error("[server] startCacheHitRateEmit failed:", err?.message ?? err);
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
  // Warm CompsByPlayer aggregate cache for popular cards so the first iOS
  // request after a container restart doesn't pay the cold-path lookup.
  warmCompsByPlayerCache().catch((err) => {
    console.warn("[server] warmCompsByPlayerCache failed:", err?.message ?? err);
  });
});
