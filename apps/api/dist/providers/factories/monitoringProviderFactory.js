"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitoringProviderFactory = monitoringProviderFactory;
// src/providers/factories/monitoringProviderFactory.ts
const env_1 = require("../../config/env");
const MockMonitoringProvider_1 = require("../monitoring/MockMonitoringProvider");
const AppInsightsProvider_1 = require("../monitoring/AppInsightsProvider");
function monitoringProviderFactory() {
    let provider;
    if (env_1.env.AI_MODE === "azure" && env_1.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
        provider = new AppInsightsProvider_1.AppInsightsProvider();
    }
    else {
        provider = new MockMonitoringProvider_1.MockMonitoringProvider();
    }
    console.log(`[MonitoringProviderFactory] Initialized Monitoring provider: ${provider.getProviderMode()}`);
    return provider;
}
