# ADR-0001: Phase 3 Predictive Range — Multiplier-Anchored Synthesis Behavior

**Status:** Accepted
**Date:** 2026-05-16
**Deciders:** Owner
**Phase:** CompIQ Predictive Engine, Phase 3
**Related code:** `backend/src/services/compiqEstimate.service.ts` (cross-parallel synthesis branch), `backend/src/agents/chromeDraftMultipliers.ts`, `backend/src/agents/predictedRangeMultiplierAnchored.ts`

---

## Context

CompIQ's existing predictive output is comp-anchored FMV — the engine finds comparable sales for the subject card and produces a fair-market-value estimate. This works well when comps are dense and recent, but breaks down for thinly-traded parallels: a Drake Baldwin 2022 Bowman Blue Refractor /150 Auto may have zero direct comps in any reasonable time window. The card's value is real and bounded, but the comp-anchored path returns nothing useful.

Phase 3 adds a second predictive path: **multiplier-anchored predicted range**, derived from (a) a player-baseline computed from the player's better-traded parallels, multiplied by (b) an owner-curated multiplier specific to the subject parallel within its brand family. The owner has hand-built a 54-entry multiplier table for Bowman Chrome / Draft parallels representing significant domain-expertise work product.

The architectural question Phase 3 answers: **when do we run multiplier-anchored synthesis, and when do we suppress it?** Three sub-questions had to be resolved:

1. Does multiplier-anchored output **replace** comp-anchored FMV, or run **alongside** it?
2. What does the engine do when the **subject's** parallel has no curated multiplier?
3. What does the engine do when the **player-baseline peers** (the cards used to compute the baseline) are themselves uncurated?

Each has plausible alternatives. The decisions below are the locked outcomes.

---

## Decision 1: Alongside, not replace

Multiplier-anchored predicted range runs **in addition to** comp-anchored FMV, not as a substitute. Both outputs are returned to the consumer.

### Alternatives considered

- **Replace FMV with multiplier-anchored range when available.** Cleaner consumer surface (one number, not two). Rejected because the two methods answer different questions: FMV says "what did this trade for recently"; multiplier-anchored says "what *should* this trade for given the parallel structure and player baseline." Both are useful. Suppressing FMV when multiplier-anchored is available hides information.
- **Run multiplier-anchored only when FMV is below confidence threshold.** Tempting because it minimizes consumer-facing complexity. Rejected because "FMV confidence" is itself a derived signal and conditioning one prediction path on another creates coupling that's hard to debug.

### Consequences

- Consumer (UI, downstream services) must handle the dual-output case explicitly. The Phase 3 service contract returns both fields; consumers decide how to display.
- The two outputs can disagree. That's a feature, not a bug — disagreement is signal worth surfacing. (Future work: a confidence-weighted reconciliation or explicit disagreement flag is out of scope for Phase 3.)
- Engine cost is slightly higher per query (two paths instead of one) but the multiplier-anchored path is cheap relative to the comp-lookup it shares infrastructure with.

---

## Decision 2: Skip synthesis when subject parallel is uncurated

If the subject card's parallel does not have an entry in the owner-curated multiplier table for its brand, the multiplier-anchored path **returns nothing** (no predicted range). Comp-anchored FMV still runs normally. The engine logs `uncurated-subject-parallel: {brand, parallelName}` for owner visibility.

### Alternatives considered

- **Best-guess multiplier from nearest curated entry.** E.g. if "Magenta Refractor /99" isn't in the table but "Purple Refractor /99" is, use the Purple multiplier. Rejected because parallel multipliers don't interpolate by color — they're driven by scarcity, hobby preference, and market-specific dynamics the owner has direct knowledge of. A best-guess substitution would silently produce wrong numbers under a confident-looking output.
- **Use a default multiplier (e.g. 1.0) when uncurated.** Rejected because 1.0 is wrong for almost every parallel — base cards don't anchor to themselves, and any number we'd pick is arbitrary.
- **Run the path anyway with a confidence flag saying "uncurated".** Rejected because consumers will display the number and ignore the flag. The right behavior is to not emit a number at all.

### Consequences

- Coverage of multiplier-anchored output is gated by the multiplier table's coverage. Today: Bowman Chrome / Draft only. Other brands return FMV only until owner curates their tables.
- The Phase A.3 + Phase B pipeline produces eligibility reports that surface uncovered parallels for owner curation. This decision and that pipeline are tightly coupled.
- Cards in uncurated brands degrade gracefully — they still get FMV, they just don't get the multiplier-anchored second opinion.

