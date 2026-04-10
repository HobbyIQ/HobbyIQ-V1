// src/providers/monitoring/MockMonitoringProvider.ts
import type { MonitoringProvider } from "./MonitoringProvider";

export class MockMonitoringProvider implements MonitoringProvider {
  getProviderMode() { return "mock"; }
  async logEvent(event: string, data?: any) {
    // No-op for mock
  }
  async reportHealth(status: string, details?: any) {
    // No-op for mock
  }
}
