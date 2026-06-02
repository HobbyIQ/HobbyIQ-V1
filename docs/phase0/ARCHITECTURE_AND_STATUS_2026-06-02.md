# HobbyIQ — Full Architecture & Completion Status

*Snapshot 2026-06-02; canonical work dir `C:/dev/hobbyiq-main` on `main`; production live at `fe6ac26` on HobbyIQ3.*

This document exists to onboard a fresh Claude session (or a human reviewer) to the full state of the app: what's built, what's in-flight, what's blocking, and what's pending. Update by replacing wholesale or by appending a "Delta since YYYY-MM-DD" section at the top.

---

## 1. THE PRODUCT

HobbyIQ is a sports-card portfolio + predictive-pricing iOS app for collectors. Four pillars:

| Pillar | What it does | State |
|---|---|---|
| **CompIQ** | Pricing engine + predictions per card. Takes free-text query OR cardsightCardId, returns FMV + predictedPrice + movement signal + comp evidence | Backend complete; iOS surfaces shipped Phase 5 |
| **PortfolioIQ** | User card inventory; sell tracking; P&L ledger; portfolio-wide reprice | Backend complete; iOS shipped (movement dashboard) |
| **InventoryIQ** | Card identification (via Cardsight identify), holding lifecycle, eBay listing flow | Backend complete; iOS partial (identify done; some flows pending) |
| **DailyIQ** | Daily player-momentum briefs, watchlists, market-delta digest | Backend complete; iOS partial; known dual-writer sync bug |

**Value prop** (locked in memory): timed action recommendations (sell/hold/list) using cascade-detected head-start windows, NOT prediction accuracy. Phase 4c training targets shift accordingly.

---

## 2. FULL STACK

