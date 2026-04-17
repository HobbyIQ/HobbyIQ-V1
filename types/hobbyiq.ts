// types/hobbyiq.ts
// Shared stable types for HobbyIQ backend responses and data contracts

export type Tier = 'FREE' | 'PRO' | 'ALL_STAR';

export interface CompIQResult {
  id: string;
  player: string;
  card: string;
  comps: Array<{
    id: string;
    price: number;
    date: string;
    source: string;
    url?: string;
  }>;
  keyNumbers: Record<string, number>;
  directAnswer?: string;
  title?: string;
}

export interface PortfolioCard {
  id: string;
  player: string;
  card: string;
  purchasePrice: number;
  purchaseDate: string;
  currentValue: number;
  comps?: CompIQResult['comps'];
}

export interface PortfolioEvaluationResult {
  totalValue: number;
  totalCost: number;
  gainLoss: number;
  cards: PortfolioCard[];
}

export interface Alert {
  id: string;
  type: 'PRICE' | 'DEAL' | 'PORTFOLIO' | 'INSIGHT';
  message: string;
  createdAt: string;
  read: boolean;
  relatedCardId?: string;
}

export interface DealAnalyzerResult {
  id: string;
  card: string;
  player: string;
  isDeal: boolean;
  reason: string;
  comps: CompIQResult['comps'];
  suggestedPrice?: number;
}

export interface EntitlementAccess {
  tier: Tier;
  searchesPerDay: number | 'unlimited';
  portfolioEnabled: boolean;
  alertsEnabled: boolean;
  advancedAlertsEnabled: boolean;
  premiumInsightsEnabled: boolean;
}
