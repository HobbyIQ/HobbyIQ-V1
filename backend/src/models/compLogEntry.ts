/**
 * CompLogEntry — operational/cohort record of one CompIQ pricing
 * response, persisted to the Cosmos `comp_logs` container.
 *
 * Distinct from {@link CorpusEntry} (services/corpus/):
 *   - CorpusEntry is privacy-rigorous, schema-locked, intended for ML
 *     training data. Forbidden-field list is the load-bearing contract.
 *   - CompLogEntry is the post-deploy soak / regression / cohort
 *     analysis record. Schema is pragmatic — fields are added when
 *     they're useful for slicing the production cohort, removed when
 *     they're not.
 *
 * Both records can be written from the same pricing response via
 * services/corpus/writeTelemetryEntries.ts; each is gated on an
 * independent sample-rate env var (COMPIQ_CORPUS_SAMPLE_RATE for
 * corpus, COMPIQ_COMP_LOGS_SAMPLE_RATE for this).
 *
 * @schemaVersion 1 — first generation. Bump when a field is added or
 *   removed; never re-purpose a field within a version.
 *
 * @ttl Container default. Set at the Cosmos container level if a TTL
 *   policy is desired; this type does not stamp a TTL field.
 *
 * @partitionKey /player. The Cosmos container `comp_logs` is
 *   partitioned by player name slug (lowercased, single-spaced). Use
 *   the literal string `"unknown"` when the pricing response carries
 *   no identifiable player (e.g. unsupported sport, cardId-pinned
 *   request with no resolvable identity).
 */

export type CompLogOutcome =
  | "ok"
  | "empty"
  | "unsupported_sport"
  | "variant_mismatch"
  | "no_recent_comps"
  | "neighbor_synthesis"
  | "error";

/** Two-value source field per the W3 observability spec. */
export type CompLogSource = "cardsight" | "fallback";

/** Two-value namespace marker for the resolved cardId. */
export type CompLogCardIdSource = "cardsight" | "cardhedge";

export interface CompLogComp {
  /** Sale price in dollars (already coerced to float upstream). */
  price: number;
  /** ISO date or ISO datetime of the sale, or null if not available. */
  soldDate: string | null;
}

export interface CompLogEntry {
  /** Schema generation. Literal `1` for the current shape. */
  compLogSchemaVersion: 1;

  /**
   * Cosmos partition key value. Lowercase player name slug, or
   * `"unknown"` when no player can be resolved.
   */
  player: string;

  /** Epoch milliseconds when the response was produced (server clock). */
  timestamp: number;

  /** Wall-clock ms the route handler spent producing the response. */
  latency_ms: number;

  /** The route that handled this request. Plain string. */
  endpoint: string;

  /** Resolved Card Hedge / Cardsight card id, or null. */
  cardId: string | null;

  /** Free-text query or pinned cardId, depending on the route. */
  query: string;

  /** Namespace marker for the cardId. Null when no cardId resolved. */
  cardIdSource: CompLogCardIdSource | null;

  /** Predicted/fair market value in dollars, or null on thin/error paths. */
  predictedPrice: number | null;

  /**
   * Up to 20 most-recent sold comps surfaced to the user, lightweight
   * shape (price + soldDate only). Kept short to bound row size and
   * Cosmos RU consumption per write.
   */
  comps: CompLogComp[];

  /** Pricing engine confidence in [0, 1], or null when unavailable. */
  confidence: number | null;

  /**
   * Two-value source per W3 spec:
   *   - "cardsight": comps came from the Cardsight router (live source).
   *   - "fallback": any non-live or non-Cardsight path (cardhedge,
   *     neighbor-synthesis, no-recent-comps, unsupported-sport,
   *     variant-mismatch, error).
   */
  source: CompLogSource;

  /**
   * Raw `source` value emitted by computeEstimate(). Captured alongside
   * the two-value `source` field so soak analysis can drill into the
   * specific fallback reason without losing the spec-mandated
   * partition. Examples: "live", "fallback", "neighbor-synthesis",
   * "no-recent-comps", "unsupported_sport", "variant-mismatch".
   */
  sourceDetail: string | null;

  /**
   * Categorical outcome of the request. Distinct from `source` —
   * outcome answers "what did the user get?" while source answers
   * "where did the comps come from?".
   */
  outcome: CompLogOutcome;

  /** Short git SHA of the deployed code, or "unknown". */
  engineVersion: string;

  // ── D2 cohort-slicing fields (minimum + soak analysis) ────────────────

  /** Parallel/variant detected from the parsed query, or null. */
  parallel: string | null;

  /**
   * Grade label as a plain string (e.g. "PSA 10", "BGS 9.5", "Raw"),
   * or null when no grade was specified or applied.
   */
  grade: string | null;

  /** Whether the request targeted an autographed card. */
  isAuto: boolean;

  /** Comp counts within rolling sale-date windows. */
  w7Count: number | null;
  w14Count: number | null;
  w30Count: number | null;

  /** Comp average sale price within rolling sale-date windows. */
  w7Avg: number | null;
  w14Avg: number | null;
  w30Avg: number | null;
}
