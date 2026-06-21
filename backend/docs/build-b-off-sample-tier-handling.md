# Build B — off-sample tier handling design

**Status:** locked (CF-BUILD-B, 2026-06-21). Records the seven design choices for `computeBaseAnchoredParallelFMV`'s treatment of holdings whose base-auto median sits above the calibration sample's top end.

**Context:** CF-CAT-ENGINE's calibration produces per-tier `baseRelativePremium` values (e.g. Blue X-Fractor /150 = 2.974× for the 2026 Bowman CPA scope, n_strict=9). The premium is computed as a per-card paired-ratio median over a small strict-paired card set. Applying that flat multiplier to a holding whose own base-auto median sits *above* the strict-paired sample's top base re-introduces the tier-blindness CF-X2-ANCHOR closed: Hartman's $80.50 × 2.974 = $239 lands at the *top* of the CF-X2-ANCHOR honest band ($121–$241), not the center ($193). The engine isn't wrong — the application is, when the consumer treats the flat premium as an in-sample value. This doc locks how Build B distinguishes in-sample from off-sample and what it emits for each.

---

## 1+2 — Sample range & off-sample detection

**Locked: strict-set min/max, boolean above-max detection. No gradient, no percentiles.**

- Engine emits `sampleBaseRange: [number, number]` per `baseRelativePremium`. The values are the **min and max of base-auto medians across the cards that fed the strict-paired set** (the empirical-promotion gate set, n_strict cards).
- Build B detects off-sample with the boolean check `holding.baseAutoMedian > sampleBaseRange[1]`.
- **Rejected alternatives:** percentile-based detection, soft-edge thresholds (`base > max + N×IQR`), or gradient classification ("near-edge" vs "far off").
- **Reasoning:** at n_strict in the 5–13 range typical for our calibrations, percentiles are noise dressed as resolution. Hartman is 31% above max ($80.50 vs $61.24 for BXF/150) — nowhere near a knife-edge — so the threshold discontinuity is academic in practice. Resolving "slightly off" from "way off" at this n is dishonest.

## 3 — Off-sample low-end derivation

**Locked: observed top-base-bucket ratio, with flagged round-haircut fallback when the bucket is too thin.**

- Engine emits `topBaseBucketRatio: number | null` per `baseRelativePremium`. Computed as: take the strict-paired set, sort by base-auto-median descending, take the **top third (ceiling of n_strict / 3)** as the bucket. If the bucket has **≥3 cards**, emit the median of those cards' paired ratios. Else emit `null`.
- Build B uses `topBaseBucketRatio` as the low-end of the off-sample band when present.
- When `topBaseBucketRatio === null` (bucket too thin), Build B falls back to a **flagged round haircut: low-end = 0.7 × flat premium**. The off-sample emission carries an explicit "extrapolated low" flag so the consumer (iOS) renders the haircut visibly.
- **Rejected alternatives:** linear regression of (paired_ratio vs base_median) extrapolated to the holding's base (n=9 doesn't support regression honesty); arbitrary fixed-multiple haircut (no data anchor).
- **Reasoning:** the highest-base cards in the strict sample are the nearest *real* analog to an off-sample card. For BXF/150 the top-third median lands near the CF-X2-ANCHOR-derived ~2.0× high-tier read — that's an honest data-anchored floor. "Multiply the flat premium by some round haircut" is a number we made up. We accept the haircut fallback ONLY when the observed signal isn't there, and we flag it.

### Worked example (BXF/150, n_strict=9)
- Strict-paired set sorted by base descending. Top third = ceiling(9/3) = top 3 cards.
- Top 3 by base: e.g. Dasan Hill ($66 base), Dauri Fernandez ($46), Andrew Tess ($33).
- Their ratios: e.g. 3.944×, 3.119×, 2.743× → median 3.119×.
- *Note:* this is illustrative only. The actual `topBaseBucketRatio` lands wherever the data points — could be higher or lower than the flat 2.974× depending on which cards happen to be at the high end. **Build B uses whatever the engine emits; it doesn't second-guess the bucket.**

