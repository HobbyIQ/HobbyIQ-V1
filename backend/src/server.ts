import * as appInsights from "applicationinsights";
import app from "./app.js";
import { startDailyJobs } from "./jobs/dailyiq.job.js";
import { startPortfolioRepriceJob } from "./jobs/portfolioReprice.job.js";
import { startPriceAlertEvaluatorJob } from "./jobs/priceAlertEvaluator.job.js";

// Initialize App Insights — must be called before the server handles requests.
// The Azure App Service agent (ApplicationInsightsAgent_EXTENSION_VERSION=~3)
// handles deep instrumentation; this SDK call enables custom telemetry and live metrics.
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
    console.log("[AppInsights] Telemetry active");
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
});