```
┌─────────────────────────────────────────────────────────────────┐
│  iOS App (SwiftUI)                                              │
│  - DashboardView, PortfolioView, CardDetailView, ListingComposer│
│  - InventoryRefreshService, CardScannerService                  │
│  - Notification routing                                         │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS / JSON
┌────────────────────────▼────────────────────────────────────────┐
│  Backend (TypeScript / Node / Express)                          │
│  Azure App Service: HobbyIQ3 (centralus-2)                      │
│                                                                  │
│  Routes:                                                         │
│   /api/compiq/{price, search, price-by-id, cardsearch, bulk,    │
│                estimate, grade-premium, sell-window, what-if,   │
│                normalization-dictionary}                         │
│   /api/portfolio/{holdings, ledger, identify, reprice}          │
│   /api/dailyiq/{briefs, watchlist}                              │
│   /api/playeriq/{refresh, /:name/stats}                         │
│   /api/ebay/{webhook, account-deletion}                         │
│   /api/health (build.shaFromCode + shaShort + checks)           │
│                                                                  │
│  Services:                                                       │
│   compiq/        - computeEstimate (the prediction engine)      │
│                    cardsight.client, cardsight.router           │
│                    trendIQ.compute, forwardProjection           │
│                    multiplierAnchoredPredictedPrice (mech 1)    │
│                    predictionCorpus.service (ML training corpus)│
│                    upstreamTimeout.helpers (NEW: fe6ac26)       │
│   signals/       - fetchPlayerSignals (HTTP to fn-serve-signals)│
│                    telemetry (manual trackHttpDependency)       │
│   portfolioiq/   - portfolioStore.service (holdings + ledger)   │
│                    markHoldingSoldFromEbay,                     │
│                    computeLedgerFinancials                      │
│   ebay/          - ebayAuth, ebayListing, ebayOrderPoll         │
│                    ebayTokenStore                               │
│   playerScore/   - mlbStats.service (roster-scan resolver)      │
│                    trendHistory                                 │
│   dailyiq/       - briefBuilder, watchlistManager, marketDelta  │
│   cardsight/     - identify.service                             │
│   certGraders/   - registry + PSA adapter                       │
│   shared/        - cache.service (Redis + in-memory fallback)   │
│                                                                  │
│  Jobs (in-process schedulers):                                  │
│   - portfolioReprice.job (nightly reprice all holdings)         │
│   - ebayOrderPoll.job (1h cadence; sale ingestion)              │
│   - dailyiq nightly brief generation                            │
│   - cache hit-rate emit (hourly)                                │
└──────┬───────────────────────────────────┬──────────────────────┘
       │                                   │
       │ HTTPS                             │ TCP / Cosmos SDK
       ▼                                   ▼
┌──────────────────┐              ┌────────────────────────────┐
│ Azure Functions  │              │ Cosmos DB: hobbyiq-comps   │
│ fn-compiq        │              │                            │
│ (eastus-8)       │              │ Containers (partition):    │
│                  │              │  - portfolio        /userId│
│ 16 functions:    │              │  - prediction_log   /cardId│
│ - fn-comps-      │              │  - player_trends    /pId   │
│   momentum (T)   │              │  - player_trend_     /pId  │
│ - fn-reddit-     │              │    history                 │
│   signals (T)    │              │  - dailyiq_briefs   /date  │
│ - fn-trends-     │              │  - dailyiq_watchlists      │
│   signals (T)    │              │  - comp_logs        /pId   │
│ - fn-news-       │              │  - ebay_tokens      /userId│
│   signals (T)    │              │  - compiq_corpus    /...   │
│ - fn-youtube-    │              │                            │
│   signals (T)    │              │ Read RBAC: agent has Data  │
│ - fn-stats-      │              │   Reader (granted          │
│   signals (T)    │              │   2026-06-01)              │
│ - fn-odds-       │              │ Write RBAC: NOT granted    │
│   signals (T)    │              └────────────────────────────┘
│ - fn-ebay-       │
│   signals (T)    │              ┌────────────────────────────┐
│ - fn-signal-     │              │ Redis Cache                │
│   aggregator (T) │              │ - cs:pricing:<cardId>:<par>│
│ - fn-serve-      │              │ - cs:catalog:<q>:<yr>:<n>  │
│   signals (HTTP) │              │ - cs:detail:<cardId>       │
│ - fn-search-     │              │ - signal:player (Workstream│
│   intent (HTTP)  │              │   D — deferred)            │
│ - fn-price-floor │              │ TTLs: 6h / 6h / 24h        │
│   (HTTP)         │              │ Stale-serve fallback: 24h  │
│ - fn-player-     │              │   on Cardsight outage      │
│   score-refresh  │              └────────────────────────────┘
│   (T, hits /api/ │
│   playeriq/      │              ┌────────────────────────────┐
│   refresh)       │              │ Azure Storage              │
│ - fn-price-alert-│              │                            │
│   checker (T)    │              │ stcompiqfnotgm2:           │
│ - fn-nightly-    │              │  compiq-signals/<player>/  │
│   comp-prefetch  │              │    <signal_type>.json      │
│ - fn-backtest-   │              │  RBAC: NOT granted to agent│
│   runner (T)     │              │  (slice 2 of Phase 4b      │
│                  │              │   needs this)              │
│ Telemetry sink:  │              │                            │
│  AI component    │              │ stghobbyiqdev:             │
│  "fn-compiq"     │              │  Holding photos, dailyiq   │
│  (eastus-8, key  │              │  briefs (legacy)           │
│  f7eebd2c-...) — │              └────────────────────────────┘
│  DIFFERENT from  │
│  HobbyIQ3 sink   │              ┌────────────────────────────┐
└──────────────────┘              │ External APIs              │
                                  │                            │
                                  │ - Cardsight (pricing+      │
                                  │   catalog+identify)        │
                                  │ - eBay Sell APIs (Inventory│
                                  │   Fulfillment, Account,    │
                                  │   Finances [deferred])     │
                                  │ - MLB Stats API (roster +  │
                                  │   momentum)                │
                                  │ - PSA Cert API             │
                                  │ - Reddit/Trends/YouTube/   │
                                  │   News (via fn-*-signals)  │
                                  └────────────────────────────┘

Observability:
- hobbyiq-insights (centralus-2, key 02dca1c0-...) — backend + DASHBOARD
- fn-compiq (eastus-8, key f7eebd2c-...) — fn-* functions ONLY
- Two more components exist (appi-hobbyiq-dev, appi-hobbyiq-prod) — unused
- Manual trackHttpDependency for fetch() spans (Risk #8 gap)
- Structured stdout logs piped to traces:
  [compiq.prediction_emitted]   - every prediction
  [compiq.signal_fetch_observed]- every signal fetch (NEW: 28de709)
  [compiq.trendIQ]              - every TrendIQ composite
  ebay_poll_summary             - every poll tick
  compiq_cache_hit_rate         - hourly cache stats
```

