// src/types/hobbyiq.ts
// Copied from root types/hobbyiq.ts for API build compatibility

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
  // ...other fields as needed
}
