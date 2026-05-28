# CF-UNIFIED-SEARCH-AND-CERT — Phase 1 Discovery (Current State)

**Date:** 2026-05-28
**Scope:** Empirical inventory of what currently exists in code (backend + iOS) that the v1 unified search/verify/comp-card flow + extensible cert-grader abstraction will build on or sit beside. **No proposals. No design.** Phase 2 (architecture proposal) consumes this; Phase 3 (design doc + HALT) follows that.

**Method:** Read-only inspection of `C:/dev/hobbyiq-main/backend/src/`, `C:/dev/hobbyiq-main/HobbyIQ/` (canonical iOS source on `main`), and `C:/Users/dvabu/OneDrive .../HobbyIQ-V1/` (parallel OneDrive working tree containing untracked Swift WIP). Sources cited inline.

---

## 1. Backend — PSA cert lookup (the one cert grader we have)

**Service:** [`backend/src/services/psa/psaCert.service.ts`](../../backend/src/services/psa/psaCert.service.ts) (149 lines).

**Upstream API:** PSA Public API. Default base URL `https://api.psacard.com/publicapi`, overridable via `PSA_API_BASE_URL`. Endpoint shape: `GET /cert/GetByCertNumber/{certNumber}`.

**Auth:** Bearer token. Reads `PSA_API_BEARER_TOKEN` (or `PSA_BEARER_TOKEN` fallback). Production has `PSA_API_BEARER_TOKEN` configured (verified 2026-05-28 in Azure app settings).

**Timeout:** 15s default (`PSA_API_TIMEOUT_MS` env override).

**Response shape** (`PsaCertLookupResult`):
```ts
{
  source: "psa-public-api",
  certNumber: string,
  certificationType: "PSA" | "DNA" | "UNKNOWN",
  card: {
    year: string | null,
    brand: string | null,
    category: string | null,
    cardNumber: string | null,
    subject: string | null,        // → playerName equivalent
    variety: string | null,         // → parallel equivalent (sometimes)
    grade: string | null,
    gradeDescription: string | null,
    specId: number | null,
    itemStatus: string | null,
    totalPopulation: number | null,
    populationHigher: number | null,
  } | null,
  raw: unknown,                     // full upstream body for debugging
}
```

**Error states (typed via `PsaApiError`):**
- `PSA_TOKEN_MISSING` (500) — env not configured
- `PSA_AUTH_FAILED` (502) — upstream 401/403
- `PSA_QUOTA_EXCEEDED` (429) — upstream rate-limited
- `PSA_TIMEOUT` (504) — 15s deadline
- `PSA_REQUEST_FAILED` (502) — other 4xx/5xx
- `PSA_REQUEST_ERROR` (502) — non-Error throw

**Route:** [`backend/src/routes/psa.routes.ts`](../../backend/src/routes/psa.routes.ts), `GET /api/psa/cert/:certNumber`. **Session-gated** via `x-session-id` header (requires valid session). Surfaces structured error codes on failure.

**Observed:** Service exists and is wired. Route exists and is wired. **NOT** called from any current iOS flow on `main`. The OneDrive WIP scan path captures a `certNumber` field but feeds it into a different endpoint (see §5).

---

## 2. Backend — Cardsight free-form catalog search (the future-proof path)

