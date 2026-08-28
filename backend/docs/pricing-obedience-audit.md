# Pricing-obedience audit — the Ohtani case

Drew, 2026-08-28. Trigger: a 2018 Topps Chrome Ohtani Refractor repeatedly
priced like the base card, surfaced by notification. This document pins the
audit so the fix session starts from evidence, not archaeology.

## The acceptance test

`hiq:baseball:2018:topps-chrome:150:refractor:no-auto`, PSA 10, must price
from its own pool and the divergence digest must stop firing on it.

Measured 2026-08-28 (sold_comps):

| pool | PSA 10 | raw |
|---|---|---|
| refractor slug | **130** | 159 |
| base slug | 528 | 868 |

There is no thin-pool justification. The correct answer exists in the data.

## Ruled OUT

- `hobbyIqFmv` composite/sibling fallbacks — gated on `directSlugCount < 3`
  (`hobbyIqFmv.service.ts` ~L389). 130 comps never reaches them.
- The compiqEstimate sibling *backport* — fires only when
  `resolvedEstimatedValue === null` (`compiqEstimate.service.ts` ~L6740).
  Correctly last-resort.
- `unifiedPricing` doctrine — `marketValue` is trend-lifted, `predictedPrice`
  is the projection. The word "median" in `basisNote` is the trace of an
  input, not the method. One real gap fixed 2026-08-28: the
  `?? u.fmv` fallback could return a bare median; order is now
  `marketValue ?? predictedPrice ?? fmv`.

## Confirmed defects

1. **Two valuation paths** (the standing `one valuation path, not two`
   ruling, still violated). Holdings' graded estimates run through the
   Cardsight-era compiler (`compileGradedEstimatesForCard.ts`,
   `compiqEstimate.service.ts` L2335+ sibling pools) — a separate engine
   from unified/canonical, still calling `getCardDetail` (cardsight.client)
   for parallels. The Hartman case (2026-07-28, PSA 9 Gold Refractor Auto:
   engine $339 vs exact-identity sales $1,475/$2,500) is this path walking
   past exact sales into a dilutive sibling rung. The July "fix" added the
   CostBasisDivergenceAlert digest (`boundedProjectionAlerts.service.ts`
   ~L68) ON TOP — the digest IS the notification Drew keeps receiving. The
   engine prices wrong, detects the divergence, and emails instead of
   pricing right.

2. **Stale legacy identity on holdings.** Live holding observed with
   `cardsightCardId = …:base:no-auto` beside a correct
   `hobbyiqCardId = …:refractor:no-auto`. Only reader found in src:
   `missingParallelsAnalyze.service.ts` L116 (discovery, not pricing) — but
   the stale field is a standing hazard. `recheck-holding-identity` re-derives
   holdings; run APPLY=true after the checklist rebuild settles.

## The fix session, scoped

1. Route holding reprice + graded estimates through the unified/canonical
   engine (exact-identity first, projection not median, grade cells from
   GRADE_CALIBRATION). The legacy graded compiler becomes a fallback for
   cells unified declines, then retires.
2. Exact-identity supremacy as an invariant: when the exact (slug, grade)
   cell has >= 3 comps in-window, no sibling/composed/premium rung may set
   the level. Assert it, don't just order it.
3. Re-point the divergence digest at market moves: fire only when the price
   came from the exact pool. A divergence produced by a fallback rung is an
   engine bug report, not a user notification.
4. Acceptance: the Ohtani case above, plus Hartman regression
   (`compileGradedEstimatesForCard` must anchor on the $1,475/$2,500 exact
   sales, never $339).

`backend/src` + tests + `tsc --noEmit` + deploy dispatch + shaShort verify.
