# Seasonality Signals — iOS Derives on Device

**Status:** ✅ CLOSED. Backend endpoint shipped in PR #476; iOS shipped in `904e81f` (on-device seasonality signals for price history, P1.1).
**Surface:** card detail / holding detail price chart + inventory-row momentum sparkline.

## Design call

**iOS derives every seasonality signal on-device from the existing `GET /api/compiq/cards/:cardId/price-history` response.** No new backend endpoint. Reasoning: the shape ships raw enough that peak-month / trough-month / YoY / momentum are one-pass computations over ~52-156 points; the network cost of a second call is worse than the CPU cost of the derivation.

Revisit if profiling shows chart-page paint > 200ms on a mid-tier device.

## Wire shape (already live)

```typescript
interface PriceHistoryResult {
  cardId: string;
  window: "3m" | "1y" | "3y" | "all";
  bucket: "weekly" | "monthly" | "quarterly";
  totalComps: number;
  earliestSoldAt: string | null;
  latestSoldAt: string | null;
  points: PriceHistoryBucketPoint[];
}

interface PriceHistoryBucketPoint {
  bucketStart: string;          // ISO date; Sunday for weekly, 1st for monthly, quarter-start for quarterly
  count: number;                // sales in this bucket
  medianPrice: number;
  minPrice: number;
  maxPrice: number;
  meanPrice: number;
  sourceBreakdown: Record<string, number>;   // { cardhedge: N, cardsight: M, user: K }
}
```

Filters iOS can pass on the request:

- `window=3m|1y|3y|all` (default `1y`)
- `bucket=weekly|monthly|quarterly` (default `monthly`)
- `minConfidence=0..1` (excludes low-confidence comps)

For every derivation below, iOS should request `window=3y, bucket=monthly` — the derivations need 12+ points to be meaningful, and monthly is the natural cadence for card-market seasonality.

## Signals iOS renders

### 1. Peak month

**Definition:** the calendar month where median price is historically highest.
**Derivation:**

```
group points by (bucketStart.month)
for each month:
  values = [p.medianPrice for p in group]
  monthMedians[month] = median(values)   // median of medians across years
peakMonth = argmax(monthMedians)
```

**Gate:** render only when total `points.length >= 12`. Below that, hide the caption — a "peak month" from 4 months of data is noise dressed as insight.
**Caption:** `"Historically peaks in September"` — placed as a subhead on the chart.
**Position:** top-right of the chart panel, muted color.

### 2. Trough month

**Definition:** calendar month with historically lowest median.
**Derivation:** identical to peak month, `argmin` instead of `argmax`.
**Gate:** same 12+ points.
**Caption:** `"Historically softest in February"`.
**Position:** below peak-month caption when both surface. Suppress when peak and trough are adjacent months — the signal is too noisy at that resolution.

### 3. YoY change (last 12 months)

**Definition:** how the recent 3-month median compares to the same 3 months from the prior year.
**Derivation:**

```
recent3 = last 3 monthly points (points.slice(-3))
priorYear3 = the 3 monthly points from 12 months earlier
  (i.e. points where bucketStart is in [now-15mo, now-12mo])
recentMedian = median(recent3.map(p => p.medianPrice))
priorMedian  = median(priorYear3.map(p => p.medianPrice))
yoy = (recentMedian / priorMedian) - 1
```

**Gate:** requires both windows to have ≥ 1 point each. If prior-year window is empty, hide.
**Rendering:** chart header, formatted as signed percentage with a directional glyph:

- `yoy >= 0`: `"▲ 18% YoY"` in green
- `yoy < 0`: `"▼ 12% YoY"` in red
- `|yoy| < 0.02`: `"─ Flat YoY"` in muted gray (round-to-flat threshold; 1% market noise isn't a signal)

### 4. Momentum (last 30 days)

**Definition:** short-term price direction, for the inventory-row sparkline.
**Derivation:** on the `bucket=weekly` response (separate request from the chart's monthly one), fit a least-squares regression to the last 12 weekly points' `medianPrice`:

```
weekly = fetchPriceHistory(cardId, "1y", "weekly")
last12 = weekly.points.slice(-12)
if last12.length < 6: return "flat"
xs = last12.indexes                // [0..11]
ys = last12.map(p => p.medianPrice)
slope = leastSquaresSlope(xs, ys) / mean(ys)   // normalized to % per week
```

**Rendering:**

- `slope >= 0.02`: `"▲"` glyph (up 2%+ per week)
- `slope <= -0.02`: `"▼"` glyph (down 2%+ per week)
- otherwise: `"─"` glyph (flat)

**Position:** trailing edge of the inventory-row sparkline, or replacing the sparkline when weekly data is too thin (< 6 points).

### 5. Bucket-source breakdown badge (optional, low priority)

Each bucket carries `sourceBreakdown`. iOS may render a small "3 CH · 1 Cardsight · 1 user" caption below the chart on tap — establishes the comp provenance the chart is built from. Nice-to-have; skip until users ask.

## Empty / thin data behavior

- **Zero points:** hide the entire chart. Do NOT render an axis with no line — reads as "we couldn't get the number".
- **1-11 points:** render the chart, hide all four signals.
- **12+ points:** render the chart + peak/trough. Momentum + YoY each gate separately (see gates above).

## Refresh cadence

- Chart data cached in-memory for the current view session. Force refresh on pull-to-refresh.
- Backend response is not itself cached at short TTL (< 6h) — the underlying `sold_comps` pool updates when new sales arrive, and iOS gets the latest whenever it asks.

## Do NOT

- Do NOT surface `meanPrice` anywhere on the chart or in captions. Use `medianPrice` for every derivation and label. This is enforced by the memory `feedback_no_medians_project_next_sale.md` — technically that rule applies to the point-estimate FMV, not chart aggregates, but consistency reads better than defending a mixed-metric surface.
- Do NOT render the min/max as a fill band under the median line. Comp min/max is noisy (garage-sale bids, gift-price offers). If iOS wants a range visualization, use the 25th/75th percentile — but that requires a wire-shape extension. Deferred.
- Do NOT chart the weekly response as the primary chart — weekly is momentum only. The primary chart is monthly.