---

## Decision 3: Strict when peers are uncurated — require 3+ curated

The player-baseline is computed from the player's better-traded parallels. For the baseline to be trustworthy, **at least 3 of those peer parallels must be curated** (have entries in the multiplier table). If fewer than 3, the multiplier-anchored path returns nothing for this card even if the subject parallel itself is curated.

### Alternatives considered

- **No minimum — use whatever peers exist, even one.** Rejected because a single-peer baseline is dominated by that one peer's noise. Any market wobble in the single peer card cascades into the predicted range for the subject.
- **Require 5+ curated peers.** Considered. Rejected as too strict for typical Bowman Chrome players whose curated-parallel peer set may be 3-4 cards. 3 is the empirical floor where the baseline is still meaningful.
- **Weight peers by curation confidence rather than requiring minimum.** Architecturally more elegant but introduces another parameter to tune and another signal to debug. The hard 3+ rule is simpler and explainable.

### Consequences

- Some cards where the subject parallel IS curated will still not get a multiplier-anchored range, because their player's peer set isn't curated enough. This is correct behavior — the subject's multiplier is meaningful only against a meaningful baseline.
- For new players (e.g. recent prospects) with limited parallel issuance, the multiplier-anchored path may not kick in until the player has more curated parallel coverage. Acceptable.
- As the multiplier table coverage grows (Phase A.3 + Phase B + owner curation over time), more cards become eligible. Coverage growth is monotonic — new curation enables new cards, doesn't break existing ones.

---

## Why these decisions, taken together

The three decisions form a consistent posture: **the multiplier-anchored path is opt-in via curation, fails closed, and doesn't degrade the existing FMV signal.** Whenever the engine isn't confident it has the curator's intent encoded for both the subject and the baseline, it suppresses the new output rather than guessing. The cost is reduced coverage; the benefit is that whatever the engine *does* emit on the multiplier path reflects the owner's actual domain knowledge, not an interpolation.

This posture is conservative on purpose. Phase 3 introduces a new predictive surface, and the failure mode of a wrong-looking confident number is worse than the failure mode of a missing number. Consumers can handle "no multiplier-anchored range available" cleanly. Consumers cannot reliably handle a number that looks right but was synthesized from uncurated guesses.

---

## When to revisit

These decisions should be re-examined if:

1. **Coverage stays low long-term.** If after extensive owner curation work, the multiplier-anchored path still fires on <30% of queries, the strictness of Decision 3 (or possibly Decision 2) may be too tight. Loosening criteria with explicit confidence flags would be the path.

2. **Disagreement between FMV and multiplier-anchored output exceeds a tolerance band consistently for specific brands or eras.** That's a signal the multiplier table for that brand needs revision, OR that Decision 1 (alongside, not replace) should evolve into a reconciliation step.

3. **A new prediction signal is introduced (e.g. population reports, pop-weighted comps).** The Decision 1 "alongside" pattern may not generalize to N predictive paths — at some point the engine needs an explicit reconciliation layer rather than emitting parallel signals.

4. **Owner ships brand-scoped multiplier tables beyond Bowman family** (per Phase A.3 architectural decision) and observes whether Decision 3's hard 3+ rule works across brand families with different parallel ladder structures. Topps Heritage's parallel structure differs materially from Bowman Chrome's; the 3+ floor may need brand-specific tuning.

---

## Related decisions

- Phase A.3: brand-scoped multiplier tables, no cross-brand canonicalization. Decisions 2 and 3 inherit this — coverage is checked within brand, not across.
- Phase B: eligibility analyzer gates set-level ingestion on 100% multiplier-table coverage. This ADR's Decision 2 is the engine-side counterpart to that pipeline-side rule.
- PR #41 (deployed 2026-05-16): engine-wide autograph identity bug fix. Phase 3's multiplier-anchored path depends on correct CH lookup behavior PR #41 enabled.

---

## Notes

- Owner-curated 54-entry multiplier table for Bowman Chrome / Draft is the source of truth for canonical parallel naming convention across the engine.
- The cross-parallel synthesis branch in `compiqEstimate.service.ts` is the architectural hook seam for Phase 3 (diagnosed via Caleb Bonemer test case during Phase 3 implementation).
- Decisions documented post-implementation; they were locked in conversation during Phase 3 prompt work and encoded in code before this ADR was written. ADR captures intent for future maintainers.
