// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase D1 (2026-05-31): 28 deprecated
// fields removed from this type. The canonical v1 shape (contract
// freeze §1.3, Phase B amendment) is 33 stored facts + 10 cached
// pipeline outputs. Two BLOCKED legacy fields stay: `setName` and
// `gradingCompany` — both held by CF-AUTOPRICE-FIELD-NAME-SHIM's
// typed-fallback reads in portfolioStore.service.ts and retire when
// that shim CF lands the iOS canonical-write + Cosmos backfill.
//
// Storage-removable D2 follow-ups (not in D1): wire-shape trims of
// the 7 computed CHEAP fields (gated on iOS repoint), legacy-fallback
// drops (gated on production probes Q1/Q2/Q3), Zod 4xx escalation
// (gated on 1-week strip-and-warn monitor). `purchasePrice` ->
// `acquisitionCost` rename is its own CF.
// CF-HELD-EXPENSES (2026-07-12) — expenses accrued on a card WHILE it's
// still in inventory. Distinct from purchasePrice (paid at acquisition) and
// from the sale-side gradingCost/suppliesCost on ledger entries (captured
// at sale time). Each write appends here + adds to holding.totalCostBasis
// so realized-P&L math on the eventual sale reflects the full-cost basis.
export type HeldExpenseKind =
  | "grading"          // sent to PSA/BGS/SGC/CGC
  | "supplies"         // sleeves, top loaders, cases
  | "shipping_to_grader"
  | "insurance"
  | "storage"
  | "other";

export interface HoldingHeldExpense {
  id: string;
  kind: HeldExpenseKind;
  amount: number;             // dollars, positive
  incurredAt: string;         // ISO — WHEN the expense was paid
  createdAt: string;          // when we recorded it
  notes?: string;
  /** Optional external receipt/invoice ref. */
  invoiceRef?: string;
}

