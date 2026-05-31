# CF-PILLAR-STATE-AUDIT — backend inventory across all pillars (read-only)

**Date:** 2026-05-30
**Type:** Discovery / inventory. NO code changes, NO deploy, NO SDK install. Backend-only (iOS consumption state out of scope).
**Canonical clone:** `C:/dev/hobbyiq-main`
**Audit HEAD:** `965c60c` (local, push pending Drew's rebase decision against origin `2bd6e25`). Code-side state is equivalent across `4ddef12 → 965c60c` for this audit (the local commit is docs-only). Origin's `2bd6e25` is iOS Swift only (out of scope).
**Method:** Three-level discipline per feature — (1) exists in code? (2) wired/deployed? (3) has a live producer/consumer? State = `complete` (1+2+3) · `partial` (1+2, gap in 3) · `stub` (1 only) · `absent`.
**Observability constraint:** fn-compiq App Insights queryable only ~31 min back (per CF-FN-COMPIQ-AI-RETENTION-INVESTIGATION). All live-traffic claims here use code + config + blob + route-registration evidence — not retrospective telemetry queries.

---

## TL;DR — what's complete vs extend vs build

### COMPLETE (level 1+2+3 — needs nothing)

- CompIQ: `/estimate`, `/search`, `/price`, `/price-by-id`, `/cardsearch`, `/bulk`, `/grade-premium`, `/sell-window`, `/comps-by-player`, `/what-if`, `/parse`, `/normalization-dictionary`, `/health` — all 13 routes wired + live
- CompIQ: unified-search dispatcher authority holds (zero router bypasses at the brief's flagged lines)
- CompIQ: 8 signal collector Functions (compsMomentum/ebay/reddit/trends/odds/stats/news/youtube) → aggregator → serve-signals → backend `fetchPlayerSignals()` — full chain live; compsMomentum just restored via 972afac, verified Phase 3b 2026-05-30 same-day
- CompIQ: prediction fields (predictedPrice + Mechanism + Range + movement* bundle) persisted at both reprice sites + surfaced in API responses
- CompIQ: `/api/portfolio/identify` (c3a5c9e) — route shipped + structural smokes PASS (wire-level smoke pending tomorrow)
- InventoryIQ: single-add `POST /api/portfolio/holdings` → `addHolding` with R1/R2/MLB-resolve/auto-price side effects
- InventoryIQ: SAS mint at `POST /api/uploads/card-photo` — full SAS path with 8 MB cap, 15-min expiry, cw permissions
- InventoryIQ: grade taxonomy resolver `resolveCardsightGradeId` (R2)
- InventoryIQ: PSA cert grader (W2 contract); registry forward-compat for v1.5
- InventoryIQ: movement signal CURRENT-snapshot persistence (5 fields, two write sites both populated)
- PortfolioIQ: ledger model `PortfolioLedgerEntry` + ITEM_SOLD webhook → ledger entry chain + `webhook_events` container
- PortfolioIQ: `computeLedgerFinancials` (single source of truth for manual-sale P&L)
- DailyIQ: producer chain (`dailyiq.job.ts` → `buildDailyBrief` → `briefStore` + `dailyiq.repository` to Cosmos `dailyiq_briefs`)
- DailyIQ: consumer chain (`handleBriefRequest` with 3-tier cache → Cosmos → file fallback)
- DailyIQ: push delivery via `sendDailyIQNotification` (APNs, opt-in via alertPreferences)
- DailyIQ: signal aggregator schedule (`0 50 */2 * * *`) — Phase 3b verified
- Shared: photo blob download (`downloadBlobByUrl`) — added via c3a5c9e for identify

### EXTEND (built but with named gaps that v1 should close)

- PortfolioHolding shape: 66 fields, 65 optional, schemaless `...rest` spread on POST; `gradingCompany`/`gradeCompany` parallel-key drift; `shimmedX` helpers documenting "13/24 production holdings under wrong names." Contract-freeze step. **L (>8h)**
- Photos write path: `photos[]` populated via spread only; zero URL validation against `parseBlobUrlOrThrow` helper that already exists. **S (<2h)**
- P&L formula (eBay path): structurally correct in `computeLedgerFinancials` but eBay sales today net out ZERO fees (see SURPRISES). **M to extend with Finances enrichment**
- DailyIQ freshness: no `generatedAt`-based floor on persisted-read path; relies on 5-min cache only. **M (2-8h)**
- DailyIQ scheduler: in-process `setTimeout` singletons; unsafe under scale-out (each replica fires). **M (2-8h)**
- `needsReconciliation` flag: computed correctly but stuck `true` permanently for every eBay sale; no clear-path. **S (after enrichment exists)**
- Movement signals: current snapshot done; per-holding HISTORY absent (latent `trend_history` Cosmos container exists but cardId-keyed, not consumed by portfolio API). **M (2-8h)**
- `aggregateValuation`: flat-sum via `summarizeHoldings` + HHI concentration via `computePortfolioHealth`; no breakdowns by player/set/grade/month/source. **M if v1 needs richer breakdowns**

### BUILD (absent — v1 may need depending on gate)

- **eBay Finances API enrichment service** (the most important gap) — replaces the hardcoded `null` fee writes with real Finances API population. Without this, eBay-sourced P&L is structurally wrong. **L (>8h)**
- **PATCH whitelist extension for ledger fee fields** — users currently cannot fix the null fees through any API surface even manually. **S (<2h)**
- **Tax export endpoint** — fully absent (zero `csv|tax|export` matches across backend/src). **M (2-8h)**
- **Create-holding-from-CompIQ-card path** — zero matches across backend/src for `createHoldingFromCard|addFromCard|addCardToInventory`. CompIQ card → InventoryIQ holding handoff has no backend implementation. Needed for the project plan's contract-freeze step. **M (2-8h)**
- **Batch-add holding endpoint** — only `runBatchReprice` exists (reprices existing); no batch-create. **M (2-8h) if launch scale demands**
- **Sell-now / tax-strategy recommendations** — both absent. Generic `recommendation` string field exists but is not a timed action signal. **L (>8h) per CF**
- **BGS / SGC / CGC cert graders** — registry forward-compat but adapter files don't exist. PSA-only today. **v2 per project plan; M per grader when triggered**
- **P&L grouping endpoints** (by month/player/set/grade/source) — `getLedger` returns flat array + flat totals; no aggregation routes. **M (2-8h)**
- **DailyIQ in-app notification history** — push fires-and-forgets; missed pushes lost; no GET endpoint for backfill. **M (2-8h)**
- **CF-FN-COMPIQ-AI-RETENTION-INVESTIGATION** — observability gap captured today; must resolve before launch-tier scale-up makes retrospective telemetry load-bearing for incident response. **M (2-4h)**
- **Prediction corpus (CF-PREDICTION-CORPUS)** — currently stdout-only structured event; no queryable Cosmos store. Required if narrow-CompIQ default is overridden. **M (2-8h) per Q5**

---

## SURPRISES (most important findings)

### 1. eBay fee fields are 100% schema-only-never-populated — the load-bearing finding

The single most consequential discovery. `PortfolioLedgerEntry` has 7 granular fields documented in schema (`finalValueFee`, `paymentProcessingFee`, `promotedListingFee`, `adFee`, `otherFees`, `netPayout`, `actualShippingCost`), with the P&L formula honoring all of them. The only producer (`backend/src/routes/ebayWebhook.routes.ts:286-294`) hardcodes EVERY field to `null` on every eBay sale, with the comment "Those arrive via separate finance/payout APIs and reconcile later." That reconciliation **does not exist** — no `Finances` service file, no enrichment job (`Grep "[Ff]inances"` returns zero matches in `backend/`). The PATCH whitelist (`portfolioStore.service.ts:1026-1031`) **does not include any of these fee fields** so users cannot fix them via API either.

**Net effect:** every eBay-sourced ledger entry today records `netProceeds ≈ grossProceeds − costBasisSold` (NO fees, NO buyer shipping, NO tax, NO grading cost — all zero on the wire). This dramatically overstates realized P&L for any seller who actually paid fees. The `needsReconciliation` flag is permanently `true` to warn about this, but there's no path to clear it.

**Why this matters for the project plan:** PortfolioIQ's "P&L" feature is `complete` at level 1+2 but structurally wrong at level 3 for the most common sale path (eBay). A v1 PortfolioIQ that surfaces realized P&L without explicit "gross-of-fees" framing would mislead users.

### 2. DailyIQ has TWO writers on Cosmos `dailyiq_briefs` with DIFFERENT schemas

`briefStore.service.ts:135-146` writes shape A: `{ id, docType:"dailyiq_brief", schemaVersion:1, date, generatedAt, mlb, milb }` via env `COSMOS_DAILYIQ_BRIEFS_CONTAINER`.

`dailyiq.repository.ts:81-99` writes shape B: `{ id, date, generatedAt, mlb, milb, notifiedAt, updatedAt, docType:"dailyiq_brief" }` via env `COSMOS_DAILYIQ_CONTAINER` (DIFFERENT env var, same default name `dailyiq_briefs`).

Both use `id == date` so they collide. `runDailyIQJob` writes via the repository (line 146 of `dailyiq.job.ts`), then `buildDailyBrief` writes via the briefStore (chain through `dailyiq.routes.ts:366 → :356 → upsertPersistedBrief`). **The order matters and the doc shape that wins depends on which path executed last.** `notifiedAt` may be stripped by the next `upsertPersistedBrief` (briefStore writer doesn't preserve it).

**Why this matters:** this is the most likely root cause of the "DailyIQ sync issue" the project plan flags for Phase A step 0 classification. **Backend-fault, not iOS-rendering.** Symptoms would include duplicate push deliveries (notifiedAt cleared), missing pushes (notifiedAt re-set on a brief that was already pushed), or schema-mismatch read errors at the consumer.

### 3. DailyIQ has TWO completely independent watchlist systems

- `/api/dailyiq/watchlist*` (canonical for DailyIQ) → Cosmos container `dailyiq_watchlist`, partition `/userId`, doc id = sha1(userId+playerId), docType `dailyiq_watchlist`
- `/api/watchlist*` (orphan) → Cosmos container `watchlist`, partition `/userId`, doc id = `randomUUID()`, docType `watchlist`

`dailyiq.job.ts` only consults the DailyIQ watchlist (line 18 + line 174). If iOS adds a player to "watchlist" via `/api/watchlist`, the DailyIQ pipeline never sees it. If iOS adds via `/api/dailyiq/watchlist`, the generic watchlist service won't see it. **No sync reconciler exists.** Either there's a UI mismatch or iOS writes to both endpoints — both bad, both untested in this audit.

### 4. `dailyiq.ts` is DEAD CODE — safe to delete

`backend/src/routes/dailyiq.ts` (7-line `/health` stub) is NOT imported anywhere in `backend/src`. `app.ts:10` imports only `./routes/dailyiq.routes.js` (the 1304-line canonical file). The dead stub compiles to `backend/dist/routes/dailyiq.js` but `dist/app.js:15` only requires `./routes/dailyiq.routes.js`. Source + dist are both dead. **Safe to delete** (S, <2h).

### 5. CompIQ router authority holds — zero bypasses at the brief's flagged lines

The brief flagged `compiq.routes.ts ~L240/L675/L678` for possible `searchCards()` direct calls bypassing the dispatcher. Verified each:
- L238 `/comps-by-player` calls `fetchCompsByPlayer(...)` — service-level helper, not search-dispatcher bypass
- L660-680 is field extraction from an already-computed `est as any` object — not a router bypass
- L301 `/cardsearch` calls `dispatchSearch(...)` — properly routed through unified-search dispatcher
- L736 `/price-by-id` calls `cardsight.client.getPricing()` directly — documented pinned-ID path (per comment at L726, pinned IDs skip search by design — not a bypass)

**No live router bypass found.** The earlier-CF concern about bypasses is resolved.

### 6. Residual CardHedge naming — variable name only, ZERO active call paths

`compiqEstimate.service.ts` has 10 references to `cardHedgeGrade` — but this is a **local variable name**, not a CardHedge API call. The variable is named historically (per W4 prior state); logic now hits Cardsight via `cardsight.client.getPricing/getCardDetail`. Documentation comments mention CardHedge in `cardsight.router.ts` (relocation history), `corpusEntry.ts` (data-shape history), and `corpusMapping.ts` (data-shape history) — all informational.

**`Grep "cardhedge\.client\|CardHedgeCard\|CardHedgeSale"` returns ZERO actual import/call sites in `backend/src`.** CardHedge is fully decommissioned at the code level. The naming residual is a code-smell worth a rename pass (`cardHedgeGrade` → `requestedGrade` or similar) — small, safe; not a v1 blocker.

### 7. `acquisitionCost` field does not exist anywhere in backend code

`Grep "acquisitionCost"` returns ZERO matches in `backend/src`. The closest analog is `purchasePrice` (`portfolioiq.types.ts:21`) and `totalCostBasis` (line 22). If "acquisitionCost" is the project plan's canonical name, that's a contract drift to resolve at contract-freeze time — either rename in code or document the mapping.

### 8. `photos[]` has zero explicit write path on the backend

Backend trust-by-default — iOS POSTs the blobUrl returned from SAS mint, backend stores the string via `...rest` spread, never validates against the configured account/container. **A typo or malicious client URL would silently persist forever.** `parseBlobUrlOrThrow` helper already exists (`photoStorage.service.ts:127`) and is reused for delete + download — just not for the photo-write path. Quick win: add validation at addHolding/updateHolding (S, <2h).

### 9. Prediction logging is stdout-only — no queryable corpus

`compiqEstimate.service.ts:2710-2715` writes structured `[compiq.prediction_emitted]` events as `console.log(JSON.stringify(...))` — captured by App Service log stream but NOT in a queryable Cosmos container. Comment explicitly flags Q5 deferral to `CF-PREDICTION-CORPUS` for formal storage. Means: predictions ARE captured (level 3 live producer) but cannot be queried retrospectively for accuracy measurement / backtest / outcome learning without scraping App Insights traces (which are subject to the same 31-min retention gap surfaced today).

**Implication for project plan's "narrow vs full CompIQ scope" gate:** narrow path (defer backtest + corpus) is the lower-cost choice today; full path requires building CF-PREDICTION-CORPUS first before backtest harness has training data to consume.

### 10. The 7-signal pipeline is one MORE than expected — 8 signal collectors live

Per `fn-signal-aggregator/function.py:18-33` weights table, 7 named slices (compsMomentum 0.20, ebay 0.20, reddit 0.15, trends 0.15, odds 0.15, stats 0.10, news 0.05) plus YouTube blended into the social slice with reddit + trends. Eight Azure Functions provide the producers (`fn-comps-momentum`, `fn-ebay-signals`, `fn-reddit-signals`, `fn-trends-signals`, `fn-odds-signals`, `fn-stats-signals`, `fn-news-signals`, `fn-youtube-signals`). All present. All consumed via aggregator → serve-signals → backend chain. compsMomentum just restored from CardHedge gap via 972afac + verified Phase 3b today.

### 11. Routes are double-mounted on two prefixes

`backend/src/app.ts:49-50` mounts portfolioiq at BOTH `/api/portfolio` AND `/api/portfolioiq`. `app.ts:51-53` mounts dailyiq at THREE prefixes: `/api/dailyiq`, `/api/dailyIQ`, `/api/daily`. Out of audit scope but flagged — observability/metrics will split across paths.

### 12. Latent `trend_history` infrastructure not consumed by PortfolioIQ

`backend/src/services/playerScore/trendHistory.service.ts` writes a Cosmos container `trend_history` partitioned by `/cardId` on every compiq estimate call. This IS a movement-history store at the card identity level — but cardId-keyed (not user-keyed) and not surfaced through any portfolio endpoint. **Could feed a per-holding movement chart** via join on `cardsightCardId` without building new infrastructure (extend, not build) — if the project plan's "movement history v1" gate goes affirmative.

---

## Per-pillar audit detail

### CompIQ pillar

| Feature | exists (file:line) | wired/deployed | live consumer | state | recommended action | size |
|---|---|---|---|---|---|---|
| `/estimate` route | compiq.routes.ts:184 | routed via Express + mounted in app.ts | called by `/api/compiq/estimate` from iOS + internal repricer | **complete** | none | — |
| `/search` route | compiq.routes.ts:324 | routed | live (free-text search → estimate) | **complete** | none | — |
| `/price` route | compiq.routes.ts:543 | routed | live | **complete** | none | — |
| `/price-by-id` route | compiq.routes.ts:736 | routed | live (pinned-ID estimate) | **complete** | none | — |
| `/cardsearch` route | compiq.routes.ts:301 | routed via `dispatchSearch` (unified-search dispatcher) | live; iOS picker gap window (W5-iOS pending) | **complete** | none | — |
| `/bulk` route | compiq.routes.ts:912 | routed | live | **complete** | none | — |
| `/grade-premium`, `/sell-window`, `/comps-by-player`, `/what-if`, `/parse`, `/normalization-dictionary`, `/health` | compiq.routes.ts:1047, 1093, 238, 216, 193, 186, 176 | all routed | all live | **complete** | none | — |
| `/search-list` route | DELETED per L729 comment | n/a | n/a | **absent (by design)** | none | — |
| Router authority (no bypasses) | brief's flagged L240/L675/L678 verified | n/a | n/a | **complete** | none | — |
| Cardsight sole; zero CardHedge calls | Grep `cardhedge.client` → 0 matches | n/a | `cardHedgeGrade` variable name only (10 hits, no active calls) | **complete** | rename `cardHedgeGrade` → `requestedGrade` (code-smell only) | S |
| Signal pipeline — 8 collectors | compiq-functions/{fn-comps-momentum, fn-ebay-signals, fn-reddit-signals, fn-trends-signals, fn-odds-signals, fn-stats-signals, fn-news-signals, fn-youtube-signals} | all deployed to fn-compiq Function App | aggregator (every 2h) → serve-signals → backend `fetchPlayerSignals` (signals/fetchSignals.ts:43) | **complete** | none (compsMomentum just verified Phase 3b) | — |
| Prediction fields persistence | portfolioiq.types.ts:39-43, :51-55; compiqEstimate.service.ts:550-552, :2054-2094, :2105-2107 | two write sites covered | live (autoPriceHolding + repriceHoldingsForUser) | **complete** | none | — |
| Prediction logging | compiqEstimate.service.ts:2713-2715 (`console.log('[compiq.prediction_emitted] '...)`) | stdout via App Service log stream | level 3 alive (every estimate logs) | **partial** (stdout-only; no Cosmos corpus) | CF-PREDICTION-CORPUS (gated by CompIQ scope gate) | M |
| `/api/portfolio/identify` route | portfolioiq.routes.ts:109 | routed; CF-CARDSIGHT-IDENTIFY-INTEGRATION c3a5c9e | structural smokes PASS; wire-level smoke pending tomorrow | **complete** (level 1+2; level 3 wire-pending) | run pending happy-path smoke (Mac-side) | S |
| Create-holding-from-CompIQ-card path | `Grep create.?holding\|createHoldingFromCard\|addFromCard\|addCardToInventory` → 0 matches | n/a | n/a | **absent** | **build** — needed for project plan contract-freeze step | M |

### InventoryIQ pillar

| Feature | exists (file:line) | wired/deployed | live consumer | state | recommended action | size |
|---|---|---|---|---|---|---|
| PortfolioHolding model | portfolioiq.types.ts:1-147 (66 fields, 65 optional) | imported across portfolioStore, compiqEstimate, ebayListing | live | **partial** (14-shape drift; parallel `gradingCompany`/`gradeCompany`; `...rest` schemaless spread; shimmedX helpers documented at portfolioStore.service.ts:358-388) | extend — Zod validation at route boundary; deprecate one of the parallel keys; ship CF-IOS-FIELD-CONTRACT-FIX + CF-PORTFOLIO-METADATA-BACKFILL; retire shims | L |
| Single-add holding | portfolioStore.service.ts:1222-1285 (`addHolding`) | routed at portfolioiq.routes.ts:37 (`POST /holdings`); double-mounted | live (handler runs normalizeR1, populateCardsightGradeId, autoPrice, resolvePlayer) | **complete** | none | — |
| Batch-add holding | Grep `batch\|bulk\|addMany\|createMany` → only `runBatchReprice` (reprice, not add) | not wired | not present | **absent** | **build** if scale demands (CSV import / multi-card scan); leave-as-is for single-user loop | M |
| Photos SAS mint | photoStorage.service.ts:73-122 (`issueSasUploadUrl`) | routed at uploads.routes.ts:35 (`POST /api/uploads/card-photo`) | live (iOS slab capture + identify pre-upload) | **complete** | none | — |
| Photos write path on holdings | `Grep holding.photos =\|photos:\[\|photos = ` → 0 backend writes; lands via `...rest` spread at portfolioStore.service.ts:1227-1230 | wired (via spread) | populated by iOS; backend never validates | **partial** | extend — validate URLs at addHolding/updateHolding via `parseBlobUrlOrThrow` (already exists) | S |
| Grade taxonomy resolver (R2) | cardsight/cardsightGradesTaxonomy.ts:169-203 (`resolveCardsightGradeId`) | wired into addHolding/updateHolding/refreshHolding via `populateCardsightGradeId` | live (3-step Cardsight tree walk + 24h cache; null on miss) | **complete** | none | — |
| Cert grader — PSA | certGraders/psa.grader.ts; registered at index.ts:15 | live via W2 CertGrader contract (dd7ec17) | live (W6 VerifyView cert lookup path) | **complete** | none | — |
| Cert grader — BGS / SGC / CGC | `ls certGraders/*.ts` → only certGrader, index, psa, registry | n/a | n/a | **absent** (registry forward-compat per index.ts:17-20 comment) | v2 per project plan; M per grader when triggered | M each |
| Movement signals — current snapshot | portfolioStore.service.ts:502-539, :2054-2094 (two write sites) | wired into both write paths | live (autoPriceHolding from add/update/refresh; repriceHoldingsForUser from cron + batch reprice) | **complete** | none | — |
| Movement signals — HISTORY | `Grep movement_history\|movementHistory` → 0 matches | not wired | latent `trend_history` container exists at playerScore/trendHistory.service.ts:23 (cardId-keyed, not portfolio-keyed) | **absent** for per-holding history; latent infra exists for cardId-keyed | gate-dependent — if movement-history v1, extend via cardsightCardId join (M); if not, leave-as-is | M |

### PortfolioIQ pillar

| Feature | exists (file:line) | wired/deployed | live consumer | state | recommended action | size |
|---|---|---|---|---|---|---|
| `PortfolioLedgerEntry` schema | portfolioStore.service.ts:199-256 | wired in `UserDoc.ledger` array (line 81) | live (sellHolding + markHoldingSoldFromEbay write; getLedger reads) | **complete** | none | — |
| ITEM_SOLD pipeline | ebayWebhook.routes.ts:250-316 (`handleItemSold`); dispatcher L355-430 | mounted at `/api/ebay/webhook` (app.ts:55); idempotent on (holdingId, ebayOrderId) | live | **complete** | none | — |
| `webhook_events` container | ebayWebhookEvents.service.ts:1-321; env `COSMOS_WEBHOOK_EVENTS_CONTAINER ?? "webhook_events"` (L71) | partition `/notificationId`; created-if-not-exists | live (captureEvent, eventExists, markEventProcessed, markEventError) | **complete** | none | — |
| Expense field `acquisitionCost` | `Grep "acquisitionCost"` → 0 matches | n/a | n/a (`purchasePrice` exists instead at portfolioiq.types.ts:21) | **absent** | rename `purchasePrice` → `acquisitionCost` OR document mapping at contract-freeze | S |
| Expense fields `gradingCost`/`suppliesCost` | portfolioStore.service.ts:239-240 (ledger only, NOT holding); manual sale read at L1587-1588; eBay path hardcodes `null` at ebayWebhook.routes.ts:300-301 | wired into `computeLedgerFinancials` (L309-326) + PATCH whitelist (L1026-1031) | **manual sale: live; eBay sale: null-on-write, user-PATCHable only** | **partial** | extend — consider holding-level grading-cost accrual so sale event defaults the field | M |
| eBay fee fields (schema) | portfolioStore.service.ts:232-238 (finalValueFee, paymentProcessingFee, promotedListingFee, adFee, otherFees, netPayout, actualShippingCost) | wired (computeLedgerFinancials honors at L289-298; PATCH-recompute at L1183-1189) | **NEVER POPULATED** — only producer hardcodes `null` (ebayWebhook.routes.ts:286-294); PATCH whitelist EXCLUDES these fields | **stub** (level 1+2; level 3 dead) | **build** — eBay Finances API enrichment service + scheduled reconciliation job + PATCH whitelist extension | L |
| `needsReconciliation` flag | portfolioStore.service.ts:245 (schema) + :1773 (computed) | written on every ITEM_SOLD ledger entry (L1825); returned via GET /ledger; PATCH whitelist excludes (intentional) | live producer; no clear-path consumer (no job sets it back to `false`) | **partial** | extend — once enrichment exists, add clear-path; consider counting toward portfolio-health "ledger quality" | S after enrichment |
| P&L computation | `computeLedgerFinancials` portfolioStore.service.ts:306-334 | wired into sellHolding (L1590) + markHoldingSoldFromEbay (L1780) + updateLedgerEntry recompute (L1197) | live; manual path full; eBay path nets ZERO fees (knownFeeSum=0 because granular fees all null) | **partial** | extend — add aggregation/grouping endpoints; add test that `needsReconciliation === true` ⇒ no consumer treats `netProceeds` as authoritative | M |
| P&L groupings (by month/player/set/grade/source) | `Grep "computeProfitLoss\|computePnl"` → only flat sum in getLedger:995-1001 | not wired | n/a | **absent** | **build** if v1 PortfolioIQ surface needs them | M |
| Tax export | `Grep "exportTax\|taxExport\|csv\|CSV"` across `backend/src` → 0 matches | not wired | n/a | **absent** | **build** Schedule D / Form 8949-shaped CSV; respect `needsReconciliation` flag | M |
| `sellNow` / sell-now recommendation | `Grep "sellNow\|sell-now"` → 0 matches in backend | not wired | generic `recommendation` string at portfolioiq.types.ts:60 populated from `estimate.action` (autoPriceHolding L541 + repriceHoldingsForUser L2096) — NOT a timed action signal | **absent** | **build** per [[project_product_actionable_seller_intelligence]] + [[information_cascade_signal_model]] | L |
| `taxStrategy` recommendation | 0 matches | n/a | n/a | **absent** | gate-dependent | M |
| `aggregateValuation` / `portfolioValuation` | `Grep` → 0 matches for named feature; flat sum via `summarizeHoldings` at portfolioStore.service.ts:875-901 + HHI concentration via `computePortfolioHealth` at L681-717 | wired via `GET /api/portfolio` | live (returns `{totalValue, totalCost, totalGainLoss, totalGainLossPct, cardCount}`) | **partial** (named feature absent; flat-sum + HHI exist) | extend if v1 needs breakdowns | M |

### DailyIQ + shared infra

| Feature | exists (file:line) | wired/deployed | live consumer | state | recommended action | size |
|---|---|---|---|---|---|---|
| Route file duplication | dailyiq.routes.ts (1304 lines, canonical) + dailyiq.ts (7 lines, dead stub) | app.ts:10 imports ONLY dailyiq.routes; dailyiq.ts not imported anywhere in `backend/src` | live consumer for routes.ts; ZERO consumer for .ts | **dailyiq.ts = dead code** | **delete** `backend/src/routes/dailyiq.ts` + `backend/dist/routes/dailyiq.js` | S |
| DailyIQ producer chain | dailyiq.routes.ts:306-367 (buildBriefPayload + buildDailyBrief); dynamicIngestion.service.ts:1-20 (ingestDailyPlayers) | dual-writer: briefStore.service.ts:241-266 → Cosmos `dailyiq_briefs` + dailyiq.repository.ts:81-99 → Cosmos `dailyiq_briefs` (SAME container, DIFFERENT schema) | live; on-demand requests + scheduled job both fire | **partial** (works; schema drift on shared container) | extend — consolidate dual writer into single source-of-truth path | M |
| DailyIQ consumer chain | dailyiq.routes.ts:866-993 (handleBriefRequest); 3-tier fallback (cache → Cosmos → file → build) | mounted at three prefixes (`/api/dailyiq`, `/api/dailyIQ`, `/api/daily`) | live (iOS dashboard) | **complete** | none | — |
| DailyIQ sync / freshness | dailyiq.routes.ts:192, :884-891 (5-min background refresh); idempotency in dailyiq.job.ts:151-158 (`notifiedAt` skip) | wired only on the "today" path of cache | live but with structural sync issue (see SURPRISES #2 + #3) | **partial** — **backend-fault classification confirmed for the project plan's Phase A step 0 DailyIQ-sync item** | extend — add `generatedAt`-based freshness floor on persisted-read path; consolidate dual writer; reconcile two-watchlist systems | M |
| DailyIQ scheduled job | dailyiq.job.ts:130-225 (`runDailyIQJob` + `startDailyJobs`) | wired via `server.ts:5, 47` (`startDailyJobs()` after listen); schedule via setTimeout/setInterval to 06:00 PT; `DAILYIQ_DISABLE_SCHEDULER` short-circuit | live; calls buildDailyBrief → saveTopPlayers → sendDailyIQNotification | **complete** but scale-out unsafe | extend — replica-singleton lock before scale-out | M |
| DailyIQ watchlist (canonical) | services/dailyiq/watchlistStore.service.ts | Cosmos `dailyiq_watchlist` partition `/userId`; doc id = sha1(userId+playerId) | live (dailyiq.job.ts:18 + :174 consume) | **complete** | none in this scope | — |
| Orphan watchlist | watchlist.routes.ts + services/watchlist/watchlist.service.ts:1-216 | mounted at `/api/watchlist` (app.ts:60); Cosmos `watchlist` partition `/userId`; doc id = randomUUID | live CRUD; NOT consumed by dailyiq.job | **complete-but-orphaned** | extend — deprecate one OR wire iOS through one source of truth | L |
| `dailyiq-watchlists.json` / `dailyiq-briefs.json` file artifacts | services/dailyiq/{watchlistStore, briefStore}.service.ts (file-write only when Cosmos disabled) | not wired in production (Cosmos IS configured); local-dev artifact only | local dev only | **dev-only fallback** | leave-as-is | — |
| DailyIQ push notification | notification.service.ts:126-151 (`sendDailyIQNotification`) | called from dailyiq.job.ts:177; APNs payload with `type: "dailyiq.top_performer"` | live (gated on alertPreferences.dailyIQAlerts === true; opt-in via `PUT /api/alerts/preferences`) | **complete-but-fire-and-forget** (no in-app history) | gate-dependent (project plan push-v1 gate); if shipped, build dailyiq_notifications history container | M |
| Signal aggregator | compiq-functions/fn-signal-aggregator/function.py:41-196 (`aggregate_signals`) | timerTrigger `0 50 */2 * * *` (every 2h at :50); writes `compsMomentum-signals/<slug>/aggregated.json` | live; Phase 3b verified 2026-05-30 (this audit session) | **complete** | none | — |
| Observability — fn-compiq AI retention | n/a | n/a | n/a | **gap** (Phase 3b finding) | **build** CF-FN-COMPIQ-AI-RETENTION-INVESTIGATION — diagnose root cause before launch-tier scale-up | M |

---

## Recommended sequencing for project plan Phase A integration

The plan's Phase A finish-line items map to this audit as follows. Each entry shows what the audit added/clarified vs the plan's draft state.

### Phase A step 0 — Classify open iOS-flagged items
- **DailyIQ sync issue → backend-fault confirmed** (SURPRISES #2 + #3). Routes into Phase A. Root causes are (a) dual-writer schema drift on `dailyiq_briefs` and (b) two-watchlist-system mismatch — both need resolving.
- Mike Trout variants / photo-capture state / identify consumption: not within this CF's audit scope; iOS-side classification needed separately.

### Phase A step 3 — Contract freeze
Add to scope:
- Normalize `gradingCompany`/`gradeCompany` parallel-key drift (SURPRISES #1 InventoryIQ section)
- Resolve `acquisitionCost` vs `purchasePrice` naming (SURPRISES #7)
- Build the **create-holding-from-CompIQ-card path** (currently absent; needed for the handoff)
- Add `photos[]` write-side validation via existing `parseBlobUrlOrThrow` helper
- Verify batch-add backend support: **confirmed absent**. If scope wants it, M to build.

### Phase A step 4 — Reporting correctness
Beyond the plan's named items, add:
- **eBay Finances API enrichment service + PATCH whitelist extension** for fee fields (SURPRISES #1) — without this the PortfolioIQ "P&L" feature is structurally wrong for the most common sale path. **L (>8h).** This is the largest single backend gap surfaced by the audit.
- P&L grouping endpoints if v1 PortfolioIQ surface needs them
- DailyIQ dual-writer consolidation (SURPRISES #2) — even if no UX changes, the schema drift is a latent correctness bug

### Phase A step 7 — Observability
Acknowledged; CF-FN-COMPIQ-AI-RETENTION-INVESTIGATION captured today in handoff.

### Out-of-scope cleanup eligible for opportunistic ship
- Delete `backend/src/routes/dailyiq.ts` + `backend/dist/routes/dailyiq.js` (dead code)
- Rename `cardHedgeGrade` → `requestedGrade` in compiqEstimate.service.ts (10 sites, code-smell only)

---

## Files read (all reads, no writes)

CompIQ:
- `backend/src/routes/compiq.routes.ts` (1195 lines)
- `backend/src/services/compiq/cardsight.client.ts`
- `backend/src/services/compiq/cardsight.router.ts`
- `backend/src/services/compiq/compiqEstimate.service.ts` (relevant sections)
- `backend/src/services/compiq/forwardProjection.ts`
- `backend/src/services/signals/fetchSignals.ts`
- `backend/src/services/compLogs/writeCompLog.ts`
- `backend/src/models/corpusEntry.ts`
- `backend/src/services/corpus/corpusMapping.ts`
- `compiq-functions/fn-signal-aggregator/function.py` + `function.json` (cron `0 50 */2 * * *`)
- `compiq-functions/fn-comps-momentum/function.py` + `__init__.py` + `function.json` (cron `0 0 2 * * *`)
- `compiq-functions/shared/__init__.py`

InventoryIQ:
- `backend/src/types/portfolioiq.types.ts`
- `backend/src/routes/portfolioiq.routes.ts`
- `backend/src/routes/uploads.routes.ts`
- `backend/src/services/portfolioiq/portfolioStore.service.ts`
- `backend/src/services/photoStorage/photoStorage.service.ts`
- `backend/src/services/cardsight/cardsightGradesTaxonomy.ts`
- `backend/src/services/cardsight/identify.service.ts`
- `backend/src/services/certGraders/{certGrader, index, registry, psa.grader}.ts`
- `backend/src/services/playerScore/trendHistory.service.ts`
- `backend/src/app.ts`

PortfolioIQ:
- `backend/src/services/portfolioiq/portfolioStore.service.ts` (full read)
- `backend/src/routes/portfolioiq.routes.ts`
- `backend/src/routes/ebayWebhook.routes.ts`
- `backend/src/services/ebay/{ebayAuth, ebayListing, ebayTokenStore, ebayWebhookEvents}.service.ts`
- `backend/src/jobs/portfolioReprice.job.ts`

DailyIQ + shared:
- `backend/src/routes/dailyiq.routes.ts` (1304 lines)
- `backend/src/routes/dailyiq.ts` (7 lines, dead)
- `backend/src/jobs/dailyiq.job.ts`
- `backend/src/services/dailyiq/{briefStore, dynamicIngestion, watchlistStore}.service.ts`
- `backend/src/repositories/dailyiq.repository.ts`
- `backend/src/services/watchlist/watchlist.service.ts`
- `backend/src/routes/watchlist.routes.ts`
- `backend/src/services/notification.service.ts`
- `backend/src/repositories/alertPreferences.repository.ts`

---

## Scope discipline upheld

- ✅ Read-only — no Edit, Write, or backend changes
- ✅ Cite file:line for every claim
- ✅ Three-level discipline applied per feature
- ✅ Did not trust this audit brief's file:line references — verified each against actual code (resulting corrections noted in SURPRISES #5)
- ✅ Did not chase adjacent issues outside scope — flagged in SURPRISES list
- ✅ No secrets in output
- ✅ Observability constraint honored (used code + config + blob + route-registration evidence; no retrospective live-traffic claims from App Insights)
- ✅ No tool-call drift — audited only the targets in the brief
