# Comps Filter Diagnostic: Drake Baldwin (`compsUsed=0`, `compsAvailable=27`)

Date: 2026-05-17  
Scope: Read-only analysis from existing artifacts and code paths only (no production calls).

## Executive answer

The `fairMarketValue` `$311.50` is **not** from direct comps. It comes from the neighbor synthesis fallback path in `computeEstimate()`, which runs when direct variant-matched comps are zero. In this response shape, `compsUsed` refers to direct comps used for live FMV, while neighbor synthesis output is surfaced separately (`source: "neighbor-synthesis"`, `neighborsUsed: 24`).

Evidence from raw artifact (`attempt-2`):

- `fairMarketValue: 311.5`
- `compsUsed: 0`
- `compsAvailable: 27`
- `source: "neighbor-synthesis"`
- `neighborsUsed: 24`
- explanation includes: `Built indicative FMV from 24 of 27 related Card Hedge sales...`

## 1) Source of `$311.50` when `compsUsed=0`

### Code path

In `backend/src/services/compiq/compiqEstimate.service.ts`:

1. Comps are fetched into `fetched.comps`.

1. Recency filter + variant filter run.

1. If variant mismatch is critical (including all recent comps rejected), code enters variant-mismatch fallback.

1. Fallback runs `synthesizeFromNeighbors(...)` over the broader neighbor pool (`combinedComps`), and if successful returns:

- `fairMarketValue = syntheticFmv`
- `source = "neighbor-synthesis"`
- `compsUsed = 0`
- `compsAvailable = fetched.comps.length`
- `neighborsUsed = neighborResult.neighborsUsed`

So there is no contradiction in code semantics: direct comp count can be zero while FMV is synthesized from related neighbor sales.

### Why exactly `$311.50`

In `backend/src/services/compiq/neighborSynthesis.ts`, FMV preference is:

- anchor (same parallel tier) if present, else
- trimmed median synthetic price.

In the Drake artifact, `neighborSynthesis.anchor` is `null`, so FMV comes from trimmed-median synthetic prices. The detail list includes a synthetic price entry of `$311.50`, and final `syntheticFmv` is `$311.50`.

## 2) Filter chain walkthrough (27 -> 0)

Subject: Drake Baldwin, 2022 Bowman Chrome, Blue Refractor Auto, Raw

### Stage counts

1. Fetch stage (`fetched.comps`):

- In: N/A
- Out: 27
- Source in artifact: `compsAvailable: 27`

1. Player-identity guard:

- In: 27
- Out: 27
- No `player_mismatch` warning in Drake attempt-2.

1. Recency filter (`applyRecencyFilter`, 21-day rule):

- Rule: keep only last 21 days if that yields >= 3 comps, else keep full pool.
- In: 27
- Out: 3
- Why: there are 3 comps in early May 2026 (within 21 days of run time); older comps are from 2025 and excluded at this stage.

1. Variant filter (`isCompVariantMatch`):

- In: 3
- Out: 0
- Reason: all 3 failed `parallel_mismatch` for requested specific parallel `Blue Refractor`.
- Artifact text confirms: `all 3 fetched comps rejected by variant filter (parallel_mismatch×3)`.

1. Comp-quality filter:

- Not reached for direct pricing branch.
- Variant-mismatch critical short-circuits before quality filtering is used to produce live direct FMV.

1. Fallback synthesis path:

- Neighbor pool basis: 27 related Card Hedge sales
- Neighbors used after synthesis filters: 24
- Output: synthesized FMV `$311.50`

### Stage responsible for `27 -> 0`

It is a two-step collapse in direct-comp path:

- `27 -> 3`: recency filter (21-day window)
- `3 -> 0`: variant filter (`parallel_mismatch` on all 3)

The decisive zeroing stage is variant filtering of the recency-reduced set.

## 3) Sample rejected comps and plausibility

Below are 5 rejected examples from the available pool and why they were rejected.