export interface PortfolioHolding {
  id: string;
  playerName?: string;
  cardTitle?: string;
  cardYear?: number;
  setName?: string;
  cardNumber?: string;
  product?: string;
  parallel?: string;
  serialNumber?: string;
  isAuto?: boolean;
  variation?: string;
  gradingCompany?: string;
  gradeCompany?: string;
  gradeValue?: number;
  quantity?: number;
  purchasePrice?: number;
  totalCostBasis?: number;
  /**
   * CF-AUTOPRICE-GRADE-LADDER-FALLBACK (2026-06-28): persist the grade-
   * ladder anchor snapshot when autoPriceHolding fell back to it (engine
   * couldn't anchor a real FMV). Surfaces on read-back so iOS can render
   * "Last sold: PSA 9 $1325 · 236 days ago" alongside the estimated value.
   */
  nearestGradedAnchor?: {
    grade: string;
    price: number;
    daysOld: number;
    sampleSize: number;
    confidence: number;
  };
  /**
   * CF-GRADER-STATUS-FIELD (2026-06-28): first-class state for cards that
   * are physically out of the user's hands but still owned. Distinct from
   * the existing `status` field (which iOS uses for inventory bucketing).
   *
   *   "available"          — in hand, ready to sell/hold/list
   *   "at_psa"             — sent for grading, still owned, awaiting return
   *   "pending_redemption" — Topps/Bowman redemption card pending fulfillment
   *   "in_route"           — bought online, in transit to user
   *
   * iOS renders a badge on the inventory row when graderStatus !== "available".
   * Filter views (Available / At PSA / Pending Redemption) read this field.
   * Future autopricing can derate confidence on cards in transit (the user
   * can't react to market moves on a card they don't physically hold).
   *
   * Absent / "available" → behavior unchanged from pre-CF.
   */
  graderStatus?: "available" | "at_psa" | "pending_redemption" | "in_route";
  purchaseDate?: string | number;
  purchaseSource?: string;
  // CF-HELD-EXPENSES (2026-07-12): expenses accrued while holding the card
  // (grading, supplies, storage). Each write also increments totalCostBasis
  // so realized-P&L math on the eventual sale reflects true all-in cost.
  // Managed through POST/DELETE /api/portfolio/holdings/:id/expenses.
  heldExpenses?: HoldingHeldExpense[];
  listingUrl?: string;
  listingPrice?: number;
  fairMarketValue?: number;
  // CF-SOURCE-VENDOR (2026-07-13): provenance of the current fairMarketValue.
  // Foundation for multi-vendor pricing (CH + Cardsight + eBay-direct sold
  // comps). Every priced holding stamps this so downstream (iOS attribution,
  // per-vendor accuracy audits, source-preference tuning) knows where the
  // number came from.
  //
  //   "cardhedge"  — CH API (current primary)
  //   "cardsight"  — Cardsight API (returning for coverage gaps)
  //   "ebay"       — direct from eBay sold-comps pool (our own sales +
  //                  Marketplace Insights)
  //   "manual"     — user-entered override
  //
  // Absent → legacy pre-CF holding, treat as unknown provenance.
  sourceVendor?: "cardhedge" | "cardsight" | "ebay" | "manual";
  /** ISO timestamp the sourceVendor was last written. */
  sourceVendorUpdatedAt?: string;
  // CF-NEXT-SALE-PREDICTION-LAYER (design d531939) — forward-looking
  // predicted price (FMV × TrendIQ-derived bounded factor). Mechanism
  // attribution distinguishes trendiq-projection (success path) from
  // multiplier-anchored (Bowman-family fallback) from unavailable.
  predictedPrice?: number | null;
  predictedPriceLow?: number | null;
  predictedPriceHigh?: number | null;
  predictedPriceMechanism?: string | null;
  predictedPriceUpdatedAt?: string | null;
  // CF-AUTOPRICE-PERSIST-TRENDIQ — persisted TrendIQ movement fields so
  // the iOS dashboard can render direction (▲/▼/—) without re-querying
  // /estimate per holding. Populated only when computeEstimate returns
  // a trendIQ object (success path); fallback paths leave these null.
  // Phase C dropped the cached composite/impliedPct/coverage triple —
  // those β-detail values are sourced from the estimate response only.
  movementDirection?: string | null;
  movementUpdatedAt?: string | null;
  verdict?: string;
  recommendation?: string;
  lastUpdated?: string | number;
  notes?: string;
  // MLB Stats personId resolved from playerName at addHolding time (PR #68, 2026-05).
  // Optional and lazily populated — older holdings created before this PR may not have it.
  playerId?: string;
  playerIdConfidence?: "high" | "medium" | "low" | "ambiguous";
  playerIdResolvedAt?: string;  // Photo URLs (permanent blob URLs in the card-images container) and an
  // iOS-generated stable identifier used for upsert-by-clientId. Both added
  // by PR B (multi-tab migration). Optional on existing docs; required-shape
  // on new InventoryIQ holdings created from iOS.
  photos?: string[];
  clientId?: string;
  // eBay listing back-references. Set by ebayListing publish flow (PR D.6).
  // null = not currently listed; absent = field never populated. End-listing
  // flow clears all three back to null.
  ebayOfferId?: string | null;
  ebayListingId?: string | null;
  ebayListingPublishedAt?: string | null;
  // CF-UNIFIED-SEARCH-AND-CERT W4 — cert identity persisted onto the
  // holding so re-pricing / re-resolution flows can re-query the
  // original grader without losing provenance. Populated by the W6
  // VerifyView "save card" flow when the source is a cert lookup;
  // remains undefined / null for holdings created from free-text
  // search or imported pre-W6. Both fields are additive and
  // backward-compatible — existing holdings parse and serialize
  // unchanged.
  //
  // certGrader uses the same grader-id enum used by the cert-grader
  // registry (psa / bgs / sgc / cgc) in upper-case display form for
  // wire / Cosmos consistency with the legacy gradingCompany field.
  // String widening preserves forward-compat for v1.5 graders that
  // ship with new ids (e.g. "HGA").
  certNumber?: string | null;
  certGrader?: "PSA" | "BGS" | "SGC" | "CGC" | string | null;
  // CF-RECOMMENDATION-FLIP-ALERT (2026-07-06): the LAST-COMPUTED
  // recommendation verdict, persisted so the alert engine can detect
  // flips at reprice time. Written by evaluateHoldingAlerts after
  // each compute; read by the same function on the next cycle.
  // Backward-compat: legacy holdings have this undefined → treated
  // as "no prior state, no flip possible" on first compare.
  lastRecommendationVerdict?: "SELL_NOW" | "HOLD" | "LIST" | "INSUFFICIENT_DATA" | null;
  // CF-INVENTORYIQ-R1 — Cardsight catalog UUID persisted onto the
  // holding at write time so identity-based re-pricing / catalog
  // enrichment lookups don't pay the text-canonicalization tax that
  // historical re-resolution paths incur. Populated when an iOS pick
  // resolves a Cardsight candidate (W5-Windows UnifiedSearchResponse
  // surfaces it as `candidate.candidateId = "cardsight:<uuid>"`);
  // backend write paths defensively strip the "cardsight:" prefix so
  // the stored form is always the bare UUID regardless of which form
  // the client sends. Remains undefined / null for pre-R1 holdings,
  // for cert-only saves, and for manual-entry holdings where no
  // Cardsight match was resolved. Both states are valid; consumers
  // must tolerate absence and fall back to text-field resolution.
  //
  // Per InventoryIQ design doc Section 4 R1 (06a5d4e). Field is
  // additive and backward-compatible — existing holdings parse and
  // serialize unchanged, same posture as W4's certNumber / certGrader
  // (683b26f).
  cardId?: string | null;
  // CF-CARDSIGHT-GRADE-ID-PATTERN — Cardsight leaf grade UUID
  // persisted onto the holding at write time when the resolver
  // matches (gradeCompany, gradeValue, isAuto) to Cardsight's grades
  // taxonomy. SUPPLEMENTARY aggregation FK alongside the existing
  // text grade fields (gradeCompany, gradeValue, certNumber,
  // certGrader); NOT a replacement. Holdings remain valid in any of:
  //   - certNumber + certGrader + gradeId
  //   - certNumber + certGrader only (Cardsight doesn't cover the
  //     grader / type)
  //   - gradeCompany + gradeValue + gradeId (text grade
  //     matched to taxonomy)
  //   - gradeCompany + gradeValue only (text grade only, no
  //     Cardsight match — including manual ungradeable entries)
  // Null is a permanent valid state -- the resolver returns null on
  // every miss path (unknown grader, unknown type, unknown grade
  // value, network failure) and the holding persists fine without it.
  //
  // Resolver: resolveCardsightGradeId at
  // backend/src/services/cardsight/cardsightGradesTaxonomy.ts.
  // Per InventoryIQ design Section 2.3 R2; per CF-CARDSIGHT-GRADES-
  // ENDPOINT-EVAL (006176d) Finding 2 GREEN. Same posture as R1
  // (cardId) -- additive, backward-compatible, no migration.
  gradeId?: string | null;

  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): pinned-parallel Cardsight UUID
  // for a parallel holding (e.g. Leo Blue Refractor /150 → parallelId
  // "0383bf13…"). Distinct from `parallel` (the human-readable name).
  // When present, autoPriceHolding's gradedEstimates assembly runs in
  // PARALLEL scope (anchor on the parallel's raw FMV); when absent, BASE
  // scope. Name-only holdings would otherwise silently fall to base
  // scope and surface the wrong rail entry — iOS POSTs from the comp
  // card include the pinned parallelId from the engine response.
  parallelId?: string | null;

  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): graded-rail valuation fields.
  // STRUCTURALLY SEPARATE from fairMarketValue (observed-only). When the
  // holding's grade matches a grounded gradedEstimates entry, the rail
  // entry populates these; fairMarketValue stays null (no estimate
  // landing in the observed slot that feeds ERP P&L / Schedule D).
  // When the entry is insufficient, estimatedValue stays null but
  // estimateBasis carries the scope-labeled "why" prose for iOS tap-
  // state. When the grade has observed sales (GUARD-skipped from the
  // rail), all these fields stay null and fairMarketValue carries the
  // observed value as before. Display-only — assert no training/comp
  // path reads these (firewall test in Step 1 commit).
  estimatedValue?: number | null;
  estimateLow?: number | null;
  estimateHigh?: number | null;
  // CF-FINAL-CONSTANTS (2026-06-12): "ballpark" is a first-class tier;
  // "no-data" replaces "insufficient" for the no-anchor case. Old
  // "insufficient" kept for Cosmos back-compat reads.
  estimateConfidence?: "estimate" | "rough" | "ballpark" | "no-data" | "insufficient" | null;
  estimateBasis?: string | null;
  isEstimate?: boolean;
  // CF-GRADED-RAIL-WIRE-IN (2026-06-14): valuation provenance tag.
  // "observed"   → holding has real comp-anchored FMV in fairMarketValue
  //                (ungraded holding OR graded holding where the grade
  //                had observed sales in scope).
  // "estimated"  → holding has a grounded graded-rail estimate in
  //                estimatedValue (PSA 10/9 borrow from card-base ratio
  //                or release-curve fill). fairMarketValue null; iOS
  //                renders the estimate with a clear "estimated" badge.
  // "pending"    → holding's grade hit an insufficient marker on the
  //                rail. fairMarketValue + estimatedValue both null;
  //                iOS surfaces estimateBasis prose explaining the gap.
  valuationStatus?: "observed" | "estimated" | "pending" | null;

  // CF-CH-THIN-COMP-PRIMARY (2026-06-26): persisted "last sold" surface for
  // holdings whose engine response carried estimateSource ===
  // "cardhedge-last-sale" — a SINGLE trusted CardHedge sale on a parallel-
  // specific chCardId. fairMarketValue STAYS null (the single CH sale is
  // not FMV-grade data), but the list/detail views can render "Last sold
  // $X via N comp(s)" off this block instead of "Can't estimate yet."
  //
  // ADDITIVE INVARIANT: this field is OPTIONAL and OMITTED on every
  // existing holding. The autoPriceHolding + repriceHoldingsForUser
  // writebacks only touch it when the engine emits
  // estimateSource === "cardhedge-last-sale"; every other code path
  // leaves the field absent. CS-sourced rows, observed-FMV rows, T3
  // base-auto rows, variant-mismatch skips, and low-confidence skips all
  // remain byte-identical pre/post this CF.
  //
  // compCount carries the singular CH count (always 1 today, but the
  // shape is forward-compat for "view 'via N comp(s)' generally"). date
  // is the soldDate string from the engine's lastSale.soldDate; null
  // when the engine couldn't determine the timestamp.
  lastSaleSurface?: {
    price: number;
    date: string | null;
    compCount: number;
  } | null;

  // CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): multiplier-model
  // expectation for the cardhedge-last-sale path. Populated only when
  // the engine's signal helper successfully computed (subset resolved,
  // curated row with empirical baseRelativePremium found, base-auto
  // pool sufficient). When the engine couldn't compute (no curated row,
  // subset unresolvable, base pool too thin, etc.), this stays absent
  // / null and iOS shows no buy/sell signal — no fake numbers.
  //
  // `value` is the price-space centroid (baseAutoMedian × multiplier);
  // `range` is the price-space [low, high] from baseAutoMedian ×
  // baseRelativePremium.range. Surfacing both lets iOS render the
  // signal with explicit numbers ("model expects $266 (range $254–$278)")
  // rather than just a verdict badge.
  modelExpectation?: {
    value: number;
    range: [number, number];
    multiplier: number;
    multiplierRange: [number, number];
    basis: string | null;
    n: number;
    baseAutoMedian: number;
    baseAutoCount: number;
    // CF-CH-MODEL-EXPECTATION-TREND-ANCHOR (2026-06-26): trend-aware
    // additions. All three are optional + nullable; absent when the
    // helper couldn't compute (flat trend / thin pool / no purchasePrice).
    trendAnchor?: {
      direction: "up" | "down";
      slopePctPerDay: number;
      trendConfidence: number;
      windowDays: number;
      daysWithSales: number;
      projectedBaseAtSale: number;
      projectedBaseToday: number;
      allTimeBaseMedian: number;
    } | null;
    forwardProjection?: {
      low: number;
      high: number;
      basis: string;
      confidence: number;
    } | null;
    positionSignal?: {
      purchasePrice: number;
      gainVsLastSale: number;
      gainVsExpectation: number;
      gainPct: number;
    } | null;
  } | null;

  // CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): buy/sell signal
  // derived from the single trusted CH sale's position vs the model
  // expectation's range.
  //   lean === "sell"  → sale is ABOVE the parallel's empirical band
  //                       (e.g. Hartman BXF /150 at $450, band [$254, $278])
  //   lean === "buy"   → sale is BELOW the band
  //   lean === "hold"  → sale is within the band
  // deltaPct is the % difference from the centroid: positive = above,
  // negative = below.
  modelSignal?: {
    lean: "buy" | "hold" | "sell";
    deltaPct: number;
    expectation: number;
    effectiveMultiplier: number;
  } | null;
}
