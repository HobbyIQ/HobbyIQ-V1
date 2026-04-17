// Diagnostics DTOs
export interface DiagnosticsOverview {
  sync: DiagnosticsSync;
  snapshots: DiagnosticsSnapshots;
  alerts: DiagnosticsAlerts;
  learning: DiagnosticsLearning;
  imports: DiagnosticsImports;
  providers: DiagnosticsProviders;
}

export interface DiagnosticsSync {
  lastRun: string | null;
  failures: number;
  pending: number;
}

export interface DiagnosticsSnapshots {
  freshness: string;
  staleCount: number;
  rebuildFailures: number;
}

export interface DiagnosticsAlerts {
  candidateCount: number;
  suppressedCount: number;
}

export interface DiagnosticsLearning {
  lastRun: string | null;
  calibrationStatus: string;
}

export interface DiagnosticsImports {
  batchHealth: string;
  unmatchedRecords: number;
  failedReconciliations: number;
}

export interface DiagnosticsProviders {
  ebay: string;
  psa: string;
  redis: string;
  queue: string;
  encryption: string;
}
