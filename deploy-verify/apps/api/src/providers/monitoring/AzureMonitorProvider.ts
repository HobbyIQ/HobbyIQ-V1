// src/providers/monitoring/AzureMonitorProvider.ts
import type { MonitoringProvider } from "./MonitoringProvider";

export class AzureMonitorProvider implements MonitoringProvider {
  getProviderMode() { return "azure"; }
  async logEvent(event: string, data?: any) {
    // TODO: Integrate with Azure Monitor
  }
  async reportHealth(status: string, details?: any) {
    // TODO: Integrate with Azure Monitor
  }
}
