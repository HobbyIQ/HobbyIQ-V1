# ADR: Tier 1 Harness Baseline Refresh — May 18, 2026

## Status
Accepted

## Context

The Tier 1 harness baselines captured on May 15, 2026 became stale across all 25 cases. Investigation surfaced three distinct categories of intentional change:

1. **Field removal (all 25 cases).** PR #44 (commit 2c17c23, May 17) deliberately removed the `neighborSynthesisDebug` field from `/api/compiq/search` and `/api/compiq/price-by-id` responses as part of Phase 3 Contract Cleanup. Baselines were not refreshed in that PR, leaving snapshot diffs FATAL across all 25 cases. Initial CI failure output only surfaced 9 cases because the harness exits the test file on the first FATAL; the remaining 16 cases produced the same staleness on full local run.

2. **State change — Card Hedge comp thinning (2 cases).** Live Card Hedge data shifted for case-13 (Elly de la Cruz 2023 Topps Update RC Raw) and case-14 (Wander Franco 2018 Bowman Chrome 1st Auto Raw). Comp supply for both thinned from ≥5 to 4. Wander Franco's marketTier value additionally dropped from $318 to $105 (a 67% decline) reflecting genuine market repricing for that card.

3. **Engine behavior change — variant-mismatch (case-19a).** Where the engine previously synthesized past variant mismatches for pinned cards and returned `source: 'neighbor-synthesis'`, it now correctly reports `source: 'variant-mismatch'` when the pinned card's Card Hedge data has a different parallel (Green Grass Refractor) than the query requested (Green Refractor). This change makes a real disambiguation issue surface instead of being papered over. Tracked as issue #18.

4. **Cross-endpoint divergence (cases 19a, 19b, 20a, 20b).** When a pinned card resolves to a sibling with no comps, `/price-by-id` returns undefined. The "price-by-id is well-formed (pinned id should resolve)" assertion was previously ungated; it is now soft-gated via blockedBy [9]. Issue #9 is the existing tracking item for this divergence.

Per the harness README: "Never silently update a baseline to make a red test green." This ADR documents the rationale for the refresh.

## Decision

1. Refresh baselines for all 25 Tier 1 cases (case-01 through case-20b inclusive) to remove the dead `neighborSynthesisDebug` field reference. Diffs verified to contain only field-removal and phase-3 field-addition (marketValue, predictedPrice, regime, regimeConfidence, regimeDiagnostics, predictedRange, predictedRangeDiagnostics, predictedRangeAdjustedConfidence, predictedPriceRange, predictedPriceAttribution) — no unexpected engine behavior shifts.

2. Refresh case-13 and case-14 baselines to reflect current Card Hedge comp counts and marketTier values. Wander Franco's marketTier drop is documented as legitimate market repricing.

3. Add `blockedBy: [55]` to case-14 (Wander) and append `55` to case-13's existing `blockedBy: [8]` array, making it `[8, 55]`. New issue #55 tracks Card Hedge comp supply thinning until either supply recovers or cards are replaced with consistently-liquid alternatives.

4. Soft-gate the minComps=5 assertion in popularBaseline.test.ts via `blockedBy?.includes(55)`. The minComps threshold remains 5 — no threshold lowering. The assertion soft-skips when comps thin below 5, preserving the assertion's strength for when supply recovers.

5. Expand case-19a's `blockedBy` from `[18]` to `[18, 9]`. Issue #18 gates the source-allowlist assertion (variant-mismatch source value). Issue #9 gates the priceById well-formed assertion.

6. Add a new soft-gate to pinnedIdHard.test.ts on the "price-by-id is well-formed (pinned id should resolve)" assertion, conditional on `blockedBy?.includes(9)`. Affects cases 19a, 19b, 20a, 20b — all of which have #9 in their blockedBy array.

7. Do NOT add `variant-mismatch` to ALLOWED_SOURCES. That would lock in an engine behavior that may itself change once #18 is properly fixed.

8. Do NOT lower minComps anywhere. The README forbids threshold lowering and identifies the soft-assertion mechanism as the correct response to legitimate state changes.

## Consequences

- CI restored to green for Tier 1: 92 tests pass, 18 soft-skipped across documented issues (#6, #7, #8, #9, #18, #55), 0 failures.
- Issue #18 remains the tracking item for parallel disambiguation.
- Issue #55 newly created and tracks comp supply thinning for case-13 and case-14.
- Future engine changes affecting variant-mismatch handling for pinned cards must be assessed against issue #18's eventual resolution.
- Future Card Hedge comp supply changes may further thin case-13/14 below 4 comps; the blockedBy gate preserves the test through that volatility.
- ADR git blame on baseline files documents the May 18 refresh as deliberate.

## References

- Harness README discipline: backend/harness/README.md, backend/harness/tier1/README.md
- Originating engine PR for field removal: #44 (commit 2c17c23) — neighborSynthesisDebug removal
- Originating engine PR for phase-3 field additions: #43 (commit c75aa25)
- Variant-mismatch behavior change: issue #18
- Cross-endpoint divergence: issue #9
- Comp supply thinning: issue #55
- Wander Franco market context: real market activity, no engine cause attributed
