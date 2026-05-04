// ObservabilitySnapshot and related types

export interface ObservabilitySnapshot {
  usedFallback: boolean;
  fallbackReason?: string;
  rejectedCompCount: number;
  duplicateCompCount: number;
  sparseDataFlag: boolean;
  anomalyFlags: string[];
}