---

## 3. THE PREDICTION PATH (the core engine)

This is the load-bearing pipeline; understanding it explains 70% of the codebase.

```
INPUT: { query: string }  OR  { cardsightCardId, gradeCompany?, gradeValue? }
                       │
                       ▼
        ┌─────────────────────────────────┐
        │ parseCardQuery (for free-text)  │
        │ -> { playerName, year, brand,   │
        │      set, parallel, isAuto,     │
        │      grade, gradingCompany }    │
        └────────────────┬────────────────┘
                         ▼
        ┌─────────────────────────────────┐
        │ computeEstimate(body, ctx)      │  ← THE main service
        │ services/compiq/                │
        │  compiqEstimate.service.ts      │
        └────────────────┬────────────────┘
                         ▼
        ┌─────────────────────────────────┐
        │ Cardsight resolution            │
        │  searchCardsRouted              │
        │   -> cardIdentity               │
        │  findCompsRouted -> comps[]     │
        │  (cached via cacheWrap; Redis)  │
        └────────────────┬────────────────┘
                         ▼
        ┌─────────────────────────────────┐
        │ Branch: comps sufficient?       │
        │ - 0 comps                → INSUFFICIENT
        │ - 1, recent <=14d        → ALLOW (thin flag)
        │ - 2, newest <=180d       → ALLOW (stale flag)
        │ - 3+, newest <=365d      → ALLOW
        └──┬────────────────────────┬─────┘
           │                        │
           ▼ INSUFFICIENT           ▼ SUFFICIENT (main path)
   ┌──────────────────────┐   ┌──────────────────────────────┐
   │ Sibling-pool rescue  │   │ Parallel filter (T0-T3 tier  │
   │ (fetchSiblingSales)  │   │   ladder; CF-VARIANT-FILTER- │
   │                      │   │   LOOSENING)                 │
   │ If siblings >= 3:    │   │                              │
   │  → source="sibling-  │   │ Compute:                     │
   │    pool"             │   │  - fairMarketValue (weighted │
   │  → fmv via weighted- │   │    median)                   │
   │    median            │   │  - quickSale, premium,       │
   │  → trendIQ NOW WIRED │   │    suggestedListPrice        │
   │    (UNCOMMITTED      │   │  - fmvBand                   │
   │    BETTS FIX)        │   │                              │
   │  → predicted via     │   │ Parallel fetch (Promise.all):│
   │    computePredicted  │   │  - siblingPool               │
   │    Price             │   │  - playerSignalsResult (HTTP)│
   │                      │   │  - broaderTrend              │
   │ Else:                │   │                              │
   │  → source="no-recent-│   │ TrendIQ composite (3 layers):│
   │    comps"            │   │  L1: playerMomentum (signal) │
   │  → fmv=null          │   │  L2: cardTrajectory (comps)  │
   │  → predicted via     │   │  L3: segmentTrajectory (sib) │
   │    mechanism1 OR null│   │  weights from 8-row matrix   │
   └──────────────────────┘   │  clamp [0.70, 1.50]          │
                              │                              │
                              │ forwardProjectionFactor =    │
                              │  clamp(0.80, 1.30,           │
                              │    1 + (composite-1) * 0.6)  │
                              │                              │
                              │ predictedPrice = fmv * factor│
                              └────────────┬─────────────────┘
                                           ▼
                              ┌──────────────────────────────┐
                              │ emitPredictionToCorpus       │
                              │  writes prediction_log row   │
                              │  with all fields + cache_hit │
                              │  + served_stale +            │
                              │  trendIQ_composite +         │
                              │  playerMomentum_multiplier + │
                              │  trendIQ_weights             │
                              └────────────┬─────────────────┘
                                           ▼
                              ┌──────────────────────────────┐
                              │ Response shape (per route):  │
                              │  /price, /search, /price-by- │
                              │  id, /bulk, /estimate         │
                              │                              │
                              │  Includes:                   │
                              │   fairMarketValueLive        │
                              │   predictedPrice             │
                              │   predictedPriceRange        │
                              │   predictedPriceAttribution  │
                              │   trendIQ {composite, dir,   │
                              │     coverage, components,    │
                              │     weights, lastUpdated}    │
                              │   regime, regimeConfidence   │
                              │   recentComps[]              │
                              │   confidence                 │
                              │   ...                        │
                              └──────────────────────────────┘
```

