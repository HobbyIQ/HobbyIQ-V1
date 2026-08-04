# Xcode Claude Prompt — HobbyIQ Unified Pricing iOS Rebuild

Paste this into Claude Code inside Xcode. Everything Claude needs to
wire the new components in, verify compile, and roll out safely is
here. Runs from an Xcode session where compile + preview + simulator
are available.

---

## Task

I need you to complete the iOS rebuild for HobbyIQ's unified pricing.
The foundation is already shipped as 6 new SwiftUI files under
`HobbyIQ/UnifiedPricing/`. Your job:

1. **Verify the new files compile.** Build the app for iOS Simulator
   (any modern iPhone). If any errors surface, fix them in-place —
   the components are self-contained; issues are almost always
   missing import, wrong `HobbyIQTheme` token name, or Swift concurrency
   annotation. Keep changes minimal.

2. **Wire the new components onto the four target screens.** Locations
   and diffs are spelled out below. Do NOT delete legacy code paths
   yet — that's Session 4. Just add the new components alongside so
   we can regression-test via feature flag or debug menu.

3. **Preview + Simulator verify** each screen:
   - Ohtani PSA 9 hero: MARKET VALUE $2,596 + PREDICTED (7D) $2,743 ↑ 5.8%
   - Ohtani PSA 9 Grade Curve row (expanded): sparkline appears + p10/p90 shown
   - Victor Figueroa Red Ink: $278.60, PSA badge shows "Raw"
   - Portfolio summary tile: total ≈ $5,014, split bar shows ~62% observed / 38% estimated

4. **TestFlight-eligible build.** Once builds + previews look right,
   bump the marketing version if the release schedule expects it,
   and archive for TestFlight upload. If any test failures, HALT and
   surface them — don't paper over.

Ship the build number bump + wire-in commits as one PR titled
`ios: unified pricing components wired into portfolio + card panel`.

---

## Context

**Backend contract (already shipped, live in prod as of 2026-08-04):**

- `POST /api/portfolio/holdings/:id/refresh` writes
  `holding.fairMarketValue = unified.marketValue` and
  `holding.predictedPrice = unified.predictedPrice`.
- `GET /api/portfolio/` summary carries `totalValue`, `observedValue`,
  `estimatedValue`, `totalGainLoss`, `totalGainLossPct`.
- `POST /api/compiq/card-panel/:cardId` gradeCurve entries carry
  unified marketValue in `entry.trendAdjustedValue` and unified
  predictedPrice in `entry.predictedPriceAt30d`.

**Every iOS surface reads those same fields.** No new API calls.

**Design tokens locked:**

- `HobbyIQTheme.Colors.electricBlue` — headline accent
- `HobbyIQTheme.Colors.hobbyGreen` — up trend / gains
- `HobbyIQTheme.Colors.danger` — down trend / losses
- `HobbyIQTheme.Colors.mutedText` — captions
- `HobbyIQTheme.Typography.hero` — 40pt bold rounded (MARKET VALUE headline)
- `HobbyIQTheme.Typography.statNumber` — 30pt bold rounded (summary totals)
- `HobbyIQTheme.Typography.statSubtle` — 15pt semibold rounded (PREDICTED companion)
- `hiqCard()` — top-level detail tile
- `hiqGroupCard()` — nested rows

**Full architecture blueprint:** `backend/docs/ios-unified-rebuild-blueprint.md`

---

## The new files (in `HobbyIQ/UnifiedPricing/`)

Already committed. You should see them in Xcode's project navigator
under `UnifiedPricing` group (auto-synced via
`PBXFileSystemSynchronizedRootGroup`).

- `UnifiedPricingModels.swift` — Codable types: `UnifiedGradeEntry`, `UnifiedPriceResult`.
- `MarketValueCard.swift` — hero pricing block. 4 preview variants.
- `UnifiedSparkline.swift` — self-contained path sparkline.
- `UnifiedGradeCurveView.swift` — per-grade rows with tap-to-expand disclosure.
- `PortfolioSummaryCard.swift` — dashboard 3-tile stat header + observed/estimated split.
- `HoldingRowView.swift` — portfolio list row.

Read `HobbyIQ/UnifiedPricing/README.md` for wire-in code snippets.

---

## Wire-in 1: hero card (`PortfolioHoldingHeroCard.swift`)

Replace the manual `marketValueBlock` + `predictedPriceBlock` layout
with a single `MarketValueCard`. Keep `heroSparkline` and
`canonicalFmvCaptionBlock` mounted separately.

Find:

```swift
Text("MARKET VALUE")
    .font(.caption.weight(.semibold))
    ...
// ... value display, low-confidence pill, etc. ...
if canonicalValue != nil { canonicalFmvCaptionBlock }
heroSparkline
predictedPriceBlock
```

Replace with:

```swift
MarketValueCard(
    marketValue: displayedValue,          // canonicalValue ?? fallbackValue
    predictedPrice: card.predictedPrice,
    confidence: canonicalFmv?.confidence ?? cachedConfidence,
    rangeLow: card.estimateLow,
    rangeHigh: card.estimateHigh,
    isEstimated: card.valuationStatus == "estimated",
    onTap: { if canWhyThisPriceOpen { showingWhyThisPriceSheet = true } }
)
if canonicalValue != nil { canonicalFmvCaptionBlock }
heroSparkline
```

Delete the now-unused `predictedPriceBlock` helper (was added earlier
today; MarketValueCard covers it). If tests reference it, keep it
until Session 4 cleanup.

## Wire-in 2: Grade Curve on card panel

