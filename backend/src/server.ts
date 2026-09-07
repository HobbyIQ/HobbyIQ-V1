import * as appInsights from "applicationinsights";
import { type InstrumentationOptions } from "applicationinsights";

const { useAzureMonitor, TelemetryClient } = appInsights;
import { SeverityNumber } from "@opentelemetry/api-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import app from "./app.js";
import { startDailyJobs } from "./jobs/dailyiq.job.js";
import { startPortfolioRepriceJob } from "./jobs/portfolioReprice.job.js";
import { startPriceAlertEvaluatorJob } from "./jobs/priceAlertEvaluator.job.js";
import { startAdvancedAlertsEvaluatorJob } from "./services/advancedAlerts/ruleEvaluator.js";
import { startEbayOrderPollJob } from "./jobs/ebayOrderPoll.job.js";
import { startWeeklyEbayPurchaseSyncJob } from "./jobs/ebayPurchaseSync.job.js";
import { startBuyerIqDealScannerJob } from "./jobs/buyerIqDealScanner.job.js";
import { startStagingDrainer } from "./services/portfolioiq/stagingDrainer.service.js";
import { startMatchedCohortJob } from "./jobs/matchedCohortMomentum.job.js";
import { startSubscriptionsSafetyNetJob } from "./jobs/subscriptionsSafetyNet.job.js";
import { startCacheHitRateEmit } from "./services/shared/cache.service.js";
import { startEbayFinancesEnrichmentJob } from "./jobs/ebayFinancesEnrichment.job.js";
import { warmCompsByPlayerCache } from "./services/compiq/compsByPlayer.service.js";
import { installWorkerLifecycleHandlers } from "./services/ops/workerLifecycle.js";
import { CosmosPingSpanFilter } from "./services/ops/cosmosPingSpanFilter.js";

