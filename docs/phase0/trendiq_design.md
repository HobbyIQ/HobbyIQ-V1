# TrendIQ Design

**Created:** 2026-05-25
**Status:** V1 design locked; implementation pending
**Strategic positioning:** Headline forward-looking score for CompIQ
predictions. Comps demoted to reference data. Makes HobbyIQ's
predictive intelligence (the strategic moat) visible in product UI.

## Name

TrendIQ. Locked. Fits the IQ family (CompIQ, ActionIQ, DailyIQ,
InventoryIQ, TrendIQ). Plain-language directional word that handles
both up and down polarity naturally.

## Data layer — three-input composite

TrendIQ composites three data inputs into a single per-card score:

**1. Player-level signal momentum**
Source: aggregator's final_mult from aggregated.json (produced by
fn-signal-aggregator).
Captures: news catalysts, search trends, performance stats, social
activity, betting odds, listing velocity, content trends.
Updated: every ~2 hours per aggregator cycle.
Current state: 3 of 7 signals active (trends, news, stats); 4
degraded (reddit, ebay, odds, youtube) pending credential repair.

**2. Card-level comp trajectory**
Source: recent comps for the specific card being valued.
Captures: whether this exact card's recent sale prices are
rising, falling, or steady.
Methodology specifics deferred to implementation time (window size,
calculation method, "sparse" threshold).

**3. Market segment trajectory anchored to last sale date**
Source: comps for related parallels — same player + same year +
same brand — over a dynamic window from this card's last sale
date to present.
Captures: how the broader market segment has moved since this
specific card was last priced by an actual transaction.
Solves: low-pop parallel valuation problem (rare cards with sparse
direct comps still get meaningful trend signal from segment).

## Composite weighting

Dynamic, not fixed. Weighting shifts based on data density:
- Common cards with rich card-level comp data: card-level trajectory
  carries primary weight; segment trajectory provides supporting context
- Rare cards with sparse direct comps: segment trajectory anchored to
  last sale date carries primary weight (substitute for absent
  card-specific trend)
- Player momentum always contributes as broader-market context

Exact weighting math deferred to implementation time. Default starting
point: 50/50 between card-level and segment-level when both have data,
shifting toward segment-level as card data thins.

## Display approach (Approach C — locked)

Single composite headline number per card with tap-to-details
breakdown showing all three components.

## Deferred to implementation time

- Display format (signed delta vs 100% baseline vs directional words
  like "Up 12%")
- Color coding specifics (green/gray/red spectrum, exact shades,
  accessibility)
- Card-level comp trajectory calculation method (window size,
  algorithm)
- Composite weighting math (exact formulas, dynamic adjustment
  thresholds)
- Segment definition refinement (player+year+brand confirmed as
  baseline; whether to distinguish product line within brand)
- Edge cases:
  - Cards with no public sale history (no anchor date available)
  - Cards with very recent last sale (window too short)
  - Cards with very old last sale (recency weighting needed)
  - Cards with no meaningful parallels in segment
- Display threshold for "since last sale" framing in details view

## Implementation phases (~16-25 hours total)

### Phase 1 — Backend exposure (~8-12 hours)
- Modify /api/compiq/price response to include trendIQ object
- Include: composite multiplier, last-updated timestamp, signal flags,
  component breakdown (player/card/segment values), coverage status,
  "since last sale date" context
- Backend logic for segment-trajectory computation anchored to
  last sale date
- Backend logic for dynamic composite weighting
- Tests for response shape and edge cases
- Source-deploy via hardened script

### Phase 2 — iOS CompIQ result view redesign (~4-6 hours)
- Decode trendIQ from backend response
- Display format decision (see deferred section)
- UI: TrendIQ headline, color coding, tap-to-details breakdown
- Demote recent comps to "reference data" section

### Phase 3 — Surface across other views (~3-5 hours)
- PortfolioIQView, DashboardView, InventoryIQView, DailyIQView
- Consistent display per Phase 2 decisions

### Phase 4 — Methodology help screen (~2-3 hours)
- Explain TrendIQ to users
- Show component signals + which are active
- Set expectations: forward-looking estimate, not guarantee

## Cross-references

- Backend: services/compiq/compiqEstimate.service.ts (where trendIQ
  data assembly will live)
- Aggregator: compiq-functions/fn-signal-aggregator/ (produces source
  data for Layer 1)
- iOS: HobbyIQ/CompIQResult.swift (decode target), CompIQPricedCardView
  or equivalent (display target)
- Related CFs: CF-CROSS-COMPANY-COMPS (BGS/CGC inclusion becomes more
  important when Layer 3 segment trajectory pulls parallels)

## V2 considerations (post-V1 implementation)

- Cross-company segment expansion (include BGS/CGC parallels in
  segment trajectory once CF-CROSS-COMPANY-COMPS resolves)
- Per-product-line segment refinement (within brand)
- Outcome feedback loop integration (predicted TrendIQ vs actual
  sale outcomes feeding back into Layer 1 aggregator weighting)
- Methodology evolution based on backtest validation
