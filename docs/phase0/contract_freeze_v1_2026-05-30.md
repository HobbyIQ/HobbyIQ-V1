# CF-CONTRACT-FREEZE-DESIGN — v1 backend contract spec (Rev 2)

**Date:** 2026-05-30 · **Rev 2** (incorporates review-round dispositions on field pruning, movement-history grade-tier, wire-rename anti-corruption layer, sync-pricing rationale)
**Type:** Spec / design doc — NO implementation this pass
**Canonical clone:** `C:/dev/hobbyiq-main`
**Audit basis:** [`pillar_state_audit_2026-05-30.md`](pillar_state_audit_2026-05-30.md) (commit `a703fda`)
**Gate locks at draft time:**
- W1 includes movement-history (trend charts v1 = yes)
- W2 reserves: granular eBay fee fields on ledger + sellNow recommendation shape
- Full P&L and Push v1 gate decisions pending; this freeze does NOT bind them — they're separate Phase A work (Finances enrichment + APN migration)

**Reading discipline:** every existing-shape claim cites file:line against actual code. Where the brief's pointers or remembered field names didn't match code, the canonical name comes from code and the brief's variant is flagged as drift.

**Freeze invariant:** v1 iOS rebuild binds to the shapes below. W2 extensions reserve fields named here so W2 can populate them without re-freezing. Any change to a v1-frozen field shape AFTER iOS rebuild requires a coordinated cross-repo ship — same discipline as the 2026-05-29 backend dual-accept drop that produced the P0 View Pricing 400 on Mac (CF-CARDHEDGE-DECOM-IOS in `2bd6e25`).

---

## 1. PortfolioHolding — canonical v1 shape

### 1.1 Current state (existing shape — for drift accounting)

