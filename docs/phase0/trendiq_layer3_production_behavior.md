# TrendIQ Layer 3 — Production Behavior Characterization

**Date:** 2026-05-25
**Workstream type:** Read-only investigation. No code changes.
**Telemetry window:** 3 hours post-Layer-3-deploy (888e0a4 +
identity-completeness deploy 220f783).
**Methodology question:** Does the locked B.2 `<7d anchor` gate
produce the intended behavior in real production traffic? Are the
methodology defaults calibrated for the real cohort, or should the
threshold be adjusted?

**Headline outcome:** The locked `<7d anchor` threshold appears
well-calibrated for the current production cohort. Most
`anchor_too_recent` gates fire for genuinely actively-traded cards
(p50 anchor age = 3.9 days), exactly the population the gate was
designed to exclude. The "rare card" Layer-3-active case (Torres-class)
fired correctly in production at the expected low rate. **Recommendation:
keep the threshold as-is for V1; re-investigate at 24-48h sample size
before any change.**

## 1. Telemetry window characterized

- **Window**: 3 hours post-deploy of CF-CARDSIGHT-SIBLING-DISCOVERY
  (888e0a4 deployed this morning) and CF-CARDSIGHT-CARDIDENTITY-
  COMPLETENESS (220f783 deployed shortly before this investigation).
- **Total trendIQ composite emissions**: 12 (each `[compiq.trendIQ]
  composite=... coverage=... weights=...` log entry represents one
  user-facing TrendIQ evaluation).
- **Total fetchSiblingSales attempts**: 14 (some endpoints — /bulk
  per-item, /price-by-id with variant-mismatch short-circuits — call
  fetchSiblingSales without emitting the top-level [compiq.trendIQ]
  trace).
- **Caveat**: 12 user-facing requests across 3h is a small sample.
  Most are agent smoke + maybe 1-3 organic iOS requests. Conclusions
  below are directional, not definitive. Recommend extending window
  to 24-48h for confident calibration.

## 2. Layer 3 outcome distribution

| Outcome | Count | Notes |
|---------|------:|-------|
| `fetch_attempted` | 28 | 14 fetcher calls × 2 log lines each (open + result) |
| `gated_anchor_too_recent` | 8 | Anchor <7d, locked gate firing |
| `gated_sparse_pool` | 3 | Fetched pool, but <2 pre OR <2 post-anchor comps |

Of the 14 fetcher attempts, 11 resulted in a null Layer 3 (8 anchor-
gated + 3 sparse-gated), leaving 3 cases where Layer 3 successfully
returned a populated segmentTrajectory.

## 3. Null reason breakdown

When Layer 3 returns null, WHY:

- **`anchor_too_recent`**: 8/11 (73%) — the locked methodology gate
  is the dominant reason for null Layer 3 in this window.
- **`sparse_pool`**: 3/11 (27%) — fetcher returned cardIds, but
  windows didn't have enough comps.
- **`no_anchor`**: 0/11 (0%) — every card in the window had at least
  one direct sale (newestTs > 0).

This is the expected distribution for a cohort heavy on tracked
players (recently-traded cards) with occasional rare-prospect queries.

## 4. Anchor age distribution for `anchor_too_recent` gates

For the 8 cases where Layer 3 was gated by the `<7d` rule:

- **p10**: 0.7 days
- **p25**: 2.9 days
- **p50**: 3.9 days
- **p75**: 5.9 days
- **p90**: 5.9 days
- **max**: 5.9 days

**Interpretation**: half of the gated cards have an anchor age ≤4d —
genuinely actively-traded cards (Ohtani-class, where the rookie sells
every 4-6 days). The p75/p90/max ceiling at 5.9d indicates the
gate is NOT clustering at the threshold edge — there's no cohort of
cards "just under the 7d cutoff" that a threshold adjustment would
unlock.

If the cohort had p50 anchor age of 5-6d, that would suggest a
significant population sitting just below the threshold that a small
adjustment could unlock. The actual p50 of 3.9d says the opposite:
the gate is correctly catching active markets, not over-rejecting
marginally-recent cards.

## 5. Coverage state distribution

What users actually see in their TrendIQ block:

| Coverage | Count | Share | Interpretation |
|----------|------:|------:|----------------|
| `no_segment` | 7 | 58% | L1 + L2 active, L3 null (anchor too recent for high-volume tracked cards) |
| `card_only` | 3 | 25% | L2 only (untracked players) |
| `no_card` | 1 | 8% | **L1 + L3 active, L2 null — the "rare card" case Layer 3 was designed for** |
| `player_only` | 1 | 8% | L1 only (untracked player + sparse comps) |

**Daily TrendIQ experience**:

- Tracked players with recent comps → `no_segment` (two-layer
  composite, dominant case)
- Untracked players with recent comps → `card_only` (Layer 2 only)
- Rare cases (1 in 12 today) get the three-layer "designed for"
  experience via either `no_card` (rare card) or eventually `full`
  (rare card on a tracked player — none observed today)

