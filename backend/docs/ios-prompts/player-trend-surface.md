# iOS prompt — Player-Trend Surface

## What the backend just shipped

- **Endpoint:** `GET /api/portfolio/player-trend/:player`
  - `:player` is url-slug of the raw player name (server does the normalization; iOS can just URL-encode the raw string, e.g. `Eric%20Hartman`)
  - Session-required (same auth as the rest of `/api/portfolio/*`)
  - Rate-limited under `priceChecksPerDay`

- **Response shape:**

```json
{
  "player": "Eric Hartman",
  "computedAt": "2026-07-17T03:45:12Z",
  "momentum": 1.4836,
  "direction": "up",
  "velocityPerWeek": 228.67,
  "cardsInPool": 56,
  "qualifyingCards": 25,
  "totalSales": 1754,
  "perCardRatios": [
    {
      "cardId": "1778476723050x968931040808609400",
      "skuLabel": "2026 Bowman Baseball · Aqua X-Fractor Refractor · BCP-102",
      "ratio": 3.155,
      "nRecent": 5,
      "nPrior": 6,
      "medianRecent": 71,
      "medianPrior": 22.51
    }
    // ... top 20 sorted by |ratio - 1| DESC (biggest movers first)
  ],
  "flags": [],  // "sparse" | "one_card_dominant" | "wide_ratio_dispersion"
  "servedFrom": "nightly_cache" | "on_demand"
}
```

## Two consumer surfaces to build

### 1. Player-detail trend arrow (highest value)

On any inventory row or search result where a player name is visible, adjacent to the player name render:

- ▲ green when `direction === "up"`
- ▼ red when `direction === "down"`
- ► amber (or hide entirely) when `direction === "flat"`
- Percentage text: `(momentum - 1) * 100`, one decimal, e.g. `+48.4%`

On tap, expand into a bottom sheet showing:

- Big number: the momentum % + direction icon
- Sub-line: `qualifyingCards` cards in cohort · `velocityPerWeek` sales/week
- Flags: if `sparse`, show "Limited data — signal may be noisy". If `one_card_dominant`, show "One card carries the signal — check per-card ratios below". If `wide_ratio_dispersion`, show "Cards disagree on direction".
- List: top-10 `perCardRatios[]` — each row = SKU label + arrow (▲/▼) + ratio-as-percentage. Tap a row to jump into that card's detail.

### 2. Hot leaderboard (Discover tab)

New section on the Discover tab titled **"Hot right now"**. Server-side add a `GET /api/portfolio/hot-players?limit=25` endpoint later (out of scope for this iOS pass; use `readAllStoredTrends` sorted by momentum client-side for now if you want to prototype).

Row layout:
```
1. Eric Hartman         ▲ +48.4%    228/wk
   25 of 56 cards agree
```

## Design notes / gotchas

- **`servedFrom: "on_demand"`** takes ~500-1500ms; nightly-cache is <30ms. If you show a spinner, only show it after 200ms so cache hits feel instant.
- **`servedFrom` should NOT be user-visible.** It's a diagnostic field for backend debugging.
- Match the existing verdict-arrow color system on inventory rows (forest / brick / amber — see the design system in `[artifact-design]` skill).
- Never display `momentum` as a bare decimal (1.484) — always convert to a percent-delta from 1.0 (+48.4%).
- **This is a matched-cohort signal, not FMV.** Do not use it to price a specific card. If the copy needs disambiguation, say "player-level momentum".

## Data quality caveats to surface

The three flags in the response each have specific UI meanings:

| Flag | UI treatment |
|---|---|
| `sparse` | Show the trend at reduced weight (grayed) with tooltip: "Only N cards had comparable-window sales" |
| `one_card_dominant` | Show trend normally but add: "1 card is >50% of volume — check breakdown" |
| `wide_ratio_dispersion` | Show trend but add: "Cards are moving in different directions" |

## Testing

- Curl `/api/portfolio/player-trend/eric_hartman` — expect `direction: "up"`, `momentum ~1.5`
- Try a player NOT in nightly cache (obscure prospect) — expect `servedFrom: "on_demand"`, still valid response
- Try a nonexistent player ("Xxxxxxxxxxx") — expect `momentum: 1`, `flags: ["sparse"]`, `qualifyingCards: 0`
