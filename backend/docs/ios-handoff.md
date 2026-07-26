# iOS handoff — new backend surfaces (2026-07)

Everything landed on prod between 2026-07-24 and 2026-07-26. Base URL:
```
https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net
```
Auth: every route below requires `x-session-id` header (`requireSession` middleware).

---

## 1. `POST /api/compiq/card-search` — catalog picker

Free-text search over card_catalog (with sold_comps fallback for vintage / Cardsight gaps). Backs typeahead-into-picker.

**Request**
```json
{
  "q": "trout topps",
  "sport": "baseball",
  "limit": 20,

  "parallel": "Blue Refractor",    // optional filter
  "grade": "PSA 10",               // optional; also parses "psa10", "gem", etc.
  "printRun": 150,                 // optional
  "isAuto": true,                  // optional boolean
  "year": 1972,                    // optional; tokenizer also picks 4-digit years from q

  "sellThresholdPct": 20           // optional; per-request sell-signal threshold (default 15, range 5-100)
}
```

**Response** (`CanonicalSearchResult`)
```swift
struct CanonicalSearchResult: Codable {
  let q: String
  let tokens: [String]
  let semanticFilters: SemanticFilters
  let appliedFilters: AppliedFilters
  let hits: [CanonicalSearchHit]
  let groups: [CanonicalSearchGroup]              // hits collapsed by (player, year, cardNumber)
  let facets: Facets
  let totalCandidates: Int
  let cachedFromMemory: Bool
  let confidentSingleResult: Bool                 // top hit ≥3× runner-up → iOS can auto-jump
  let computedAt: String                          // ISO
}

struct CanonicalSearchHit: Codable {
  let hobbyiqCardId: String?                      // canonical slug — pass to /card-detail
  let player: String?
  let releaseName: String?
  let cardYear: Int?
  let cardNumber: String?
  let parallels: [Parallel]
  let isAutographSet: Bool
  let sport: String
  let imageUrl: String?
  let recentMedian: Double?                       // 90-day median from sold_comps
  let compCount: Int
  let matchedTokens: [String]
  let matchedRanges: [MatchedRange]               // for bold-highlight in the row
  let momentumPct: Double?                        // 30d-vs-prior-60d % change
  let recentSaleCount: Int                        // popularity indicator
  let signal: Signal                              // "sell-now" | "hold" | "buy" | "watch"
  let signalReason: String                        // one-sentence explanation for tooltip
  let score: Double
}

enum Signal: String, Codable { case sellNow = "sell-now", hold, buy, watch }

struct MatchedRange: Codable {
  let field: String                               // "player" | "releaseName" | "cardNumber" | "parallels"
  let start: Int
  let end: Int
  let token: String
}

struct Parallel: Codable {
  let id: String?
  let name: String
  let numberedTo: Int?
}

struct CanonicalSearchGroup: Codable {
  let groupId: String
  let player: String?
  let cardYear: Int?
  let releaseName: String?
  let cardNumber: String?
  let variantCount: Int
  let hits: [CanonicalSearchHit]
}

struct Facets: Codable {
  let parallels: [String: Int]
  let grades: [String: Int]
  let printRuns: [String: Int]
  let years: [String: Int]
  let releaseNames: [String: Int]
}
```

**Render notes**
- `hits[0].confidentSingleResult == true` + no user disambiguation → auto-jump straight into `/card-detail`
- `matchedRanges` gives exact substring positions per matched field; use to bold in the row label
- `signal` badge colors: `sellNow` red/orange, `buy` green, `hold` neutral gray, `watch` muted / hide
- `signalReason` verbatim → badge tooltip
- `momentumPct` inline arrow: `↑` if > 0, `↓` if < 0, hide if null

**Sell threshold setting**
- Add "Sell alert at +N%" in settings (default 15, slider 5-100)
- Pass `sellThresholdPct` on every `/card-search` request
- Buy/hold/watch stay locked at doctrine defaults regardless

---

## 2. `POST /api/compiq/card-detail` — tap-into-card composite

