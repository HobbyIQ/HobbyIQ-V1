# iOS Prompt — Unified Corpus-Signals Surfaces (2026-07-17)

**For:** Claude Code running against the HobbyIQ iOS repo
**Backend context:** ~1M-row baseball comp corpus (`ch_daily_sales`), nightly-computed player trends (stratified: all/raw/graded), observed family multipliers, grader-premium curves. All endpoints session-required, rate-limited under `priceChecksPerDay`.

## Backend endpoints (all shipped or in flight to prod)

### 1. Player trends (stratified)
`GET /api/portfolio/player-trend/:player`

Path param is URL-encoded raw player name. Response:

```json
{
  "player": "Eric Hartman",
  "computedAt": "2026-07-17T03:45:12Z",
  "momentum": 1.48,           // "all" variant fields at top level (v1 back-compat)
  "direction": "up",
  "velocityPerWeek": 228.67,
  "cardsInPool": 56,
  "qualifyingCards": 25,
  "flags": [],
  "perCardRatios": [...top 20 SKUs sorted by |ratio-1| DESC],
  "raw":    { "momentum": 1.35, "direction": "up", ... },
  "graded": { "momentum": 1.62, "direction": "up", ... },
  "servedFrom": "nightly_cache" | "on_demand"
}
```

Key insight for grade-worthy: **if `graded.momentum > raw.momentum` on the same player, the market is REWARDING grading right now.**

### 2. Grade-Worthy per-holding
`GET /api/portfolio/holdings/:id/grade-analysis`

Response:
```json
{
  "holdingId": "abc",
  "player": "Eric Hartman",
  "year": 2026,
  "cardNumber": "CPA-EHA",
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
    "allTiers": [...],
    "overallRecommendation": "grade_now" | "grade_worthy_but_wait" | "not_worth" | "insufficient_data",
    "reason": "..."
  },
  "diagnostics": {
    "localCorpusRows": 329,
    "playerMomentum": 1.4836,
    "playerMomentumDirection": "up"
  }
}
```

### 3. Grade-Worthy portfolio scan
`GET /api/portfolio/grade-worthy-alerts`

Returns candidates with `recommendation === "grade_now"`, sorted by `expectedGain` DESC:
```json
{
  "scannedHoldings": 36,
  "gradeWorthyCount": 4,
  "candidates": [ ... ]
}
```

### 4. Family multipliers (blended-avg-by-product fallback)
`GET /api/portfolio/family-multipliers/:family`
`GET /api/portfolio/family-multipliers/:family/:tier`

`:family` accepts human text (`"Bowman Chrome Baseball"`) OR slug (`"bowman_chrome_baseball"`) — server slugs idempotently.

Family response:
```json
{
  "familyKey": "bowman_chrome_baseball",
  "tiers": [
    {
      "graderTier": "PSA 10",
      "multiplier": 5.4,
      "confidence": "high",     // "high" | "medium" | "low"
      "nGraded": 47, "nRaw": 340,
      "medianRawPrice": 89, "medianGradedPrice": 480,
      "computedAt": "..."
    },
    ...
  ]
}
```

## Two consumer surfaces to build

### Surface 1 — Portfolio Home banner + Grade-Worthy list view

On the portfolio dashboard, above the holdings list:

1. Fetch `/grade-worthy-alerts` on app foreground (5-min TTL cache).
2. If `gradeWorthyCount > 0`, show a top-of-list banner:

```
┌─────────────────────────────────────────────────┐
│ 💎  4 cards worth grading                       │
│    Top: Hartman CPA-EHA — expected +$710        │
│    [Review all →]                               │
└─────────────────────────────────────────────────┘
```

