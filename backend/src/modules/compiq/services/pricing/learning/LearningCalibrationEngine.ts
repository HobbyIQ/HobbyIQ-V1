// LearningCalibrationEngine: prediction/outcome logging
export interface PredictionLog {
  id: string;
  cardKey: string;
  predictedFMV: number;
  predictedQuickSale: number;
  predictedPremium: number;
  pricingConfidence: number;
  createdAt: string;
}
export interface OutcomeLog {
  id: string;
  predictionId: string;
  realizedSalePrice: number;
  realizedSaleDate: string;
  realizedDaysToSell: number;
  platform: string;
  auctionOrBin: string;
}
export class LearningCalibrationEngine {
  // TODO: Use real DB later
  static predictions: PredictionLog[] = [];
  static outcomes: OutcomeLog[] = [];
  static logPrediction(pred: PredictionLog) { this.predictions.push(pred); }
  static logOutcome(outcome: OutcomeLog) { this.outcomes.push(outcome); }
}
