// src/providers/factories/monitoringProviderFactory.ts
import { env } from "../../config/env";
import { MockMonitoringProvider } from "../monitoring/MockMonitoringProvider";
import { AppInsightsProvider } from "../monitoring/AppInsightsProvider";

export function monitoringProviderFactory() {
  let provider;
  if (env.AI_MODE === "azure" && env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    provider = new AppInsightsProvider();
  } else {
    provider = new MockMonitoringProvider();
  }
  // Beta: suppress monitoring provider init log
  return provider;
}
