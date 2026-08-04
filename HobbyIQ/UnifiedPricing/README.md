# UnifiedPricing/ — iOS rebuild Session 1 & 2 foundation

**Shipped 2026-08-04.** Drop-in SwiftUI components that render the unified pricing contract identically to web. Cross-platform parity locked; see `backend/docs/ios-unified-rebuild-blueprint.md`.

## Files

- `UnifiedPricingModels.swift` — canonical Codable types matching backend `UnifiedPriceResult` + `UnifiedGradeEntry`.
- `MarketValueCard.swift` — hero pricing block: MARKET VALUE + PREDICTED (7D) + range + confidence pill. Drop-in for existing hero.
- `UnifiedSparkline.swift` — self-contained SwiftUI path sparkline. No Charts framework dependency.
- `UnifiedGradeCurveView.swift` — per-grade market/predicted/confidence rows with tap-to-expand disclosure. Sparkline reveals inside the disclosure.

## Xcode compile

Project uses `PBXFileSystemSynchronizedRootGroup` — new files in `HobbyIQ/` auto-pick-up by Xcode 16+. No project.pbxproj edit required. Files reference only:
- `HobbyIQTheme` (existing)
- `wholeUSDString` (existing, defined in `HIQCardStyles.swift`)
- Standard SwiftUI + Foundation

If a compile fails, check that HobbyIQTheme + wholeUSDString are still in-scope; both are module-internal so any file in the `HobbyIQ` target picks them up.

## Wire-in points

### 1. Hero pricing on `PortfolioHoldingHeroCard`

Replace the `marketValueBlock` + `predictedPriceBlock` handoff with a single `MarketValueCard`:

```swift
// Before:
marketValueBlock
if canonicalValue != nil { canonicalFmvCaptionBlock }
heroSparkline
predictedPriceBlock

// After:
MarketValueCard(
    marketValue: card.fairMarketValue,
    predictedPrice: card.predictedPrice,
    confidence: card.pricingConfidence,
    rangeLow: card.estimateLow,
    rangeHigh: card.estimateHigh,
    isEstimated: card.valuationStatus == "estimated",
    onTap: { showingWhyThisPriceSheet = true }
)
heroSparkline
```

Keep `heroSparkline` and `canonicalFmvCaptionBlock` — MarketValueCard doesn't own those; it's just the two numeric blocks.

### 2. Grade Curve on any card detail screen

Feed the /card-panel `gradeCurve.entries` into an array of `UnifiedGradeEntry`
(model-side transformation — same JSON keys, direct decode) and mount:

```swift
UnifiedGradeCurveView(
    entries: unifiedEntries,
    salesHistoryByGrade: salesHistoryDict
)
```

Sales history is optional — when omitted the sparkline falls back to a two-point line from p10/p90.

## Migration order

1. **Session 1 (this):** UnifiedPricingModels + MarketValueCard. TestFlight verify Ohtani hero shows $2,596 (market) + $2,743 (predicted, ↑ 5.8%).
2. **Session 2 (this):** UnifiedSparkline + UnifiedGradeCurveView. Wire onto card panel. Verify tap-to-expand reveals sparkline + p10/p90.
3. **Session 3:** PortfolioSummaryCard + HoldingRowView (blueprint).
4. **Session 4:** Cleanup — delete legacy `resolvedMarketValue`, `CompatibilityShims` fields, deprecated view code paths.

## Design tokens

Every color, gradient, radius, and font pulled from `HobbyIQTheme.*`. Zero new tokens. Zero new gradients. Same design language as the rest of the app — matches web `--color-*` variables 1:1 per the parity table in the blueprint.
