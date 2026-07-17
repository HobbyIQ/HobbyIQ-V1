# Attribution Quality — Phase 1: dHash Pipeline

**Status:** design draft (2026-07-16). Awaits Drew review before code lands.
**Prereq:** PR #502 (daily-bulk ingest) merged, PR #505 (backfill flag) merged, 90-day backfill completes so we have real data to build against.
**Precedes:** Phase 2 (reference library), Phase 3 (attributionConfidence field), Phase 4 (iOS feedback loop), Phase 5 (LLM vision escalation).

## What Phase 1 ships

For every sale in `ch_daily_sales`, compute a **perceptual hash** of its eBay thumbnail image. Cluster per-card visually similar sales together. Flag `card_id` values whose sales split into ≥2 clusters — those are the attribution errors.

**What Phase 1 does NOT do:**

- Doesn't compare to a canonical reference image (Phase 2 does that).
- Doesn't emit a per-sale `attributionConfidence` field (Phase 3 does that; Phase 1 just produces the raw signal).
- Doesn't touch any user-facing surface. Zero UI change. Zero comp-pool filtering change.
- Doesn't call LLM vision (Phase 5 does that, only for the ambiguous cases Phase 1 surfaces).

Phase 1 is the **observability foundation** — we're measuring how bad attribution actually is, per card, before we take action on it.

## Algorithm choice: dHash, not pHash

pHash (using DCT) and dHash (using left-to-right pixel gradients) both produce 64-bit hashes with Hamming-distance similarity. For our specific use case — distinguishing "same card different lighting" (should cluster together) from "different parallel" (should split) — dHash is:

- **Simpler to implement** — no DCT, no external math library
- **Faster** — pure loop over 8×9 grayscale grid
- **Sufficient** — parallel differences (Base vs Chrome vs Refractor, foil vs matte) show up cleanly at 8×8 grayscale resolution

If Phase 1 data shows dHash misses too many real attribution errors, we swap to pHash in a Phase 1.5. Ship dHash first, calibrate on real corpus.

## Data flow

```
ch_daily_sales (populated by PR #502 + PR #505 backfill)
       │
       │ read sale.image_url per price_history_id
       ▼
image download (streaming, no local persistence)
       │
       │ sharp: resize to 9x8 grayscale
       ▼
dHash: 64-bit compare-to-right-neighbor
       │
       ▼
ch_sale_phashes container (new)
       │
       │ id = price_history_id  (idempotent)
       │ partition = card_id
       │ fields: { hash, computed_at, card_id, cluster_id }
       ▼
per-card_id clustering (Hamming distance ≤ threshold → same cluster)
       │
       ▼
ch_card_attribution_stats container (new, small)
       │
       │ id = card_id
       │ partition = card_id
       │ fields: { total_sales, cluster_count, largest_cluster,
       │           smallest_cluster, suspect: bool }
       ▼
KQL / dashboard queries → "top attribution offenders by cluster spread"
```

## Cosmos containers

### `ch_sale_phashes`

- Partition: `/card_id`
- Doc id: `price_history_id`
- TTL: 365 days (matches `ch_daily_sales`; if the underlying sale ages out, so does its hash)
- Fields per doc:

  ```typescript
  interface CHSalePhashDoc {
    id: string;               // = price_history_id
    card_id: string;          // partition key
    sale_date: string;        // pass through for time-window queries
    image_url: string;        // pass through for debugging
    hash: string;             // 16-char hex (64-bit dHash)
    hash_algo: "dhash-v1";    // versioned for future swap
    cluster_id: number;       // per-card cluster; assigned by cluster step
    computed_at: string;      // ISO
    download_bytes: number;   // for cost tracking
    download_ms: number;      // for perf tracking
  }
  ```

### `ch_card_attribution_stats`

Small container — one doc per unique `card_id`. Updated after each clustering pass.

- Partition: `/card_id`
- Doc id: `card_id`
- No TTL (audit history)
- Fields:

  ```typescript
  interface CHCardAttributionStats {
    id: string;              // = card_id
    card_id: string;
    total_hashed_sales: number;
    cluster_count: number;
    largest_cluster_size: number;
    smallest_cluster_size: number;
    suspect: boolean;        // true when cluster_count >= 2 AND largest < total
    last_updated: string;    // ISO
  }
  ```