The single `no_card` case in this window (Torres 2018 Topps Update)
is exactly the "rare card" use case Layer 3 was specifically built
for — sparse direct comps but rich segment data. Layer 3 fired,
populated trajectory, and contributed to the composite via the
{0.30, 0.00, 0.70} weights.

## 6. Sibling pool richness (when fetchCompsByPlayer fires)

When fetchSiblingSales actually calls fetchCompsByPlayer (player +
product both present):

- **avg siblings**: 3.3
- **p50 siblings**: 3
- **avg sales**: 16.1
- **p50 sales**: 6
- **siblings = 0**: 3/9 (33%) — empty pool (dictionary miss OR Cardsight returned only the exact card)
- **siblings > 0**: 6/9 (67%) — discoverable segment

**Interpretation**:

- Two-thirds of fetches discover a segment. That's a reasonable hit
  rate for V1.
- The remaining third (zero-siblings) is split between:
  - Dictionary misses (e.g. "Upper Deck" not in
    `COMPIQ_TO_CARDSIGHT_RELEASES` — Griffey query in this window)
  - Chrome-fallback collapses (e.g. Bonemer-class cards where only the
    exact card matches the chrome filter)
- Worth tracking dictionary coverage in CF-CARDSIGHT-COVERAGE follow-up.

## 7. Methodology assessment

The locked `<7d anchor` threshold from B.2 (843b210) is producing the
intended behavior:

- ✅ **High-volume cards correctly excluded from Layer 3** — p50 anchor
  age of 3.9d means the gate catches genuinely actively-traded cards.
  These cards have reliable Layer 2 cardTrajectory anyway; adding
  noisy segment data wouldn't improve the composite.
- ✅ **"Rare card" case activates correctly** — Torres-class queries
  (1 in 12 today) get the L1+L3 composite as designed.
- ✅ **No edge-clustering** — the p90 of 5.9d shows no cohort sitting
  just below the threshold that would benefit from a small relaxation.
- ⚠️ **Sample size caveat** — 12 user-facing requests is small. The
  signal is directionally clear but a 24-48h window would give more
  confidence.

## 8. Recommendation

**Keep the locked `<7d anchor` threshold as-is for V1.** The 3h
production data supports the methodology working as designed.

### Re-investigation criteria

Re-examine at 24-48h (after richer organic traffic):

- If `anchor_too_recent` rate falls below 50% of nulls, suggests the
  gate is firing less often than expected → may want to consider
  if it's still needed.
- If `anchor_too_recent` p50 anchor age creeps toward 5-6d (cohort
  clustering near threshold), consider relaxing to `<5d` to unlock
  more Layer 3 activation.
- If `sparse_pool` rate climbs above 50% of nulls, the issue is data
  availability, not methodology — focus shifts to CF-CARDSIGHT-COVERAGE
  (dictionary expansion + sibling discovery improvements).
- If the `no_card`+`full` (Layer-3-active) share stays at ~8-15% of
  total coverage events, the methodology is doing its job. If it
  drops below 5% or rises above 25%, methodology revisit warranted.

### Alternatives considered (and not recommended for V1)

- **Lower threshold to 3-5d**: would let mid-frequency cards (selling
  every 4-7 days) use Layer 3. Risk: introduces segment noise into
  cards that already have reliable L2 cardTrajectory. The 3h data
  shows the gated cohort is actively-traded (p50=3.9d), not edge-
  hugging. No evidence the gate is over-rejecting today.
- **Add escape valve when L2 is null**: when cardTrajectory is null
  (Layer 2 sparse), relax the `<7d` to `<3d` so Layer 3 can fill the
  gap. This addresses the "rare card with very recent single sale"
  case directly. Worth ~3-4h implementation IF the 24-48h window
  shows player_only coverage cases that would benefit. Today's
  player_only count is 1 — too small to justify the work.
- **Per-card-tier adjustment**: low-pop cards get relaxed threshold,
  high-pop cards keep strict. Requires card-tier classification we
  don't currently have. V2 candidate, premature for V1.
- **Defer entirely until 24-48h sample**: recommended above.

### What would CHANGE the recommendation

- If 24-48h window shows `no_card`+`full` share <5%, Layer 3 is
  underdelivering and methodology adjustment is warranted.
- If `sparse_pool` rate dominates `anchor_too_recent` in larger
  sample, the issue is upstream (Cardsight discovery) not the
  threshold itself — workstream shifts.
- If real user-visible complaints about Layer 3 being too
  conservative (e.g., "why doesn't Ohtani's trendIQ have a segment
  layer?"), the answer is methodology — we'd need to weigh
  segment-noise-on-active-cards vs missing-data-on-segment-layer.

## 9. Cross-references

- B.2 design lock (843b210) — `<7d anchor` threshold rationale
- 888e0a4 — Layer 3 production deploy
- 220f783 — CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS deploy
- 84d8f85 — CF-CARDSIGHT-SIBLING-DISCOVERY investigation findings
- [cardsight_sibling_discovery_investigation.md](./cardsight_sibling_discovery_investigation.md)