If the card panel currently renders `CompIQCardGrades` or an ad-hoc
grade list, mount `UnifiedGradeCurveView` alongside behind a
`#if DEBUG` or `AppFlags.useUnifiedGradeCurve` flag. Decode from the
existing `/card-panel` response — the JSON keys match `UnifiedGradeEntry`
directly.

Grade entry projection (in the ViewModel/decoder):

```swift
let unifiedEntries: [UnifiedGradeEntry] = panelResponse.gradeCurve.entries.map { entry in
    UnifiedGradeEntry(
        grade: entry.grade,
        gradeCompany: entry.grader,
        gradeValue: entry.gradeValueNumeric,
        weightedMedian: entry.weightedMedianPrice,
        plainMedian: entry.plainMedianPrice,
        sampleCount: entry.sampleCount,
        p10: entry.priceRangeLow,
        p90: entry.priceRangeHigh,
        newestSaleDate: entry.newestSaleDate,
        valueSource: entry.valueSource ?? "observed",
        confidence: entry.confidenceScore ?? 0,
        marketValue: entry.trendAdjustedValue ?? entry.weightedMedianPrice,
        predictedPrice: entry.predictedPriceAt30d,
        trendPctPerWeek: entry.predictedPricePct,
        trendDirection: entry.trendDirection ?? "flat"
    )
}
```

Optional sales-history dict (feeds the sparkline inside disclosures):

```swift
let history: [String: [Double]] = Dictionary(
    uniqueKeysWithValues: panelResponse.gradeCurve.entries.compactMap { e -> (String, [Double])? in
        guard let series = e.salesHistory?.map({ $0.price }), !series.isEmpty else { return nil }
        return (e.grade, series)
    }
)
```

Then:

```swift
UnifiedGradeCurveView(entries: unifiedEntries, salesHistoryByGrade: history)
```

## Wire-in 3: portfolio summary tile

On the portfolio screen (`PortfolioIQView.swift` or wherever the
existing summary tile mounts), project the backend PortfolioSummary
onto `UnifiedPortfolioSummary` and render `PortfolioSummaryCard`:

```swift
let summary = UnifiedPortfolioSummary(
    totalValue: response.summary.totalValue,
    totalCost: response.summary.totalCost,
    totalGainLoss: response.summary.totalGainLoss,
    totalGainLossPct: response.summary.totalGainLossPct,
    observedValue: response.summary.observedValue,
    estimatedValue: response.summary.estimatedValue,
    cardCount: response.summary.cardCount,
    estimatedCount: response.summary.estimatedCount,
    pendingCount: response.summary.pendingCount
)

PortfolioSummaryCard(summary: summary)
```

## Wire-in 4: holding list row

Optional for this pass — Session 3 in the blueprint. Skip if scope
gets tight. If tackled: replace the existing `PortfolioInventoryCells`
tile with `HoldingRowView`, projecting `InventoryCard` onto
`HoldingRowModel` at the call site.

---

## Verification checklist

Before ending the session:

1. **Build succeeds** for `HobbyIQ` scheme on iOS Simulator.
2. **Every preview compiles.** Open each new file in Xcode canvas
   and confirm previews render. `MarketValueCard` has 4 states;
   `UnifiedGradeCurveView` has an Ohtani-style curve; the others
   have healthy/underwater/empty and observed/rare/estimated variants.
3. **Live-data verify.** Log in to a portfolio with Ohtani PSA 9 in
   it. Hero shows $2,596 + $2,743. Portfolio summary total ≈ $5,014.
   Card panel Grade Curve row for PSA 9 expands to reveal sparkline.
4. **No console errors.** Run under Instruments briefly if any warning
   about missing Codable keys appears — they'd all trace to the
   entry projection above.
5. **Screenshots.** Take screenshots of hero + Grade Curve + summary
   and diff them against the web references at
   `apps/web/src/app/app/portfolio/[id]/page.tsx` and
   `apps/web/src/components/GradeCurveView.tsx`. Numbers should
   match. Layout should feel cross-platform-consistent (same info
   density on iOS, expanded on web).

## Guardrails

- **Do not** add new colors, gradients, or fonts. Every visual
  choice routes through `HobbyIQTheme`.
- **Do not** delete legacy pricing code yet. That's Session 4 in the
  blueprint and needs a separate PR with regression coverage.
- **Do not** change any backend endpoint or wire format. The whole
  point of Sessions 1-3 is client-side rendering of numbers backend
  already computes.
- **HALT and ask** if you hit a compile error you can't resolve with
  a 1-line fix. Don't paper over with `try?` or `@unchecked` — those
  hide real problems.
- **Test on device** for the disclosure animation and the
  `AsyncImage` on `HoldingRowView` (simulator can't test the real
  eBay image URLs).

## What to report back

A crisp summary at end of session:

- Build status (green / errors resolved / errors surfaced to Drew)
- Which of the 3-4 wire-ins landed
- Ohtani PSA 9 numbers seen on hero + Grade Curve (should match
  $2,596 / $2,743 within cents)
- Any deprecated code paths that surface and warrant Session 4
- TestFlight build number, if uploaded

## Reference files (read these first)

- `HobbyIQ/UnifiedPricing/README.md` — file map + wire-in snippets
- `backend/docs/ios-unified-rebuild-blueprint.md` — full architecture
- `HobbyIQ/UnifiedPricing/*.swift` — the 6 new components
- `apps/web/src/components/GradeCurveView.tsx` — web reference for Grade Curve
- `apps/web/src/app/app/portfolio/[id]/page.tsx` — web hero reference
- `apps/web/src/app/app/portfolio/page.tsx` — web portfolio summary reference

Start by reading `HobbyIQ/UnifiedPricing/README.md`, then run a build,
then work through the wire-ins in order. Ask Drew if anything is
ambiguous — better to check than to guess on user-facing pricing
math.
