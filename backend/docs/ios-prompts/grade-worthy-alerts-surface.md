# iOS prompt — Grade-Worthy Alerts Surface

## What the backend just shipped (PR #518)

Two endpoints on `/api/portfolio/*`. Session-required, same auth as the rest of the portfolio routes. Rate-limited under `priceChecksPerDay`.

### 1) `GET /api/portfolio/holdings/:id/grade-analysis`

Single holding, returns:

```json
{
  "holdingId": "abc123",
  "player": "Eric Hartman",
  "year": 2026,
  "cardNumber": "CPA-EHA",
  "set": "2026 Bowman Baseball",
  "variant": "Base",
  "analysis": {
    "rawPrice": 110,
    "bestTier": {
      "graderTier": "PSA 10",
      "gradedMedianPrice": 900,
      "gradedSampleSize": 8,
      "gradingCostAssumed": 79.99,
      "expectedGain": 710.01,
      "expectedRoi": 3.74,
      "recommendation": "grade_now",
      "reason": "374% ROI on cost basis — strong signal"
    },
    "allTiers": [
      // Every analyzed tier, sorted by expectedGain DESC
    ],
    "overallRecommendation": "grade_now",
    "reason": "Best tier PSA 10: expected gain $710 (374% ROI on raw+grading cost)"
  },
  "diagnostics": {
    "localCorpusRows": 329,
    "playerMomentum": 1.4836,
    "playerMomentumDirection": "up"
  }
}
```

`overallRecommendation` is one of:
- `grade_now` — strong signal, expected gain ≥ $50 AND ROI ≥ 50% AND momentum not down
- `grade_worthy_but_wait` — solid ROI (≥ 20%) but player momentum down; suggest waiting for reversal
- `not_worth` — expected gain < $50 or ROI too low
- `insufficient_data` — no graded comps, or holding already graded

### 2) `GET /api/portfolio/grade-worthy-alerts`

Portfolio-wide scan. Same auth. Returns only `grade_now` candidates, sorted by best-tier `expectedGain` DESC.

```json
{
  "scannedHoldings": 36,
  "gradeWorthyCount": 4,
  "candidates": [
    { "holdingId": "...", "cardTitle": "Hartman CPA-EHA", "player": "Eric Hartman", "analysis": {...} },
    // sorted highest expected gain first
  ]
}
```

## Two consumer surfaces to build

### Surface A — Portfolio-level alert badge on the dashboard

On the main portfolio home:

- Fetch `/grade-worthy-alerts` on app foreground (5-min TTL cache)
- If `gradeWorthyCount > 0`, show a top-of-list banner:

```
┌─────────────────────────────────────────────────┐
│ 💎 4 cards worth grading                        │
│    Top: Hartman CPA-EHA — expected +$710        │
│    [Review all →]                               │
└─────────────────────────────────────────────────┘
```

Tap → list view of all candidates with:
- Card thumb (from `local comp store` — reuse existing image fetch)
- Expected gain in green
- Grader tier
- One-line reason
- CTA: **"Mark as At Grading"** (uses existing `/regrade` endpoint) or **"Details"**

### Surface B — Per-card grade analysis on card detail

On the existing card-detail view, when the card is Raw:

- Load `/holdings/:id/grade-analysis` when the view opens
- Below the FMV, show:

```
┌──────────────────────────────────┐
│ Grade Analysis                   │
│                                  │
│  💎 GRADE NOW                    │
│  PSA 10 expected: $900 (n=8)     │
│  After $80 grading: +$710 gain   │
│  374% ROI on cost basis          │
│                                  │
│  Also worth: BGS 9.5 (+$310)     │
│                                  │
│  [Mark as At Grading]            │
└──────────────────────────────────┘
```

If `overallRecommendation === "grade_worthy_but_wait"`:
```
⚠️ WORTH GRADING (but wait)
   Player momentum is down.
   Waiting for reversal could add 25%+ to expected gain.
```

If `overallRecommendation === "not_worth"` or `"insufficient_data"`: hide the block entirely. Don't show a "no signal" card — it's noise.

## Design notes / gotchas

- **Never surface the internal `expectedRoi` decimal.** Show as `%` string (e.g. "374% ROI"). Below 100% show 1 decimal (e.g. "45.6% ROI").
- Show `gradedSampleSize` as "based on N recent graded sales" — build trust in the number.
- **Do not** show the "insufficient_data" state as an actionable UI. Hide it.
- The `diagnostics.playerMomentumDirection` is context for the copy but NOT a separate UI element — it's already reflected in the recommendation.
- Grade-worthy check is a raw-holdings-only path. Graded holdings return an `already_graded_out_of_scope` recommendation — hide that block on graded card detail.

## Testing

- `curl /api/portfolio/holdings/<raw-hartman-holding-id>/grade-analysis` — expect `grade_now`
- `curl /api/portfolio/holdings/<graded-holding-id>/grade-analysis` — expect `not_worth` with reason "Already graded"
- `curl /api/portfolio/grade-worthy-alerts` — expect list sorted by expectedGain DESC
- Try a holding for an obscure player with no graded comps — expect `insufficient_data`

## v2 known limits to document in-app

The v1 explicitly assumes: graded outcome = target tier. Add small "?" info toggle: *"Assumes best-case grade result. Actual outcome depends on card condition."*

v2 will add a condition-scoring model (auto-scored via user photo or user-declared) that returns a probability-weighted expected gain across (PSA 10 / 9 / 8) outcomes.