### A) Rejected at variant filter (direct trigger to zero)

1. `2022 Bowman Draft Drake Baldwin 1st Chrome Auto #CDA-DBN ROY Braves - Raw`

- Rejection reason: `parallel_mismatch:expected_Blue Refractor`
- Plausibility: legitimate Drake Baldwin auto comp, but no explicit Blue Refractor token. Rejection is consistent with strict exact-variant logic.

1. `2022 Bowman Draft Chrome 1st AUTO Drake Baldwin #CDA-DBN Braves RC MINT - Raw`

- Rejection reason: `parallel_mismatch:expected_Blue Refractor`
- Plausibility: same as above; auto is present but requested parallel is missing.

1. `2022 Bowman Chrome Draft 1st Bowman Drake Baldwin Auto #CDA-DBN - Raw`

- Rejection reason: `parallel_mismatch:expected_Blue Refractor`
- Plausibility: same as above.

### B) Rejected at recency filter (not in 21-day direct pool)

1. `2022 Bowman Draft Drake Baldwin Chrome Auto 1st #CDA-DBN Braves - Raw 10` (2025-08-12)

- Rejection reason: outside 21-day recency window for direct comp pricing.
- Plausibility: valid related comp, but intentionally excluded from direct recent-live FMV.

1. `2022 Bowman Draft Chrome Drake Baldwin 1st Auto #CDA-DBN ATL Braves Rookie RC - Raw 10` (2025-06-30)

- Rejection reason: outside 21-day recency window for direct comp pricing.
- Plausibility: valid related comp, intentionally excluded from direct recent-live FMV.

### Owner-facing assessment of rejections

- Variant-filter rejections: mostly legitimate for strict direct exact-variant pricing; these are base/unspecified auto comps, not clearly Blue Refractor comps.
- Recency-filter rejections: also by design for direct FMV, but this is conservative for low-volume cards.
- Mitigation already active: those older/related comps are still used in neighbor synthesis, which is exactly why FMV is non-null.

## 4) Comparison against known-good high-volume case

Comparison artifact used (existing baseline):

- `backend/harness/tier1/baselines/case-16-ken-griffey-jr-1989-upper-deck-rc-psa9.json`

### Comparison chain summary (Ken Griffey Jr PSA 9)

From baseline payload:

- `source: "live"`
- `compsUsed: 26`
- `compsAvailable: 26`
- `variantWarning: []`

Interpretation:

- No variant collapse happened.
- No fallback synthesis was needed.
- Direct comps survived through filtering and were used end-to-end.

### Drake vs comparison

- Drake: specific parallel+auto request with sparse exact-variant recent comps -> recency reduced pool, variant stage zeroed survivors, fallback synthesis used.
- Griffey: dense, base variant, high-liquidity card -> direct path survives and prices live comps directly.

Conclusion from comparison:

- This does not look like a universal filter-chain bug.
- It is primarily a sparse exact-variant path behavior (Drake-specific context), with conservative direct filters and explicit fallback synthesis.

## Recommendation

Recommendation: **Engine is correct for current design semantics.**

- `compsUsed=0` means zero direct exact-variant comps used in live FMV path.
- `$311.50` derives from neighbor synthesis fallback (`source: "neighbor-synthesis"`, `neighborsUsed: 24`).
- Ship decision should focus on whether synthesized FMV is acceptable for this scenario, not on an internal contradiction.

Secondary note:

- The direct-comp filter chain is conservative for low-volume cards, but it is currently mitigated by synthesis fallback. If owner wants less conservative direct behavior, that is a policy change (Phase 3.1), not evidence of a runtime bug in this run.

## Time-box / limitations

- No production calls were made.
- Counts are reconstructed from existing artifact fields + deterministic code logic.
- Exact per-stage rejection logs are not persisted for every stage in the artifact; where missing, stage outputs are inferred from dates and branch behavior.
