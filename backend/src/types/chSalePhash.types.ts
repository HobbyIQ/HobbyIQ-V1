// CF-ATTRIBUTION-PHASE-1-DHASH (Drew, 2026-07-16). Types for the per-sale
// perceptual hash pipeline that clusters visually-similar sales per
// card_id and flags mis-attribution.

/**
 * dHash algorithm version — versioned so a future upgrade to pHash-DCT
 * or 128-bit hashes stays compatible with the on-disk corpus.
 *   dhash-v1 → 64-bit gradient hash, 9x8 resize, sharp+greyscale
 */
export type PhashAlgo = "dhash-v1";

/** One row per sale (partitioned by /card_id, id = price_history_id). */
export interface CHSalePhashDoc {
  id: string;               // = price_history_id
  card_id: string;          // partition key
  sale_date: string;        // ISO — passthrough for time-window queries
  image_url: string;        // passthrough for debugging + future re-hashing
  /** 16-char hex — 64-bit hash. */
  hash: string;
  hash_algo: PhashAlgo;
  /** Per-card cluster id assigned by the clustering step. -1 when the
   *  sale has been hashed but not yet clustered. */
  cluster_id: number;
  computed_at: string;      // ISO
  /** Bytes downloaded — for cost tracking. 0 when hash inherited from
   *  cache (URL identical to a prior sale). */
  download_bytes: number;
  /** Wall-clock ms of the download+hash step — perf tracking. */
  download_ms: number;
  ttl?: number;
}

/** Aggregate per card_id — output of the clustering pass. */
export interface CHCardAttributionStats {
  id: string;              // = card_id
  card_id: string;         // partition key
  total_hashed_sales: number;
  cluster_count: number;
  largest_cluster_size: number;
  smallest_cluster_size: number;
  /** True when cluster_count >= 2 AND some cluster is smaller than the
   *  largest. Load-bearing for the observability dashboard — this is
   *  the signal Phase 2/3 acts on. */
  suspect: boolean;
  last_updated: string;    // ISO
}