**Client:** [`backend/src/services/compiq/cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts).

**Function:** `searchCatalog(query, opts)` — POST/GET to `${BASE_URL}/catalog/search?q=...&type=card&segment=baseball&take=...&year=...`. Returns `CardsightCatalogResult[]`:
```ts
{
  id: string,           // Cardsight cardId (UUID)
  name: string,         // typically just the player name
  number: string,
  releaseName: string,  // product line, e.g. "Topps Chrome"
  setName: string,      // subset, e.g. "Base Set"
  year: number,
  player?: string,
}
```

**Wrapped by router:** [`backend/src/services/compiq/cardsight.router.ts`](../../backend/src/services/compiq/cardsight.router.ts) `searchCardsRouted(query, limit)`. Mode-gated on `CARDSIGHT_MODE` env (currently `exclusive` in prod). Adapts to `CardHedgeCard` shape via `csToChCard` so downstream consumers see one type.

**Coverage limitations** (documented across this session):
- Cards with non-flagship products may not match: `topps` (flagship) NOT in `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary at [cardsight.mapper.ts:51-66](../../backend/src/services/compiq/cardsight.mapper.ts#L51-L66). Resolver falls back to player-name-only search.
- Some parallels (Wal-Mart Border, Target Red, CHR PROS family) not catalogued at all (vendor gap).
- Some parallels (Tiffany) catalogued but sales not tagged by `parallel_id` (handled today via title-match fallback per CF-CARDSIGHT-RESOLVER-REDESIGN).

**Probed health:** `/api/ops/cardsight-probe` (admin-gated) — used multiple times this session, returns HTTP 200 with sub-2s latency.

---

## 3. Backend — Card Hedge (the legacy picker path, still active in prod)

**Functions:** [`searchCards`](../../backend/src/services/compiq/cardhedge.client.ts) (the picker endpoint), `getCardSales`, `findCompsByQuery`.

**Active prod call sites** (under `CARDSIGHT_MODE=exclusive`):
- [`compiq.routes.ts:6`](../../backend/src/routes/compiq.routes.ts#L6) — direct import of `searchCards` for `/api/compiq/cardsearch`.
- [`compiq.routes.ts:753`](../../backend/src/routes/compiq.routes.ts#L753) — dynamic import of `searchCards` for `/api/compiq/search-list`.
- `cardsight.router.ts` `off`/`shadow`/`primary` mode branches reference `cardhedge.client.ts` but are inert under `exclusive`.

**Status:** Removal sequenced as **CF-PICKER-MIGRATE-TO-CARDSIGHT** in the active roadmap (Week 5-6 work). v1 unified search has to make a build-time choice: route through CardHedge (current picker, legacy) OR Cardsight (future, but lacks CHR PROS class coverage today).

---

## 4. Backend — Existing search/picker endpoints (what we'd reuse vs. replace)

| Endpoint | Method | Use | Response shape | Backend |
|---|---|---|---|---|
| `/api/compiq/cardsearch` | POST | iOS Search picker, up to 50 hits with image_url | `{ ok, hits: [{card_id, title, player, year, set, card_number, variant, image_url}] }` | CardHedge `searchCards` |
| `/api/compiq/search-list` | POST | Card-Ladder-style two-step search, up to 30 hits with autograph detection + color matching + sort scoring | `{ results: [{cardHedgeCardId, player, set, year, number, variant, ...}] }` | CardHedge `searchCards` (dynamic import) |
| `/api/compiq/search` | POST | DashboardView free-text search; runs full `computeEstimate` | Full estimate shape | Routes through `findCompsRouted` |
| `/api/compiq/price-by-id` | POST | Picker tap → full estimate pinned to a specific cardHedgeCardId | Full estimate shape (CompIQPriceByIdResponse) | Routes through `getCardSalesRouted` |
| `/api/compiq/estimate` | POST | Direct estimate with structured query (playerName/cardYear/product/...) | Full estimate shape | Routes through `findCompsRouted` |
| `/api/psa/cert/:certNumber` | GET | PSA cert lookup (defined, session-gated) | `PsaCertLookupResult` (§1) | PSA Public API |

**No unified search endpoint exists today.** Each surface picks one of the above. A new endpoint or a client-side dispatcher are both architecturally viable (Phase 2 decision).

---

## 5. iOS — Current search → picker → priced-card flow (canonical `main` branch)

**Files surveyed** (all on `C:/dev/hobbyiq-main/HobbyIQ/`, tracked in git):

| File | LoC | Role |
|---|---:|---|
| `HobbyIQCleanSearchView.swift` | 18 | Thin wrapper — just embeds `CompIQView()` |
| `CompIQView.swift` | 728 | Search entry — hero + search input + `CompIQVariantPickerView` navigation |
| `CompIQSearchService.swift` | 55 | Backend client: `searchVariants(query)` → `/api/compiq/cardsearch`; `priceByCardId(...)` → `/api/compiq/price-by-id` |
| `CompIQSearchModels.swift` | 421 | Codable shapes: `CompIQVariantHit`, `CompIQPriceByIdResponse`, etc. |
| `CompIQVariantPickerView.swift` | 300 | Results screen — list of hits, tap → priced card |
| `CompIQPricedCardView.swift` | 1676 | Comp card page — pricing surface, recent comps, verdict |
| `CompIQViewModel.swift` | 299 | Shared state |
| `CompIQCardSelectionView.swift` | 214 | (separate selection surface, likely an alt entry) |
| `CompIQResult.swift` | 322 | Shared result model |

**Current flow (free-text only, no cert support, no verify step):**

```
CompIQView (search input)
  → submit → navigationDestination → CompIQVariantPickerView (results)
    → tap variant → CompIQPricedCardView (comp card page)
```

**No explicit "verify" intermediate page today.** Picker tap goes directly into the priced card page. The "verify" concept in v1 would slot between picker and priced.

**No cert input today.** Search input is a single free-text field; cert auto-detection would need a heuristic at the input layer (digits-only > N chars? prefix? explicit toggle?) and a dispatch decision.

---

## 6. iOS — Scan flow exists as WIP, NOT on `main`

**Critical context:** Scan-related Swift files live in the **OneDrive working tree** (`C:/Users/dvabu/OneDrive .../HobbyIQ-V1/`) as **untracked** files. None are on the canonical `main` branch in `C:/dev/hobbyiq-main/`.

**Files surveyed (OneDrive only):**

| File | LoC | Role |
|---|---:|---|
| `CardScannerView.swift` | 273 | Camera capture UI |
| `CardScannerService.swift` | 87 | Backend client for scan → identity |
| `CardScanResultView.swift` | 173 | Result/confirmation page after scan |
| `CardItem.swift` | 129 | SwiftData `@Model` — local card model with `certNumber` field |
| `AddCardView.swift` | 255 | Manual-entry form |

**Backend endpoint the scan calls:** `POST /api/compiq/image` (line 31 of `CardScannerService.swift`). **This endpoint does NOT exist in the backend on `main`.** Grep returns no matches. Either:
- The scan path was never functional (backend never built)
- It worked via a different endpoint that was later removed
- It was deferred until backend support landed

**`CardScanResult` shape returned by the (non-existent) endpoint:**
```swift
struct CardScanResult: Codable {
  let cardId: String
  let cardName: String
  let playerName: String?
  let year: Int?
  let set: String?
  let grade: String?
  let gradingCompany: String?
  let certNumber: String?       // ← cert IS in the scan-result contract
  let imageUrl: String?
  let marketPrice: Double?
  let confidence: Double         // upstream confidence; <0.8 = treat as failure
}
```

**`CardScanResultView` UI shape** is already approximately the "verify page" the v1 design needs:
- Card image
- Card identity (player, year, set, grade, gradingCompany)
- Cert display + a literal "Verify on PSA" link (already!)
- Market value
- Three action buttons: "Full Analysis", "Add to Inventory", "Add to Watchlist"

**Implication:** The scan-flow code that exists in OneDrive WIP is design-adjacent to v1's "verify page" concept but currently dead (backend endpoint missing). Phase 2 architecture has to decide whether v1 builds the verify page fresh inside the search-flow (`CompIQView` → results → verify → priced), or reuses/adapts the WIP `CardScanResultView` shape — and how that pairs with v2 scan integration.

---

## 7. Canonical card-identity shapes (where the metadata lives)

Four parallel shapes, currently. v1 design will need to choose the canonical and define mappings.

### 7a. Backend — `PortfolioHolding` (Cosmos persistence)

[`backend/src/types/portfolioiq.types.ts`](../../backend/src/types/portfolioiq.types.ts), 60+ fields. Identity-relevant subset:

```ts
{
  playerName?, cardTitle?, cardYear?,
  brand?, setName?, product?,    // ← THREE product-ish fields (field-name shim history)
  cardNumber?, parallel?, variation?, bowmanFirst?,
  serialNumber?, isAuto?, isPatch?,
  grade?, gradingCompany?,        // legacy
  gradeCompany?, gradeValue?,     // canonical (post CF-AUTOPRICE-GRADE-CANONICAL-MIGRATION)
  // NO certNumber field on the backend type at all
}
```

**Observed:** `certNumber` is NOT on `PortfolioHolding`. iOS `CardItem` (SwiftData) has it locally but it doesn't sync to backend.

### 7b. iOS — `CardItem` (SwiftData)

```swift
playerName, cardTitle, year, setName, cardNumber, parallel, serialNumber, isAuto
gradingCompany, grade, certNumber   // certNumber IS present on iOS-local model
purchasePrice, currentValue, status, notes, photoURLs, ebayListing*, createdAt, updatedAt
```

### 7c. CompIQEstimateRequest (backend search/pricing path)

[`backend/src/types/compiq.types.ts`](../../backend/src/types/compiq.types.ts):

```ts
{
  playerName?, cardYear?, product?, parallel?, cardNumber?,
  gradeCompany?, gradeValue?, isAuto?,
  cardHedgeCardId?  // pinned-card path
}
```

### 7d. PSA cert response `card` block

```
year, brand, category, cardNumber, subject, variety, grade, gradeDescription,
specId, itemStatus, totalPopulation, populationHigher
```

### Mapping gaps (empirical, no proposal here)

- `subject` (PSA) ↔ `playerName` (everywhere else)
- `variety` (PSA) ↔ `parallel` (others) — but PSA's `variety` can include grade/parallel/edition tokens (e.g., "Limited Edition (Tiffany)" form already seen this session)
- `brand` (PSA) ↔ `brand` / `setName` / `product` (backend has all three; field-name shim history complicates this)
- `category` (PSA) — sports/baseball gate; doesn't map cleanly to any backend field
- `certNumber` — present on PSA response + iOS CardItem + scan result, **absent from PortfolioHolding**

---

## 8. Concrete contamination examples (observed in production data)

From this session's portfolio inspection (`admin-testing-hobbyiq` Cosmos document, 23 holdings):

```
playerName: "TRADED TIFFANY GREG MADDUX TIFFANY"   (Maddux 1987 Topps Traded Tiffany)
playerName: "MIKE TROUT WAL-MART BORDER"            (Trout 2011 Topps Update WMB)
playerName: "CHROME PROSPECT AUTOGRAPHS GAGE WOOD CHR PROSPECT - REF"   (Gage Wood)
playerName: "PROSPECT AUTOGRAPHS JOHN GIL CHR PROS - MINI DIA"   (John Gil)
playerName: "CHROME PROSPECT AUTOGRAPHS CALEB BONEMER CHR PROSPECT AU- SHIM"
```

**Pattern:** iOS scan/manual-entry path is writing set / parallel / parallel-code tokens into the `playerName` field instead of their dedicated `setName` / `parallel` / `variation` / `serialNumber` fields.

**Other contamination shapes observed:**
- `year` stored as **string** `"1987"` (not number) in `player_trends`. Mixed-type in portfolio Cosmos too.
- `product: "Topps Traded"` and `setName: "Topps"` both present — phantom-field-name shim case.
- `playerName: "Bobby Witt Jr"` (no period) stored canonical; MLB Stats API supplies `"Bobby Witt Jr."` (with period) — surfaced today as CF-PLAYERNAME-CANONICALIZATION root cause, now fixed at the comparison layer.

**Server-side workarounds already shipped to mask contamination:**
- `cardsight.mapper.ts:148 normalizePlayerName` strips set/status prefix/suffix tokens (TRADED, TIFFANY, CHROME PROSPECT AUTOGRAPHS, CHR PROS family).
- `cardsight.mapper.ts:51 COMPIQ_TO_CARDSIGHT_RELEASES` maps product variants.
- `types/playerScore.ts:canonicalizePlayerName` (shipped earlier today via `b51b763`) handles period/accent/suffix mismatches for player score lookups.
- Pre-route field-name shim (`CF-AUTOPRICE-FIELD-NAME-SHIM` from `252233b`) reads iOS phantom field names.

---

## 9. Sport/category gating

Backend has `SUPPORTED_SPORTS = new Set(["baseball"])` ([`compiqEstimate.service.ts:1492`](../../backend/src/services/compiq/compiqEstimate.service.ts#L1492)). Hits return `source: "unsupported_sport"` for non-baseball when AI category resolves outside the set.

PSA's `category` field surfaces the sport too. For v1's cert-grader abstraction, "is this card supported by our pricing" gate has to live somewhere — current code gates at the pricing layer, not the search/identity layer.

---

## 10. Existing extension points worth knowing about

| Concern | File | What's there now |
|---|---|---|
| Mode-routing across vendors (CardHedge/Cardsight) | `cardsight.router.ts` | `CARDSIGHT_MODE` env: `off`/`shadow`/`primary`/`exclusive`. The pattern is reusable if v1 wants similar mode-gating for graders. |
| Cache for cert lookups | none | `psaCert.service.ts` does NOT currently cache. Each cert call is a fresh HTTPS request. |
| Cache for pricing | `services/shared/cache.service.ts` | `cacheWrap` with Redis (REDIS_HOST configured) + 6h TTL on `cs:pricing:*`. Pattern usable for `psa:cert:*` if v1 wants it. |
| Structured logging | inline `console.log(JSON.stringify({event, source, ...}))` | Pattern used across services. No formal logger abstraction. |
| Session/auth | `services/authService.ts` | HMAC-signed token via `AUTH_SESSION_SECRET`. Same x-session-id header gate that psa.routes.ts already uses. |

---

## 11. What's NOT in the codebase today (gaps the design must address)

- ❌ Backend `/api/compiq/image` endpoint — iOS scan path expects it; not implemented.
- ❌ Any cert-grader other than PSA — no BGS / SGC / CGC client, service, or route.
- ❌ Any cert-grader abstraction / registry / dispatcher — psaCert.service.ts is standalone, not behind an interface.
- ❌ Any "verify page" UI — picker → priced is direct in the current iOS flow.
- ❌ Any cert-mode input in iOS Search — the input is single free-text only.
- ❌ Any auto-detection heuristic for cert-vs-free-text — no precedent in the code.
- ❌ Any unified search response shape that accommodates BOTH single-authoritative (cert) AND multi-candidate (free-form) results.
- ❌ `certNumber` field on backend `PortfolioHolding` type. iOS has it locally; backend never receives it.
- ❌ A shared canonical identity type that any cert-grader OR free-form-search hit could populate. Each surface has its own shape.

---

## 12. Cross-machine state worth flagging

The `C:/dev/hobbyiq-main/` working tree is the canonical `main` checkout (where all of today's commits landed). The `C:/Users/dvabu/OneDrive .../HobbyIQ-V1/` working tree is on `safety/v1-checkpoint-2026-05-19-late` (an unrelated checkpoint branch) AND carries several untracked Swift files (the scan-flow WIP — `CardScanner*`, `CardScanResult*`, `AddCardView`, etc.).

For Phase 2 architecture: the scan-flow WIP existing in OneDrive but NOT in main means design decisions about "where does v2 scan plug in" have to either:
- Plan for those files to land in main before v2 implementation, OR
- Build v1 verify-page assuming scan-flow is a fresh implementation, OR
- Cherry-pick the WIP into main as part of v1 implementation prep

This is a Phase 2 decision, captured here so it isn't missed.

---

## 13. Open questions surfaced (for Phase 2 architecture)

These are things the discovery has NOT answered. Phase 2 (the architecture proposal) should address each explicitly:

1. **Free-form search backend choice for v1.** CardHedge `searchCards` (current picker, works today, removed by CF-PICKER-MIGRATE-TO-CARDSIGHT) OR Cardsight `searchCatalog` (future-proof, but has known gaps on CHR PROS class). Sequencing question.

2. **Unified endpoint vs. client-side dispatcher.** Both viable. Endpoint = single backend route that dispatches internally; dispatcher = iOS client calls `/api/psa/cert/...` OR `/api/compiq/cardsearch` based on input mode.

3. **Cert auto-detection heuristic.** What rule decides "treat input as cert" vs "treat input as free-text"? Length? Digits-only? Explicit toggle UI? Phase 2 picks one.

4. **Cert-grader abstraction shape.** Interface? Registry pattern? Adapter pattern? Where does the dispatcher live (route, service, both)? How does v1.5's BGS/SGC/CGC each drop in without touching v1 code?

5. **Unified response shape.** Cert path returns a single authoritative match. Free-text path returns multiple candidates. Both need to fit one client-side type (or two distinct types the client handles explicitly).

6. **Verify page contract for v1 (no commit, just confirm).** What does it consume? What does it produce when user taps "Use this card"? How does it differ from v2 (where it commits to portfolio)?

7. **Where does `certNumber` live on the backend persistence?** Add to `PortfolioHolding`? Separate `cert_metadata` collection? Don't store at all on portfolio side?

8. **Canonical identity type.** Does v1 introduce a `CardIdentity` type that every cert-grader response AND every free-form search candidate populates? If so, where lives the mapping (per-grader adapter)?

9. **`/api/compiq/image` endpoint.** Is this still on the roadmap? If yes, v1 design should be compatible with it surfacing in v2. If no, the OneDrive WIP scan-flow files are orphan — needs an explicit decision.

10. **Cert population / serial-edition disambiguation.** PSA's `populationHigher` matters for value. Does v1 verify-page surface it? Does the comp-card path consume it? Or is it metadata-only for now?

11. **Sport gating for cert lookups.** PSA returns non-baseball certs too. Should the cert lookup gate at the endpoint level (reject non-baseball) or pass through and let pricing reject downstream?

12. **Mac access for design verification.** Phase 2 architecture for iOS screens may benefit from confirming SwiftUI navigation primitives + state model match what's already in `CompIQView.swift`'s `navigationDestination(isPresented:)` pattern. iOS source is readable from Windows; behavior is not without Mac build.

---

## 14. References

- `CF-CARDSIGHT-RESOLVER-REDESIGN Phase 2` (96cbc30) — title-match architecture this session's backend pricing builds on.
- `CF-CARDSIGHT-TRANSLATER-GRADE-WIRING` (8e61f51) — grade-aware pricing wiring that variant-mismatch path inherits.
- `CF-PLAYERNAME-CANONICALIZATION` (b51b763) — same identity-mismatch class on the playerScore lookup; today's fix pattern.
- `CF-VARIANT-MISMATCH-PRICESOURCE-PARITY` (ccd05dc) — today's parity fix; informs how to surface "we couldn't price this" reasons on a verify page.
- `CF-PICKER-MIGRATE-TO-CARDSIGHT` — Week 5-6 in the refresh roadmap, gates the question in §13.1.
- [HOBBYIQ_ROADMAP_2026-05-28.md](../HOBBYIQ_ROADMAP_2026-05-28.md) W1-W3 — the surrounding plan; this CF is W1 design + W2-W3 implementation candidate.
- [SESSION_HANDOFF.md](../SESSION_HANDOFF.md) — running context for today's CF-PLAYERTRENDS-QUERY-FAILURE / CF-PLAYERNAME-CANONICALIZATION / CF-VARIANT-MISMATCH-PRICESOURCE-PARITY arc that informed this scope.

---

## End of Phase 1

This document is the empirical baseline. Phase 2 (architecture proposal) starts when Drew has reviewed and either approves or amends the scope captured here. **No proposals were made in this document by design.**