Single call for the card-detail screen. Returns identity + FMV + related cards in parallel. `Promise.allSettled` — partial failures don't blank the screen.

**Request**
```json
{
  "hobbyiqCardId": "hiq:baseball:2026:bowman:cpa-eh:base:auto",
  "gradeCompany": "PSA",         // optional
  "gradeValue": 10,              // optional
  "maxAgeDays": 180,             // freshness window (default 180)
  "previewLimit": 10,            // recentComps preview size
  "relatedLimit": 8,             // related-cards per bucket
  "includeGradeLadder": false    // opt-in for the full PSA 10 / 9 / 8 / BGS / Raw grade breakdown
}
```

**Response**
```swift
struct CardDetailResult: Codable {
  let success: Bool
  let hobbyiqCardId: String
  let identity: CardDetailIdentity
  let fmv: HobbyIqFmvResult?                       // may be null on error; use fmvError
  let fmvError: String?
  let gradeLadder: [GradeLadderTier]?              // null when includeGradeLadder=false
  let gradeLadderError: String?
  let related: RelatedCardsResult?
  let relatedError: String?
  let processingMs: Int
  let computedAt: String
}

struct CardDetailIdentity: Codable {
  let hobbyiqCardId: String
  let sport: String?
  let year: Int?
  let setKey: String?
  let cardNumber: String?
  let parallel: String?
  let isAuto: Bool?
  let printRun: Int?
}

struct GradeLadderTier: Codable {
  let gradeLabel: String       // "PSA 10", "BGS 9.5", "Raw"
  let gradeCompany: String?
  let gradeValue: Double?
  let fmv: Double?
  let compCount: Int           // direct comps in this tier (0 = insufficient data — gray it out)
  let trend: String            // "up" | "down" | "flat"
  let method: String
  let confidence: Double
}
```

**Perf note** — grade-ladder is opt-in (previously blew up to 15s; now single-scan drops to <1s but still opt-in for tap-into-card default). Only include when rendering the grade-breakdown view.

---

## 3. `POST /api/compiq/hobbyiq-fmv` — canonical FMV read

Zero-vendor-call FMV lookup by slug. Read this for anywhere iOS needs "the HobbyIQ price."

**Request**
```json
{
  "hobbyiqCardId": "hiq:baseball:2026:bowman:cpa-eh:base:auto",
  "gradeCompany": "PSA",
  "gradeValue": 10
}
```

**Response** — see `HobbyIqFmvResult` in backend/src/services/portfolioiq/hobbyIqFmv.service.ts (comprehensive; not repeated here). Key fields for iOS:
- `fmv: Double?` — the number
- `method: String` — which fallback rung fired (direct-slug is highest confidence)
- `confidence: Double` — 0.0-1.0 iOS-friendly bar
- `trend: { direction, slopePerMonthPct, method }` — for the trend badge
- `breakdown.byAutoStyle / byGradeQualifier` — mix badges
- `population.byGrader` — scarcity badges ("PSA10 pop 47")
- `quality: { score, flaggedCompCount, sources }` — trust indicator + flag count

---

## 4. `POST /api/compiq/lookup-by-image` — scan-a-card

User takes a photo → pHash → match against 2.34M-row pHash pool.

**Request**
```json
{
  "imageBase64": "iVBORw...",            // OR
  "imageUrl": "https://...",
  "limit": 5,
  "maxHamming": 20                       // 0-64, default 20
}
```

**Response**
```swift
struct ImageLookupResult: Codable {
  let algo: String                       // "dhash-v1"
  let queryHash: String?                 // null if image couldn't be hashed
  let hits: [ImageLookupHit]
  let totalPhashedRows: Int              // for context: the pool size
  let computedAt: String
  let processingMs: Int
}

struct ImageLookupHit: Codable {
  let hobbyiqCardId: String
  let player: String?
  let cardYear: Int?
  let setName: String?
  let cardNumber: String?
  let parallel: String?
  let isAuto: Bool
  let hamming: Int                       // 0-64, lower = better
  let matchConfidence: String            // "exact" | "strong" | "likely" | "possible"
  let recentMedian: Double?
  let imageUrl: String?
  let compCount: Int
}
```

