// Diagnostics helper for refreshes
export interface RefreshDiagnostics {
  reason: string;
  path: string;
  durationMs: number;
  changedFieldsCount?: number;
  liveApiUsed?: boolean;
  confidenceDelta?: number;
}

export class RefreshDiagnosticsService {
  buildDiagnostics(params: RefreshDiagnostics): Record<string, unknown> {
    return { ...params };
  }
}