**Catch-block on every route (NEW fe6ac26)**: `if (isCardsightTimeoutError(err))` → 200 with `source: "upstream-timeout"`, null pricing, shape-stable defaults. Mirrors `unsupported_sport` short-circuit.

---

## 4. WHAT'S BUILT vs IN-FLIGHT vs PENDING

### COMPLETE (production-live)

| Phase | Workstream | Evidence |
|---|---|---|
| 0 | Repo cleanup, deploy tooling, CI patterns | Multiple CFs through May 2026 |
| 1 | Prediction emit baseline, silent-regression fix verified | Roadmap §22 RESOLVED 2026-06-01 |
| 2 | Variant filter T0-T3 tier ladder | CF-VARIANT-FILTER-LOOSENING (6ef37b5) |
| 3 | CardHedge full cutover; Cardsight-only pricing | CF-CARDHEDGE-HARD-CUTOVER (10ad39d) |
| 3.5 | TrendIQ Phase 1 + Phase 2 plumbing; forward-projection | CF-NEXT-SALE-PREDICTION-LAYER (8bd2487) |
| 3.5 | Prediction corpus to Cosmos | CF-PREDICTION-CORPUS (702dcfe) |
| 3.5 | Grade-aware pricing (request + response halves) | CF-CARDSIGHT-TRANSLATER-GRADE-WIRING (8e61f51) |
| 4a v1 | Cache hardening (A+B+C): stale-serve, cache_hit, hit-rate emit | PHASE-4A-2.2 (d850d51) + FIX (326b43b) |
| 4b slice 1 | Signal observability + corpus flat-field capture | PHASE-4B-SLICE-1 (28de709) |
| 4b proof | "Signals fire" verdict + roster sized | PHASE-4B-SLICE-1-PROOF + PROOF-CLOSE (d0c048a) |
| **NEW** | **Elly 500 graceful timeout (5 routes)** | **fe6ac26 (deployed 2026-06-02)** |
| 5 partial | Portfolio movement integration on iOS dashboard | 7f758cd (movement pulse + top movers + drill-down) |
| 5.5 | PR E reconciliation backend + iOS Phase 2/3 | CF-PR-E-* (150d14b, 01d2cd4, 0fe88ef) |
| 6.0 | eBay listing flow + business policies (PR #98) | ebayListing.service.ts (live) |
| 6.1 | eBay sale-ingestion poll (C1) | EBAY-POLL-INGESTION-C1 (d019f0e) |
| 6.2 | Sandbox C2 verification (documented-schema path) | Path 2: 26/26 spec checks pass |
| Infra | Tier-100 launch readiness (autoscale + 6 alerts) | CF-LAUNCH-READINESS-100 |
| Infra | Deploy script with --track-status false fix | bf01029 + validated 4 deploys |
| Infra | Cardsight resolver redesign (parallelTitleMatch) | CF-CARDSIGHT-RESOLVER-REDESIGN (96cbc30) |
| Infra | MLB player roster-scan resolver | CF-RESOLVER-COVERAGE-GAP (1c72a90) |
| Infra | Unified search + cert grader registry W2 | CF-UNIFIED-SEARCH-AND-CERT W2 (dd7ec17) |
| Infra | Cardsight identify integration | CF-CARDSIGHT-IDENTIFY-INTEGRATION |
| Infra | Prediction corpus null-cardId handling | CF-PREDICTION-CORPUS-CARDID-EMISSION |
| Infra | Holding identity validation gate | CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION |
| Infra | Cardsight schema empirical reference | docs/phase0/cardsight_schema_truth.md |

### IN-FLIGHT (uncommitted or parked-awaiting-trigger)

| Workstream | State | Trigger to unpark |
|---|---|---|
| **Betts Option C (sibling-pool TrendIQ wiring)** | **Code complete, tests pass (1421/100), UNCOMMITTED in working tree** | **User sign-off to deploy** |
| Phase 4b slice 3 (layer-decomposed accuracy backtest) | Substrate accumulating | ~2 weeks of corpus rows (next ~2026-06-16) |
| eBay C2 (live first-sale verification) | Production poller running healthy `ordersFetched=0` | First real prod eBay sale |
| eBay Finances Slice A/B/C (fee enrichment) | All parked | Same trigger (first real sale → C2 → Slice A/B/C cascade) |
| Phase 6 iOS reconciliation rendering | Backend done; iOS pending | Same trigger |
| Phase 6.5 iOS end-to-end product finalization | Pending | Drew Mac hands + first real sale |
| Phase 4a Workstream D (signal-driven cache invalidation) | Deferred; was 4b-gated, now slice-3-gated | Slice 3 verdict on Layer 1 value |
| Phase 4a Workstream E (pre-warm top-K) | Deferred | Slice 1's hit-rate measurement |
| Phase 4a iOS cache-staleness marker | Deferred | iOS surface readiness |

### PARKED (waiting on product decision)

| CF | Question | Surface |
|---|---|---|
| `CF-CARDSIGHT-TIMEOUT-ROOT-CAUSE-INVESTIGATION` | Why does Elly 20s timeout? Is 20s too short? | Parked from Elly fix |
| `CF-CARDSIGHT-CATALOG-COVERAGE-INVESTIGATION` | Is Cardsight catalog missing 2024 Topps Chrome late-release players (Acuña class)? | Acuña recon |
| `CF-FALLBACK-SOURCE-TAXONOMY` | Distinguish `cardsight-catalog-miss` (0 candidates) from `no-recent-comps` (candidates found, no sales)? | Acuña recon |
| `CF-TRENDIQ-FALLBACK-LAYER-1-ONLY` | Compute L1 in no-recent-comps path for in-roster players? | Acuña recon |
| `CF-CARDSIGHT-CATALOG-COVERAGE-GAPS-INVENTORY` | Catalog what's actually missing from Cardsight (sample 10 cards in unavailable bucket) | 66% unavailable recon |
| `CF-VARIANT-FILTER-TIER-LADDER-EXTENSION` | Add T4/T5 even-softer tiers? | 35% variant-mismatch within unavailable |
| `CF-PREDICTION-CORPUS-JOINABLE-DROP` | Drop unjoinable sentinel rows from corpus | Carry-forward from cleanup CFs |
| `CF-ORPHAN-PURGE-APPLY` | Delete justin-herbert + 8 resolvable slug orphans | Drew runs OR temp Contributor RBAC |
| `CF-PSA-CERT-RESOLUTION-PIPELINE` | Cert-at-scan → canonical holding metadata via PSA API | High-value iOS bug class |
| `CF-CATALOG-GAP-PRICING-HONESTY` | Surface low-confidence "approximate" instead of confident number | Trout WMB / John Gil class |

### NOT STARTED (future phases)

| Phase | Scope | Estimated start |
|---|---|---|
| **4c — ML training pipeline** | Build comp_logs → training-dataset pipeline; first AutoML experiment | Mid-July (gated on slice 3) |
| **4d — ML serving production traffic** | A/B harness, model endpoint, outcome tracking | Late July-Aug (gated on 4c data sufficiency) |
| **4e — ML moat realized** | 75%+ traffic, feedback loop closed | Aug-Sept (stretch target) |
| **5 full** | Aggregate portfolio valuation tracking, tax-strategy recs | Parallel with 4b-4d (current: only movement integration shipped) |
| **6.5 launch** | iOS end-to-end product readiness signature | Gated on 4b verification + iOS reconciliation + eBay live sale |

---

## 5. CURRENT BLOCKING GATES (the critical path)

```
                ┌─────────────────────────────────┐
                │ Betts fix sign-off + deploy     │
                │ (uncommitted, ready now)        │
                └────────────┬────────────────────┘
                             ▼
        ┌────────────────────────────────────────────┐
        │ Phase 4b slice 1 corpus matures ~2 weeks   │
        │ (started ~2026-06-02; ready ~2026-06-16)   │
        └────────────────────┬───────────────────────┘
                             ▼
        ┌────────────────────────────────────────────┐
        │ Phase 4b slice 3: layer-decomposed         │
        │ accuracy backtest                          │
        │ Decides: does playerMomentum earn its      │
        │  0.20-0.30 weight at horizon-matched       │
        │  outcomes?                                  │
        └──┬──────────────────────────────┬──────────┘
           │ YES                          │ NO
           ▼                              ▼
    ┌─────────────────┐         ┌────────────────────┐
    │ Slice 2: per-   │         │ Reweight L1 → 0.05 │
    │  source blob    │         │  OR retire signal  │
    │  freshness (RBAC│         │  pipeline entirely │
    │  needed)        │         │ Frees fn-* infra   │
    │ Slice 5: roster │         │ for ML investment  │
    │  broaden 10→100 │         └────────────────────┘
    │ Slice 4: cap +  │
    │  per-source     │
    │  fallback       │
    └─────────────────┘

Parallel critical path (eBay vertical):
        ┌────────────────────────────────────────────┐
        │ First real prod eBay sale fires            │
        │  ebay_poll_summary { ordersFetched > 0 }   │
        │ (Drew lists holding → real buyer → poll)   │
        └────────────────────┬───────────────────────┘
                             ▼
        ┌────────────────────────────────────────────┐
        │ EBAY-POLL-INGESTION-C2 (live verification) │
        │ → EBAY-FINANCES-SLICE-A (entitlement +     │
        │   sell.finances scope + first real Finances│
        │   response captured)                       │
        │ → SLICE-B (enrichment helper)              │
        │ → SLICE-C (scheduled 6h sweep)             │
        │ → Phase 6 iOS reconciliation rendering     │
        │ → Phase 6.5 launch signature               │
        └────────────────────────────────────────────┘

Parallel critical path (ML moat — mid-Sept target):
   4b slice 3 verdict → 4c training pipeline → 4d serving → 4e moat
   (Aug-Sept; stretch target; depends on data sufficiency at 4c gate)
```

---

## 6. NUMBERS THAT MATTER

| Metric | Value | Source |
|---|---|---|
| Backend tests | **1421 passed, 100 skipped, 0 regressions** | latest vitest run (with Betts fix uncommitted) |
| Aggregator player roster | **10 players** | `COMPIQ_TRACKED_PLAYERS` env var on fn-compiq |
| Backend `player_trends` roster | **75 player IDs** | Cosmos query |
| Prediction corpus (14d window) | **728 rows** | Cosmos query |
| Corpus split: main-pipeline | 22.3% (162 rows) | Cosmos query |
| Corpus split: sibling-pool | 3.7% (27 rows) | Cosmos query |
| Corpus split: unavailable | **66.3% (483 rows)** | Cosmos query |
| Sibling-pool null-predicted rate | **27/27 = 100%** (before Betts fix) | Cosmos query |
| Unavailable split: no-recent-comps | ~65% (compsUsed=0) | Cosmos query |
| Unavailable split: variant-mismatch | ~35% (compsUsed>0) | Cosmos query |
| Unavailable generated by /search | **45.1%** | Cosmos query |
| Unavailable generated by reprice job | 19.9% | Cosmos query |
| Production user count | 1 (admin-testing-hobbyiq, pre-launch) | Cosmos query |
| eBay poll cadence | 1h (tunable via env) | ebayOrderPoll.job |
| Cardsight cache TTLs | pricing 6h / catalog 6h / detail 24h / stale-serve 24h | cardsight.client |
| Deploy mode catalogue | **5 known modes**; mode (b) noisy-oracle fixed | scripts/deploy-with-build-info.ps1 |
| Last 4 deploy [2/5] timing | ~instant (vs ~634s pre-fix) | bf01029 + d850d51 + 28de709 + fe6ac26 |

---

## 7. WHAT TO TELL THE NEXT CLAUDE

If you're handing off, the load-bearing facts:

1. **Production lives at SHA `fe6ac26`** on HobbyIQ3 (Elly graceful-timeout fix). Verify via `GET https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/health` → `build.shaFromCodeShort`.

2. **The Betts fix is uncommitted in the working tree** (2 files, +153/-13 in `compiqEstimate.service.ts` + `compiqEstimate.siblingRescue.test.ts`). Tested + tsc-clean. Awaiting sign-off to commit + deploy.

3. **Phase 4b slice 1 substrate is live** (`28de709`). Corpus accumulating `trendIQ_composite`/`playerMomentum_multiplier`/`trendIQ_weights` rows + `[compiq.signal_fetch_observed]` log lines. Slice 3 decision target: ~2026-06-16 after 2 weeks of data.

4. **The aggregator roster is 10 players hard-coded in `COMPIQ_TRACKED_PLAYERS`** on fn-compiq. Broaden via env-var edit (slice 5 gated on slice 3 verdict).

5. **eBay vertical is parked** waiting on the first real prod sale to fire `ebay_poll_summary { ordersFetched > 0 }`. C1 poller verified healthy at `d019f0e`; everything downstream auto-cascades.

6. **fn-compiq emits telemetry to a SEPARATE App Insights workspace** (`fn-compiq` component, eastus-8, key `f7eebd2c-...`). Backend emits to `hobbyiq-insights` (centralus-2, key `02dca1c0-...`). Cross-workspace queries won't find fn-* traces.

7. **Canonical work happens in `C:/dev/hobbyiq-main` on `main`**. The OneDrive path `C:/Users/dvabu/OneDrive.../HobbyIQ-V1` is a SEPARATE checkout on `safety/v1-checkpoint-2026-05-19-late`. Claude Code's gitStatus snapshot reports from OneDrive — always confirm with `cd C:/dev/hobbyiq-main && git rev-parse --abbrev-ref HEAD`.

8. **Memory file persists across sessions** at `C:/Users/dvabu/.claude/projects/c--Users-dvabu-OneDrive---Just-the-Boys-and-Cards-LLC-Desktop-HobbyIQ-V1/memory/MEMORY.md`. Contains 6 load-bearing user/project/feedback entries — read first.

9. **Authoritative docs**:
   - `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md` — the roadmap with Phase 4b reframe locked
   - `docs/SESSION_HANDOFF.md` — chronological CF log (newest at line 46 area; getting long)
   - `docs/phase0/PROJECT_PLAN_2026-06-01.md` — 3-track plan: eBay / Phase 4a / accuracy validation
   - `docs/phase0/pillar_state_audit_2026-05-30.md` — 4-pillar feature inventory
   - `docs/phase0/cardsight_schema_truth.md` — empirical Cardsight schema reference
   - `docs/phase0/ARCHITECTURE_AND_STATUS_2026-06-02.md` — this file

10. **The biggest open product decision** is whether to invest in the Cardsight catalog gap workstream (66% of corpus rows have `fmvMechanism=unavailable`, mostly real obscure prospects + late-release products that Cardsight doesn't catalog yet) vs accept that as the upstream ceiling and put the effort into Phase 4c (ML training pipeline).
