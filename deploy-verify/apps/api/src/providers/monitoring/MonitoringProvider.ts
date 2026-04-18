// src/providers/monitoring/MonitoringProvider.ts
export interface MonitoringProvider {
  getProviderMode(): string;
  logEvent(event: string, data?: any): Promise<void>;
  reportHealth(status: string, details?: any): Promise<void>;
}
