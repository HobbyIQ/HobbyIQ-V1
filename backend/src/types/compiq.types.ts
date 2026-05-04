export interface CompIQEstimateRequest {
  playerName?: string;
  cardYear?: number;
  product?: string;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: number;
  isAuto?: boolean;
}

export interface CompIQEstimateResponse {
  cardTitle: string;
  verdict: string;
  action: "Buy" | "Hold" | "Sell" | "Pass";
  dealScore: number;
  quickSaleValue: number;
  fairMarketValue: number;
  premiumValue: number;
  explanation: string[];
  marketDNA: {
    demand: "High" | "Medium" | "Low";
    speed: "Fast" | "Normal" | "Slow";
    risk: "Low" | "Medium" | "High";
    trend: "Up" | "Flat" | "Down";
  };
  confidence: {
    pricingConfidence: number;
    liquidityConfidence: number;
    timingConfidence: number;
  };
  exitStrategy: {
    recommendedMethod: "auction" | "bin";
    expectedDaysToSell: number | null;
    timingRecommendation: string;
  };
  freshness: {
    status: "Live" | "Updated today" | "Yesterday" | "Needs refresh";
    lastUpdated: string | null;
  };
}
