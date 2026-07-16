# Verdict History + Flip Surfaces

**Status:** Backend routes shipped alongside this doc (PR follow-up to #428). iOS implementation TODO.
**Related PR:** #428 shipped the persistence + flip detection; this follow-up wires the read routes iOS consumes.

## Design call

Three surfaces, magnitude-gated push:

1. **Inventory-row dot** — small colored dot for holdings whose verdict flipped in the last 7 days.
2. **Holding-detail history strip** — permanent 3-flip strip on the detail sheet.
3. **Push notification** — fires only for `significance="major"` flips (bull ↔ bear boundary crossings) AND only when the user opted in during onboarding.

Reasoning on the push threshold: HOLD-adjacency nudges (mixed → bull, bull → strong_bull) are not actionable news for most users. Bull ↔ bear boundary crossings are — the thesis actually changed.

## Backend routes (live)

### `GET /api/compiq/players/:player/verdict-history?days=90`

Returns the ordered verdict history + detected flips for a single player. Feeds the **holding-detail history strip**.

**Auth:** requires session.
**Path param:** `player` — the display name, URL-encoded. Backend normalizes (lowercase + hyphen).
**Query:** `days` — 1..180, defaults to 90.

**Response:**

```typescript
{
  success: true,
  player: string,                    // normalized (lowercase-hyphenated)
  days: number,
  history: VerdictDoc[],             // oldest → newest
  flips: VerdictFlip[]               // oldest → newest, only day-over-day changes
}

interface VerdictDoc {
  id: string;                        // `${player}::${YYYY-MM-DD}`
  player: string;
  date: string;                      // YYYY-MM-DD
  verdict: "strong_bull" | "bull" | "mixed" | "supply_tight" | "static"
         | "oversupply" | "bear" | "soft" | "weak" | "unavailable";
  salesDirection: "up" | "down" | "static" | null;
  listingsDirection: "up" | "down" | "static" | null;
  generatedAt: string;               // ISO timestamp of the snapshot
  ttl: number;                       // 180d
}

interface VerdictFlip {
  player: string;                    // normalized
  date: string;                      // YYYY-MM-DD of the NEW verdict
  from: Verdict;                     // prior verdict
  to: Verdict;                       // new verdict
  significance: "major" | "minor";   // major = crosses bull/bear boundary
}
```

### `POST /api/compiq/portfolio/flips`

Batch mirror: returns recent flips across a list of players. Feeds the **inventory-row dot** and the future push-notification worker.

**Auth:** requires session.
**Body:**

```json
{
  "players": ["Eric Hartman", "Mike Trout", "Wander Franco"],
  "days": 7
}
```

- `players` — array of display names, 1..200 entries, non-empty strings after trim. Duplicates deduplicated by normalized name server-side.
- `days` — 1..30, defaults to 7.

**Response:**

```typescript
{
  success: true,
  requestedPlayers: number,          // count after client dedupe
  days: number,
  flips: VerdictFlip[]               // newest first, deduplicated
}
```

## Surface 1 — Inventory-row dot

**Trigger:** on portfolio load, iOS calls `POST /portfolio/flips` with every unique player in the user's holdings (cap 200; if the portfolio is larger, batch — the endpoint enforces the 200 cap and returns 400 above it).

**Rendering per holding:**

- For each holding, look up `flips.filter(f => f.player === normalized(holding.playerName))[0]` (most recent flip for that player).
- If found: render a 6pt dot on the leading edge of the inventory row.
- **Color:** matches the new verdict — green for bull-side (`bull`, `strong_bull`, `supply_tight`), red for bear-side (`bear`, `soft`, `weak`, `oversupply`), gray for `mixed` / `static` / `unavailable`.
- **Freshness:** dot at full opacity for 7 days after `flip.date`. Days 8-14, drop to 40% opacity. Day 15+, hide.
- **Tap:** navigates to the holding detail sheet (which shows the history strip; see Surface 2).

**Do NOT** overlay the dot on card art. It goes in the row's fixed leading padding area — same slot the "graderStatus" badge already uses if that field is present.

## Surface 2 — Holding-detail history strip

**Trigger:** when the holding detail sheet opens, iOS calls `GET /players/:player/verdict-history?days=90`.

**Rendering:** a horizontal strip at the top of the detail sheet, above the value block. Show the last 3 flips (or fewer if the player has fewer):

```
SELL ← HOLD 3d · HOLD ← BUY 21d · BUY ← MIXED 47d
```

Formatting:

- Verdict labels ARE the user-facing terms iOS already renders elsewhere (`bull` → "BUY", `bear` → "SELL", `mixed` → "HOLD", etc.). Reuse whatever mapping already ships.
- Days-since is `now - flip.date`. Format: `3d` for <7 days, `2w` for 7-27, `1mo` for 28-364, `1y+` for older.
- Separator: `·` centered dot.
- **When `flips.length === 0`:** hide the strip entirely (do not render an empty state). The value block sits at the top.

**Tap:** each flip is tappable → expands to a full-history modal showing `verdict-history.history` as a vertical timeline. Use the modal for users who want the full 90-day view.

## Surface 3 — Push notification (opt-in)

**Not implemented in this PR.** Wiring pass:

1. During onboarding (or in Settings), add a toggle: "Verdict flip alerts — get notified when a card in your inventory flips from BUY to SELL or vice versa". Store as `preferences.pushOnMajorFlip: bool` on the user doc.
2. A downstream worker (backend, out of scope here) reads the `verdict_flip_detected` App Insights events emitted by the daily cron, filters `significance === "major"` AND joins to users whose portfolio contains that player AND `preferences.pushOnMajorFlip === true`, then fans out via APNs.
3. Copy: `"Trout '11 Update flipped from BUY to SELL. Tap to review."` Deep-link opens the holding detail sheet.

**Do NOT** implement the fan-out worker in iOS. This is purely a backend cron follow-up; iOS just needs the settings toggle and the deep-link handler.

## Empty / edge cases

| State | iOS behavior |
|---|---|
| Player has zero snapshots (`history: []`) | Hide the strip. No dot on the row. |
| Player has 1 day of history | Same as above. Flips need ≥ 2 consecutive-day snapshots. |
| Player has snapshots but no flips in the window | Strip hidden; no dot. `readRecentFlipsForPlayers` returns them at newest-first order — just filter to non-empty. |
| Portfolio > 200 players | Client batches 200 at a time. Server enforces the cap with 400. |
| Backend Cosmos unavailable | Both routes return `flips: []` / `history: []` (never throw). iOS renders as "no flip" state. |

## Refresh cadence

- Batch flips: refresh on portfolio open, on pull-to-refresh, and once every 15 minutes if the app is foregrounded. Not more often — the daily cron writes snapshots once per day, so more-frequent polling is wasted.
- Detail-sheet history: fresh fetch each time the sheet opens. Cache in-memory for that session only.

## Test with real inventory

Verify against Drew's portfolio:

1. Open portfolio, wait for `/portfolio/flips` — any inventory rows show a dot in the first 7 days after a real flip.
2. Tap into a holding with a flip → history strip renders 1-3 chips.
3. Tap a chip → full-history modal shows the 90-day timeline.
4. Flip a hypothetical: manually seed a `verdict_history` doc via Cosmos Data Explorer for a Drew-owned player (Trout, Hartman), refresh, confirm the dot appears with correct color.

## Related

- [[project_information_cascade_signal_model]] — the flip event IS the cascade fire moment. Detail-sheet history should read as "the thesis changed" not "we're less sure".
- [[project_product_actionable_seller_intelligence]] — flips are the actionable moment. UI copy should be action-oriented, not descriptive.
