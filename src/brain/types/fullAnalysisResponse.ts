// Types for the unified /api/brain/full-analysis response

export interface FullAnalysisResponse {
  summary?: Record<string, any>;
  zones?: Record<string, any>;
  insights?: Record<string, any>;
  reasoning?: any[];
  recentComps?: any[];
  marketLadder?: any[];
  outcome?: any[];
}

// You can extend or refine these types as the response contracts become more specific.