`backend/src/types/portfolioiq.types.ts:1-147` declares **73 fields, 72 optional** on `interface PortfolioHolding` (the prior audit's "66" undercounted by ~7 trailing fields after the extended-comment cert/Cardsight FKs section). Only `id` is required. The schemaless `...rest` spread at `portfolioStore.service.ts:1227-1230` accepts any client-sent key, which is the structural enabler for the 14-shape drift.

Drift symptoms documented in code comments:
- `gradingCompany` vs `gradeCompany` parallel keys with `??` fallback at `portfolioStore.service.ts:442, :470`
- iOS-vs-canonical name drift documented in `shimmedX` helpers (`:358-388`): iOS `year` ↔ canonical `cardYear`; iOS `setName` ↔ canonical `product`; iOS `cardName` ↔ canonical `cardTitle`
- Schema-only-never-populated: `feesPaid`/`taxPaid`/`shippingPaid` (audit confirmed; ledger owns fees)
- Stale-derived-P&L bug class: pre-CF-PR-E-P&L-COST-RECOMPUTE entries persisted buggy `realizedProfitLoss` values; CF-PORTFOLIO-PL-BACKFILL exists specifically to backfill stale derived fields → the canonical example of why persisting derived values is the wrong pattern

### 1.2 Principle for the canonical v1 shape

**A holding stores facts; computed views are not stored.** Identity, grade, cost basis, photos, eBay linkage, cert, FKs, MLB resolution, user listing intent — these are facts the holding owns. Everything derived (P&L, current value, net estimated value, premium, quick-sale, recommendation labels, market characterization, deal score, etc.) comes off the holding and gets computed at response time, or served by the pricing layer.

**Concrete rationale for the cut:** persisting derived values is exactly what produced the stale-P&L bug (CF-PR-E-P&L-COST-RECOMPUTE / CF-PORTFOLIO-PL-BACKFILL). Pre-fix ledger entries carried stale buggy P&L because the derived value was stored and never re-derived after the formula corrected. Drop the entire derived class and that bug class cannot recur.

**Cached-derivable exceptions only with documented reason** — where compute-on-read is genuinely expensive AND staleness is tolerable. Each documented per field. The MINIMAL exception set is what dashboard-list rendering requires to avoid per-holding pricing-layer calls during a single dashboard render; everything beyond that minimum is computed on response.

### 1.3 Field disposition — all 73 fields with justification

**STORED FACTS (KEEP — 33 fields):**

| Field | Category | Justification |
|---|---|---|
| `id` | Identity | Cosmos partition / doc id (REQUIRED) |
| `playerName` | Identity | Fact: who's on the card (REQUIRED) |
| `cardTitle` | Identity | Display title fact (REQUIRED) |
| `cardYear` | Identity | Year fact (REQUIRED) |
| `product` | Identity | Set/release short form, canonical pricing axis (REQUIRED) |
| `parallel` | Identity | Parallel fact; `"Base"` explicit (REQUIRED) |
| `cardNumber` | Identity | Disambiguator |
| `serialNumber` | Identity | Print-run-stamped fact |
| `isAuto` | Identity | Auto fact (drives pricing tier) |
| `variation` | Identity | Free-form variation (relic/patch/signed differentiator) |
| `gradeCompany` | Grade | Grade issuer (REQUIRED — `"Raw"` explicit) |
| `gradeValue` | Grade | Grade value (REQUIRED when graded; null only when `gradeCompany==="Raw"`) |
| `quantity` | Acquisition | How many owned |
| `acquisitionCost` | Acquisition | Per-unit cost (renamed from `purchasePrice`; backend shim accepts both for transition) |
| `totalCostBasis` | Acquisition | Aggregate cost; may differ from `acquisitionCost × quantity` if rollup-fees are included pre-sale |
| `purchaseDate` | Acquisition | When acquired |
| `purchaseSource` | Acquisition | Where acquired (provenance) |
| `listingUrl` | Listing intent | User's listing URL (user-input fact, not derived) |
| `listingPrice` | Listing intent | User's listing price (user-input fact, not derived) |
| `lastUpdated` | Timestamp | When pricing was last computed for this holding |
| `notes` | User notes | User-provided notes |
| `photos[]` | Media | Azure Blob URLs; backend MUST validate via `parseBlobUrlOrThrow` on write |
| `clientId` | Identity | iOS-generated stable id for upsert-by-clientId (multi-tab) |
| `playerId` | MLB resolution | MLB numeric id |
| `playerIdConfidence` | MLB resolution | high/medium/low/ambiguous |
| `playerIdResolvedAt` | MLB resolution | When MLB resolution ran |
| `ebayOfferId` \| null | eBay linkage | Back-ref fact |
| `ebayListingId` \| null | eBay linkage | Back-ref fact |
| `ebayListingPublishedAt` \| null | eBay linkage | Back-ref fact |
| `certNumber` \| null | Cert (W4) | Cert string fact |
| `certGrader` | Cert (W4) | Grader id (PSA/BGS/SGC/CGC) |
| `cardsightCardId` \| null | Cardsight FK (R1) | Cardsight catalog UUID — load-bearing for movement-history join + corpus join |
| `cardsightGradeId` \| null | Cardsight FK (R2) | Cardsight grade taxonomy UUID |

**CACHED PIPELINE OUTPUTS (KEEP — minimal set for dashboard-list rendering — 10 fields per Phase B amendment 2026-05-31):**

| Field | Justification (compute cost + staleness tolerance + freshness signal) |
|---|---|
| `fairMarketValue` | **Compute cost:** Cardsight pricing call (~1-2s) + signal aggregator read; unacceptable per-holding during dashboard render. **Staleness tolerance:** value stays meaningful between reprice cycles; iOS displays via `lastUpdated` timestamp. **Freshness signal:** `lastUpdated` field on the holding. |
| `predictedPrice` \| null | **Compute cost:** ride-along with `fairMarketValue` pricing call + forwardProjection layer; same expense profile. **Staleness tolerance:** same as FMV. **Freshness signal:** `predictedPriceUpdatedAt`. |
| `predictedPriceLow` \| null | **Compute cost:** computed alongside `predictedPrice` (`fairMarketValue × forwardProjectionFactor × 0.92`); zero extra cost when `predictedPrice` is cached. **Staleness tolerance:** same. **Freshness signal:** `predictedPriceUpdatedAt`. |
| `predictedPriceHigh` \| null | Same as `predictedPriceLow`. |
| `predictedPriceUpdatedAt` \| null | Timestamp paired with prediction cache; staleness signal. |
| `movementDirection` \| null | **Compute cost:** signal aggregator fetch via fn-serve-signals (~200ms-1s); unacceptable per-holding during dashboard render. **Staleness tolerance:** signal aggregator runs every 2h; staleness up to that interval is product-tolerable. **Freshness signal:** `movementUpdatedAt`. |
| `movementUpdatedAt` \| null | Timestamp paired with movement cache; staleness signal. |
| `verdict` \| null | **Phase B amendment (2026-05-31) — promoted from REMOVE.** Actionable dashboard signal (the wire's plain-English Buy/Hold/Sell sentence). Computing on read would require re-running VerdictEngine (`backend/src/modules/compiq/services/verdict/VerdictEngine.ts:14`) which consumes `{dealScore, priceLanes, market, arbitrage, confidence, marketDNA}` — none of those except priceLanes is cached on the holding. Caching is cheaper than re-running computeEstimate per-row. **Staleness signal:** `lastUpdated`. |
| `recommendation` \| null | **Phase B amendment** — same engine origin as `verdict` (`result.action` per `compiqEstimate.service.ts:2780`). Promoted from REMOVE for the same reason. |
| `predictedPriceMechanism` \| null | **Phase B amendment** — honesty display + corpus stratifier (`"trendiq-projection" \| "multiplier-anchored" \| "unavailable"`). Recipe `predictedPrice === FMV ? "unavailable" : "trendiq-projection"` is lossy: it cannot distinguish the multiplier-anchored Mechanism-1 fallback path (Bowman family) from the success path. Keeping cached preserves fidelity to the methodology §2.2 mechanism enum. |

That's **10 cached fields** (FMV + 4 prediction + 2 movement + verdict + recommendation + predictedPriceMechanism). Total canonical shape: **33 stored facts + 10 cached pipeline outputs = 43 fields**, vs 73 today.

**DROPPED — secondary derived (compute at response time from cached + stored — 19 fields per Phase B amendment):**

Per Phase B amendment 2026-05-31: `verdict`, `recommendation`, `predictedPriceMechanism` PROMOTED from this REMOVE table into the cached set above (10 cached). The 7 β fields below stay REMOVED from `PortfolioHolding` but are sourced from the estimate response on **estimate-bearing card-detail endpoints only** (`POST /api/compiq/{estimate,price,price-by-id}`). They are **EXPLICITLY OMITTED from the portfolio wire** (`GET /api/portfolio`, `GET /api/portfolio/holdings`, `GET /api/portfolio/holdings/:id`). iOS list views render without; iOS detail views call the estimate endpoint to fetch β richness.

| Field | Why dropped | How replaced |
|---|---|---|
| `currentValue` | Secondary derivative: `fairMarketValue × quantity` | Compute at response assembly |
| `quickSaleValue` | Secondary: FMV × discount factor. **Phase B layer uses success-path multiplier 0.85** (per `PriceDistributionEngine.ts:5`); writer fallback 0.88 path produces stale-cache delta (CF-CURRENTVALUE-DIMENSION-CANONICALIZE unifies). | Compute at response assembly |
| `premiumValue` | Secondary: FMV × 1.15. **Phase B layer FLATTENS to normal-market 1.15** (writer fallback + estimate-success at marketSpeed="normal"); the estimate-success fast (1.25) / slow (1.10) speed bands are not reproducible at response assembly since `marketSpeed` is dropped under Gate-2 β. Flattening is the accepted consequence — losing the speed-conditional premium signal is acceptable per the Gate-2 β framing (advanced portfolio analytics deferred to W2). CF-CURRENTVALUE-DIMENSION-CANONICALIZE unifies. | Compute at response assembly + at VerdictEngine call site |
| `suggestedListPrice` | Secondary: FMV × 1.05 (writer fallback; estimate-success path coincides at `compiqEstimate.service.ts:2097`) | Compute at response assembly |
| `netEstimatedValue` | **Phase B finding:** declared on `PortfolioHolding` at L56 but NEVER POPULATED anywhere in the backend (grep verified). Today's wire value is always undefined. Recipe (likely `premiumValue - fees - tax - shipping`) ties to W2 eBay-finances (fee fields are themselves DROPPED below). | Layer OMITS the field; no faithful definition today; revisit in W2 eBay-finances |
| `totalProfitLoss` | **Secondary — THIS IS THE STALE-P&L BUG SOURCE** | Compute at response assembly from `fairMarketValue × quantity - totalCostBasis` |
| `totalProfitLossPct` | Same | Compute at response assembly |
| `compsUsed` | **β: detail-only.** Provenance for cached FMV; on `POST /api/compiq/*` response. | Estimate response only; OMITTED from portfolio wire |
| `movementComposite` | **β: detail-only.** Signal detail; on `POST /api/compiq/*` via `trendIQ.composite`. | Estimate response only; OMITTED from portfolio wire |
| `movementImpliedPct` | **β: detail-only.** Same via `trendIQ.impliedPct`. | Same |
| `movementCoverage` | **β: detail-only.** Same via `trendIQ.coverage`. | Same |
| `marketSpeed` | **Gate 2 = β LOCKED:** drop field AND both consumer paths AND shelve alert-generation reshape to W2. Two consumers were reading this: liquidity-risk alerts at `portfolioStore.service.ts:666-676`, AND portfolio-health concentration at `:698`. Neither is v1 surface — alerts are sell-now's family (W2 per §5.2); liquidity-concentration is advanced portfolio analytics, not core to the wedge. Drop the field + the alert-generation code + the concentration view code together; the alert/concentration features return as W2 work when the reshape ships. **Do NOT drop the field while leaving a v1 surface reading it broken** — but per β, no v1 surface reads it. | β: drop field + alert-generation code + concentration-view code; reshape deferred to W2 |
| `marketPressure` | Same Gate 2 = β: drop field + alert consumer code + concentration consumer code together. | Same |
| `confidence` | **β: detail-only.** Composite scalar; on `POST /api/compiq/*` via `confidence: { pricingConfidence, liquidityConfidence, timingConfidence }`. | Estimate response only; OMITTED from portfolio wire |
| `expectedDaysToSell` | **β: detail-only.** Pipeline output; on `POST /api/compiq/*` via `exitStrategy.expectedDaysToSell`. | Estimate response only; OMITTED from portfolio wire |
| `parallelDetected` | Pure derivative of `parallel`; never used per grep | Drop entirely |
| `explanationBullets` | **β: detail-only.** Pipeline output, large array, mostly UX text; on `POST /api/compiq/*` via `explanation`. | Estimate response only; OMITTED from portfolio wire |
| `freshnessStatus` | Pure label ("Live"/"Updated Today"/"Yesterday"/"Needs refresh") derivable from a success-only pricing timestamp. **Phase B status: CACHED PASS-THROUGH** (not yet computed at response assembly). An age-bucket compute-from-`lastUpdated` recipe was attempted and reverted: `lastUpdated` is bumped on reprice-FAILURE too (`portfolioStore.service.ts:2047-2056` stamps `lastUpdated: now` + `freshnessStatus: "Stale"` simultaneously), so an age-based recipe reads `"Live"` on holdings whose last reprice failed, losing the `"Stale"` signal. **Phase C scope:** identify a success-only timestamp (verify whether `predictedPriceUpdatedAt` / `movementUpdatedAt` qualify — both are set only on success-path estimate writes; add a dedicated `pricedAt` only if neither does), compute `freshnessStatus` from that at response assembly, drop the cached field. This is the root-cause fix for the false-"Live"-after-failed-reprice bug. | Phase B: cached pass-through. Phase C: compute from success-only timestamp at response assembly. |
| `trend` | Superseded by `movementDirection` (cached) | Replaced |

**DROPPED — duplicates / legacy / unused — 11 fields:**

| Field | Why dropped |
|---|---|
| `brand` | Duplicate of `product` on a user holding (`brand` stays in agent/curation tooling models — different code path; out-of-scope of this freeze) |
| `setName` | iOS-side legacy variant of `product`; iOS rebuild binds canonical `product` |
| `grade` | Duplicate of `gradeCompany` + `gradeValue` |
| `gradingCompany` | Use `gradeCompany` canonical |
| `feesPaid` | Schema-only-never-populated; per-sale fees live on `PortfolioLedgerEntry`, not on the holding |
| `taxPaid` | Same |
| `shippingPaid` | Same |
| `bowmanFirst` | Zero read sites per grep (`backend/src` search for `.bowmanFirst`); pure type cruft |
| `isPatch` | Single-use flag; subsumed by `variation` (free-form) — if iOS surfaces it explicitly, restore in W2 |
| `riskLevel` | Zero read sites per grep; pure type cruft |
| `statusCategory` | Single read site at `portfolioStore.service.ts:880` as fallback; consolidate to a single canonical `cardStatus` field at storage time (separate cleanup CF) |

**Final shape (Phase B amendment 2026-05-31): 43 fields** (33 stored + 10 cached) vs 73 today. **41% reduction.** 30 fields removed (19 secondary-derived + 11 duplicates/legacy below). "Into the 30s" of stored facts as Drew predicted; 10 cached exceptions each with stated compute-cost + staleness-tolerance + freshness-signal justification. The 7 β fields (`confidence`, `expectedDaysToSell`, `compsUsed`, `explanationBullets`, `movementComposite`, `movementImpliedPct`, `movementCoverage`) are sourced from the estimate response on estimate-bearing card-detail endpoints only and OMITTED from the portfolio wire.

### 1.4 Required vs optional — v1 canonical contract

**Required for any holding (8):**
- `id`, `playerName`, `cardTitle`, `cardYear`, `product`, `parallel` (default `"Base"`)
- `gradeCompany` (default `"Raw"`), `gradeValue` (null only when `gradeCompany==="Raw"`)

**Optional (32 — write any subset; readers tolerate absence):** the remaining stored facts + cached pipeline outputs

### 1.5 Validation discipline at the route boundary (NEW for v1)

- Zod schema for PortfolioHolding at `POST /api/portfolio/holdings`, `POST /api/portfolio/holdings/from-card`, `PATCH /api/portfolio/holdings/:id`
- Reject unknown keys with a warning header (NOT a 4xx during transition); after iOS rebuild + 1-week monitor, escalate to 4xx reject
- Validate every `photos[]` entry via `parseBlobUrlOrThrow` (`photoStorage.service.ts:127`)
- Response-time computation: dropped fields compute fresh at every response — no caching of secondary derivatives anywhere in the response pipeline
- **Phase B (2026-05-31) — anti-corruption wire layer BUILT** at [`backend/src/services/portfolioiq/responseAssembly.ts`](../../backend/src/services/portfolioiq/responseAssembly.ts) (`composeHoldingWireShape` / `composePortfolioListResponse`). All 3 portfolio wire paths route through it — explicit field-mapping, no holding-object spread. Phase C (writer stops) and Phase D (type deletion) cannot silently drop a wire field; the contract test at [`backend/tests/portfolioWireShape.contract.test.ts`](../../backend/tests/portfolioWireShape.contract.test.ts) locks both presence-on-portfolio-wire (cached-10 + CHEAP-7) and absence-on-portfolio-wire (the 7 β fields). Card-detail (`POST /api/compiq/*`) is already explicit-mapped at `compiqEstimate.service.ts:2777-2854` and was NOT reworked; gap: success-path response does NOT carry `suggestedListPrice` (only the sibling-pool fallback at L2131 does) — pre-existing, surface in W2 card-detail polish, NOT a Phase B regression.

### 1.6 Backfill posture

Existing 23 production holdings carry old field set. After iOS rebuild ships:
- Read shim returns canonical shape (computed-on-read for the dropped fields; cached pipeline outputs migrate as-is)
- Write shim accepts both old + new shapes during a 1-week transition
- `CF-PORTFOLIO-METADATA-BACKFILL` then runs to canonicalize stored docs; rewrites holdings to the 40-field canonical shape, drops the 22 secondary-derived + 11 duplicate fields from storage

### 1.7 Residual debt (NOT contract-blocking; debt sweep CF)

- Local variable `cardHedgeGrade` in `compiqEstimate.service.ts` (10 hits) — code-smell only; rename to `requestedGrade` in CF-PHASE-A-DEBT-SWEEP. NOT a wire-contract field.

---

## 2. CompIQ card-detail shape — what the standalone card screen consumes

### 2.1 Current state

The "standalone CompIQ card screen" is served by `POST /api/compiq/estimate` and `POST /api/compiq/price`. Declared type at `compiq.types.ts:29-58` (`CompIQEstimateResponse`) describes a SUBSET of what the route actually returns. The full response constructed at `compiq.routes.ts:660-698` (the `/price` handler — same shape pattern as `/price-by-id` at `:903` and `/estimate` via service) merges typed fields with dynamic adds.

Two structural drifts in current response:
1. **`confidence` naming collision** — typed `{pricingConfidence, liquidityConfidence, timingConfidence}` overwritten by dynamic-add composite number `confidence: finalConfidence`. Same key, different shape, dynamic spread wins. Brittle.
2. **`trendAnalysis` snake_case** keys (`market_direction`, `change_from_older_to_recent`) inconsistent with camelCase elsewhere.

### 2.2 Canonical v1 shape — frozen

`POST /api/compiq/estimate` and `POST /api/compiq/price` (and the candidate-detail enrichment in `/cardsearch`) return one canonical shape:

```typescript
interface CompIQCardDetail {
  // Identity
  cardTitle: string;
  cardIdentity: CardIdentity | null;
  parsedQuery: ParsedQuery;
  searchQuery: string;
  gradeUsed: string | null;

  // Valuation
  fairMarketValue: number;
  quickSaleValue: number;
  premiumValue: number;
  suggestedListPrice: number | null;

  // Comps
  recentComps: CardsightSaleRecord[];
  compsUsed: number;
  compsAvailable: number;
  daysSinceNewestComp: number | null;
  neighborSynthesis: object | null;
  crossParallelAnchor: object | null;

  // Movement signal (replaces snake_case trendAnalysis)
  movement: {
    direction: "rising" | "falling" | "stable";
    impliedPct: number;                         // formerly trendAnalysis.change_from_older_to_recent
    composite: number;                          // formerly trendIQ.composite
    coverage: "full" | "card_only" | "no_segment" | "insufficient";
    components: {
      playerMomentum: number | null;
      cardTrajectory: number | null;
      segmentTrajectory: number | null;
    };
    signalsLastUpdated: string | null;          // ISO 8601
  };

  // Prediction + confidence (resolves the naming collision)
  prediction: {
    predictedPrice: number | null;
    predictedPriceRange: { low: number; high: number } | null;
    mechanism: "trendiq-projection" | "multiplier-anchored" | "unavailable";
    forwardProjectionFactor: number;
    confidence: {
      pricing: number;                          // 0..100 (formerly pricingConfidence)
      liquidity: number;                        //         (formerly liquidityConfidence)
      timing: number;                           //         (formerly timingConfidence)
      composite: number;                        // 0..100 single roll-up for at-glance display
    };
  };

  // Verdict + recommendation
  verdict: string;
  action: "Buy" | "Hold" | "Sell" | "Pass";
  dealScore: number;
  recommendation: string;
  explanation: string[];

  // Market structure
  marketDNA: {
    demand: "High" | "Medium" | "Low";
    speed: "Fast" | "Normal" | "Slow";
    risk: "Low" | "Medium" | "High";
    trend: "Up" | "Flat" | "Down";
  };
  exitStrategy: {
    recommendedMethod: "auction" | "bin";
    expectedDaysToSell: number | null;
    timingRecommendation: string;
  };

  // Freshness
  freshness: {
    status: "Live" | "Updated today" | "Yesterday" | "Needs refresh";
    lastUpdated: string | null;
  };

  // Diagnostic
  variantWarning: string | null;
  source: string;
  supply: null;
  buySignal: null;
}
```

### 2.3 Rename scope — wire-only with single anti-corruption layer

**Verified via grep:** `trendAnalysis` has zero readers anywhere in `backend/src` or `mcp-server`; only producer sites (12 in `compiq.routes.ts`). `pricingConfidence`/`liquidityConfidence`/`timingConfidence` is the internal `Confidence` type at `modules/compiq/models/pricing.types.ts:75-77`, consumed by `PricingPipeline.ts:458, 460-461, 471, 521` (dealScore / dealEdge / ROI) and `ExplanationEngine.ts:25-26`. **Renaming the internal type breaks 4 internal files for zero functional gain.**

**Scope: wire-only rename.** Internal `Confidence` (`pricingConfidence`/etc) stays UNCHANGED in `modules/compiq/`. Rename happens at the wire-emission seam.

**ANTI-CORRUPTION LAYER — single mapping function (NEW for v1):**

Create `backend/src/services/compiq/responseAssembly.ts`:

```typescript
// Single seam where internal pipeline shape → wire shape mapping happens.
// All response constructors in compiq.routes.ts call this; no inline construction.
// Prevents shape drift across the (currently 7+) producer sites and contains
// any future wire shape change to one file.

export function composeCardDetailResponse(args: {
  estimate: EstimateResult;                     // internal shape from compiqEstimate.service
  parsed: ParsedQuery;
  searchQuery: string;
  // … other inputs
}): CompIQCardDetail {
  // Map internal { pricingConfidence, liquidityConfidence, timingConfidence }
  // → wire prediction.confidence { pricing, liquidity, timing, composite }
  // Map internal trendIQ + trendAnalysis → wire movement
  // Compute composite confidence scalar from the three component confidences
  // Return one canonical CompIQCardDetail object
}
```

All 7 producer sites in `compiq.routes.ts` (currently constructing the response inline at `:369-371`, `:488-490`, `:585-587`, `:665-667`, `:790-792`, `:846-848`, `:996-998` plus the short-circuit branches) replace inline construction with a single call to `composeCardDetailResponse(...)`. Future shape changes touch ONE file; consumers downstream of the wire layer can't see the internal pipeline shape; drift between producer sites becomes impossible.

**Frozen contract guarantees:**
- `prediction.predictedPrice` null when prediction unavailable; iOS MUST render `fairMarketValue` in that case
- `movement.signalsLastUpdated` null when no signal data — iOS MUST hide movement indicator
- `recentComps[]` may be empty; not an error
- `cardIdentity` null when not resolved; iOS renders from `parsedQuery`
- Single canonical response across all 4 read endpoints (`/estimate`, `/price`, `/price-by-id`, candidate-detail in `/cardsearch`) — locked via single anti-corruption layer

---

## 3. CompIQ card → create-holding handoff

### 3.1 Current state

**Absent.** Audit confirmed via `Grep "createHoldingFromCard|addFromCard|addCardToInventory|cardId.*holding|holding.*from.*card"` → 0 matches across `backend/src`.

### 3.2 Canonical v1 shape — spec'd (NEW endpoint to build)

**Endpoint:** `POST /api/portfolio/holdings/from-card`

**Request body:**
```typescript
interface CreateHoldingFromCardRequest {
  // Identity from the CompIQ card screen (required)
  cardsightCardId: string;                      // R1 FK — required for this path
  cardTitle: string;
  playerName: string;
  cardYear: number;
  product: string;
  parallel: string | "Base";

  // Grade — choose ONE of these three discriminated shapes
  grade:
    | { mode: "raw" }
    | { mode: "graded";
        gradeCompany: "PSA" | "BGS" | "SGC" | "CGC" | string;
        gradeValue: number;                     // half-grades allowed (BGS)
        cardsightGradeId?: string;
      }
    | { mode: "cert";
        certNumber: string;
        certGrader: "PSA" | "BGS" | "SGC" | "CGC" | string;
        gradeCompany: string;                   // populated from cert lookup
        gradeValue: number;
        cardsightGradeId?: string;
      };

  // Acquisition (optional)
  acquisitionCost?: number;                     // canonical name (renamed from purchasePrice)
  purchaseDate?: string;                        // ISO 8601 or epoch ms
  purchaseSource?: string;
  quantity?: number;                            // default 1

  // Photos (optional — backend validates each via parseBlobUrlOrThrow)
  photos?: string[];

  // Optional metadata
  serialNumber?: string;
  isAuto?: boolean;
  variation?: string;
  notes?: string;
  clientId?: string;
}
```

**Response (201):**
```typescript
interface CreateHoldingFromCardResponse {
  message: "Holding saved";
  id: string;
  holding: PortfolioHolding;                    // canonical shape per §1.4 — auto-priced + cache populated
  pricing: CompIQCardDetail;                    // full shape per §2.2 — pinned to this holding's gradeUsed
}
```

### 3.3 Decision rationale — sync auto-price-before-return (not accidental)

**Sync re-price IS the v1 choice.** Three reasons make it deliberate:

1. **Trust boundary** — never trust a client-supplied price field for storage. User could send a 99x discount; client may have stale price from a cached estimate. Storage-of-record must be backend-computed.

2. **Race avoidance** — today's `addHolding` (`portfolioStore.service.ts:1255-1259`) fires `autoPriceHolding` async; a client that GETs the holding immediately after POST sees pre-pricing state. Sync closes the race window deterministically.

3. **Corpus-write requirement (LOAD-BEARING)** — the prediction corpus (per [`prediction_credibility_methodology_2026-05-30.md`](prediction_credibility_methodology_2026-05-30.md)) requires server-computed predictions with full signal provenance to be useful. A client-supplied price would either skip the corpus entirely OR write a provenance-less row, both of which break the corpus's value as a measurement substrate. Sync re-price ensures every from-card-add produces a corpus row with complete provenance.

**Trade-offs honestly carried:**
- Adds ~1-2s to one-tap add (Cardsight estimate latency)
- Eats one Cardsight rate-limit slot (~8 req/s ceiling; one-tap-add at scale could trip — launch-tier concern, not v1)
- iOS shows a spinner during the call

**Cached-estimate optimization explicitly deferred** — would require client-cache-key threading for a latency problem we don't have at single-user pre-launch state. Reserved for launch-tier scale work if rate-limit becomes binding.

### 3.4 Critical guarantees the endpoint MUST enforce

- `cardsightCardId` REQUIRED (path is "from-card" — caller has a card)
- Backend computes `acquisitionCost` ← `acquisitionCost ?? purchasePrice ?? 0` (compat shim during rename window)
- `gradeCompany` and `gradeValue` populated synchronously by response time (cert-lookup runs SYNC for this endpoint, not async)
- `populateCardsightGradeId` SYNCHRONOUSLY resolves `cardsightGradeId` from `(gradeCompany, gradeValue, isAuto)` if not already present
- `autoPriceHolding` runs SYNCHRONOUSLY before response — `holding.fairMarketValue`, cached `predictedPrice`, cached `movementDirection` all populated in returned body
- `pricing` field returns the full CompIQ card-detail shape for the just-priced holding — saves iOS a round-trip to refresh the card screen
- Corpus write fires (fire-and-forget) within the sync path so the new holding's first prediction is captured

**Error responses:**
- 400 — missing `cardsightCardId` or missing required grade fields per chosen mode
- 400 — invalid `photos[]` URL (cross-account / malformed)
- 401 — missing auth
- 502 — Cardsight upstream error during sync auto-price (returns the holding saved + pricing null + warning header; corpus write skipped with `mechanism: "unavailable"`)
- 502 — Cosmos write failure

**Wire-contract sequencing rule for this endpoint:** any future change to the request shape must ship iOS-FIRST or coordinated. Backend-additive (new optional fields) can ship backend-first.

---

## 4. Movement-history — v1 shape

### 4.1 Current state

`trend_history` Cosmos container exists and is actively written. Writer: `writeTrendSnapshot` at `playerScore/trendHistory.service.ts:92-142` (fire-and-forget, 60-min rate-limit per cardId). Document shape per `types/playerScore.ts:136-161` partitioned by `/cardId`. Two readers exist:
- `getRecentSnapshotsByPlayer(playerName, windowDays=7)` at `:151-178` — **wired**, called by `playerScore.service.ts:894, :920` (computeMarketScore aggregation)
- `getRecentSnapshotsByCardId(cardId, windowDays=30)` at `:184-212` — **declared but ZERO callers** in backend/src (audit confirmed)

Infrastructure is 50% live: writer + player-aggregation reader exist; per-card-history endpoint doesn't.

### 4.2 Canonical v1 shape — spec'd (NEW endpoint to build)

**Endpoint:** `GET /api/portfolio/holdings/:holdingId/movement-history?windowDays=30`

**Backend flow:**
1. Resolve `holdingId` → `PortfolioHolding`
2. If `holding.cardsightCardId` null → return `{ snapshots: [], reason: "no_cardsight_card_id" }` (200, not 4xx)
3. Call `getRecentSnapshotsByCardId(holding.cardsightCardId, windowDays)` (already implemented)
4. Project snapshots into the response shape below

**Response (200):**
```typescript
interface MovementHistoryResponse {
  holdingId: string;
  cardsightCardId: string | null;
  windowDays: number;
  gradeTierAggregated: true;                    // ALWAYS true in v1 — see §4.3 honesty
  snapshots: Array<{
    timestamp: string;                          // ISO 8601 (asc-sorted)
    fairMarketValue: number | null;
    impliedTrendPct: number;
    direction: "up" | "down" | "flat";
    basedOn: "exact" | "broader" | "insufficient";
    recentMedian: number | null;
    olderMedian: number | null;
    sampleCount: number;                        // = recentCount + olderCount
  }>;
  reason?: "no_cardsight_card_id" | "no_history_yet" | "cosmos_unavailable";
}
```

### 4.3 Grade-tier honesty — the explicit decision

The `trend_history` writer indexes by `cardId` ONLY, not by `(cardId, gradeCompany, gradeValue)`. So a held PSA 9 and a held PSA 10 of the same card render the SAME movement chart. **This is a coarse signal for the serious-collector user.**

**Honest framing:** the stated user is the serious collector, and serious collectors skew toward exactly the high-grade hot-rookie cards where grade-tier divergence is largest. PSA 10 / PSA 9 trajectory divergence on hot cards can be ~2x in magnitude — meaningful information loss for the core user.

**v1 disposition: (A) card-level history with explicit labeling.**
- Backend returns `gradeTierAggregated: true` in every response (always; never false in v1)
- iOS rebuild MUST render this as "Card movement (all grades, last 30d)" — NOT as "Your PSA 10's movement chart"
- The aggregation flag is the load-bearing visual disclaimer that defends against the misleading-chart failure mode

**`CF-MOVEMENT-HISTORY-GRADE-TIER` is HIGH-PRIORITY W2** — promoted to TOP of W2 backlog (not bottom). The upgrade rebuilds `trend_history` writer to index by `(cardId, gradeCompany, gradeValue)`, switches reader signature, accepts thin-history start during transition. Sized at L per the audit. This is reserved EXPLICITLY because the core user is the one most affected by the v1 coarseness, not a minority.

### 4.4 iOS rendering contract

- Empty `snapshots[]` with `reason: "no_cardsight_card_id"` → render "Add this card to history by re-resolving via Cardsight" or hide chart
- Empty `snapshots[]` with `reason: "no_history_yet"` → render "Movement history will appear after a few price refreshes"
- Empty `snapshots[]` with `reason: "cosmos_unavailable"` → render "Movement history temporarily unavailable" (retry)
- Populated `snapshots[]` → render time-series chart of `fairMarketValue` with direction-colored markers
- `gradeTierAggregated: true` → MUST surface "all grades" disclaimer label on chart (load-bearing for honesty)

**v1 trade-offs carried:**
- Per-card history shared across users — correct (market-wide signal), no PII concern
- Grade-tier aggregation per §4.3 — disclosed via flag + label
- 60min writer rate-limit → high-traffic cards get one snapshot/hour MAX, sparse for low-traffic cards; iOS UX shows asof timestamp prominently

**Reuse vs build sizing:** **M (2-8h)** per audit — writer + per-player reader exist; this CF builds the per-holding endpoint that calls existing `getRecentSnapshotsByCardId` + response projection + `gradeTierAggregated: true` constant. Does NOT include the W2 grade-tier upgrade.

---

## 5. RESERVED — W2 shapes (define now, do NOT build)

### 5.1 Granular eBay fee fields + netPayout on the ledger entry

**Current state:** schema already exists at `portfolioStore.service.ts:228-238` (`PortfolioLedgerEntry`). Every eBay-sourced entry hardcodes these to `null` at `ebayWebhook.routes.ts:286-294`. Audit SURPRISES #1 documented this as the LARGEST backend gap. P&L formula `computeLedgerFinancials` ALREADY honors these fields when populated — no formula change in W2.

**Reserved v1 contract:**
- Schema fields stay AS-IS at `portfolioStore.service.ts:228-238`
- `needsReconciliation` (always `true` for eBay path today) is the consumer's signal — iOS MUST tolerate `null` on every fee field, MUST display realized P&L with explicit "gross-of-fees" framing when `needsReconciliation === true`
- PATCH whitelist (`:1026-1031`) — W2 extends to allow user-side fee correction; wire shape unchanged, only writability changes

**W2 work (separate CFs, NOT this freeze):**
- `CF-EBAY-FINANCES-ENRICHMENT` (L) — Finances API service backfills fee fields on scheduled reconcile; clears `needsReconciliation` when complete
- `CF-LEDGER-PATCH-WHITELIST-EXTEND` (S) — Add fee fields + dismissedAt/Reason to PATCH whitelist

### 5.2 Sell-now recommendation shape

**Current state:** absent. Generic `recommendation: string` on holding (now also being computed-on-read per §1.3, not stored) is a verdict label, not a timed action.

**Reserved v1 contract — NEW field on the CompIQCardDetail response (NOT on PortfolioHolding — sell-now is computed at request time):**

```typescript
// In CompIQCardDetail (§2.2), reserved for W2 — populated by CF-SELL-NOW-RECOMMENDATION
sellNowRecommendation?: {
  action: "sell_now" | "hold" | "list_now" | "wait";
  confidence: number;                           // 0..100
  windowDays: number;                           // recommended action window
  reason: string;
  signals: Array<{
    name: string;                               // e.g. "compsMomentum_rising"
    weight: number;                             // 0..1
  }>;
  computedAt: string;                           // ISO 8601
} | null;
```

**Frozen contract guarantees for v1:**
- Field OPTIONAL on `CompIQCardDetail` (additive)
- iOS rebuild MUST tolerate absence — falls back to generic verdict
- W2 builds cascade-tier-aware sell-now per [[information_cascade_signal_model]]; shape above locked
- Surface decision (whether iOS renders it visibly in v1 placeholder or hides until W2) is product-side; SHAPE is reserved either way

---

## 6. Honest framings carried in this spec

1. **The dual-mounted route prefixes** (`/api/portfolio` AND `/api/portfolioiq`; `/api/dailyiq` + variants) — out of contract-freeze scope; iOS rebuild picks ONE prefix per pillar; consolidation is post-rebuild CF.

2. **`dailyiq.routes.ts` vs `dailyiq.ts` dead-code** — out of scope; `CF-PHASE-A-DEBT-SWEEP` handles.

3. **DailyIQ dual-writer schema drift on `dailyiq_briefs`** (audit SURPRISES #2) — out of scope; `CF-DAILYIQ-WRITER-COLLISION` diagnose-then-fix handles.

4. **Two-watchlist-system disconnect** — explicitly OUT per audit; product decision required.

5. **Platform observability gap (~30 min retention across BOTH `hobbyiq-insights` and `fn-compiq` AI instances)** — separate CF renamed `CF-PLATFORM-OBSERVABILITY-RETENTION` and elevated to **PUBLIC-LAUNCH GATE** per [`prediction_credibility_methodology_2026-05-30.md`](prediction_credibility_methodology_2026-05-30.md) §1.3. Rationale: shipping a product handling portfolio + tax data while blind to anything older than 30 min means you cannot debug a real incident. Closes before public launch, not before scale-up. Unaffected by wire contract; runs as independent infra workstream.

6. **What this freeze does NOT touch:** fields on existing schemas not named here keep their current shape implicitly.

7. **Sequencing rule (load-bearing):** subtractive cross-repo field-shape changes require iOS-FIRST or coordinated ship; additive can go backend-first. Lesson from `2d05db6 → 2bd6e25`.

8. **Field-pruning principle (load-bearing):** stored facts vs computed views. The stale-P&L bug is the concrete reason. Persisting derived values is the failure mode; computing at response time from cached pipeline outputs + stored facts is the remediation. ALERT GENERATION moves to estimate-completion event so it doesn't require from-holding-read of `marketSpeed`/`marketPressure`.

9. **Wire-only rename scope:** internal `Confidence` shape stays whole; mapping happens at one anti-corruption layer in `services/compiq/responseAssembly.ts`.

---

## 7. Implementation CFs derived from this spec (NOT done here)

Each becomes its own CF after sign-off. Sized per audit and the principles above:

| CF | Phase A step | Estimate | Notes |
|---|---|---|---|
| `CF-PORTFOLIOHOLDING-VALIDATION-ADD` | step 3 | M (2-8h) | Zod schema + photos URL validation + warning-then-reject migration |
| `CF-PORTFOLIOHOLDING-FIELD-PRUNE` | step 3 | **L (>8h)** | 73 → 40 fields per §1.3 disposition table; **Gate 2 = β**: drop `marketSpeed`/`marketPressure` AND both their consumer paths (liquidity-risk alerts + portfolio-health concentration) together; alert-generation reshape DEFERRED to W2 (not bundled with v1 prune). Response-assembly computes other dropped derivatives at request time. CF-PORTFOLIO-METADATA-BACKFILL follows. |
| `CF-PURCHASEPRICE-TO-ACQUISITIONCOST-RENAME` | step 3 | S (<2h) | Shim both names on write, return canonical on read |
| `CF-GRADINGCOMPANY-COLLAPSE` | step 3 | S (<2h) | Converge writes to `gradeCompany` |
| `CF-CREATE-HOLDING-FROM-CARD` | step 3 | M (2-8h) | New endpoint per §3.2 + sync auto-price + corpus write fire-and-forget |
| `CF-MOVEMENT-HISTORY-ENDPOINT` | step 3 / W1 | M (2-8h) | New endpoint per §4.2 with `gradeTierAggregated: true` constant; reuses existing reader |
| `CF-COMPIQ-CARD-DETAIL-RESHAPE` | step 3 | M (2-8h) | Create `responseAssembly.ts` anti-corruption layer; rename 7 producer sites to call it; resolve `confidence` collision; `trendAnalysis` → `movement` |
| `CF-EBAY-FINANCES-ENRICHMENT` | step 4 | **L (>8h)** | W2-reserved per §5.1; gates Full P&L gate decision |
| `CF-LEDGER-PATCH-WHITELIST-EXTEND` | step 4 | S (<2h) | W2-reserved companion |
| `CF-MOVEMENT-HISTORY-GRADE-TIER` | **W2 TOP-PRIORITY** | L (>8h) | Per §4.3 — promoted to top of W2 backlog (core user is most affected); rebuild trend_history writer to (cardId, gradeCompany, gradeValue) index |
| `CF-SELL-NOW-RECOMMENDATION` | W2 | L (>8h) | W2-reserved per §5.2 |
| `CF-PORTFOLIO-METADATA-BACKFILL` | post-iOS-rebuild | M (2-8h) | Once iOS sends canonical names, backfill 23+ legacy holdings to 40-field canonical shape |
| `CF-IOS-FIELD-CONTRACT-FIX` | iOS-side / coordinated | iOS scope | Mac-side rebuild sends canonical names |
| `CF-ALERT-GENERATION-RESHAPE` | **W2** (deferred per Gate 2 = β) | M (2-8h) | Originally proposed as Phase A sub-task; **deferred to W2 alongside the alert + concentration feature surfaces themselves**. v1 ships without liquidity-risk alerts and without portfolio-health concentration view. W2 work: ship the features (sell-now family + advanced portfolio analytics) AND reshape alert generation to fire at estimate-completion event (not from-holding-read pull). |

---

## 8. Files read (for spec basis)

- `backend/src/types/portfolioiq.types.ts` — PortfolioHolding (73 fields actually; "66" prior audit undercount)
- `backend/src/types/compiq.types.ts` — CompIQEstimateRequest/Response (typed subset)
- `backend/src/types/cardIdentity.ts` — CardIdentity
- `backend/src/types/playerScore.ts` — TrendSnapshot
- `backend/src/services/compiq/forwardProjection.ts` — PredictedPriceResult
- `backend/src/services/playerScore/trendHistory.service.ts` — trend_history writer + readers
- `backend/src/services/portfolioiq/portfolioStore.service.ts` — addHolding (L1222-1285), PortfolioLedgerEntry (L199-256), shimmedX (L358-388), liquidity-risk alert generation (L666-676), portfolio health concentration (L698)
- `backend/src/routes/compiq.routes.ts` — response assembly (L660-698 sampled; 7 producer sites)
- `backend/src/routes/portfolioiq.routes.ts` — /identify route (L109+)
- `backend/src/routes/ebayWebhook.routes.ts` — fee-field null hardcoding (L286-294)
- `backend/src/services/compiq/compiqEstimate.service.ts` — prediction event emission (L2700-2740)
- `backend/src/modules/compiq/services/verdict/VerdictEngine.ts` — premiumValue usage
- `backend/src/modules/compiq/services/verdict/ExplanationEngine.ts` — pricingConfidence usage
- `backend/src/modules/compiq/services/pricing/core/PricingPipeline.ts` — pricingConfidence/timingConfidence usage

Audit reference: [`pillar_state_audit_2026-05-30.md`](pillar_state_audit_2026-05-30.md).
Methodology reference: [`prediction_credibility_methodology_2026-05-30.md`](prediction_credibility_methodology_2026-05-30.md) — sync-pricing rationale §3.3 ties to corpus-write requirement.

---

## 9. Scope discipline upheld

- ✅ Read + document only — NO implementation
- ✅ Every existing-shape claim cites file:line against actual code (corrected: type has 73 fields, not the 66 in prior audit)
- ✅ Field-pruning principle stated load-bearing: stored facts vs computed views; concrete bug rationale (stale-P&L)
- ✅ Cached-derivable exceptions documented per field with compute-cost + staleness-tolerance + freshness-signal
- ✅ Grep validated for ambiguous fields (premiumValue / bowmanFirst / riskLevel / freshnessStatus / marketSpeed-marketPressure dependencies)
- ✅ Wire-only rename scope explicit; single anti-corruption layer at `responseAssembly.ts` prevents drift across 7 producer sites
- ✅ Sync-pricing decision rationale carries the corpus-write requirement as load-bearing
- ✅ Movement-history (A) decision with honest "core user is the one most affected" framing; W2 promotion to TOP, not bottom
- ✅ W2 shapes RESERVED, not implemented
- ✅ Honest framings carried (gate-dependent items, sequencing rules, out-of-scope items, debt sweep separate CF)
- ✅ HALT for review — no commit without sign-off
