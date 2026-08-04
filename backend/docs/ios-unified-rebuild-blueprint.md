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

## Cross-platform visual parity — web is the reference

**Drew's ask: iOS and web should LOOK and FEEL the same.** The visual
reference for every iOS component is the corresponding web view.
Component-for-component parity across platforms:

### Component ↔ Web reference

| iOS Component | Web reference | Design contract |
|---|---|---|
| `MarketValueCard` | `apps/web/src/app/app/portfolio/[id]/page.tsx` hero block | Big MARKET VALUE + PREDICTED (7D) below + Range + Confidence pill + sparkline |
| `GradeCurveView` | `apps/web/src/components/GradeCurveView.tsx` | 3-column: `[Grade label + n=52 + OBSERVED badge]` `[Market Value + trend %]` `[Sparkline]` `[Predicted + delta + range]`, confidence bar underneath |
| `PortfolioSummaryCard` | `apps/web/src/app/app/portfolio/page.tsx` header | Total + observed / estimated split, gain/loss + return % |
| `HoldingRowView` | Portfolio grid tile on web | Card art, title, grade chip, value right-aligned |

### Tokens (already parity)

Web `--color-*` CSS variables and iOS `HobbyIQTheme.Colors.*` map 1:1:

| Concept | Web | iOS |
|---|---|---|
| Background | `--color-bg` | `Colors.appBackground` |
| Card fill | `--color-card` | `Colors.cardNavy` |
| Border | `--color-border` | `Colors.border` |
| Accent | `--hiq-electric-blue` | `Colors.electricBlue` |
| Up trend | `--hiq-hobby-green` | `Colors.hobbyGreen` |
| Down trend | `--hiq-danger` | `Colors.danger` |
| Muted text | `--hiq-muted-text` | `Colors.mutedText` |
| Warning | `--hiq-warning` | `Colors.warning` |

### Grade-Curve row exact layout (both platforms)

```
┌─────────┬───────────────┬──────────┬────────────────┐
│ PSA 9   │ MARKET VALUE  │          │ PREDICTED (7D) │
│ n=52    │ $2,596        │ ~ ~ ~    │ $2,743         │
│[OBSVD]  │ ↑ 5.8%        │  spark   │ +6.5%          │
│         │ p10 $1,750    │  line    │ range 2,350—   │
│         │ p90 $3,101    │          │       2,759    │
└─────────┴───────────────┴──────────┴────────────────┘
│ Confidence [████████████████████████] 100%           │
└──────────────────────────────────────────────────────┘
```

iOS translates this using `HStack` + `VStack` with `HobbyIQTheme.Spacing.medium`
gutters. `hiqGroupCard()` container. Same font sizes:
- Grade label: `Typography.cardTitle` (18pt semibold rounded)
- Market/Predicted numbers: `Typography.statNumber` (30pt bold rounded)
- Captions ("MARKET VALUE", "n=52", "p10"): `Typography.caption` (13pt)
- Range detail: 10pt muted

### Hero card exact layout (both platforms)

```
┌────────────────────────────────────────┐
│  MARKET VALUE                          │
│  $2,596                                │
│  [OBSERVED · 100% confidence]          │
│                                        │
│  ~ ~ ~ ~ ~ ~ ~ ~ (30d sparkline)      │
│                                        │
│  PREDICTED (7D)                        │
│  $2,743  ↑ 5.8%                        │
│                                        │
│  Range $2,350 – $2,759                 │
└────────────────────────────────────────┘
```

iOS uses `Typography.hero` (40pt) for the market value number,
`Typography.statSubtle` (15pt semibold) for the predicted number.
Existing gradient overlay stays as-is.

### Numbers convention (both platforms)

- Whole dollars over $100 (no cents): `$2,596`
- Cents for < $100: `$92.44`
- Percent: `5.8%` (one decimal), `↑` up, `↓` down, no arrow when flat
- All numeric text uses `tabular-nums` (web) / monospaced-digit (iOS)
- `—` when truly no data (never for estimated — use `~$X` prefix)

## Design tokens — same as always, all shipped

- `HobbyIQTheme.Colors.electricBlue` — headline accent
- `HobbyIQTheme.Colors.hobbyGreen` — up trend
- `HobbyIQTheme.Colors.danger` — down trend
- `HobbyIQTheme.Colors.mutedText` — captions
- `HobbyIQTheme.Typography.hero` — MARKET VALUE headline (40pt rounded bold)
- `HobbyIQTheme.Typography.statSubtle` — PREDICTED companion (15pt rounded)
- `HobbyIQTheme.Gradients.dashboardStroke` — card border
- `hiqCard()` — top-level detail tile
- `hiqGroupCard()` — nested Grade Curve rows

**No new tokens.** No new colors. No new fonts. Web CSS variables and
iOS theme constants map 1:1. The design language is already
cross-platform — the rebuild is about structural clarity, matching
web's information density, and math correctness. Not visual overhaul.

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
