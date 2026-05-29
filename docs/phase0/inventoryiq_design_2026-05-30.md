# InventoryIQ design — empirical inventory + Cardsight schema comparison

**Date:** 2026-05-30 (workstream began 2026-05-29 late session per Drew's Option B sequencing locked at `4187a7e`)
**Status:** Phase 1 written. HALT for Drew review before Phase 2 Cardsight schema deep-read.
**Predecessor:** `4187a7e` (roadmap Option B sequence step 2 — InventoryIQ design); `06b585d` (W5-Windows ship with `certNumber` + `certGrader` schema additions); `683b26f` (W4 additive schema).

## Framing (per Drew's lock)

- **InventoryIQ is the holdings-storage surface** (where cards live in HobbyIQ). **PortfolioIQ is the financial-layer services on top of it** (P&L, reconciliation, eBay sync, valuation). They are conceptually distinct even though they live in the same `backend/src/services/portfolioiq/` directory today.
- **Search scope B**: broader codebase inventory across `backend/src/`, `HobbyIQ/` (iOS), and documentation — NOT limited to `services/portfolioiq/`.
- **Shape C**: conceptual/naming distinction over existing `portfolioiq` code. No service carve-out or rename in this investigation; this is documentation work informing future modeling decisions.
- **Cardsight as REFERENCE for schema modeling, NOT as inventory implementation.** Their `collections.*` service is NOT becoming HobbyIQ's storage; we are learning from their schema choices and building on our own.

---

# Section 1 — What InventoryIQ Is Today (Empirical)

## 1.1 File inventory

### Backend (TypeScript) — 7 source files + 4 routes + ~10 tests

**Types (the contract):**
- [`backend/src/types/portfolioiq.types.ts`](../../backend/src/types/portfolioiq.types.ts) — defines `PortfolioHolding` interface (60+ optional fields covering identity / grading / acquisition / valuation / movement / photos / eBay linkage / certification).

**Storage service (the implementation):**
- [`backend/src/services/portfolioiq/portfolioStore.service.ts`](../../backend/src/services/portfolioiq/portfolioStore.service.ts) — 2400+ lines, the single Cosmos store for holdings + ledger + alerts + recommendation-feedback + per-holding price history. Defines `UserDoc` (the persisted Cosmos document shape), `PortfolioLedgerEntry` (sale records), `PortfolioPricePoint` (price snapshots), `PortfolioAlert`, `RecommendationFeedback`, `PortfolioSummary`. Exports 16+ route handlers + helper exports for `markHoldingSoldFromEbay` (consumed by the eBay webhook).
- [`backend/src/services/portfolioiq/gradeParser.ts`](../../backend/src/services/portfolioiq/gradeParser.ts) — parses grade-label strings ("PSA 10", "BGS 9.5", "GEM MT 10") into canonical `{ gradeCompany, gradeValue }` tuples. Used by the autopricing path; reused by W2's PSA cert-grader adapter for vernacular fallback.

**HTTP surface (routes wiring service handlers):**
- [`backend/src/routes/portfolioiq.routes.ts`](../../backend/src/routes/portfolioiq.routes.ts) — 16 routes (see §1.4 capability inventory).
- [`backend/src/routes/ebay.routes.ts`](../../backend/src/routes/ebay.routes.ts) — eBay OAuth + connection-status routes (consume holdings indirectly via listing flow).
- [`backend/src/routes/ebayWebhook.routes.ts`](../../backend/src/routes/ebayWebhook.routes.ts) — ingests eBay `ITEM_SOLD` webhooks, calls `markHoldingSoldFromEbay()`.

**Adjacent services that consume/mutate the holdings store:**
- [`backend/src/services/ebay/ebayListing.service.ts`](../../backend/src/services/ebay/ebayListing.service.ts) — reads holdings to build eBay inventory items + offers; sets `ebayOfferId / ebayListingId / ebayListingPublishedAt` back on the holding.
- [`backend/src/jobs/portfolioReprice.job.ts`](../../backend/src/jobs/portfolioReprice.job.ts) — scheduled batch reprice (reads `reprice_runs` Cosmos container for last-run state).

**Tests:**
- `backend/tests/portfolio.routes.test.ts` — multi-user sell-ledger integration
- `backend/tests/portfolioStore.fieldNameShim.test.ts` — CF-AUTOPRICE-FIELD-NAME-SHIM (iOS phantom field-name fallback)
- `backend/tests/portfolioStore.ledgerFinancials.test.ts` — netProceeds / P&L math
- `backend/tests/autoPricePersistTrendIQ.test.ts` — movement fields persistence
- `backend/tests/markHoldingSoldFromEbay.test.ts` — eBay sale ingestion
- `backend/tests/ebayWebhookItemSold.test.ts` — webhook → holding state transition
- `backend/tests/ebayListingLink.test.ts` — holding ↔ listing back-reference
- `backend/tests/portfolioHoldingCertFields.test.ts` — W4 `certNumber` + `certGrader` round-trip (5 tests)

### iOS (Swift) — 19 files touching holdings

**Primary client-side type pair:**
- [`HobbyIQ/HobbyIQ/PortfolioArchitecture.swift`](../../HobbyIQ/HobbyIQ/PortfolioArchitecture.swift) — defines `InventoryCard` Codable (45 lines of fields). **`InventoryCard` ↔ `PortfolioHolding`** is the iOS-backend type pair across the wire.
- [`HobbyIQ/PortfolioIQModels.swift`](../../HobbyIQ/PortfolioIQModels.swift) — additional Codable models for the PortfolioIQ dashboard surface.
- [`HobbyIQ/CompatibilityShims.swift`](../../HobbyIQ/CompatibilityShims.swift) — bridges between newer / older field-name shapes during the contract migration arc.

**Views (user-facing surfaces over holdings):**
- [`HobbyIQ/InventoryIQView.swift`](../../HobbyIQ/InventoryIQView.swift) — the user-facing inventory browsing surface (NOT a backend domain term; the iOS-side label).
- [`HobbyIQ/PortfolioAddFlowView.swift`](../../HobbyIQ/PortfolioAddFlowView.swift) — Add-holding flow UI.
- [`HobbyIQ/PortfolioIQView.swift`](../../HobbyIQ/PortfolioIQView.swift) — Portfolio dashboard UI (P&L, movements, summary).
- [`HobbyIQ/PortfolioDetailPhotosCard.swift`](../../HobbyIQ/PortfolioDetailPhotosCard.swift) — per-holding photo gallery.
- [`HobbyIQ/EbayListingDraftView.swift`](../../HobbyIQ/EbayListingDraftView.swift) — eBay listing draft preview before publish.

**ViewModels:**
- [`HobbyIQ/PortfolioIQViewModel.swift`](../../HobbyIQ/PortfolioIQViewModel.swift)
- [`HobbyIQ/HobbyIQ/PortfolioWorkspaceViewModel.swift`](../../HobbyIQ/HobbyIQ/PortfolioWorkspaceViewModel.swift)
- [`HobbyIQ/DashboardModels.swift`](../../HobbyIQ/DashboardModels.swift), [`HobbyIQ/DashboardService.swift`](../../HobbyIQ/DashboardService.swift)

**Sync / API layer:**
- [`HobbyIQ/PortfolioSyncService.swift`](../../HobbyIQ/PortfolioSyncService.swift) — manages local-cache + server sync; handles the legacy/canonical field-name dual-shape.
- [`HobbyIQ/APIService.swift`](../../HobbyIQ/APIService.swift) — HTTP client; wraps the 16 backend routes.
- [`HobbyIQ/SyncIntent.swift`](../../HobbyIQ/SyncIntent.swift) — sync-decision policy.

**Cross-domain consumers:**
- [`HobbyIQ/CompIQSearchModels.swift`](../../HobbyIQ/CompIQSearchModels.swift) — search hit models; `init(from: InventoryCard)` constructor builds a search hit from a stored holding (e.g. "find comps for this card").
- [`HobbyIQ/CompIQPricedCardView.swift`](../../HobbyIQ/CompIQPricedCardView.swift) — uses an `InventoryCard` as input to render priced-card detail.

### Documentation (existing referencing inventory model)

- `docs/HOBBYIQ_ROADMAP_2026-05-28.md` — multiple references to W4 schema additions and CF-CARDHEDGE-DECOMMISSION-FULL's `cardHedgeCardId` rename question
- `docs/SESSION_HANDOFF.md` — W4 closeout entry, the new CF-CARDSIGHTPARALLEL-TYPE-MIGRATION and CF-CARDSIGHT-DETAIL-NOTFOUND-OBSERVABILITY entries
- `docs/phase0/cardsight_published_sdk_2026-05-29.md` Appendix A2.2 lists Cardsight's 12 collection-management tools as a capability surface NOT consumed today

## 1.2 Type system

Three structural layers in the persistence model:

### Layer 1: The persisted Cosmos document — `UserDoc`

Single Cosmos document per user (one row per user in the `portfolio` container, partition key `/userId`). Defined privately in [`portfolioStore.service.ts:76-84`](../../backend/src/services/portfolioiq/portfolioStore.service.ts#L76-L84):

```ts
interface UserDoc {
  id: string;                                                 // = userId
  userId: string;                                             // partition key
  holdings: Record<string, PortfolioHolding>;                 // by holdingId
  ledger: PortfolioLedgerEntry[];                             // append-only sales log
  priceHistoryByHolding: Record<string, PortfolioPricePoint[]>;
  alerts: PortfolioAlert[];                                   // value-move / cost-cross / stale-data / liquidity
  recommendationFeedback: RecommendationFeedback[];           // followed / ignored / partial
}
```

**Key structural property:** all of a user's holdings + ledger + alerts + recommendation feedback + price history live in ONE document. There is no per-holding Cosmos document. Whole-document is loaded on read (30-sec in-process cache softens), whole-document upserted on write. Multi-user portability is at the whole-document level.

### Layer 2: The holding shape — `PortfolioHolding`

Exported from [`backend/src/types/portfolioiq.types.ts`](../../backend/src/types/portfolioiq.types.ts). **Every field optional** (`field?: type`); the type is a flat bag of attributes. Conceptual groupings (not enforced by the type):

**Identity (the card itself):**
- `id` (required — the holding UUID; not the card)
- `playerName, cardTitle, cardYear, brand, setName, cardNumber, product, parallel, serialNumber, variation, isAuto, isPatch, bowmanFirst`
- **No stable vendor cardId** (`cardHedgeCardId`, `cardsightCardId`) persisted on the holding. Each pricing call resolves identity textually.
- `playerId, playerIdConfidence, playerIdResolvedAt` — MLB Stats personId resolved from playerName at addHolding time

**Grading (post-W2/W4):**
- `grade` (text label e.g. "PSA 10"), `gradingCompany` (legacy), `gradeCompany` (canonical), `gradeValue` (numeric)
- **`certNumber, certGrader`** — shipped W4 (`683b26f`). Cert identity persisted for re-resolution flows + W6 VerifyView "save card."

**Acquisition (cost basis):**
- `quantity, purchasePrice, totalCostBasis, purchaseDate, purchaseSource, feesPaid, taxPaid, shippingPaid`

**Disposition (current state):**
- `listingUrl, listingPrice, currentValue, quickSaleValue, fairMarketValue, suggestedListPrice, premiumValue`

**Forward-looking (CF-NEXT-SALE-PREDICTION-LAYER):**
- `predictedPrice, predictedPriceLow, predictedPriceHigh, predictedPriceMechanism, predictedPriceUpdatedAt`

**Backward-looking movement (CF-AUTOPRICE-PERSIST-TRENDIQ):**
- `movementDirection, movementComposite, movementImpliedPct, movementCoverage, movementUpdatedAt`

**Reporting derived:**
- `netEstimatedValue, totalProfitLoss, totalProfitLossPct, verdict, recommendation, trend, riskLevel, marketSpeed, marketPressure, expectedDaysToSell, confidence, compsUsed, parallelDetected, explanationBullets, freshnessStatus, lastUpdated`

**User-controlled metadata:**
- `statusCategory` ("active" / "sold" / "archived" / "watchlist" / "tradepending") — drives `summarizeHoldings` exclusion
- `notes`

**Photos (PR B):**
- `photos: string[]` (permanent blob URLs in the card-images container), `clientId` (iOS-generated stable upsert-by-clientId identifier)

**eBay back-references (PR D.6):**
- `ebayOfferId, ebayListingId, ebayListingPublishedAt` (null = not currently listed; absent = field never populated; end-listing clears all three back to null)

**Total field count: ~60+, all optional.** This is structurally a "flat bag of attributes" pattern.

### Layer 3: Adjacent types nested inside `UserDoc`

**`PortfolioLedgerEntry`** ([`portfolioStore.service.ts:198-255`](../../backend/src/services/portfolioiq/portfolioStore.service.ts#L198-L255)) — sale records. Two source variants: manual (default; omits eBay fields) and eBay (set by webhook with `source: "ebay"`). Granular fee fields (`finalValueFee, paymentProcessingFee, promotedListingFee, adFee, otherFees, netPayout, actualShippingCost, suppliesCost, gradingCost`) are `number | null` — never coerced to 0. `needsReconciliation` flag for incomplete data; `dismissedAt + dismissedReason` for user-acknowledged-but-still-incomplete entries.

**`PortfolioPricePoint`** — `{ at, value, confidence?, compsUsed?, source? }`. Appended by `appendPriceHistory()` on add / refresh / sale events.

**`PortfolioAlert`** — `{ id, level, type, createdAt, holdingId, playerName, cardTitle, message, context? }`. Types: `value-move | cost-basis-cross | stale-data | liquidity-risk`. Computed alerts; surfaced via `/alerts`.

**`RecommendationFeedback`** — `{ id, holdingId, recommendation, actionTaken, notes?, createdAt }`. Captures whether the user followed / ignored / partially-followed the system's verdict; closes the loop for future ML training.

### iOS counterpart — `InventoryCard` (Codable)

In [`HobbyIQ/HobbyIQ/PortfolioArchitecture.swift:45-90`](../../HobbyIQ/HobbyIQ/PortfolioArchitecture.swift#L45-L90), Codable struct mirroring the holding-on-the-wire shape:

- iOS-named fields: `playerName, cardName, cost, currentValue, status, year, setName, parallel, grade`
- Backend-canonical fields: `playerName, cardTitle, purchasePrice, currentValue, statusCategory, cardYear, product, parallel, gradeCompany + gradeValue`

**The mismatch (`cardName` ↔ `cardTitle`; `cost` ↔ `purchasePrice`; `year` ↔ `cardYear`; `setName` ↔ `product`/`setName`)** is real and managed by the CF-AUTOPRICE-FIELD-NAME-SHIM read-side fallback at [`portfolioStore.service.ts`](../../backend/src/services/portfolioiq/portfolioStore.service.ts) `shimmedCardYear / shimmedProduct / shimmedCardTitle`. iOS still posts the phantom names from older builds; ~13/24 historical production holdings have data under phantom names. Cleanup gated on CF-IOS-FIELD-CONTRACT-FIX + CF-PORTFOLIO-METADATA-BACKFILL.

iOS also adds fields the backend doesn't currently store: `imageFrontUrl, imageBackUrl, lowValue, highValue, method, summary` — some are computed display-only on iOS, some round-trip into `PortfolioHolding`'s wider field set.

## 1.3 Data layer

### Cosmos containers used in the inventory flow

All in the `hobbyiq` database in the `hobbyiq-comps` account (per [`docs/phase0/launch_readiness_100_2026-05-29.md`](launch_readiness_100_2026-05-29.md)):

| Container | Partition key | Throughput | Role | Owned by |
|---|---|---|---|---|
| `portfolio` | `/userId` | autoscale 1000-4000 RU/s (post-CF-LAUNCH-READINESS-100) | All user holdings + ledger + alerts + price history + feedback (one doc per user) | `portfolioStore.service.ts` |
| `comp_logs` | `/userId` (verify) | 400 RU/s flat | Predictions emitted per estimate call; downstream ML training dataset | `compiqEstimate.service.ts` (writes), `corpus/writeTelemetryEntries.ts` |
| `reprice_runs` | `/userId` | 400 RU/s flat | Batch reprice run state (last-run timestamps, results, errors) | `portfolioReprice.job.ts` (writes), `ops.routes.ts` (reads) |
| `trend_history` | `/cardId` | 400 RU/s flat | Per-card trend snapshots for chart UI | `compiqEstimate.service.ts` |

**Write paths into `portfolio` container:**
- `addHolding` (POST /api/portfolio/holdings)
- `updateHolding` (PUT/PATCH /api/portfolio/holdings/:id)
- `deleteHolding` (DELETE /api/portfolio/holdings/:id)
- `sellHolding` (POST /api/portfolio/holdings/:id/sell)
- `refreshHolding` (POST /api/portfolio/holdings/:id/refresh — full re-price)
- `markHoldingSoldFromEbay` (called from eBay webhook ingestion)
- `updateLedgerEntry` (PATCH /api/portfolio/ledger/:id — for reconciliation)
- `addRecommendationFeedback` (POST /api/portfolio/feedback/recommendation)
- `autoPriceHolding` (internal — invoked by add/refresh/batch flows; sets predictedPrice + movement + price-history)
- `runBatchReprice` (POST /api/portfolio/reprice/batch — schedule-triggered or manual)

**Read paths:**
- All 9 GET routes in [`portfolioiq.routes.ts:20-32`](../../backend/src/routes/portfolioiq.routes.ts#L20-L32)
- `summarizeHoldings()` exported helper called by dashboard

**Cache:** 30-second in-process read cache (`portfolioStore.service.ts:62-73`). No Redis; not necessary at user-scoped granularity since each user's doc is one read.

### Recent schema additions

- **W4 (`683b26f`)**: `certNumber?: string | null`, `certGrader?: "PSA" | "BGS" | "SGC" | "CGC" | string | null` — additive, optional, no Cosmos migration. Round-trip verified (5 tests).
- **CF-AUTOPRICE-PERSIST-TRENDIQ (earlier)**: 5 movement fields persisted from estimate response.
- **CF-NEXT-SALE-PREDICTION-LAYER**: 5 prediction fields.
- **PR B (multi-tab)**: `photos[]` + `clientId` for iOS-side photo storage.
- **PR D.6**: eBay back-references.

All additive; the type interface widens monotonically.

## 1.4 Capability inventory — what InventoryIQ surface does today

Empirically grouped:

### Holdings CRUD
- ✅ Add holding (`POST /api/portfolio/holdings`) — spreads `req.body` over a stub; resolves `playerId` via `playerResolver` lazily; fires `autoPriceHolding` fire-and-forget (failure doesn't block save)
- ✅ Get holdings list (`GET /api/portfolio/holdings`) — returns `{ userId, count, holdings: [...] }`
- ✅ Get holdings + summary (`GET /api/portfolio/`) — combined for iOS dashboard with `summarizeHoldings()` computed
- ✅ Get holding by id (`GET /api/portfolio/holdings/:id`)
- ✅ Update holding (`PUT/PATCH /api/portfolio/holdings/:id`) — spread-merge with previous
- ✅ Delete holding (`DELETE /api/portfolio/holdings/:id`)

### Lifecycle / state transitions
- ✅ Sell holding (`POST /api/portfolio/holdings/:id/sell`) — appends `PortfolioLedgerEntry` (source: "manual"), decrements quantity, archives holding when fully sold
- ✅ Refresh holding (`POST /api/portfolio/holdings/:id/refresh`) — triggers fresh `computeEstimate`, persists updated value + movement + prediction + price-history
- ✅ Batch reprice (`POST /api/portfolio/reprice/batch`) — fires reprice across multiple holdings; rate-limit + freshness gates; populates `reprice_runs` container with run summary

### eBay integration
- ✅ Build eBay listing preview (`POST /api/portfolio/holdings/:id/ebay/draft`) — eBay-account-connected gate; returns preview shape for iOS confirmation
- ✅ Create eBay listing (`POST /api/portfolio/holdings/:id/ebay/listing`) — publishes; sets `ebayOfferId / ebayListingId / ebayListingPublishedAt`
- ✅ Mark holding sold from eBay webhook (`markHoldingSoldFromEbay`) — appends `PortfolioLedgerEntry` (source: "ebay"); populates granular eBay fee fields; sets `needsReconciliation` if data incomplete

### Per-holding history
- ✅ Get price history (`GET /api/portfolio/holdings/:id/history`) — returns `{ holdingId, count, points: PortfolioPricePoint[] }`

### Portfolio-level surfaces
- ✅ Alerts (`GET /api/portfolio/alerts`) — value-move / cost-cross / stale-data / liquidity-risk; computed periodically, persisted on user doc
- ✅ Health score (`GET /api/portfolio/health/score`) — composite health metric
- ✅ Calibration analytics (`GET /api/portfolio/analytics/calibration`) — predicted vs realized
- ✅ Weekly brief (`GET /api/portfolio/insights/weekly-brief`)
- ✅ Recommendation feedback (`POST /api/portfolio/feedback/recommendation`) — captures followed/ignored/partial

### Ledger
- ✅ Get ledger (`GET /api/portfolio/ledger`) — sales history
- ✅ Patch ledger entry (`PATCH /api/portfolio/ledger/:id`) — for reconciliation flow; user provides missing eBay fee data

### What's planned but not yet shipped or partial

- 🟡 **W6 VerifyView → "save card" path** to populate `certNumber + certGrader` from cert lookups — W4 schema in place; the write-path that exercises it ships in W6
- 🟡 **CF-IOS-FIELD-CONTRACT-FIX + CF-PORTFOLIO-METADATA-BACKFILL** to retire the field-name shim — partial; awaiting Mac access for iOS contract changes
- 🟡 **CF-PORTFOLIO-PL-BACKFILL** — for ledger entries created before CF-PR-E-P&L-COST-RECOMPUTE shipped; reactive (next PATCH on each entry recomputes), not proactive
- 🟡 **CF-CARDHEDGE-DECOMMISSION-FULL** — covers `cardHedgeCardId` field-naming decision; rename to vendor-neutral or accept as legacy name

### What's broken or incomplete

- ❌ **No stable vendor cardId on `PortfolioHolding`.** Identity is text only (`playerName + cardYear + cardTitle + product + parallel + grade`). Every re-pricing call re-resolves identity from text. CF-CARDSIGHT-RESOLVER-* arc was about this; W5-Windows now resolves via Cardsight but doesn't persist the Cardsight cardId back onto the holding. **Consequence:** repeat re-pricing pays the resolution cost every time; long-term metadata drift (e.g. set-name re-canonicalization) requires text-comparison heuristics, not id-equality.
- ❌ **No multi-collection support.** Each user has exactly one virtual "collection" (the flat `holdings: Record<string, PortfolioHolding>` map). No grouping by binder / set / wishlist / wantlist / pre-purchase concept.
- ❌ **No wishlist / want-list distinction.** The `watchlist` status category exists but isn't a separate-collection concept — it's a state tag on a holding that already exists. A user who wants to track "cards I'm considering buying" alongside "cards I own" has no clean way to do that today.
- ❌ **No public-share / portability surface.** Single-doc-per-user means a holding can't be exposed publicly or shared between users without manual data extraction.
- ❌ **No cost-basis lots / FIFO.** `purchasePrice + totalCostBasis` are scalars; if a user buys 3 of the same card at different prices, the cost basis is collapsed.

## 1.5 Structural observations

1. **Single-doc-per-user persistence** is the most distinctive structural choice. It's simple, atomic-write per user, and keeps the in-process cache cheap. Trade-offs: whole-doc rewrites on every mutation; doc-size growth long-term; no partial loads. **Per Drew (Phase 1 review): intentional v1 — re-evaluate only at 500/1000-tier if RU cost or partial-load needs surface.**
2. **Flat-bag-of-attributes holding shape** with ~60 optional fields. Trade-offs: easy to extend (W4 was 2 lines); no compile-time guarantees about which subset is populated; consumers (iOS dashboards, eBay listing builder, autopricing path) each rely on different field subsets.
3. **Text-identity, not vendor-id-identity** for holdings. Identity stability is bounded by text consistency; vendor cardId resolution is per-call rather than persisted. **Per Drew (Phase 1 review): deferred cleanup, not intentional. When CF-CARDHEDGE-DECOMMISSION-FULL ships, `PortfolioHolding` should gain `cardsightCardId: string` for stable canonical identity persisted at write time. Section 4 captures this as a recommended modeling adoption.**
4. **Four parallel arrays on one storage substrate**: `holdings[]` is the inventory; `ledger[]` is the disposition history; `priceHistoryByHolding[]` is the value-trajectory; `alerts[]` is the observation layer. All four arrays live on the same user doc. Cleanly separable conceptually. Section 2 will surface that Cardsight treats these as distinct domain entities (Collections, Collection Cards, transaction history via update_collection_card sold-fields, set-progress, analytics) — HobbyIQ's single-doc conflates them. **The choice to keep single-doc was deliberate (per Drew Phase 1 review on Q4); the comparative analysis notes the structural difference without recommending a v1 redesign.**
5. **eBay integration is bidirectional and the most coupled external surface today**: holdings carry back-references; webhook can mutate ledger; listing flow needs auth + reads holdings.
6. **No explicit collection / binder / list / collector concept**. The schema is "user owns N holdings" and that's it. Cardsight publishes collection management as a domain (Appendix A2.2). **Per Drew (Phase 1 review on Q2): multi-collection is intentional v1 scope — not foreclosed. Cost-basis FIFO / lot tracking (Q3) is also intentional v1 scope.** These land in Section 5 "Future Capabilities to Consider" — not pre-decided.

## 1.6 Out-of-scope flag — Codable contract maintenance

The recurring **iOS `InventoryCard` ↔ backend `PortfolioHolding` field-name drift** (cardName/cardTitle, cost/purchasePrice, year/cardYear, etc.) is a Codable contract maintenance issue, **NOT an InventoryIQ structural design problem.** It's tracked separately as CF-AUTOPRICE-FIELD-NAME-SHIM (read-side fallback shipped) + CF-IOS-FIELD-CONTRACT-FIX (iOS-side; awaiting Mac access) + CF-PORTFOLIO-METADATA-BACKFILL (data cleanup once contract lands).

Phase 3 modeling recommendations explicitly do NOT attempt to solve this via the schema. The Codable contract is a separate workstream.

---

## Phase 1 → Phase 2 transition

Phase 1 captured what's there empirically + four open questions resolved by Drew's review (intent answers in §1.5). Phase 2 reads Cardsight's collection schema as a reference; the comparative analysis follows in §3 + §4.

---

# Section 2 — Cardsight's Collection Schema (reference reading)

## 2.1 Investigation method + scope discipline

**Source priority:** Cardsight's published MCP server (`mcp.cardsight.ai`) tool definitions captured during the 2026-05-29 investigation (commit `2aebd29` Appendix A2.2). 90 MCP tools total; this section focuses on the 38 collection-management tools relevant to the InventoryIQ modeling comparison.

**Empirical API call budget held at ZERO** (lower end of Drew's ≤5 allowance). Rationale: Cardsight's MCP tool descriptions are unusually thorough — each tool has a workflow guide, distinguishes per-instance IDs from catalog IDs, and explicitly enumerates response-shape semantics. For every modeling question the comparative analysis needs, the input schemas reveal what fields Cardsight TRACKS, and the descriptions reveal what fields the analytics/breakdown endpoints RETURN. No ambiguity that requires a live probe.

**Scope discipline upheld:**
- Read-only documentation only (existing MCP tools-list dump from `c:/tmp/mcp-tools-list.txt` — 91 KB captured 2026-05-29)
- Zero API calls
- Zero test data created
- Cardsight account left in pristine state (no collections, collectors, binders, or lists created during this investigation)
- This document is documentation only

## 2.2 Domain entity inventory (38 tools, 6 entity groups)

Cardsight publishes a fully-decomposed inventory domain model. Six top-level entities:

| Entity | Count | Purpose |
|---|---:|---|
| **Collectors** | 5 tools (CRUD) | Individuals who own collections; multi-tenant per API key |
| **Collections** | 12 tools (CRUD + cards + analytics + breakdown) | Top-level grouping of cards under a collector; can have many per collector |
| **Collection Cards** | (within collections) | Per-instance card-in-collection records with quantity / buyPrice / buyDate / sellPrice / soldPrice / soldDate / parallelId / gradeId |
| **Binders** | 8 tools (CRUD + binder cards) | Sub-organization WITHIN a collection; group cards without removing them; cards can be in multiple binders |
| **Lists (wishlists)** | 8 tools (CRUD + list cards) | "Cards I want to acquire" — separate from collections; per-collector |
| **Set Progress** | 3 tools (read-only) | Automated catalog-set completion tracking against owned cards; base + parallel-set variants |
| **Collection Card Images** | 2 tools | Per-instance image retrieval (raw + thumbnail) |
| **Grades taxonomy** | 3 tools (read-only) | Company → Type → Grade tree backing every gradeId in the system |

## 2.3 Entity-by-entity schema

### 2.3.1 Collectors

**Tools:** `list_collectors`, `get_collector`, `create_collector`, `update_collector`, `delete_collector`.

**Persisted fields** (verbatim from input schemas):
- `id: UUID` (server-generated, returned by create_collector)
- `name?: string` (optional display name; server provides a default if omitted)

**Semantic:**
- Collectors are **bound to the caller's API key** ("Collectors are individuals who own collections of cards" — from `list_collectors` description). Multi-tenant within one API key.
- Workflow guidance hard-codes the "0 collectors → create_collector first / 1 collector → use it / 2+ collectors → ask" branching — Cardsight expects most users to have exactly one collector profile, but the schema supports many.
- `delete_collector` cascade: "Permanently delete a collector and all collections, binders, and lists it owns." — Collector is the root of the ownership tree.

**Comparison anchor for §3:** HobbyIQ has no Collector concept. The `userId` (from `getUserBySession`) plays the role; one HobbyIQ user maps cleanly to one Cardsight collector. No multi-collector-per-API-key concept needed unless household-account UX surfaces.

### 2.3.2 Collections

**Tools:** `list_collections`, `get_collection`, `create_collection`, `update_collection`, `delete_collection`, `list_collection_cards`, `add_collection_card`, `get_collection_card`, `update_collection_card`, `remove_collection_card`, `get_collection_analytics`, `get_collection_breakdown`.

**Persisted fields on the Collection itself** (from `create_collection` input schema):
- `id: UUID` (server-generated)
- `collectorId: UUID` (required FK to Collector)
- `name?: string` (optional; "1990s Rookies", "Investment Portfolio")
- `description?: string` (optional; "Detailed description of collection purpose or theme")

**Semantic — collections vs collectors vs cards:**
- A collector can own many collections (`create_collection` workflow expects "If 2+ collections: Ask which collection")
- Collections are pure organizational groupings ("Collections help users organize their cards by theme, player, year, investment goals, or any custom criteria")
- **Important deletion semantic:** `delete_collection` description verbatim — *"This removes the collection container but does NOT delete the actual cards from the system - only the organizational grouping."*

This last line is interesting: Cardsight treats cards as **independent persistent entities** from collections. Removing a collection drops the grouping, not the card. But there's nuance — when you `add_collection_card`, you're creating a per-collection card INSTANCE (with `quantity, buyPrice, buyDate, sellPrice, soldPrice, soldDate, parallelId, gradeId`). The instance is what gets removed when you delete the collection. The CATALOG card remains untouched (that's Cardsight's master catalog data, not user data).

So Cardsight's data model:
1. **Catalog cards** (Cardsight's master data, immutable from user perspective) — has `id, name, releaseName, setName, year, parallels[], attributes[]`
2. **Collection card instances** (user data, per-collection) — has `id` (instance UUID), `cardId` (FK to catalog), `quantity, buyPrice, buyDate, sellPrice, soldPrice, soldDate, parallelId, gradeId`

This is **exactly** the asymmetry HobbyIQ has today (text-identity-on-holding vs vendor-cardId-on-ledger) but Cardsight has resolved it: catalog cards have stable UUIDs, instance records carry the FK.

### 2.3.3 Collection Card instances (the most load-bearing schema for §3)

**Tools:** `add_collection_card`, `get_collection_card`, `update_collection_card`, `remove_collection_card`, `list_collection_cards`.

**Persisted fields on a Collection Card instance** (verbatim from `add_collection_card` + `update_collection_card` input schemas):

| Field | Type | Required | Semantic |
|---|---|---|---|
| `id` | UUID | server-generated | Per-collection instance ID — **NOT the catalog cardId** ("the collection card instance ID, not the catalog card ID" — verbatim from `get_collection_card`) |
| `collectionId` | UUID | yes | FK to Collection |
| `cardId` | UUID | yes | FK to catalog card |
| `parallelId` | UUID \| null | optional, nullable | Specific parallel variant |
| `gradeId` | UUID \| null | optional, nullable | Specific grade (PSA 10, BGS 9.5, etc.) — UUID from grades-taxonomy tree |
| `quantity` | number | optional, default 1 | Number of copies |
| `buyPrice` | string \| null | optional, nullable | Purchase price as string ("49.99") |
| `buyDate` | string \| null | optional, nullable | Purchase date ISO format YYYY-MM-DD |
| `sellPrice` | string \| null | optional, nullable | Asking/list price |
| `soldPrice` | string \| null | optional, nullable | Actual sale price |
| `soldDate` | string \| null | optional, nullable | Date sold ISO YYYY-MM-DD |

**Critical observations for §3:**

1. **Stable FK to catalog (`cardId`)** — every collection card has a UUID pointing at the catalog. No text re-resolution. Identity is id-based.
2. **Parallel + grade via UUIDs**, not free-text. `parallelId` resolves through the catalog's `parallels[]` array (per Section 2.3.2). `gradeId` resolves through the grades taxonomy tree (Section 2.3.7).
3. **Money fields are strings**, not numbers. ISO-format strings ("49.99"). Avoids floating-point precision issues in JSON serialization.
4. **Sale tracking is on the instance**, not in a separate ledger entity. `sellPrice` (asking) + `soldPrice` (actual) + `soldDate` are fields on the per-instance record. When a card is sold, you `update_collection_card` with those fields set; you don't create a separate transaction record.
5. **No status enum.** No "active / archived / watchlist / tradepending / sold" status field. Soldness is implied by `soldPrice != null`. Future-state ("watching to buy", "trade pending") is handled by Lists (wishlists) as a separate entity, not status on the collection card.
6. **Quantity is a scalar.** No lot-tracking, no per-lot cost basis. Same v1 simplification Drew flagged as deliberate for HobbyIQ.
7. **No notes / explanation field** on the collection card. Cardsight pushes that to the catalog level (where notes belong to the canonical card, not the per-user instance) and via Lists (for cards-being-considered).
8. **No image fields on the instance** — images come from a separate endpoint pair: `get_collection_card_image` (full) and `get_collection_card_thumbnail` (preview). MCP image content blocks (binary).

**`list_collection_cards` filter / sort capabilities** (the read-side surface):
- Filter by `cardId, parallelId, gradeId, hasSold` (bool)
- Sort by `buyDate | soldDate | buyPrice | soldPrice` (asc/desc)
- Paginated `skip + take` (max 50 per page)

This is a tight inventory-query surface — exactly what the picker/dashboard needs.

### 2.3.4 Collection Analytics

**Tool:** `get_collection_analytics({ collectionId })`.

**Returns** (verbatim from description): *"total cards, total spend, current estimated value, unrealized + realized gains, ROI, top performers."*

**Inferred shape** (no API call made; this is the documented response):
- `totalCards: number`
- `totalSpend: number` (or string per Cardsight's money-as-string pattern)
- `currentEstimatedValue: number`
- `unrealizedGains: number`
- `realizedGains: number`
- `roi: number` (or percentage)
- `topPerformers: Array<{ cardId, name, gain?, gainPct? }>` (best-guess shape; not empirically verified)

**Computed source semantics:**
- `currentEstimatedValue` — likely computed via `get_card_pricing` or `get_card_pricing_bulk` against current sold-comp medians per the workflow guidance ("`list_collection_cards` + `get_card_pricing_bulk` to verify the reported value against current market data")
- `realizedGains` — from `soldPrice - buyPrice` summed over cards where `soldPrice != null`
- `unrealizedGains` — from `currentEstimatedValue - buyPrice` summed over cards where `soldPrice == null`
- `roi` — `(realized + unrealized) / totalSpend`

**Comparison anchor for §3:** HobbyIQ's `summarizeHoldings()` in `portfolioStore.service.ts:806-832` computes `totalValue, totalCost, totalGainLoss, totalGainLossPct, cardCount`. Same conceptual surface; Cardsight adds realized-vs-unrealized split + top-performers ranking.

### 2.3.5 Collection Breakdown

**Tool:** `get_collection_breakdown({ collectionId, groupBy: 'release' | 'year' | 'grade' | 'player' | 'manufacturer', sortBy?, order?, minCount?, take?, skip? })`.

**Returns** (verbatim from description): *"counts and percentages per bucket — useful for visualizing what dominates a collection."*

**Inferred response shape:**
- `buckets: Array<{ key: string, count: number, percentage: number }>` per the documented sortBy enum
- Filterable via `minCount` (suppress noise from tiny buckets)
- Paginated for collections with many distinct values

**Comparison anchor for §3:** HobbyIQ has NO breakdown surface today. `summarizeHoldings()` returns aggregates only; per-player / per-year / per-grade distributions would require client-side computation by iOS. Cardsight ships this as a first-class server-side capability.

### 2.3.6 Set Progress (3 tools)

**Tools:** `list_collection_set_progress`, `get_collection_set_progress`, `get_collection_set_progress_parallel`.

**Concept:** automated catalog-set completion tracking. For every set the user has any card from, compute owned / total / % complete / missing card IDs.

**`list_collection_set_progress({ collectionId, take?, skip?, sortBy?: 'completion' | 'missing' | 'difficulty', order?, minCompletion?, nearComplete? })`:**
- Per-set summary across the whole collection
- Filter `nearComplete: true` returns sets >80% complete (the "almost done" UX)
- Sort by `difficulty` desc = "hardest sets to complete" (rarest cards remaining)

**`get_collection_set_progress({ collectionId, setId })`:**
- Single set's full detail — every missing card UUID
- Workflow: pair with `get_card_pricing_bulk` (up to 100 IDs) to budget remaining purchases; or `add_list_card` to drop missing IDs into a wishlist

**`get_collection_set_progress_parallel({ collectionId, setId, parallelId })`:**
- Parallel-specific completion — "how complete am I on the Refractor parallel of this set?"
- Distinguishes from `get_collection_set_progress` which tracks base-set; this tracks per-parallel completion

**Comparison anchor for §3:** HobbyIQ has NO set-progress concept. This is a domain capability Cardsight ships that HobbyIQ doesn't currently expose to users (likely a future capability, not v1 need — Cardsight's product is heavier on set-completion-collector UX than HobbyIQ's investment-tracker UX).

### 2.3.7 Grades taxonomy (3 tools)

**Tools:** `list_grading_companies`, `list_grading_company_types`, `list_grading_company_grades`.

**3-step tree resolution** (verbatim workflow from `list_grading_companies` description):

1. `list_grading_companies` → returns companies by code/UUID: "PSA, BGS, SGC, TAG, CGC, HGA, etc."
2. `list_grading_company_types({ company })` → returns grading types within a company: "PSA Regular, PSA DNA (autograph), BGS Regular, BGS Black Label, etc."
3. `list_grading_company_grades({ company, type })` → returns the actual grades with UUIDs: PSA 10, PSA 9, PSA 8, BGS 9.5, BGS 10 Black Label, etc.

**The leaf-level UUID is the `gradeId`** used by `get_card_pricing`, `get_card_marketplace`, `add_collection_card`, `update_collection_card`, `get_card_population`.

**Comparison anchor for §3:** HobbyIQ stores grade as TEXT (`grade: "PSA 10"`, `gradeCompany: "PSA"`, `gradeValue: 10`). No id-based linkage. Re-parsing happens on every pricing call. Cardsight uses uuids end-to-end — this is the same id-vs-text asymmetry as the cardId discussion but specifically for grades.

This is **also** the load-bearing question for v1.5 BGS / SGC / CGC grader CFs (per the roadmap's CF-CARDSIGHT-GRADES-ENDPOINT). If we adopt Cardsight's `gradeId` model, the W2 cert-grader adapter pattern lets v1.5 graders ship as one-line registrations backed by Cardsight's grades taxonomy.

### 2.3.8 Binders (8 tools)

**Concept** (verbatim from `list_binders` description): *"Binders are sub-organization units (e.g., 'PSA-10 RCs', 'Charizards', 'Trout Player Collection') that group cards within a collection without removing them from it."*

**Persisted fields:**
- `id: UUID`
- `collectionId: UUID` (FK)
- `name: string`
- `description?: string`

**Binder Cards** (link-table semantics):
- `add_binder_card({ collectionId, binderId, collectionCardId })` — adds a per-instance card to a binder
- `remove_binder_card({ collectionId, binderId, cardId: <binder card UUID> })` — removes
- `list_binder_cards({ collectionId, binderId, take?, skip? })` — lists

**Critical structural property** (verbatim from `add_binder_card` description, captured in caps in the source): *"The `collectionCardId` parameter is **NOT** the catalog card UUID. It is the per-collection instance ID returned by `list_collection_cards` (each row's `id` field)."*

**This means a card can be in multiple binders.** Many-to-many between binders and collection card instances within a collection.

**Comparison anchor for §3:** HobbyIQ has NO binder concept. The only grouping today is `statusCategory` ("active" / "watchlist" / "tradepending"). Drew flagged multi-collection as intentional v1 scope (Q2); binders are sub-collection groupings that compose with that.

### 2.3.9 Lists / Wishlists (8 tools)

**Concept** (verbatim from `list_lists` description): *"Want lists are separate from collections — they're 'cards I want to acquire' rather than 'cards I own'."*

**Persisted fields:**
- `id: UUID`
- `collectorId: UUID` (FK to Collector — important: lists belong to the COLLECTOR, not a specific collection)
- `name: string`
- `description?: string`

**List Cards** (the membership shape):
- `add_list_card({ listId, cardId?: string, cardIds?: string[] })` — single or bulk add
- `remove_list_card({ listId, cardId })` — remove
- `list_list_cards({ listId, take?, skip? })` — list

**Critical structural difference from collection cards:**
- The `cardId` here is the **catalog UUID** (not a collection card instance ID). Want lists track "cards the user wants to acquire" — there's no per-instance buyPrice/buyDate because the cards aren't owned yet.

**Workflow guidance:** *"Inverse: when the user actually acquires a card on the list, use `remove_list_card` so the list shrinks as they hunt."* The expected pattern is: hunt → `add_list_card` → acquire → `add_collection_card` → `remove_list_card`.

**Comparison anchor for §3:** HobbyIQ has a `watchlist` status category on holdings (per the EXCLUDED_STATUS set in `summarizeHoldings`). It's NOT a separate entity — it's a state tag on something the user already created. Cardsight separates "watching to buy" (List entity) from "owning" (Collection Card) cleanly. HobbyIQ doesn't.

### 2.3.10 Collection Card Images (2 tools)

**`get_collection_card_image({ collectionId, cardId })`:** full-resolution image via MCP image content block. Binary returned.

**`get_collection_card_thumbnail({ collectionId, cardId })`:** smaller payload for previews / grids.

**Both per-instance.** Images stored on the collection card instance, not on the catalog card. (Catalog cards have a separate `get_card_image` tool that returns binary too.)

**Comparison anchor for §3:** HobbyIQ has `photos: string[]` on `PortfolioHolding` storing URLs to permanent blob storage. Same conceptual shape; HobbyIQ stores URLs, Cardsight serves binary directly. The CF-LAUNCH-READINESS-100 image-fetch mitigation strategy work (W5-iOS) intersects this.

## 2.4 Cardsight's domain entity diagram

```
Collector (per API key, 1..N)
    │
    ├─→ Collection (1..N per Collector)
    │       │
    │       ├─→ CollectionCard (per-instance, 1..N per Collection)
    │       │       ├── cardId   (FK → Catalog Card)
    │       │       ├── parallelId (FK → Catalog Parallel)
    │       │       ├── gradeId  (FK → Grades Taxonomy)
    │       │       ├── quantity
    │       │       ├── buyPrice, buyDate
    │       │       ├── sellPrice (asking)
    │       │       ├── soldPrice, soldDate (actual sale)
    │       │       └── image (separate endpoint)
    │       │
    │       └─→ Binder (1..N per Collection)
    │               └─→ BinderCard (many-to-many w/ CollectionCard)
    │
    └─→ List (1..N per Collector — wishlists)
            └─→ ListCard (catalog cardId FK)

Catalog (read-only reference data)
    ├── Card (UUID-keyed, immutable from user perspective)
    │     ├── attributes[]
    │     └── parallels[] (per-card)
    └── GradesTaxonomy
          └── Company → Type → Grade (UUID at leaf)
```

## 2.5 Structural observations about Cardsight's modeling

1. **Three-layer separation:** Catalog (Cardsight's master data) ↔ Collection Card instance (user data, FK to catalog) ↔ Aggregations (Binders, Lists, set-progress). HobbyIQ has effectively a two-layer view: text-identity on the holding ↔ ledger entries with `cardHedgeCardId`. The middle layer (a stable cardId on the holding) is what's missing.

2. **Sale lifecycle is on the instance, not a separate entity.** Cardsight tracks `sellPrice / soldPrice / soldDate` as fields on the Collection Card record. When a sale happens, you `update_collection_card`. HobbyIQ uses a separate `PortfolioLedgerEntry` array on the user doc. **Two different design choices for the same problem.**

3. **Grouping is multiple levels:** Collections (top-level), Binders (sub-collection groupings, many-to-many with instances), Lists (cross-collection wishlists at the collector level). HobbyIQ has one level (the `holdings` map). Cardsight's richness here would support v2 product-shape moves; v1 doesn't need it.

4. **Money is string-typed**, not number. Cardsight: `buyPrice: "49.99"`. HobbyIQ: `purchasePrice: number`. Cardsight's choice avoids JSON-number precision issues but pushes parsing to the consumer.

5. **No status enum on Collection Card.** Soldness is implied by `soldPrice != null`. Watch-to-buy goes to a separate List entity. HobbyIQ uses `statusCategory: "sold" | "active" | "watchlist" | ...` mixed on the same holding shape. **Two different design choices** (status-as-state-field vs status-as-entity-separation).

6. **Server-side breakdown / analytics.** Cardsight ships first-class `get_collection_breakdown(groupBy)` and `get_collection_analytics`. HobbyIQ ships `summarizeHoldings()` (aggregates only) + alerts/health/calibration as separate routes. Breakdown-by-X is iOS-client-computed today.

7. **Set-progress is a first-class capability** with three dedicated tools. HobbyIQ has no equivalent — set-completion isn't a product surface. This is the most divergent product-shape difference between the two.

8. **No reconciliation / needs-attention surface** equivalent to HobbyIQ's `needsReconciliation` flag on ledger entries. Cardsight's design assumes the user enters complete data at the time of sale; HobbyIQ's design accommodates eBay-webhook ingestion with incomplete data + a reconciliation pass.

9. **No P&L scenarios** equivalent to HobbyIQ's predicted/movement fields. Cardsight tracks ROI as realized + unrealized gains computed against `get_card_pricing` current sold-comp medians. HobbyIQ's TrendIQ + forward-projection layer is genuinely additional product surface — not something Cardsight models.

10. **No iOS Codable contract concept.** Cardsight publishes typed SDKs (Node/Python/Swift/Java) generated from the OpenAPI spec. Cross-language type safety is solved at the spec level. HobbyIQ's iOS `InventoryCard` vs backend `PortfolioHolding` field-name drift is HobbyIQ-specific; out of scope for this comparison.

---

# Phase 2 → Phase 3 transition

Section 2 captures Cardsight's modeling decisions as a reference. Section 3 (comparative analysis) and Section 4 (ranked recommendations) follow.

Headline observations to carry forward:

- **`cardId` FK on the holding** is the most obvious win — stable identity, no text re-resolution, aligns with W5-iOS's path-(i) Cardsight-cardId-flowing-from-search work
- **`gradeId` FK to the grades taxonomy** is the second obvious win — aligns with the roadmap's CF-CARDSIGHT-GRADES-ENDPOINT and v1.5 grader adapter work
- **Sale lifecycle as fields-on-instance vs separate-ledger** is a genuine design choice — Cardsight's is cleaner schema-wise; HobbyIQ's accommodates the eBay-webhook reconciliation flow which Cardsight's doesn't model
- **Multi-collection / binders / lists / set-progress** are intentional v1 scope decisions (per Drew Phase 1 review); Section 5 captures them as future capabilities, not v1 recommendations
- **Server-side breakdown** is a small specific capability gap worth surfacing as a candidate for v1.5
- **Money-as-string vs money-as-number** is a real choice that goes either way

---

## Phase 2 → Phase 3 transition

Phase 2 captured Cardsight's collection schema as a reference. The headline observations above sketch Section 3's direction without committing to recommendations.

---

# Section 3 — Side-by-side comparison

For each major modeling concept: HobbyIQ today, Cardsight's approach, honest assessment of whether one is better, equivalent, or solving a different problem. Twelve concepts covered (the ten structural observations from §2.5 plus the two HobbyIQ-specific surfaces — reconciliation/eBay flow and forward-looking P&L — that have no Cardsight counterpart).

## 3.1 Identity (text vs UUID)

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Holding identifies which CATALOG card via | `playerName + cardYear + cardTitle + product + parallel + grade` text fields | `cardId: UUID` FK to catalog card |
| Re-pricing re-resolves identity by | Text matching (cardsight router → mapper → score) | UUID lookup against catalog |
| Drift risk | Name canonicalization changes, parallel naming evolution, set rename → text no longer matches | None — UUID is stable |
| Repeat-call cost | Pay resolution cost every time | Cache hit on UUID instantly |

**Honest assessment:** Cardsight's is strictly better. The asymmetry (HobbyIQ has `cardHedgeCardId` on ledger entries but NOT on `PortfolioHolding`) is deferred cleanup per Drew Phase 1 Q1. Persisting a Cardsight UUID on the holding eliminates the entire text-resolution canonicalization-bug class (CF-PLAYERNAME-CANONICALIZATION, CF-CARDSIGHT-RESOLVER-*, CF-VARIANT-MISMATCH-* arcs all stem from this). **→ Section 4 R1.**

## 3.2 Grade representation (text vs UUID taxonomy)

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Grade fields | `grade: "PSA 10"`, `gradeCompany: "PSA"`, `gradeValue: 10` (text + parsed numeric) | `gradeId: UUID` FK to grades taxonomy tree (Company → Type → Grade) |
| Pricing filter "all PSA 10 sales" | Text-match in `cardsight.client.ts` query construction | UUID filter: pass `gradeId` to `get_card_pricing` |
| Grader-specific grade types (PSA Regular vs PSA DNA, BGS Regular vs BGS Black Label) | No representation — grade types collapse to (company, value) | Distinct UUIDs at the Type layer |
| Population data linkage | Manual via `psaCert.service.ts:totalPopulation` | First-class via `get_card_population({ cardId, gradeId })` |
| v1.5 grader pluggability | W2 cert-grader registry — each grader ships own adapter | Cardsight covers grader taxonomy uniformly |

**Honest assessment:** Two complementary paths:
- **W2 cert-grader registry** = identity per grader (slab cert lookup yields `certNumber + gradeCompany + gradeValue + totalPopulation`)
- **Cardsight gradeId** = grade-bucket aggregation (lets you query "all PSA 10 sales of this card" via Cardsight's pricing/marketplace)

They're **complementary, not substitutes**. The W4-shipped `certNumber + certGrader` remain valid for the cert path; adding `cardsightGradeId` supplements with grade-bucket aggregation power. Cardsight's path covers more grader variants (PSA DNA, BGS Black Label distinct from PSA Regular, BGS Regular) which W2's per-grader-adapter approach would otherwise need to model itself. **→ Section 4 R2.**

## 3.3 Sale lifecycle (fields-on-instance vs separate ledger)

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Where sale data lives | Separate `PortfolioLedgerEntry[]` array on user doc | Fields ON the Collection Card record: `sellPrice / soldPrice / soldDate` |
| Multiple sales of the same card | New ledger entries appended | `quantity` decrement on Collection Card + `update_collection_card` for soldPrice/soldDate |
| Sold ≠ owned distinction | `statusCategory: "sold"` on holding, OR holding archived + ledger entry exists | `soldPrice != null` implies sold |
| eBay webhook sale ingestion | `markHoldingSoldFromEbay` writes `PortfolioLedgerEntry` with granular eBay fields (`finalValueFee, paymentProcessingFee, promotedListingFee, adFee, otherFees, netPayout, actualShippingCost`) + `source: "ebay"` | Not modeled — Cardsight has no webhook-from-marketplace pattern |
| Incomplete-data reconciliation | `needsReconciliation: boolean` + `dismissedAt / dismissedReason` user-acknowledged-but-still-incomplete state | Not modeled — Cardsight assumes complete data at time of sale entry |
| Granular fee semantics | `number \| null` (NEVER coerced to 0; null = "not yet reported by eBay") | No granular fees — just `sellPrice` and `soldPrice` strings |
| Net-vs-gross | `grossProceeds / fees / tax / shipping / netProceeds / costBasisSold / realizedProfitLoss / realizedProfitLossPct` per ledger entry | `soldPrice` only; consumer infers gain from `soldPrice - buyPrice` |

**Honest assessment — "different problems being solved" per Drew's framing:**

Cardsight's schema is **cleaner**:
- Single record per ownership history
- No separate ledger array to navigate
- Soldness implicit in `soldPrice != null`
- Simpler analytics computation

But Cardsight's schema **doesn't model what HobbyIQ actually needs**:
- The eBay webhook reconciliation flow (PR D.6) ingests `ITEM_SOLD` notifications with INCOMPLETE data — fees not yet reported, shipping not yet finalized, payout pending. The `null` vs `0` distinction on granular fee fields is operationally critical (coerce-to-0 would silently inflate netProceeds). The `needsReconciliation` flag drives a UI surface for the user to acknowledge or correct.
- The user-dismissal-of-reconciliation-prompts pattern (`dismissedAt / dismissedReason`) is a real product surface that Cardsight has no place for.
- The CF-PR-E-P&L-COST-RECOMPUTE work proved that `gradingCost / suppliesCost` are additional cost deductions specific to HobbyIQ's seller-side P&L modeling. Cardsight's `soldPrice` is single-field.

**HobbyIQ's ledger model is uglier but operationally correct for the eBay webhook + reconciliation flow + granular P&L surface.** Cardsight's modeling is cleaner but doesn't carry the semantics the product needs. **→ Section 4 NR1: keep HobbyIQ's ledger model.**

## 3.4 Multi-collection support

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Number of collections per user | One implicit (the `holdings` map) | Many — collector owns N collections |
| Organization within | `statusCategory` enum on each holding | First-class Collection entities + Binders within |
| Cross-collection moves | N/A | `update_collection_card({ collectionId: newColId })` |
| Per-collection valuation | N/A | First-class `get_collection_analytics({ collectionId })` |

**Honest assessment:** Cardsight ships richer organizational primitives. Per Drew Phase 1 Q2 answer: **intentional v1 scope, not foreclosed.** Multi-collection adds real product complexity that doesn't unlock value pre-launch. Captured for §5 future consideration; not recommended for v1.

## 3.5 Grouping levels

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Levels | 1 (statusCategory tags on each holding) | 4 (Collection → Binder → CollectionCard; Lists separately at Collector level) |
| Many-to-many groupings (card in multiple groupings) | No — statusCategory is a single state field | Yes — Binder ↔ CollectionCard is many-to-many |
| Cross-cutting concerns (e.g. "all my graded RCs across all collections") | iOS client-side filter | `search_cards` + Cardsight catalog filters; or List entity |
| Wishlist / want-to-buy state | `statusCategory: "watchlist"` mixed onto a holding the user already created | Lists entity — separate from owning |

**Honest assessment:** Status-as-state-field vs entity-separation is a real design choice. HobbyIQ's approach is simpler and matches the "one user, one virtual collection" v1 framing. Cardsight's lets users separate "owning" from "watching to buy" cleanly; HobbyIQ conflates them. Per Drew Phase 1 Q2: intentional v1; future capability §5. **No v1 recommendation.**

## 3.6 Server-side aggregation

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Aggregate summary | `summarizeHoldings()` → `{ totalValue, totalCost, totalGainLoss, totalGainLossPct, cardCount }` | `get_collection_analytics()` → `{ totalCards, totalSpend, currentEstimatedValue, unrealizedGains, realizedGains, roi, topPerformers }` |
| Realized vs unrealized split | Not in `summarizeHoldings()` — would be computed from ledger entries client-side | First-class on analytics endpoint |
| Top-performers ranking | Not computed server-side | First-class on analytics endpoint |
| Breakdown by dimension (year / manufacturer / grade / player / set) | NOT computed server-side — would be iOS client-side `Dictionary(grouping:)` over the holdings array | `get_collection_breakdown({ groupBy: 'release' \| 'year' \| 'grade' \| 'player' \| 'manufacturer' })` returns `{ buckets: [{ key, count, percentage }] }` |
| Set-progress | NOT modeled | First-class `list_collection_set_progress` etc. |

**Honest assessment:** HobbyIQ's `summarizeHoldings()` covers the top-line dashboard surface but the breakdown-by-X capability is a real gap. iOS client-side computation works at v1 single-user scale; at 100/500/1000 tier with larger collections it would push data to clients unnecessarily. **Server-side breakdown is a real capability gap worth surfacing — Section 4 R3 (medium tier, design call).**

**Nuance for R3:** Cardsight's `groupBy` enum is `release | year | grade | player | manufacturer`. HobbyIQ's analog would translate:
- `release` ← `brand` or `setName` (HobbyIQ has both text fields; mapping isn't 1:1)
- `year` ← `cardYear` (clean)
- `grade` ← either `gradeCompany + gradeValue` text OR (post-R2) `cardsightGradeId`
- `player` ← `playerName` text (post-PR #68 `playerId` resolved from MLB)
- `manufacturer` ← `brand` text

Adopting Cardsight's groupBy verbatim requires the identity-canonicalization wins from R1/R2 to land first; otherwise breakdown is text-driven and pays the same canonicalization tax that R1 was meant to eliminate. **R3 sequences after R1/R2.**

## 3.7 Storage shape

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Granularity | One Cosmos doc per user (`UserDoc` holds all holdings + ledger + alerts + price history + feedback) | Per-entity records: collectors, collections, collection cards, binders, lists, etc. (inferred — not empirically verified) |
| Read pattern | Full user doc loaded; 30-sec in-process cache | Per-entity reads with pagination (`take`/`skip` on every list endpoint) |
| Write pattern | Whole-doc upsert on every mutation | Per-entity targeted writes |
| Concurrency model | Last-write-wins on whole doc (single-user pre-launch makes this irrelevant per Drew) | Per-entity targeted updates |
| Multi-user portability | Whole-doc-level | Per-entity-level |
| Partial loads | None (whole doc) | Native (paginated per-entity) |

**Honest assessment:** Cardsight's approach is normalization-modeled; HobbyIQ's is denormalization-modeled. Both are valid for their respective use cases:
- Cardsight: multi-collector / multi-collection / multi-binder / multi-list product means per-entity reads are essential
- HobbyIQ v1: single-user / one-collection / no-binders means whole-doc is efficient

Per Drew Phase 1 Q4 answer: structural observation, not defect. **Section 4 NR3: do not recommend storage redesign for v1.** Re-evaluation gate is at CF-LAUNCH-READINESS-500/1000 if specific scale concerns surface (whole-doc RU cost, partial-load needs).

## 3.8 Money typing

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Price fields | `number` (TS) | `string` (e.g. "49.99") |
| JSON precision | Standard number serialization; floating-point precision exposed | Avoids JSON-number precision issues |
| Parsing burden | None (numeric arithmetic direct) | Consumer must parse string → number for arithmetic |
| Currency-symbol clarity | Implicit USD; no representation | Implicit USD; no representation |

**Honest assessment:** Trade-off goes either way. HobbyIQ's number-typed approach is the dominant Express/TypeScript convention; Cardsight's string-typed approach is a defensible choice for inter-language SDK precision but adds parsing overhead in our use case. **Section 4 NR2: do not recommend change; not load-bearing.**

## 3.9 Images

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Per-holding photos | `photos: string[]` URLs to permanent blob storage (PR B multi-tab) | `get_collection_card_image / _thumbnail` — binary via MCP image content block |
| What's stored | URL pointers to Azure blob container `card-images` (user uploads) | Binary served on demand from Cardsight backend |
| Catalog (Cardsight-canonical) image | Separate endpoint `get_card_image` (binary or base64-JSON) — W5-iOS gap | Same separate endpoint |
| Caching | CDN-fronted blob URL; iOS native cache | Per-request binary from Cardsight |
| User-uploaded images | Yes — that's exactly what `photos[]` stores | Yes — `get_collection_card_image` |

**Honest assessment:** Both solve the user-uploaded-photo problem. The difference is delivery mode (URL pointer vs binary).

For iOS native consumption, URL pointer is operationally cleaner:
- CDN-edge caching for free
- Network library async/await + AsyncImage works natively
- No backend proxying needed for user-uploaded photos (HobbyIQ's blob URLs are directly fetchable)
- Cardsight's MCP-binary model is optimized for AI-agent consumption (Claude Desktop renders inline); not iOS-app-optimized

Cardsight's `collection_card_images` is a first-class concept in their domain entity diagram (§2.4) but the same conceptual surface exists in HobbyIQ via `photos[]` on `PortfolioHolding`. **Different delivery, same domain model.**

**Section 4 R4: explicit no-recommendation needed.** The W5-iOS image-fetch mitigation work (per the Cardsight published-SDK investigation appendix A2) is about CATALOG (Cardsight-canonical) images for the picker. User-uploaded photos are a separate problem already solved by `photos[]` + blob storage.

## 3.10 Set-progress tracking

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Set as first-class entity | No — `setName: string` text field on holdings | Yes — `setId: UUID` in catalog; sets have their own `list_collection_set_progress` capability |
| "How close am I to completing set X?" | Not modeled | First-class — owned / total / % complete / missing card IDs |
| "What sets am I close to finishing?" | Not modeled | First-class with `nearComplete: true` filter |
| Parallel-set completion ("the Refractor parallel of this set") | Not modeled | First-class — `get_collection_set_progress_parallel` |
| Missing-card list for purchase budgeting | Not modeled | Pair with `get_card_pricing_bulk` workflow |

**Honest assessment:** This is the **most divergent product-shape difference** between the two systems. Set-completion-collector UX is a real product category that HobbyIQ doesn't currently serve. Investment-tracker UX (HobbyIQ's focus) and set-completionist UX (Cardsight's heavy emphasis) are different but compatible product shapes.

Per Drew Phase 1 framing on Q2: intentional v1 scope — not foreclosed. Set-progress is the kind of capability some HobbyIQ users WILL want post-launch (collectors who care about set completion vs investors who care about ROI). Captured in §5 as future capability. **No v1 recommendation.**

## 3.11 Reconciliation / eBay-webhook flow (HobbyIQ-specific)

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Webhook ingestion of marketplace sales | Yes — `markHoldingSoldFromEbay` ingests eBay `ITEM_SOLD` notifications | Not modeled |
| Incomplete-data state | `needsReconciliation: boolean` | Not modeled |
| User dismissal of incomplete-data prompts | `dismissedAt / dismissedReason` | Not modeled |
| Granular fee nullability | `number \| null` with explicit "never coerce to 0" semantic | Not modeled |
| Re-fetch + correct flow | Reconciliation pass re-fetches eBay order, updates entry | Not modeled |

**Honest assessment:** HobbyIQ-specific. Cardsight doesn't model marketplace webhook integration at all. **No comparison — different scope.** This is one of HobbyIQ's real product surfaces beyond inventory tracking. Captured here for completeness; nothing to learn from Cardsight on this dimension.

## 3.12 Forward-looking P&L / TrendIQ (HobbyIQ-specific)

| Aspect | HobbyIQ today | Cardsight |
|---|---|---|
| Predicted-price fields | `predictedPrice, predictedPriceLow, predictedPriceHigh, predictedPriceMechanism, predictedPriceUpdatedAt` | Not modeled (current-value only) |
| Forward-looking movement | `movementDirection, movementComposite, movementImpliedPct, movementCoverage, movementUpdatedAt` (TrendIQ-derived) | Not modeled |
| Recommendation surface | `verdict, recommendation, trend, riskLevel, marketSpeed, marketPressure, expectedDaysToSell, confidence, explanationBullets` | Not modeled |
| Alert / signal layer | `PortfolioAlert[]` typed as value-move / cost-cross / stale-data / liquidity-risk | Not modeled |
| ROI computation source | Compared to `currentValue` (live estimate) | `currentEstimatedValue` from `get_card_pricing` median |
| User feedback closure | `RecommendationFeedback[]` (followed / ignored / partial) | Not modeled |

**Honest assessment:** This is HobbyIQ's actual moat (per Answer B locked at `0f9bafb`). Cardsight tracks ROI against current-comp medians but doesn't predict, project, or recommend. The cascade-detected prediction + grade-aware pricing + portfolio integration that the 2026-05-29 moat-decision locked as the launch differentiator is exactly what's NOT in Cardsight's collections schema. **No comparison — different scope.** HobbyIQ's forward-looking layer is the product, not the inventory.

---

# Section 4 — Ranked recommendations

Three tiers per Drew's framing.

**Sequencing note:** R1 → R2 → R3 is load-bearing order. R3 ships without R1 means breakdown endpoint re-pays the text-canonicalization tax R1 eliminates. Ship R1 first (smallest, foundation). R2 second (additive, complementary). R3 only after R1 (R2 not required for R3).

## Tier 1 — Clear wins (low risk, high compounding value)

### R1 — Persist `cardsightCardId: string | null` on `PortfolioHolding`

**Recommendation:** Additive optional field on `PortfolioHolding`. Persist the Cardsight catalog UUID at holding-write time whenever the search resolution yields one. Read-side: if `cardsightCardId` present → id-based catalog lookup; if null → text-based resolution (current path).

**Why:**

- Stable canonical identity eliminates the text-resolution canonicalization-bug class. CF-PLAYERNAME-CANONICALIZATION, CF-CARDSIGHT-RESOLVER-COMPREHENSIVE, CF-VARIANT-MISMATCH-PRICESOURCE-PARITY arcs throughout this session all stem from text re-resolution losing identity stability across canonicalization changes.
- Aligns with W4's pattern (`certNumber + certGrader` additive optional fields).
- Aligns with the asymmetry Drew flagged in Phase 1 Q1: `cardHedgeCardId` IS persisted on ledger entries; the missing-piece is the holding.
- Sequences cleanly with CF-CARDHEDGE-DECOMMISSION-FULL: when the CH cardId becomes obsolete, the rename / migration question becomes "swap `cardHedgeCardId` → `cardsightCardId` on ledger" not "add a brand-new field everywhere."
- W5-Windows already returns `cardsightCardId` in `UnifiedSearchResponse.candidates[].candidateId` (e.g. `"cardsight:6134bc63-..."`). The data flow from search → holding is ready; only the persistence step is missing.

**Cost:** Small.
- Type: 2-line addition to `PortfolioHolding` interface
- Service: 2-line addition to `addHolding` and `refreshHolding` write paths to extract and persist
- Backward compat: existing holdings have null; first refresh populates the field as a side effect; no migration needed
- Tests: similar shape to W4's 5 round-trip tests (~150 lines)
- No new Cosmos schema changes (additive optional)

**Risk:** Low.
- Field is optional; consumers don't break if null
- Existing text-resolution path remains as fallback
- Migration is opportunistic via refresh — no batch operation needed

**Implementation direction:**

```ts
// backend/src/types/portfolioiq.types.ts
cardsightCardId?: string | null;  // Cardsight catalog UUID; null when
                                  // search resolution didn't yield one
                                  // OR for legacy holdings created before
                                  // W5-Windows. Populated by addHolding /
                                  // refreshHolding when available.
```

**Write-path integration point:**
- In `addHolding`, when search resolution returns a Cardsight candidate, extract `candidateId` and strip `"cardsight:"` prefix → `cardsightCardId`
- In `refreshHolding`, if `cardsightCardId` is null, attempt resolution and persist on success

**Sequences before R2, R3** (R2 and R3 both compose more cleanly if R1 is in place first).

### R2 — Persist `cardsightGradeId: string | null` on `PortfolioHolding`

**Recommendation:** Additive optional field on `PortfolioHolding`. FK to Cardsight's grades taxonomy when (a) holding is graded AND (b) Cardsight covers that grader. Existing `certNumber + certGrader + gradeCompany + gradeValue` fields remain — `cardsightGradeId` is a supplementary aggregation FK, not a replacement.

**Why:**

- Two complementary paths per §3.2 honest assessment:
  - **Per-grader cert lookup (W2 path)** = identity of THIS slab (`certNumber + gradeCompany + gradeValue + totalPopulation`)
  - **`gradeId` aggregation FK (R2 path)** = "all PSA 10 sales of this card" via Cardsight pricing/marketplace
- Aligns with CF-CARDSIGHT-GRADES-ENDPOINT (MEDIUM backlog from roadmap Option B step 4-5)
- Aligns with Drew's "all grading data in the app" framing — the W2 cert-grader registry covers cert-identity per grader; the `cardsightGradeId` covers grade-bucket aggregation queries
- Cardsight's taxonomy distinguishes grader types (PSA Regular vs PSA DNA, BGS Regular vs BGS Black Label) which the current `gradeCompany + gradeValue` 2-field shape doesn't capture
- Unblocks v1.5 BGS/SGC/CGC adapters if we choose to back them via Cardsight's grade taxonomy rather than per-grader API integration (the open Q1 from the roadmap strategic reshape)

**Cost:** Small.
- Type: 1-line addition to `PortfolioHolding` interface
- Service: 2-line addition to `addHolding` to populate when grade matches Cardsight taxonomy
- Backward compat: existing holdings have null; refresh populates opportunistically
- Tests: ~50 lines (round-trip + null-default behavior)

**Risk:** Low — additive; existing grade fields remain authoritative for the cert path.

**Layering note:** R2 is a complement to W4's cert fields, not a substitute. Holdings can have:
- `certNumber + certGrader + cardsightGradeId` (cert lookup matched to Cardsight taxonomy)
- `certNumber + certGrader` only (cert lookup but Cardsight doesn't cover that grader / type)
- `gradeCompany + gradeValue + cardsightGradeId` (text-grade matched to taxonomy without cert lookup)
- `gradeCompany + gradeValue` only (text-grade only — no cert, no Cardsight match)

The cert grader and grade taxonomy paths are orthogonal axes; R2 adds the second axis without disturbing the first.

**Sequences after R1** (clean canonicalization + cardId-first lookups support reliable gradeId resolution).

## Tier 2 — Real value but design call (medium risk)

### R3 — Server-side breakdown / aggregation surface

**Recommendation:** Add a server-side `GET /api/portfolio/breakdown?groupBy=...` endpoint returning `{ buckets: [{ key, count, percentage }] }`. Initial groupBy enum: `year | player | grade | brand | setName` (HobbyIQ-translation of Cardsight's `year | player | grade | manufacturer | release`).

**Why:**

- iOS client-side breakdown computation works at single-user v1 scale but doesn't scale (network payload + client compute) at 100/500-tier with users who have larger collections
- Cardsight's first-class breakdown capability is a real product feature (drives "where is my money concentrated?" insights)
- Aligns with `summarizeHoldings()` pattern — same shape, additional dimensional capability
- Cleanly composable with R1/R2 — when those land, breakdown by canonical `cardsightGradeId` becomes possible without text-string-bucketing artifacts

**Cost:** Medium.
- New backend service: `breakdownByDimension(holdings, groupBy) → { buckets: [...] }`
- New route in `portfolioiq.routes.ts`
- iOS integration to consume + replace client-side computation (this is the coordination cost)
- Tests for each groupBy dimension

**Risk:** Medium.
- iOS coordination: existing iOS code computes breakdowns client-side; switching to server-side requires concurrent iOS work (W5-iOS scope or polish)
- Acceptable if landed alongside W5-iOS rebuild; risky if backend ships in isolation (breaks the iOS-side aggregation that's already there)

**Sequencing nuance:** Cardsight's `groupBy` enum is `release | year | grade | player | manufacturer`. HobbyIQ's literal adoption needs translation:
- `release` ← `brand` or `setName` (HobbyIQ has both; not 1:1 with Cardsight's release model)
- `year` ← `cardYear` (clean)
- `grade` ← `gradeCompany + gradeValue` text OR (post-R2) `cardsightGradeId`
- `player` ← `playerName` text OR (post-PR #68) `playerId`
- `manufacturer` ← `brand` text

**R3 sequences after R1 and R2** — without canonical identity FKs, breakdown is text-driven and pays the same text-resolution tax R1 was meant to eliminate.

**Recommend:** Evaluate in v1.5 timeframe alongside W5-iOS rebuild. Not a blocker; a polish-tier addition that compounds with R1/R2 wins.

### R4 — Image management approach

**Recommendation:** **No change recommended.**

**Why:** §3.9 honest assessment establishes that HobbyIQ's `photos[]` (URL pointers to blob storage) and Cardsight's `get_collection_card_image / _thumbnail` (binary via MCP) solve the same domain problem (user-uploaded card photos) with different delivery modes. URL-pointer is operationally cleaner for an iOS native app (CDN edge caching + `AsyncImage` native support). Cardsight's MCP-binary is optimized for AI-agent consumption (Claude Desktop inline rendering).

**Different delivery, same domain model.** Adopting Cardsight's binary-via-MCP model would degrade iOS UX without unlocking new capability.

**The W5-iOS image-fetch mitigation work is a SEPARATE concern** — that's about CATALOG (Cardsight-canonical) images for the picker, which has its own design space per the Cardsight investigation Appendix A2.

## Tier 3 — Explicit non-recommendations (document WHY NOT)

### NR1 — Sale-lifecycle as fields-on-instance

**Why we KEEP HobbyIQ's separate ledger model:**

Cardsight's "soldPrice/soldDate as fields on the collection card" pattern is cleaner schema-wise but loses semantics HobbyIQ requires:
- **Granular eBay fee fields with `null` vs `0` distinction** — `finalValueFee, paymentProcessingFee, promotedListingFee, adFee, otherFees, netPayout, actualShippingCost` are `number | null`; null = "not yet reported by eBay." Cardsight has no equivalent fee modeling.
- **`needsReconciliation` flag + `dismissedAt / dismissedReason`** — drive UI surfaces for incomplete-data states from eBay webhook ingestion. Cardsight assumes complete data at sale time.
- **`source: "manual" | "ebay"` provenance** — distinguishes user-entered sales from webhook-ingested sales. Affects which reconciliation pass applies.
- **Multiple-sale-of-same-card-id history** — append-only ledger preserves disposition trail; fields-on-instance would lose history when soldPrice is overwritten.
- **CF-PR-E-P&L-COST-RECOMPUTE semantics** — `gradingCost` (cost to grade) + `suppliesCost` (cost of packaging supplies for THIS sale) are HobbyIQ-specific seller-side P&L deductions Cardsight doesn't model.

HobbyIQ's ledger is operationally correct for the eBay webhook + reconciliation flow + granular seller P&L surface. Cardsight's cleaner schema doesn't capture the semantics. **Keep HobbyIQ's ledger model.**

### NR2 — Money-as-string

**Why we KEEP `number`:**

Cardsight's string-typed money (`"49.99"`) avoids JSON-number precision issues at the cost of consumer parsing overhead. HobbyIQ's `number` follows TypeScript convention, integrates with arithmetic operations directly, and works fine with JavaScript's IEEE 754 doubles up to the $9007199254740992 boundary (well beyond any plausible card price).

**Trade-off goes either way; not load-bearing.** No recommendation to change.

### NR3 — Storage shape change (single-doc → multi-doc per user)

**Why we KEEP single-doc-per-user:**

Per Drew Phase 1 Q4 answer: structural observation, not defect. Single-doc-per-user is right for v1:
- Simple, atomic, cheap in-process cache
- 2MB Cosmos limit is distant (HobbyIQ's largest user docs are <100KB today)
- Concurrency (last-write-wins on rapid changes) is irrelevant pre-launch

Cardsight's per-entity record model is the right choice for their product (multi-collector, multi-collection, multi-binder, multi-list). HobbyIQ's product shape doesn't require it.

**Re-evaluation gate:** CF-LAUNCH-READINESS-500 / 1000 if specific scale concerns surface (whole-doc RU cost, partial-load needs). Section 2 didn't surface those; do NOT recommend redesign for v1.

---

# Section 5 — Future capabilities to consider

Per Drew's intentional-v1 framing on Q2 (multi-collection) and Q3 (lot tracking) from Phase 1 review. These are discoverable opportunities for post-launch evaluation, NOT v1 commitments.

## F1 — Multi-collection support

**Concept:** Lift `PortfolioHolding.statusCategory` from a state field to a first-class `Collection` entity. User can have N collections per profile.

**User value:** "Investment portfolio" vs "personal collection" vs "for-sale stack" as distinct organizational containers. Per-collection valuation. Cross-collection moves.

**Trigger:** Post-launch user feedback indicating users want to separate organizational containers vs status tags.

## F2 — Binders (sub-collection groupings)

**Concept:** Many-to-many groupings within a collection. A card can be in multiple binders ("PSA 10 RCs", "Trout PC", "Charizards"). Adopting Cardsight's pattern.

**User value:** Cross-cutting organization beyond a single status enum.

**Trigger:** F1 must land first; binders are sub-collection structures.

## F3 — Lists (wishlists)

**Concept:** Cards the user wants to acquire — separate from holdings they own. `add_list_card` (catalog cardId) vs `add_collection_card` (per-instance with cost basis).

**User value:** Clean separation of "owning" vs "watching to buy"; integrates with budget-planning ("here's what these missing cards cost")

**Trigger:** Post-launch UX signal that watch-to-buy is a real use case distinct from `statusCategory: "watchlist"` (the current state-on-holding approach).

## F4 — Set-progress tracking

**Concept:** Automated catalog-set completion tracking. "I have 47 of the 50 cards in 2024 Topps Chrome Update — here are the 3 missing."

**User value:** Set-completionist UX (a real product category Cardsight serves heavily that HobbyIQ doesn't). Pairs with `get_card_pricing_bulk` for purchase budgeting ("complete this set for $127").

**Trigger:** Post-launch user signal. Some HobbyIQ users will absolutely want it (collectors who care about completion); investment-focused users won't.

**Prerequisite:** F5 (set-as-first-class entity).

## F5 — Set as first-class entity

**Concept:** Replace `PortfolioHolding.setName: string` text with `setId: UUID` FK to a Set entity backed by Cardsight's catalog. Enables F4 plus richer per-set product surfaces.

**Trigger:** F4 requirement, OR a set-themed product feature surfaces.

**Sequencing:** Compose with R1's `cardsightCardId` adoption — the catalog FK chain is `cardsightCardId → Set → Release` etc. R1 makes F5 cheap.

## F6 — FIFO / LIFO / specific-lot tax accounting

**Concept:** Cost-basis lots rather than scalar `purchasePrice + totalCostBasis`. Tax-aware accounting for users who buy multiples at different prices.

**User value:** Tax sophistication for users selling for capital gains/losses reporting. Most v1 users are casual collectors per Drew's Phase 1 Q3 framing.

**Trigger:** Post-launch user signal from heavier-trader segment. Could land in PR E reconciliation UX or as its own future CF.

**Implementation cost:** Large — touches every cost-basis computation path; existing `purchasePrice + totalCostBasis` scalars need to compose with new `lots: Array<{ qty, unitCost, acquiredAt }>` while preserving the simple path.

---

# Section 6 — Honest refinement notes

Two analytical refinements emerged during Section 3 / 4 composition worth surfacing explicitly rather than smoothing into the recommendation text.

## 6.1 R1 / R2 / R3 sequencing is load-bearing

The Tier 1 + Tier 2 recommendations form a dependency chain:

- **R1 (cardsightCardId)** must land first — it eliminates text-resolution canonicalization risk that contaminates everything downstream
- **R2 (cardsightGradeId)** sequences after R1 — clean canonicalization supports reliable grade-bucket resolution
- **R3 (breakdown surface)** sequences after R1 AND R2 — without identity FKs, breakdown remains text-driven and inherits the same canonicalization tax

Doing R3 before R1/R2 would surface as "breakdown shows two separate buckets for 'Topps Chrome' and 'Topps Chrome Update'" at first user interaction. **The Phase 4 commit should be explicit about this sequencing** so a future implementer doesn't pick R3 alone.

## 6.2 R2's relationship with W2's cert-grader registry needs explicit naming

The W2-shipped cert-grader registry (registered: PSA only; designed for v1.5 BGS / SGC / CGC plug-in additions) and the proposed R2 `cardsightGradeId` adoption are **complementary, not substitutes**, but the relationship has nuance worth surfacing at v1.5 grader CF kickoff:

- **W2 cert path** = identity-of-this-slab (cert lookup yields `certNumber + gradeCompany + gradeValue + totalPopulation`). Per-grader API integration; rich semantics.
- **R2 gradeId path** = grade-bucket-aggregation (`gradeId` filters Cardsight pricing/marketplace). Universal grader coverage via Cardsight's taxonomy; aggregation-focused.

At v1.5 grader CF kickoff, the question is "do we ship BGS/SGC/CGC adapters via direct cert-API integration (richer per slab) OR via Cardsight's grades.companies.* (cheaper, vendor-mediated)?" — Drew's roadmap Option B step 4 evaluation question.

**R2 doesn't pre-decide that question.** R2 says "persist the gradeId FK when available." Whether v1.5 graders use cert-API or Cardsight depends on the empirical evaluation in Option B step 4. R2 makes the gradeId persistence ready for either outcome.

## 6.3 NR1's "different problems being solved" framing should not be diluted

The sale-lifecycle comparison is the strongest "honest framing" win in the doc. Cardsight's schema IS cleaner; HobbyIQ's IS uglier. The HobbyIQ uglier-schema is operationally correct for the eBay webhook + reconciliation flow + granular seller P&L surface that Cardsight doesn't model at all.

Future-Drew reading this should NOT come away thinking "we should clean this up." The right takeaway is: "we have an explicit design choice driven by operational requirements that have no Cardsight analog." NR1's framing in Section 4 should stay sharp.

---

# Phase 3 → Phase 4 transition

Sections 3, 4, 5, 6 written. Two Tier-1 recommendations (R1, R2), one Tier-2 recommendation (R3) with sequencing nuance, one Tier-2 explicit-no-rec (R4), three Tier-3 non-recommendations (NR1, NR2, NR3), six future capabilities (F1-F6), and three honest refinement notes (6.1-6.3).

Standing by for Drew review before single commit.
