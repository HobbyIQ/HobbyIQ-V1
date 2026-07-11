# No-Null Pricing Architecture

**Owner:** Drew · **Draft date:** 2026-07-11 · **Status:** in-flight (this arc)

## Problem statement

The engine's current fallback chain can return `fairMarketValue: null` +
`fmvMechanism: "unavailable"` for cards where the pipeline can't anchor a
price (Hartman-class + entirely uncatalogued modern cards + pre-1996
vintage without direct comps). iOS surfaces these as "Can't estimate yet".

With the reference catalog now covering **1887-2026 across 286 productKeys
and 8,673 documents**, we have enough structural knowledge to price
*every* identifiable card — the question is what to project against when
comps are absent.

## Design principles

1. **Never null when identifiable.** If the engine can identify
   `(year, product, parallel?)` from the input, it emits SOMETHING.
   Only garbage input returns null.

2. **Transparent tiering.** The response carries `pricingTier` telling
   iOS which fallback fired. iOS renders each tier differently so users
   see confidence at a glance.

3. **No additive blend.** Same principle as Phase 5 — each tier fires
   alone; we never sum a comps-driven price with a structural floor.

4. **Confidence decays down the chain.** `pricingConfidence` drops
   monotonically as we move to coarser fallbacks. The number is the
   contract iOS uses to mute display.

## The fallback chain (top → bottom)

| Tier | Mechanism | Anchor | Fires when | Confidence |
|---|---|---|---|---:|
| 1 | `direct-comps` | player+product+parallel sales | ≥3 comps | 75-95 |
| 2 | `sibling-pool` | weighted median across sibling parallels | ≥3 sibling comps | 60-70 |
| 3 | `product-family-projection` | parent product base median × family multiplier | family match | 55 |
| 4 | `parallel-floor-projection` | parent-player base median × ladder tier | thin comps + ladder hit | 55 |
| 5 | `scarcity-prior-floor` (Phase 5 v2) | product-year cross-player median × ladder tier | zero player comps + ladder hit | 40 |
| **6 (NEW)** | **`reference-catalog-baseline`** | **era baseline × ladder tier** | **ladder hit + no comps at all** | **25** |
| **7 (NEW)** | **`setdoc-baseline`** | **SetDoc era-typed baseline × grade multiplier** | **year + product identify** | **15** |
| 8 | `unavailable` | none | truly unidentifiable input | 0 (null) |

Tier 6 and 7 are the new work.

## Tier 6 — `reference-catalog-baseline`

**Fires when:** the reference catalog has a ParallelDoc for
`(product, year, parallel)` but no comps exist at any level (player,
product-year cross-player, family). This is the "Level 5 also missed"
case.

**Formula:**
```
floor = eraBaseline(productKey, year, cardClass) × tierMultiplier(printRun, cardClass)
range = floor × [0.5, 2.0]   // wider than Level 5's ±40%
```

**`eraBaseline(productKey, year, cardClass)`** — a small refreshed-daily
Cosmos container (`era-baselines`) computed by a background job that
aggregates ALL comps for `(productKey, year, cardClass)` regardless of
player, parallel, or grade — the "how much does an average card in this
release trade for" number. Refreshed daily; falls back to a hand-curated
static table (`eraBaselines.static.ts`) if the container is empty.

**`tierMultiplier`** — reuses existing `floorForPrintRunByClass` from
`parallelPremiumFloors.ts`. Same tier math the ladder already uses.

**Rollout gate:** env flag `COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED`
(default false). Same discipline as Phase 5 v1/v2.

## Tier 7 — `setdoc-baseline`

**Fires when:** we can identify `(year, product)` but the ladder has no
matching ParallelDoc AND Tier 6 didn't fire (pre-1996 base cards + any
uncatalogued query that at least identifies the set).

**Formula:**
```
baseline = setTypeBaseline(setType, era)
grade_mult = gradeMultiplier(gradeCompany, gradeValue)  // reuse existing
floor = baseline × grade_mult
range = floor × [0.3, 3.0]     // very wide — this is a rough era estimate
```