## Clustering

Per `card_id`, load all pHash rows. Union-find on pairwise Hamming-distance-below-threshold. Threshold **default 10 bits** (≈ 15% of 64) — will tune on real corpus.

For N=100 sales per card, pairwise is N² = 10k comparisons. Cosmos read + Hamming compute is trivial at this scale. When N > 500 (large-cap popular cards), fall back to a locality-sensitive-hashing approximation instead of pairwise — but Phase 1 doesn't need it; almost every card has < 200 sales in the 90-day window.

## Workflow

**`.github/workflows/ch-sale-phashes.yml`** — new scheduled workflow.

- Schedule: 06:00 UTC daily (45 min after `ch-daily-sales-ingest.yml`)
- Reads sales from `ch_daily_sales` where `computed_at` is null in `ch_sale_phashes` (or older than TTL)
- Streams image downloads with concurrency 32 (image download is IO-bound; low CPU)
- Batches Cosmos writes at 500/doc
- Runs the per-card clustering step after all new hashes land
- Same OIDC-auth pattern as the ingest workflow

Backfill mode: `--days=90` iterates over 90 days of already-ingested sales, computes hashes for any not yet processed. Idempotent by `price_history_id`.

## Cost / rate budget

- **eBay image bandwidth:** 78k images/day × ~50KB avg = ~4 GB/day. eBay CDN, no rate-limit issues at this volume.
- **CH bandwidth:** zero (we read image_urls from Cosmos, not CH).
- **Cosmos writes:** 78k phash docs/day + 1-2k stats docs/day. Well within our current RU allocation.
- **Compute:** sharp + dHash is ~5ms per image. 78k × 5ms = ~6.5 minutes single-threaded. At concurrency 32, ~15 min wall-clock.
- **For 90-day backfill:** 7M images × 50KB = ~350 GB total download. Runs in chunks. ~10-15 hours if done sequentially; multi-workflow parallel dispatches shrink this to ~2-3 hours.

## Dependencies

- **`sharp`** — image resize + grayscale (already required if we ever add other image processing; small addition to package.json).
- **Native fetch** — image download; no new dep.
- No external ML library for Phase 1. dHash is a 30-line function.

## Testing

- **Fixture tests** for dHash: pin known-hash values for a fixed set of test images (checked into repo, small).
- **Cluster tests**: seed with synthetic hash pairs at various Hamming distances, verify grouping.
- **Integration test**: seed 3 sales for a fake `card_id` with 2 visually-different clusters (via manually-crafted hashes), verify stats surface as `suspect: true`.

## Success metrics

Phase 1 is successful when:

- ✅ All ingested daily sales get hashes within 24h of ingestion.
- ✅ `ch_card_attribution_stats.suspect=true` fires on cards we know to be problematic (Drew names 5 examples during design review).
- ✅ False-positive rate on `suspect` is < 20% across a Drew-reviewed sample of 50 cards.
- ✅ No performance regression on any other workflow.

## What Phase 2 uses this for

Phase 2 pulls CH's `/cards/card-details` for the canonical image per `card_id`. Compares that reference to each cluster's medoid image (the hash closest to the cluster center). The cluster whose medoid is closest to the reference is the "correct" cluster; other clusters are the attribution errors. That's when the raw signal becomes actionable per-sale.

## Open questions for Drew

- **Threshold tuning:** default 10-bit Hamming distance for clustering. Adjust after seeing real corpus behavior?
- **Suspect threshold:** flag `card_id` as suspect when `cluster_count ≥ 2` — should we require a minimum sales count first (e.g. only flag when total_hashed_sales ≥ 5)?
- **Backfill priority:** should we prioritize hashing the highest-volume cards first, or run strictly chronological?
- **Reference image source in Phase 2:** CH's `/cards/card-details` (best guess) vs a hand-curated reference library (higher quality, more effort). Kicked to Phase 2 design.
