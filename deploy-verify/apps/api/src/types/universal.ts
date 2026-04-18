// Types for universal search engine
export type UniversalSearchIntent = "comp" | "sell" | "hold" | "show" | "portfolio" | "unknown";

export interface UniversalSearchRequest {
  query: string;
  context?: any;
}

export interface UniversalSearchResult {
  intent: UniversalSearchIntent;
  directAnswer: string;
  action: string;
  keyNumbers: Record<string, any>;
  why: string[];
  tags: string[];
  expandable?: Record<string, any>;
  engine?: string;
}