// CF-WORKER-LIFECYCLE (#1973, 2026-09-07). Installed FIRST, before App
// Insights setup and before the server listens, so a failure during boot
// is still attributable. Emits one `worker_shutdown` event naming the
// reason the process ended (SIGTERM = platform recycle: deploy,
// appsettings write, scale, host patch), and absorbs unhandled
// rejections instead of letting a stray promise recycle a worker.
installWorkerLifecycleHandlers();

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
// undici's diagnostics_channel. Registers AFTER the SDK starts so the
// instrumentation picks up the v3 SDK's global tracer provider.
//
// ── CF-TELEMETRY-VOLUME (2026-09-07) ──────────────────────────────────
//
// This block used to call the legacy `appInsights.setup(...).setX(...).start()`
// shim. It now calls `useAzureMonitor` directly, for one concrete reason: the
// shim CANNOT carry a span processor. `Config.parseConfig()` builds a fresh
// options object and never copies `spanProcessors` through, and the v2-era
// `client.addTelemetryProcessor()` is a no-op in v3 whose entire body is a
// `diag.warn("... not supported ... any longer")`. Filtering via the shim would
// have compiled, gone green in tests, and dropped nothing in production.
//
// Every setting below is the documented equivalent of the shim call it
// replaces, verified against applicationinsights@3.14.0's own shim-config.js:
//   setAutoCollectRequests(true)        -> enableAutoCollectRequests
//   setAutoCollectPerformance(true,true)-> enablePerformanceCounters
//   setAutoCollectExceptions(true)      -> enableAutoCollectExceptions
//   setAutoCollectDependencies(true)    -> enableAutoCollectDependencies
//   setSendLiveMetrics(true)            -> enableLiveMetrics
//   setAutoCollectConsole(true, X)      -> instrumentationOptions.console.enabled = X
//                                          (+ winston/bunyan = first arg)
//
// CONSOLE TELEMETRY. The report asked for `setAutoCollectConsole(true, false)`
// to stop the 15.4M AppTraces. Reading the SDK shows the first argument does
// NOT mean "keep console.error": it maps to winston/bunyan only, and this
// backend logs through bare `console.*`, so `(true, false)` would have dropped
// console errors and warnings too.
//
// The mechanism that actually separates them is severity. The console
// subscriber (out/src/logs/diagnostic-channel/console.sub.js) tags every record
// before emitting:
//     stderr -> SeverityNumber.WARN     (console.error, console.warn)
//     stdout -> SeverityNumber.INFO     (console.log, console.info)
// and emits only when `logSendingLevel <= severity`. So console stays ENABLED
// with `logSendingLevel: WARN`: every console.log stops minting a billed
// AppTraces row, while errors and warnings — the ones worth keeping — still
// arrive. console.log also still reaches the App Service log stream regardless,
// since this changes only what is exported to App Insights.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  try {
    useAzureMonitor({
      azureMonitorExporterOptions: {
        connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
      },
      enableAutoCollectExceptions: true,
      enableAutoCollectRequests: true,
      enableAutoCollectDependencies: true,
      enablePerformanceCounters: true,
      enableLiveMetrics: true,
      // Typed through the SDK's own InstrumentationOptions: the distro's
      // narrower interface (what AzureMonitorOpenTelemetryOptions declares)
      // has no `console` key, while applicationinsights extends it with one.
      instrumentationOptions: {
        // Console capture stays ON; severity is what filters it. WARN keeps
        // console.error/console.warn (stderr) and drops console.log (stdout).
        console: { enabled: true, logSendingLevel: SeverityNumber.WARN },
      } as InstrumentationOptions,
      // Drops the ~356k/hour 1ms Cosmos gateway "GET /" pings that made
      // AppDependencies 215.7M rows in 7 days and the query API unusable.
      // Slow or failing root calls are deliberately NOT dropped.
      spanProcessors: [new CosmosPingSpanFilter()],
    });
    registerInstrumentations({
      instrumentations: [new UndiciInstrumentation()],
    });

    // KEEP `appInsights.defaultClient` ALIVE. Moving off the shim removed the
    // `setup()` call that used to populate it, and two modules read it for
    // manual telemetry:
    //   services/ops/workerLifecycle.ts  -> the `worker_shutdown` event (#1977)
    //   services/signals/telemetry.ts    -> trackException
    // Both guard with `if (client)`, so a missing defaultClient would not throw
    // — it would silently stop reporting, which is precisely the blindness
    // #1977 was written to end. So publish a client explicitly.
    //
    // `useGlobalProviders: false` is load-bearing, not incidental. A client
    // left on the default (true) lazily calls `initialize()` on its first
    // `trackEvent`, and that calls `useAzureMonitor` a SECOND time — a function
    // with no re-entry guard, which runs `trace.disable()` and rebuilds the
    // tracer provider from scratch. That would tear out the span processor
    // registered above at the exact moment a worker is shutting down. Isolated,
    // the client builds its own provider, exports to the same App Insights
    // resource, and never touches global state.
    try {
      (appInsights as any).defaultClient = new TelemetryClient(
        process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
        { useGlobalProviders: false },
      );
    } catch (err: any) {
      console.warn("[AppInsights] defaultClient publish failed:", err?.message);
    }

    console.warn(
      "[AppInsights] Telemetry active (undici fetch instrumentation; console>=WARN; Cosmos gateway pings filtered)",
    );
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
  // CF-STAGING-DRAINER (Drew, 2026-08-06). In-process continuous
  // drainer for comps_staging (data-clean + promotion). Gated on
  // STAGING_DRAINER_ENABLED=true — off by default at boot; flip on
  // via App Service settings after verifying deploy landed.
  try {
    startStagingDrainer();
  } catch (err: any) {
    console.error("[server] startStagingDrainer failed:", err?.message ?? err);
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
  // CF-WEEKLY-EBAY-PURCHASE-SYNC (Drew, 2026-08-03). Sunday 06:00 UTC
  // sweep to pull last 7 days of purchases per connected user. Gated
  // on WEEKLY_EBAY_PURCHASE_SYNC_ENABLED — off by default at boot.
  // Combined with EBAY_IMPORT_FORCE_REVIEW=true, imports route to
  // the review queue instead of auto-creating holdings.
  try {
    startWeeklyEbayPurchaseSyncJob();
  } catch (err: any) {
    console.error("[server] startWeeklyEbayPurchaseSyncJob failed:", err?.message ?? err);
  }
  // CF-BUYERIQ-DEAL-SCANNER (Drew, 2026-08-03). Hourly scan of every
  // BuyerIQ "wanted" target; push notifications when a live eBay
  // listing lands below FMV × threshold (default 15%). Env-flag
  // gated (BUYERIQ_DEAL_SCANNER_DISABLE) so we can toggle without
  // a redeploy.
  try {
    startBuyerIqDealScannerJob();
  } catch (err: any) {
    console.error("[server] startBuyerIqDealScannerJob failed:", err?.message ?? err);
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