3. Tap → list view of all candidates. Each row:
   - Card thumb (reuse existing local-comp image fetch)
   - Expected gain in **forest green** (existing verdict color)
   - Grader tier + ROI %
   - One-line reason
   - CTA button: **"Mark as At Grading"** (calls existing `/regrade` endpoint with the best tier's `graderTier`)

### Surface 2 — Card detail view (upgrade)

Existing card-detail view. When the card is Raw:

1. On view open, fetch:
   - `/holdings/:id/grade-analysis` — the direct signal
   - `/player-trend/:player` — for the player context arrow

2. Layout, below the FMV:

```
┌──────────────────────────────────────────┐
│ Player Momentum                          │
│  Eric Hartman   ▲ +48.4%   228/wk        │
│  25 of 56 cards agree                    │
│                                          │
│  ↓ tap for split ↓                       │
│    Raw   ▲ +35.2%                        │
│    Graded ▲ +62.4%  ← market rewards     │
│                       grading now         │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ Grade Analysis                           │
│                                          │
│  💎 GRADE NOW                            │
│  PSA 10 avg: $900 (n=8)                  │
│  After $80 grading: +$710 gain           │
│  374% ROI on cost basis                  │
│                                          │
│  Also worth: BGS 9.5 (+$310)             │
│  [Mark as At Grading]                    │
└──────────────────────────────────────────┘
```

Fallback treatments:
- `overallRecommendation === "grade_worthy_but_wait"` — same block but title is **"⚠️ Worth grading — but wait"** with reason line "Player momentum is down. Waiting could add 25%+ to expected gain."
- `overallRecommendation === "not_worth"` — hide the Grade Analysis block entirely. Don't show a null-state — it's noise.
- `overallRecommendation === "insufficient_data"` — hide.

### Player Trend Arrow (inline on inventory rows)

On every inventory row where a player name is visible, adjacent render:

- ▲ green when `direction === "up"`
- ▼ red when `direction === "down"`
- ► amber (or omit) when `direction === "flat"`
- Percentage text: `(momentum - 1) * 100`, one decimal, e.g. `+48.4%`

Rate-limit caching: fetch player trend once per session per player, in-memory. If more than 12h old, re-fetch.

## Design tokens / gotchas

- **Never surface `expectedRoi` as a bare decimal (3.74).** Always `%` string ("374% ROI"). Below 100% use one decimal ("45.6% ROI").
- **`servedFrom`, `flags`, `confidence`, `nGraded`, `nRaw`, `computedAt`** are all diagnostic. Never render raw; use them to inform the copy.
- Match existing verdict-arrow color system on inventory rows (forest / brick / amber). Do NOT introduce new accent colors.
- **Do not render "insufficient_data" as a UI state.** Hide the block.
- All amounts formatted with existing currency helpers.
- Trend arrow should appear at reduced weight (grayed) if `flags` includes `"sparse"`. Add a tooltip: "Limited data — signal may be noisy."
- If `flags` includes `"one_card_dominant"`: normal arrow, add subline "1 card is >50% of volume — check breakdown."
- If `flags` includes `"wide_ratio_dispersion"`: normal arrow, add subline "Cards moving in different directions."

## Copy rules

- **This is a matched-cohort signal, not FMV.** Do not use momentum to price a specific card. If the copy needs disambiguation, say "player-level momentum" or "market-level trend."
- Grade Analysis is NOT a guarantee. Include small "?" info toggle: *"Assumes best-case grade result. Actual outcome depends on card condition."*
- Never surface diagnostic strings (`"nightly_cache"`, `"insufficient_data"`) to users. They're for logs.

## Testing

- Curl `/api/portfolio/player-trend/eric_hartman` — expect `direction: "up"`, `momentum ~1.48`, `raw`/`graded` sub-objects
- Curl `/api/portfolio/holdings/<raw-hartman-holding-id>/grade-analysis` — expect `grade_now`
- Curl `/api/portfolio/family-multipliers/Bowman%20Chrome%20Baseball` — expect ≥3 tiers with `confidence: "high"` or `"medium"`
- Curl `/api/portfolio/grade-worthy-alerts` — expect list sorted by `expectedGain` DESC

## What's shipping when

| PR | Endpoint | Status |
|---|---|---|
| #517 | `/player-trend/:player` | Deployed to prod |
| #518 | `/grade-analysis` + `/grade-worthy-alerts` | In CI |
| #519 | `player-trend` gains `raw`/`graded` sub-objects | In CI |
| #520 | `/family-multipliers/*` | In CI |

Build iOS to consume the STRATIFIED shape (with `raw`/`graded`) from day one. If PR #517-only prod hasn't been updated yet, top-level fields still work.
