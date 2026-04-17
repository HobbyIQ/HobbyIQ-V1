"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppInsightsProvider = void 0;
class AppInsightsProvider {
    // TODO: Wire up Azure Application Insights SDK client here for production
    // import * as appInsights from "applicationinsights"; // Example
    // appInsights.setup(...).start();
    getProviderMode() { return "azure"; }
    async logEvent(event, data) {
        // TODO: Integrate with Azure Application Insights SDK
        // Example: appInsights.defaultClient.trackEvent({ name: event, properties: data });
    }
    async reportHealth(status, details) {
        // TODO: Integrate with Azure Application Insights SDK
        // Example: appInsights.defaultClient.trackMetric({ name: "ProviderHealth", value: status, properties: details });
    }
}
exports.AppInsightsProvider = AppInsightsProvider;
