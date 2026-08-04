# iOS Unified Pricing Rebuild — Architecture Blueprint

**Author:** Session with Drew, 2026-08-04
**Status:** Blueprint. Backend convergence shipped. iOS surgical wins shipped. Full rebuild pending Xcode-in-loop sessions.
**Owner:** Drew

---

## Backend contract (shipped 2026-08-04)

`computeUnifiedPrice(cardId | hobbyiqCardId, {grade, excludeContributorUserId})` returns:

- `fmv` — weighted median with 14d halflife decay (past clearing price)
- `marketValue` — trend-lifted current value (`fmv × recent-vs-prior ratio`)
- `predictedPrice` — 7d forward projection (`fmv × ratio^1.5`)
- `confidence` — 0-1 from sample count + recency
- `windowDays` — adaptive window that produced these numbers
- `trendDirection` — up/down/flat
- `trendPctPerWeek`
- `gradeCurve[]` — per-grade breakdown of all the above

**Every pricing surface reads these fields.** Portfolio, Grade Curve,
`/hobbyiq-fmv`, `/canonical-fmv`, `/card-detail`, iOS wire — all
converge on this function.

**Persistence contract on `PortfolioHolding`:**
- `fairMarketValue` ← `unified.marketValue` (the ONE canonical number)
- `predictedPrice` ← `unified.predictedPrice` (the ONE prediction)
- `pricingSource: "unified-pricing"` when unified fired
- `estimateBasis` carries the math trace

---

## iOS rebuild target — five core components

### 1. `UnifiedPricing.swift` — canonical Swift types
Mirror the backend `UnifiedPriceResult` + `UnifiedGradeEntry` interfaces
exactly. Every price display consumer takes one of these; no direct
JSON decoding scattered across views.

### 2. `MarketValueCard.swift` — hero pricing card
Replaces the current headline block on `PortfolioHoldingHeroCard`.
Shows:
- MARKET VALUE (big number, blue-white gradient — existing style)
- PREDICTED (7D) companion under it with ↑/↓ arrow + %
- Confidence pill (small caveat when < 0.6)
- Sparkline underneath (existing)

### 3. `GradeCurveView.swift` — per-grade breakdown
New view matching the web `GradeCurveView`. For each canonical grade:
- Grade label + observed/estimated badge + sample count
- MARKET VALUE with trend chip
- PREDICTED (7D) with delta
- Sparkline
- p10 / p90 range

Renders inside `hiqGroupCard()`. One entry per row using
`HobbyIQTheme.Colors.slateGray` accent.

### 4. `PortfolioSummaryCard.swift` — dashboard total
Reads the backend `PortfolioSummary`:
- `totalValue` (includes estimated now — see `computeDisplayValue`)
- `observedValue` / `estimatedValue` split so users see honestly what
  fraction of their book is anchored vs estimated
- `totalGainLoss` / `observedGainLoss` (never mixes estimated dollars
  into realized-looking P&L)

### 5. `HoldingRowView.swift` — clean list row
Replaces the current row rendering in `PortfolioInventoryCells`.
- Card art thumbnail
- Player + set + grade line
- MARKET VALUE right-aligned
- Tiny `~` prefix on estimated rows
- P/L chip

---

## Migration plan (executable in Xcode sessions)

**Session 1 — Foundation**
1. Add `UnifiedPricing.swift` types + Codable extensions.
2. Add `MarketValueCard.swift` as a drop-in replacement for the
   headline block; render it inside the existing hero.
3. TestFlight → verify Ohtani + Bobby Witt show correct market + predicted.

**Session 2 — Grade Curve**
1. Add `GradeCurveView.swift`.
2. Wire onto card panel screen.
3. Delete the old `CompIQCardGrades` rendering path once verified.

**Session 3 — Portfolio total + list**
1. Add `PortfolioSummaryCard.swift`, `HoldingRowView.swift`.
2. Wire onto dashboard + portfolio list.
3. Delete deprecated wrappers.

**Session 4 — Cleanup**
1. Remove `CompatibilityShims.swift` fields tied to legacy pricing.
2. Remove `resolvedMarketValue` remnants.
3. Consolidate scattered `bestKnownMarketValue` / `currentValueFormatted`
   variants — all should route through the new components.
4. Regression test on 20-holding portfolio.

---

## Design tokens — same as always

- `HobbyIQTheme.Colors.electricBlue` — headline accent
- `HobbyIQTheme.Colors.hobbyGreen` — up trend
- `HobbyIQTheme.Colors.danger` — down trend
- `HobbyIQTheme.Colors.mutedText` — captions
- `HobbyIQTheme.Typography.hero` — MARKET VALUE headline (40pt rounded bold)
- `HobbyIQTheme.Typography.statSubtle` — PREDICTED companion (15pt rounded)
- `HobbyIQTheme.Gradients.dashboardStroke` — card border
- `hiqCard()` — top-level detail tile
- `hiqGroupCard()` — nested Grade Curve rows

**No new tokens.** No new colors. No new fonts. The design language
stays exactly as it is — the rebuild is about structural clarity and
math correctness, not visual overhaul.

---

## What's already shipped (2026-08-04)

- ✅ Backend convergence (Phase 1 + Phase 2)
- ✅ `PortfolioIQModels.displayValueText`/`displayValueFormatted`:
  fall-through to `estimatedValue` with tilde prefix
- ✅ `PortfolioHoldingHeroCard.predictedPriceBlock`: PREDICTED (7D)
  under MARKET VALUE
- ✅ Portfolio total (`computeDisplayValue` on backend) now rolls in
  `estimatedValue`

## What's next

Everything in this blueprint. Execute in Xcode sessions with TestFlight
verification per stage.
