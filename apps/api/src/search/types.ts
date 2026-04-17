// Normalized types for HobbyIQ search

export type SearchIntent =
  | 'playeriq'
  | 'compiq'
  | 'compare'
  | 'buy_sell_decision'
  | 'general_card_analysis';

export interface SearchRequest {
  query: string;
}

// Service boundaries for real data integration
export interface SearchResponse {
  success: boolean;
  query: string;
  intent: string;
  title: string;
  summary: string;
  result: Record<string, unknown>;
  bullets: string[];
  nextActions: string[];
}

// Service interfaces for future integration

export interface PlayerIQService {
  getPlayerReport(
    player: string,
    query: string,
    parsed?: any
  ): Promise<{
    title: string;
    summary: string;
    bullets: string[];
    nextActions: string[];
    result?: Record<string, unknown>;
  }>;
}


export interface CompIQService {
  getCardComps(
    card: string,
    query: string,
    parsed?: any
  ): Promise<{
    title: string;
    summary: string;
    bullets: string[];
    nextActions: string[];
    result?: Record<string, unknown>;
  }>;
}

export interface BuySellDecisionService {
  getDecision(card: string, query: string): Promise<{
    title: string;
    summary: string;
    bullets: string[];
    nextActions: string[];
    result?: Record<string, unknown>;
  }>;
}

export interface CompareService {
  getComparison(left: string, right: string, query: string): Promise<{
    title: string;
    summary: string;
    bullets: string[];
    nextActions: string[];
    result?: Record<string, unknown>;
  }>;
}
