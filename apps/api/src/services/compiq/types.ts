// Strongly typed request and response models for CompIQ

export interface CompIQRequest {
  query: string;
  player?: string;
  set?: string;
  parallel?: string;
  gradeTarget?: string;
  isAuto?: boolean;
}

export interface CompIQResponse {
  success: boolean;
  player: string | null;
  cardSet: string | null;
  productFamily: string | null;
  parallel: string | null;
  normalizedParallel: string | null;
  isAuto: boolean;
  cardType: string | null;
  rawPrice: number | null;
  adjustedRaw: number | null;
  estimatedPsa9: number | null;
  estimatedPsa10: number | null;
  confidenceScore: number;
  confidenceLabel: string;
  explanation: string;
  warnings: string[];
  nextActions: string[];
}