**`setTypeBaseline`** — hand-curated static table:
`(setType, era) → typical raw base-card sale`. E.g.:

| SetType | 1988-1994 | 1995-2005 | 2006-2015 | 2016-2026 |
|---|---:|---:|---:|---:|
| Base | $2 | $3 | $5 | $8 |
| Premium | $5 | $10 | $15 | $25 |
| Premium Chromium | $15 | $30 | $50 | $75 |
| Ultra Premium | $50 | $100 | $150 | $250 |
| Retro | $3 | $6 | $10 | $15 |
| Chromium | $10 | $20 | $30 | $45 |
| Autograph | $30 | $75 | $125 | $200 |
| Metallic | $8 | $15 | $25 | $40 |

The table is educated-guess and marks these baselines as *very* low
confidence (15). Owner can refine over time as we accumulate data.

**Rollout gate:** env flag `COMPIQ_SETDOC_BASELINE_ENABLED` (default false).

## New response fields

```ts
interface CompIQEstimateResponse {
  // ... existing fields ...
  fairMarketValue: number | null;   // still null only at Tier 8
  pricingTier: "direct-comps"
    | "sibling-pool"
    | "product-family-projection"
    | "parallel-floor-projection"
    | "scarcity-prior-floor"
    | "reference-catalog-baseline"   // NEW
    | "setdoc-baseline"              // NEW
    | "unavailable";                 // truly null only
  pricingConfidence: number;         // 0-95
  fmvMechanism: string;              // legacy — kept for backward compat
}
```

`pricingTier` becomes the primary discriminator for iOS display; the
existing `fmvMechanism` field is preserved for the prediction corpus
+ downstream tools that already consume it.

## iOS display treatment (per tier)

| Tier | Confidence | Range copy | Visual treatment |
|---|---:|---|---|
| direct-comps | 75-95 | tight | full brightness, price + range |
| sibling-pool | 60-70 | moderate | full brightness, "similar cards" note |
| product-family-projection | 55 | ±25% | full brightness, "projected from family" note |
| parallel-floor-projection | 55 | ±25% | "structural floor" badge |
| scarcity-prior-floor | 40 | ±40% | "coarser estimate" note, muted color |
| reference-catalog-baseline | 25 | ±100% | "era baseline" caveat, muted, wide range |
| setdoc-baseline | 15 | -70% / +200% | "era typed baseline — verify comps" small text |
| unavailable | 0 | — | "Can't estimate" (only for garbage input) |

## PR sequence

- **PR 1 (this):** design memo + `setDocTypeBaseline.ts` module
  (hand-curated static table + tests). No engine wire-up yet.
- **PR 2:** `referenceCatalogBaseline.ts` module + `eraBaselines`
  static fallback table + tests.
- **PR 3:** Wire Tier 6 + 7 into `compiqEstimate.service.ts` after
  Phase 5 v2's `scarcity-prior-floor` fallback. Behind flags. Add
  `pricingTier` field to response. Tests.
- **PR 4:** Era-baseline background job — daily refresh from CH
  aggregates. Populates `era-baselines` Cosmos container. Replaces
  static fallback with dynamic data.
- **PR 5:** iOS display treatment per tier — muted colors, wider
  ranges, tier-specific badges. iOS-side prompt to deliver to iOS
  Claude.

Each PR is independently flag-gated so we can roll them out one
at a time and measure impact.

## Rollout metric

**Success:** null-status ("Can't estimate yet") rate drops below 1%
of estimate calls, measured over a 30-day window in App Insights.

**Guardrail:** precision proxy for the new tiers — % of Tier 6 / 7
estimates that end within their range when a real sale eventually
posts on that card. Target 60% for Tier 6, 40% for Tier 7.

## What this arc doesn't do

- **No pricing engine algorithm changes above Tier 6.** Tiers 1-5
  keep their current logic exactly. This is additive — only Tier 6/7
  and the response schema change.
- **No iOS work in this backend PR.** iOS work is PR 5, delivered
  as an iOS Claude prompt.
- **No historical repricing.** Existing predictions in
  `prediction_log` stay as-is. Only NEW estimate calls after
  deploy carry `pricingTier`.
