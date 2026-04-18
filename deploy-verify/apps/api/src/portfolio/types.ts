// PortfolioIQ types and DTOs
import { Recommendation, GradeCompany } from "@prisma/client";

export interface CreatePortfolioInput {
  userId: string;
  name: string;
}

export interface PortfolioDTO {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddPortfolioCardInput {
  player: string;
  year: number;
  brand: string;
  setName: string;
  cardNumber?: string;
  parallel: string;
  serialNumber?: string;
  printRun?: number;
  isAuto: boolean;
  gradeCompany?: GradeCompany;
  gradeValue?: number;
  purchasePrice: number;
  purchaseDate: string;
  quantity: number;
  source?: string;
  notes?: string;
  imageUrl?: string;
}

export interface PortfolioCardDTO {
  id: string;
  portfolioId: string;
  userId: string;
  player: string;
  year: number;
  brand: string;
  setName: string;
  cardNumber?: string;
  parallel: string;
  serialNumber?: string;
  printRun?: number;
  isAuto: boolean;
  gradeCompany?: GradeCompany;
  gradeValue?: number;
  purchasePrice: number;
  purchaseDate: string;
  quantity: number;
  source?: string;
  notes?: string;
  imageUrl?: string;
  currentEstimatedValue: number;
  riskAdjustedValue?: number;
  quickExitValue?: number;
  gainLossDollar: number;
  gainLossPercent: number;
  currentRecommendation: Recommendation;
  currentConfidenceScore: number;
  currentUrgencyScore?: number;
  currentDecisionScore?: number;
  liquidityScore?: number;
  negativePressureScore?: number;
  marketMomentumScore?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioSummary {
  totalMarketValue: number;
  totalCostBasis: number;
  totalGainLossDollar: number;
  totalGainLossPercent: number;
  numCards: number;
  recommendationCounts: {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  };
  topGainers: PortfolioCardDTO[];
  highestRisk: PortfolioCardDTO[];
  highestConviction: PortfolioCardDTO[];
  allocation: Record<string, any>;
}

export interface RefreshPortfolioResult {
  success: boolean;
  results: Array<{
    cardId: string;
    success: boolean;
    error?: string;
  }>;
}
