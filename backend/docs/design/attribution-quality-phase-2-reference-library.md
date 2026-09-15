# Attribution Quality — Phase 2: Reference Library + Confidence Scoring

**Status:** design draft (2026-07-17). Awaits Drew review before code lands.
**Prereq:** Phase 1 (PR #506) merged + active, at least 7 days of hashed sales in `ch_sale_phashes`.
**Precedes:** Phase 3 (comp-pool filtering), Phase 4 (iOS surface + user feedback), Phase 5 (LLM vision escalation).

## What Phase 2 ships

For each `card_id` with clustered sales from Phase 1:

1. Fetch (or accept a user-attested) **canonical reference image**.
2. For each cluster, compute its **medoid** (the member closest to the cluster's own center).
3. Score each cluster against the reference by Hamming distance.
4. Emit a per-sale `attribution_confidence` (0–1) combining sale→cluster fit, cluster→reference fit, and cluster size.

Phase 2 = **observability + per-sale confidence scoring**. Phase 3 is where anything acts on those numbers.

## What Phase 2 does NOT do

- Doesn't touch iOS (Phase 4)
- Doesn't change any comp-pool query filter (Phase 3)
- Doesn't call LLM vision (Phase 5)
- Doesn't feed user "wrong card" flags back into the reference (Phase 4)
- Doesn't take Phase 1's data-normalization gap on — that's Phase 6+

Phase 2 emits the number that everything downstream reads.

## Where the canonical reference comes from

Three ranked sources:

1. **User-attested** (`reference_source = "user-attested"`) — a HobbyIQ user with high reputation confirmed "this is the card." Highest trust; used first when present. Feedback loop lands in Phase 4.
2. **CH `/cards/card-details`** (`reference_source = "cardhedge-card-details"`) — CH's catalog carries a `front_image_url` per card_id (verified 2026-07-16 in `cardhedge.client.ts` line 119-120). Default source for Phase 2 bootstrap. Free within our existing CH rate limit.
3. **Computed medoid of largest cluster** (`reference_source = "computed-medoid-fallback"`) — bootstrap when CH has no image AND no user attestation. Circular reasoning (we're using our own data to check our own data) but better than nothing for small-tail cards where CH's catalog is sparse.

**Never** hand-curate. The scale kills it (millions of card_ids). If we ever need hand-curation, that's a very-late-Phase problem.

## Algorithm

### Step 1: Compute cluster medoids

For each cluster from Phase 1 with N members and hashes `h_1, ..., h_N`:

```
medoid_idx = argmin_i sum_j hamming(h_i, h_j)
```

The medoid is the member with the smallest total distance to every other member. Interpretation: the "typical" sale in the cluster — the one that best represents what the cluster looks like on average.

**Runtime:** O(N²) per cluster. N is typically < 500. Sub-second per card.

### Step 2: Score cluster vs reference

For each cluster, compute:

```
cluster_ref_distance = hamming(medoid.hash, reference.hash)
```

Hamming distance in 64-bit space: 0 = pixel-identical, 64 = complete inverse.

**Interpretation bands** (defaults, tune on real corpus):

- `0-8`: cluster is the reference. Confidence signal ~1.0.
- `9-15`: cluster is close to reference. Same physical card, different lighting/framing. Confidence ~0.85.
- `16-25`: cluster is materially different from reference. Different parallel or wrong card. Confidence ~0.4.
- `26+`: cluster is grossly different. Attribution error. Confidence ~0.15.

### Step 3: Per-sale confidence score

For each sale in cluster `C`:

```
sale_to_medoid = hamming(sale.hash, C.medoid.hash)  // how well this sale fits its own cluster
cluster_to_ref = hamming(C.medoid.hash, reference.hash)  // how well the cluster matches the reference
cluster_size = |C|

fit_score = 1 - (sale_to_medoid / 64)          // 0..1, higher = better fit
match_score = 1 - (cluster_to_ref / 64)        // 0..1, higher = closer to reference
size_score = min(1, cluster_size / 10)         // 0..1, saturates at 10 sales

attribution_confidence = geomean(fit_score^2, match_score^3, size_score^1)
```

Weighting choice: `match_score` cubed (weight 3), `fit_score` squared (weight 2), `size_score` linear (weight 1). Cluster-vs-reference match matters most (it's the definition of correctness); sale-vs-cluster fit matters second (it's a data-quality signal); cluster size is tie-breaker.

Total weight = 6. `attribution_confidence` = `(fit_score^2 * match_score^3 * size_score^1)^(1/6)`.

### Step 4: Threshold decisions

| Confidence range | Label | Downstream behavior |
|---|---|---|
| ≥ 0.9 | **verified** | Full weight in comp pool; Phase 3 default. |
| 0.7–0.9 | **likely** | In comp pool, weighted by confidence in weighted-median math. |
| 0.4–0.7 | **review** | Surfaces in a manual review queue. Not in comp pool. |
| < 0.4 | **suspect** | Excluded from comp pool. Flag for CH taxonomy escalation. |

## Cosmos data model changes

### New: `ch_card_references` container

- Partition: `/card_id`
- Doc id: `card_id`
- No TTL (references are audit history)

```typescript
interface CHCardReference {
  id: string;                  // = card_id
  card_id: string;
  reference_image_url: string;
  reference_hash: string;      // dHash of the reference image
  reference_hash_algo: "dhash-v1";
  reference_source:
    | "user-attested"
    | "cardhedge-card-details"
    | "computed-medoid-fallback";
  reference_verified_by?: string;  // userId when user-attested
  reference_computed_at: string;   // ISO
  reference_download_ms: number;
  reference_download_bytes: number;
}
```

### Extend: `ch_sale_phashes` fields

Two new fields per sale doc:

```typescript
// existing CHSalePhashDoc gains:
attribution_confidence: number;    // 0..1
attribution_label: "verified" | "likely" | "review" | "suspect";
```

Population: Phase 2 orchestrator writes these after computing confidence.

### Extend: `ch_card_attribution_stats` fields

```typescript
// existing CHCardAttributionStats gains:
reference_cluster_id?: number;         // which Phase 1 cluster is closest to the reference
reference_present: boolean;            // did we resolve a reference at all?
median_attribution_confidence: number; // aggregate signal per card
confidence_distribution: {             // counts per band
  verified: number;
  likely: number;
  review: number;
  suspect: number;
};
```

## Services (structure mirrors Phase 1)

- `phashReference.service.ts` — fetch CH card-details, compute reference dHash, upsert to `ch_card_references`.
- `phashConfidence.service.ts` — pure functions: cluster medoid, cluster-vs-reference score, per-sale confidence formula.
- `phashPhase2Orchestrator.service.ts` — orchestrates the loop: for each card_id with new Phase 1 hashes but no reference, resolve reference → compute all confidences → update stats. Idempotent per card_id.

## Workflow

`.github/workflows/ch-attribution-phase2.yml` — new scheduled workflow.

- Schedule: 07:00 UTC daily (1h after Phase 1's 06:00 UTC hash+cluster pass).
- Reads cards touched by Phase 1 in the last 24h.
- Backfill mode: `--days-back=N` iterates over all previously-hashed cards to compute confidence retroactively.

## Cost / rate budget

- **CH card-details bandwidth:** one call per unique card_id we haven't fetched a reference for. Typically 1-3k unique cards touched per day. Well within our existing CH rate limit.
- **eBay image bandwidth:** zero — the reference image URL is on CH's CDN, not eBay.
- **Cosmos writes:** ~78k phash confidence updates/day + ~2k reference upserts/day. Modest.
- **Compute:** all in-process math, sub-second per card.

## Rate-limit note

CH's `/cards/card-details` isn't documented as rate-limited but their whole API is on the Elite/Enterprise tier we already use. If we start hitting a limit at 1-3k calls/day, add:
- Batch prefetch: pull card-details for a full day of hashed cards in one loop with retry-with-backoff.
- Cache aggressively: reference doesn't change after first fetch (card art is stable).

Neither is expected to be needed at Phase 2 scale.

## Success metrics

Phase 2 is successful when:

- ✅ ≥ 80% of card_ids that have hashed sales also have a resolved reference (bounded by CH's card-details coverage).
- ✅ Confidence-band distribution across the corpus: ≥ 70% `verified`, ≤ 20% `likely`, ≤ 8% `review`, ≤ 2% `suspect`. Anything outside these bands means threshold tuning is off.
- ✅ On Drew's 20-card manual audit: `suspect` false-positive rate < 20%, `verified` false-negative rate < 5%.
- ✅ No performance regression on any Phase 1 or upstream workflow.

## Dependencies

None new. `sharp` from Phase 1 handles reference-image hashing. No new npm deps.

## Testing plan

- **Confidence formula unit tests**: verified via fixtures — perfect match (fit=1, match=1, size=10) → 1.0; worst case (fit=0.5, match=0.2, size=1) → ~0.28.
- **Medoid computation**: 5-member cluster with obvious center → medoid is the center; 5-member cluster with two subgroups → medoid picks the tighter subgroup's center.
- **Reference-fetch integration**: mock CH `/cards/card-details` response with a known image URL, verify the reference doc lands with the correct hash.
- **Threshold band assignments**: pin the label boundaries.

## What Phase 3 uses this for

Phase 3 flips a comp-pool query filter: `WHERE attribution_confidence >= 0.7` becomes the default read. Suspect + review sales stop counting toward FMV math. That's when the raw Phase 1/2 signal becomes user-visible product value.

## Open questions for Drew

- **Confidence formula weights:** cluster→reference match at weight 3, sale→cluster fit at 2, size at 1. Adjust after seeing real-corpus distribution?
- **Threshold bands (0.9/0.7/0.4):** where should the cuts land? Real data will show whether the current guesses are near-right or off.
- **CH card-details coverage:** we assume ≥ 80% of card_ids have a `front_image_url`. Worth a quick probe once Phase 1 has 30 days of data — hit `/cards/card-details` for 100 random hashed card_ids, count image URL presence.
- **Reference cluster tie:** what if two clusters are equidistant from the reference? Default: pick the larger one. Alternative: mark as ambiguous, kick to LLM escalation earlier.
- **User attestation trust math:** how many attestations does it take to override CH's reference? Ties into the reputation infra (PR #463).
