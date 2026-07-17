// CF-PHASE-6A-CANONICALIZATION (Drew, 2026-07-17). Types for the LLM-
// driven canonicalization of free-text player / set / variant fields
// on ch_daily_sales.

export type CanonicalEntityType = "player" | "set" | "variant";

export type CanonicalSource =
  | "embedding-cluster"
  | "llm-adjudication"
  | "user-attested"
  | "deterministic";

export interface CanonicalEntityDoc {
  id: string;                    // = canonical_id (UUID v4)
  canonical_id: string;
  entity_type: CanonicalEntityType;
  canonical_name: string;
  aliases: string[];             // lowercase, deduplicated
  /** Free-text discriminator for entities that share the same name but
   *  refer to different things — e.g. two "Chris Sale" in different
   *  eras, or "Refractor" in Topps Chrome vs Bowman Chrome. Null when
   *  the canonical is genuinely global. */
  discriminator?: string | null;
  sport?: string | null;         // inferred from majority sport of aliased sales
  source: CanonicalSource;
  confidence: number;            // 0..1
  llm_cost_usd?: number;         // spend per entity (audit)
  first_seen: string;            // ISO — first sale using any alias
  last_seen: string;             // ISO — most recent sale using any alias
  sale_count: number;            // total sales matched
  created_at: string;
  updated_at: string;
}

export interface CandidateCluster {
  /** Raw strings vector-clustered together. Sent to LLM for adjudication. */
  strings: string[];
  /** Vector-cluster confidence — the min pairwise similarity within the
   *  cluster. Callers use this to prioritize which clusters get LLM
   *  attention. */
  min_similarity: number;
  /** Optional context: sample sales per string to help LLM disambiguate. */
  context?: Array<{
    string: string;
    sample_sale_titles: string[];
    sample_years: number[];
    sample_sports: string[];
  }>;
}

export interface LLMResolution {
  /** true if all strings in the input cluster refer to the same entity. */
  same: boolean;
  /** When same=true, the canonical name emitted by the LLM. */
  canonical?: string;
  /** When same=false, the split — one canonical per group of strings. */
  splits?: Array<{ canonical: string; strings: string[] }>;
  /** LLM confidence in this resolution. */
  confidence: number;
  /** LLM's short explanation (kept for audit / debugging). */
  reasoning?: string;
}

export interface CanonicalizationRunSummary {
  entityType: CanonicalEntityType;
  distinctStrings: number;
  clustersFormed: number;
  clustersAdjudicated: number;
  entitiesEmitted: number;
  llmCostUSD: number;
  embeddingCostUSD: number;
  elapsedMs: number;
}
