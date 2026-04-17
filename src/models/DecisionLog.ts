export interface DecisionLog {
  payload: any;
  decision: any;
  confidence: number;
  estimatedValue: number;
  compCount: number;
  timestamp: string;
}
