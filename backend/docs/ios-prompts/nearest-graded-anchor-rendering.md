# iOS Prompt: Render `nearestGradedAnchor` on inventory rows

**Status:** Backend ready (PR #186 deployed 2026-06-29). Wire field is live.
**Surface:** Portfolio inventory row + holding detail sheet.
**Effort:** ~2-3 hours for both surfaces.

## Context

When the engine can't anchor a real FMV for a holding (typical case: graded card with no recent same-grade sales), the **grade-ladder fallback** rescues the estimate by anchoring on the nearest available grade (e.g., a PSA 9 sale is used to back-derive a Raw or PSA 8 estimate via the calibrated multiplier table).

This rescue produces:
- `estimatedValue` (the derived FMV) — already rendered as an "Estimated" badge
- `nearestGradedAnchor` (the source anchor we derived from) — **NEW: not yet rendered**

Without rendering the anchor, the user sees "Estimated $X" with no explanation of WHERE the estimate came from. With the anchor, they see "Estimated $X — based on PSA 9 sale at $1,325 (236 days old)".

## Wire shape

`nearestGradedAnchor` is now an optional field on `PortfolioHoldingWire`. The key is OMITTED entirely when the engine didn't fall back to the ladder (the universal case for healthy-priced holdings). When present, the shape is:

```typescript
nearestGradedAnchor?: {
  grade: string;           // e.g. "PSA 9", "BGS 8.5", "SGC 10"
  price: number;           // anchor sale price in USD
  daysOld: number;         // freshness of the anchor sale (0 = today)
  sampleSize: number;      // 1 = single comp; 3+ = consensus
  confidence: number;      // 0.0-1.0; 0.5+ = solid, 0.3-0.5 = rough, <0.3 = ballpark
}
```

## Surface 1: Inventory row (compact)

When a holding has `valuationStatus === "estimated"` AND `nearestGradedAnchor != null`, append a small secondary label below the estimated value badge:

```
$2,150  (Estimated)
based on PSA 9 · $1,325 · 8 mo ago
```

Formatting rules:
- `grade` rendered as-is (it's already user-facing)
- `price` formatted as currency (commas, dollar sign)
- `daysOld` to human-readable: `< 30` → "{N} days ago", `< 365` → "{N} mo ago" (N = floor(days/30)), `>= 365` → "{Y} yr ago"
- Confidence band drives label color:
  - `≥ 0.5` → muted gray (default for "Estimated")
  - `0.3-0.5` → amber tint ("rough estimate")
  - `< 0.3` → red tint ("ballpark only")

## Surface 2: Holding detail sheet (expanded)

In the value section (where you currently show "Estimated $X · `estimateBasis` prose"), add a "Source" subsection:

```
Source
────────────
PSA 9 sold for $1,325
8 months ago · 1 comp · ballpark confidence
```

The 4-row presentation makes it clear:
1. What grade and price anchored the estimate
2. How fresh the anchor is
3. Whether it's based on consensus (multiple comps) or a single sale
4. The confidence band

Tappable: opens a "How we estimate" explainer modal (one-time educational sheet).

## Edge cases

| Holding state | nearestGradedAnchor | Render |
|---|---|---|
| `valuationStatus="observed"`, has FMV | absent | Don't show anything new — current behavior preserved |
| `valuationStatus="estimated"`, no anchor | absent | Show "Estimated $X" without source line — current behavior |
| `valuationStatus="estimated"`, has anchor | present | **Show new "based on..." line** — this CF's surface |
| `valuationStatus="pending"`, no value | absent | Show "Valuation pending" — current behavior |
| `nearestGradedAnchor.sampleSize === 1` | present | Note "1 comp" in detail surface; confidence-tint accordingly |

## Backend invariant

`nearestGradedAnchor` is ADDITIVE — the wire key is OMITTED entirely when absent. No defensive parsing needed; standard optional-field handling in Swift works (`if let anchor = holding.nearestGradedAnchor { ... }`).

## When the field appears

Per PR #180 + the auto-multipliers / vintage-multipliers refresh, the ladder fallback fires for any holding where:
- engine returned no usable FMV (insufficient comps, variant mismatch, etc.)
- AND `cardsightCardId` is present
- AND a same-card sale exists in another grade

Drew's volume-test inventory had 41 holdings rescued this way out of 83 total (~50% rate). Production-wide rate should be similar for graded holdings.

## Testing

Test cards in Drew's inventory that currently have `nearestGradedAnchor`:
- 1952 Topps Mantle (post-PR-180): anchor PSA 8, $1.83M, ~14 days old
- Various 70s/80s vintage HOFs
- Nick Kurtz CPA-NK Green Lava /150 PSA 9 (from earlier session)

Confirm:
- ✓ Field renders when present
- ✓ No layout shift when absent (the universal case)
- ✓ daysOld formatting handles 0, 1, 29, 30, 364, 365, 1000
- ✓ Confidence tint applies correctly per band

## Open questions for Drew

- Confidence band thresholds (currently 0.3 / 0.5) — adjust based on user testing?
- Should the explainer modal also show "We re-estimate every 6 hours from CardHedge's reference data"?
- Tap-target: is the secondary label tappable on the inventory row, or only the detail sheet?