### Threshold rule
| n_strict | top-third count | bucket ≥3? | `topBaseBucketRatio` |
|---|---|---|---|
| 5 | 2 (ceiling(5/3) = 2) | NO | `null` (haircut fallback) |
| 6 | 2 | NO | `null` |
| 7 | 3 | YES | observed median |
| 9 | 3 | YES | observed median |
| 13 | 5 | YES | observed median |

This places **BXF/150, Purple/250, Speckle/299 in the observed-bucket bucket**; Aqua/125, Green/99, Green Lava/99 (n=5 each) fall to the haircut-fallback bucket. Honest by construction — the n=5 floor tiers are exactly where we shouldn't claim "the top-base cards showed X" because the top-base bucket is too thin.

## 4 — Off-sample emission shape

**Locked: distinct `estimateBasis`, tier-extrapolated flag, emits through the CF-A(a) honesty path.**

**Live-data refinement (2026-06-21 first run):** the band is `[min(value, anchorRatio), max(value, anchorRatio)]` — NOT the original spec's `[anchorRatio, value]` (which assumed tier-shrink). The first live engine run on 2026 Bowman CPA's BXF/150 produced `topBaseBucketRatio: 3.254×` > `value: 2.974×` — high-tier players' parallels carried an additional scarcity premium beyond the flat ratio. min/max handles BOTH tier-shrink and tier-inflate honestly without committing to a tier-direction prior the data may not support.

### Known limitation: off-sample upside ceiling

The off-sample band's high end is `max(value, anchorRatio) × baseMedian` — bounded by whichever of the flat premium or the top-base-bucket ratio is higher. This is honest for the current FMV (Hartman lands $239–$262, current value sits inside the band) but it **under-bounds an off-sample riser** whose value climbs past the in-sample top — there's no headroom built in for "this card could be worth more than any card the engine's seen."

**Resolution: the refresh cycle, not a static headroom factor.** As real off-sample sales accumulate (e.g. Hartman's own card or a similar-tier sibling actually sells), the next engine run firms a higher premium and the band re-fits upward on its own. Hard-coding a ceiling-above-anchor today would mean picking a headroom magnitude with no data behind it — the manufactured-number anti-pattern we've explicitly refused throughout this work. The honest version of "leave room for the rise" is to let recalibration handle it.

**Cap doesn't bite for current state.** Hartman's current implicit FMV sits inside the $239–$262 band the live data produces. The cap is dormant in practice; it would only matter once Hartman's tier sells materially above the engine's observed range, by which point the next refresh would already be re-fitting upward.

Documented because the limitation IS real (the band has no headroom prior), not because there's an action to take now.

| field | off-sample value | in-sample value |
|---|---|---|
| `estimatedValue` | `(low + high) / 2` (centroid of band) | `holding.baseMedian × premium.value` |
| `estimateLow` | `holding.baseMedian × min(value, anchorRatio)` (anchor = topBaseBucketRatio when ≥3 cards in bucket; else `0.7 × value`) | `holding.baseMedian × premium.range[0]` |
| `estimateHigh` | `holding.baseMedian × max(value, anchorRatio)` | `holding.baseMedian × premium.range[1]` |
| `valuationStatus` | `"estimated"` | `"estimated"` |
| `estimateBasis` | `"base_anchored_off_sample_paired_premium"` | `"base_anchored_paired_premium"` |
| `isEstimate` | `true` | `true` |
| `estimateConfidence` | `"ballpark"` | `"rough"` |
| `fairMarketValue` | `null` | `null` |

**iOS note (for a future CF, not Build B):** the off-sample band should render *viscerally rough*, clearly not mistakable for a confident point value. Wider visual band, "tier extrapolated" flag visible.

## 5 — In-sample emission shape

**Locked: relaxed-IQR band, `valuationStatus: "estimated"`, no extrapolation flag.**

When `holding.baseMedian` sits within `sampleBaseRange`, Build B emits a tighter band using the engine's existing `range` field (the relaxed-IQR from the engine's worksheet). No tier extrapolation, no haircut, normal `"rough"` confidence. Tighter band wins because the holding *looks like* the calibration set.