**Confidence buckets:**
- `exact` (hamming ≤ 5) → auto-jump into card-detail
- `strong` (≤ 10) → highlight + confirm
- `likely` (≤ 15) → show as best guess, allow "not this one"
- `possible` (> 15) → list of maybes

---

## 5. `GET /api/compiq/autocomplete-player?q=X` — player typeahead
## 6. `GET /api/compiq/autocomplete-set?q=X` — set typeahead

10-min in-memory cache. Prefix + contains match. Sub-second post-warm.

**Request:** `?q=trou&sport=baseball&limit=10`

**Response**
```swift
struct AutocompleteResult: Codable {
  let q: String
  let hits: [AutocompleteHit]
  let computedAt: String
  let cachedFromMemory: Bool
}
struct AutocompleteHit: Codable {
  let name: String
  let count: Int              // usage count in card_catalog
  let sport: String?
}
```

Renders: name + faded count. Ranks prefix matches first, then contains matches, both by count desc.

---

## 7. `GET /api/compiq/trending` / `trending-players` / `related-cards`

Discovery surfaces. All 10-min memoized. `related-cards` takes `?slug=hiq:...`.

Response shapes in `backend/src/services/portfolioiq/discoverySurfaces.service.ts`.

---

## 8. `POST /api/compiq/flag-comp` — comp verification

User taps "flag this comp" on any comp shown → this endpoint. First flag adds `"user-flagged"` to `qualityFlags` → next FMV compute drops it.

**Request**
```json
{
  "compId": "cardhedge::abc123",       // from the comp record (comp.id)
  "cardId": "cs-abc",                  // partition key (comp.cardId)
  "reason": "wrong-price",             // enum below
  "note": "listed same day at 10x"     // optional, 500 char cap
}
```

Reasons: `wrong-price`, `wrong-card`, `wrong-grade`, `off-market`, `duplicate`, `other`

**Response**
```swift
struct FlagCompResult: Codable {
  let success: Bool
  let compId: String
  let alreadyFlaggedByYou: Bool
  let totalUserFlags: Int
  let qualityFlagsApplied: Bool         // true when this flag pushed to auto-filter threshold
}
```

**iOS surface** — small flag icon on each recent comp row; sheet with reason picker + optional note; POST on submit; badge state uses `alreadyFlaggedByYou`.

---

## 9. `PortfolioHolding` now carries `hobbyiqCardId`

Every holding wire response now includes `hobbyiqCardId: String?`. iOS holding tap → `POST /card-detail` with that slug — no client-side derivation needed.

If null (legacy holding missing identity fields), fall back to legacy tap behavior.

---

## Priority wire order for iOS

1. **`/card-search` picker** (most-used surface — search, tap, done)
2. **`/card-detail` on tap-into-card** (single call replaces N legacy calls)
3. **Holding row tap → `/card-detail` via holding.hobbyiqCardId** (portfolio↔detail)
4. **`/autocomplete-player` typeahead** (fast UX polish)
5. **`/flag-comp` UI on recent-comps rows** (closes the quality feedback loop)
6. **`/lookup-by-image` scan-a-card** (killer differentiator, but bigger UI lift)
7. **Sell alert threshold setting** (pass on every /card-search)
8. **Grade-breakdown view opt-in** (`includeGradeLadder: true`)

---

## Edge cases / gotchas

- **`/card-search` may return 0 hits with `_origin: "sold-comps-fallback"` cards** — these have `cardId: null`; that's expected. Use `hobbyiqCardId` for tap-through.
- **`fmv` in `/card-detail` may be null with `fmvError` populated** — render "temporarily unavailable" for the FMV section, but still show identity + related.
- **`signal == "watch"` cards** — probably don't render the signal badge at all (would be noise).
- **`gradeLadder` tiers with `compCount == 0`** — gray out; those are fallback values (would be nice to hide entirely for empirical purity).
- **`confidentSingleResult == true`** — only auto-jump when user hasn't started typing more; otherwise let them refine.