## 6 — Provenance gate & the backwards-UX artifact

**Locked: provenance-gated dormancy. Empirical-only firing. Live-with-and-flag the X-Fractor-priced-while-Refractor-pending artifact.**

- Build B fires ONLY when `baseRelativePremium.provenance === "empirical"`. Sibling-provisional or `undefined` rows: Build B returns null → fall through to existing fallback (base_auto_floor or null FMV).
- **Documented artifact:** the engine firms tiers by data availability (n≥5), not by ladder position. So Blue X-Fractor /150 (firmed at n=9) gets priced by Build B *before* its true-color twin Blue Refractor /150 (n_strict=2, held provisional) firms. A user holding both sees the textured (cheaper) parallel estimated and the true-color (pricier) twin pending. **Per-card per-tier honesty** holds (each estimate is right *for its own card*); **cross-tier visual coherence** doesn't.
- **Decision: live with it and flag.** Suppressing a valid per-card estimate to avoid an awkward cross-card comparison would be the worse trade. The artifact self-resolves as more rows firm, and the coherence-pass on the worksheet (you sweep the rainbow for ordering before merging) catches structural rotations.
- **Rejected: twin-coherence gate** (don't emit an X-Fractor estimate while its true-color twin is unpriced). Adds catalog-coupling complexity that doesn't exist today, blocks valid per-card honesty for a cross-card UX concern the worksheet review handles upstream.

## 7 — Schema delta (CF-BUILD-B engine enhancement)

**Locked: minimal additive fields on `BaseRelativePremium`.**

```ts
export interface BaseRelativePremium {
  // ... existing fields ...
  value: number;
  range: [number, number];
  n: number;
  basis: "base_auto_paired";
  provenance: "empirical" | "sibling_provisional";
  calibratedAt: string;

  // CF-BUILD-B additions (optional for back-compat with CF-CAT-ENGINE Track-a values).
  sampleBaseRange?: [number, number];      // [min, max] base-auto medians over strict-paired set
  topBaseBucketRatio?: number | null;       // observed top-third bucket median, or null if bucket <3 cards
}
```

Both fields are **optional**. CF-CAT-ENGINE Track-a values (committed without these) read as `undefined` → Build B treats as in-sample-only when present, falls back to a conservative posture (treat as off-sample with haircut) when absent.

Actually — for the dormancy guarantee, when these fields are absent, Build B should also fall through to fallback. Concretely: Build B requires BOTH `provenance === "empirical"` AND `sampleBaseRange !== undefined` to fire. This is the cleanest cut.

---

## Dormancy guarantee

At ship time:
- Zero rows in `chromeDraftMultipliers.ts` have `baseRelativePremium` populated (all 135 rows still pre-CF-CAT-ENGINE).
- Build B returns null for every lookup → falls through to existing fallback chain.
- **No live pricing changes from CF-BUILD-B shipping.**

Per-tier activation:
- Owner merges a worksheet's `baseRelativePremium` value into a row via PR (e.g. Speckle /299).
- Build B starts firing for holdings that hit that row's lookup keys.
- Subsequent worksheet PRs add more tiers; Build B activates per-tier organically.

Provenance gate ensures: no firing on sibling_provisional values regardless of PR cadence.

## Test plan (locked in CF-BUILD-B execution)

- Engine units: `sampleBaseRange` computed correctly; `topBaseBucketRatio` clears the ≥3-card gate and falls null when thin; schema migration back-compat.
- Build B units: provenance gate → null; off-sample detection boolean; off-sample band derivation (observed bucket OR haircut fallback); in-sample band; null when `sampleBaseRange` absent.
- Integration: Hartman returns null today (Blue X-Fractor /150 not yet merged empirical with the new fields) — the dormancy assertion.
- Blast radius: all holdings null/pending post-build — the proof Build B ships safe.
