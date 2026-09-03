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
  /**
   * CF-IDENTITY-VERIFIED (Drew, 2026-07-27): true once the owner has
   * explicitly picked a catalog candidate through the Confirm gate in
   * the Edit modal (or supplied a cert# that resolved authoritatively).
   * Downstream: portfolio row shows a VERIFIED / UNVERIFIED chip;
   * follow-up PR can gate storefront publication on this. Never set
   * silently — always via an explicit user action.
   */
  identityVerified?: boolean;
  identityVerifiedAt?: string;
  identityVerifiedBy?: {
    source: string;          // e.g. "cardsight", "psa-cert", "manual-confirm"
    candidateId: string;     // e.g. "cardsight:<uuid>" or "psa:<cert>"
    verifiedAt: string;      // ISO — mirrors identityVerifiedAt for audit
  };
  /**
   * CF-NEVER-AGAIN (Drew, 2026-09-02). The ONE field the nightly pricing
   * invariant auditor (scripts/audit-pricing-invariants.cjs) may write, and
   * the only write that job does at all: a marker saying "the last audit run
   * could not reconcile this holding's persisted value with an independent
   * re-derivation".
   *
   * It is a MARKER, never a price. The auditor never writes fairMarketValue,
   * estimatedValue, fmvRung or any other pricing field — a divergence is
   * evidence for a human, never an auto-correction (a machine that silently
   * rewrites prices to match its own shadow would hide the very defect it
   * was built to surface).
   *
   * PUBLISH + LABEL doctrine: the value still shows. This flag adds a subtle
   * "under review" badge beside it; it never blanks, clamps or hides the
   * number the holding already carries.
   *
   * Cleared by the same job on the next run when the holding reconciles.
   */
  auditFlag?: {
    /** Human-readable "<INVARIANT>: <kind>", e.g. "BASIS-IDENTITY: cross-product". */
    reason: string;
    /** ISO timestamp of the audit run that raised it. */
    at: string;
    /** The invariant class: BASIS-IDENTITY | RUNG-HONESTY | SUBSTITUTION | DETERMINISM. */
    invariant: string;
  } | null;
  /**
   * CF-STOREFRONT-OPT-IN (Drew, 2026-07-27, rev 2): explicit per-card
   * opt-in for the public /u/<username> storefront. Default false —
   * NOTHING renders on the public page unless the owner has clicked
   * "Add to storefront" on that specific holding. Investor caps at 50
   * selected; Pro Seller at 200. Anything selected beyond the cap is
   * rejected at write time so a stale over-cap state can't exist.
   *
   * Why opt-in: sellers hold cards for investment vs. sale. Opting in
   * per-card lets a seller keep long-term holds off the shop without
   * a "hide" click per card. The pre-existing hideFromStorefront flag
   * is now legacy — the storefront filter reads only showOnStorefront.
   */
  showOnStorefront?: boolean;
  /**
   * CF-STOREFRONT-HIDE (Drew, 2026-07-27): DEPRECATED as of the
   * CF-STOREFRONT-OPT-IN flip. Historic values ignored by the
   * publicSeller filter; kept on the type for backward-compat during
   * reads. Do not gate anything new on this field.
   */
  hideFromStorefront?: boolean;
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
  /**
   * CF-BGS-BLACK-LABEL-INGEST (Drew, 2026-07-16, PR #495 follow-up):
   * distinguishes a BGS 10 Black Label / Pristine 10 slab from a regular
   * BGS 10. When true AND gradeCompany === "BGS" AND gradeValue === 10,
   * autoPriceHolding passes grade "10 Black Label" to getGraderPremium,
   * which routes to the 9x fallback tier (12/9/7/5.5 tiered) instead of
   * the regular BGS 10 3.5x tier. Absent / false → treated as regular
   * BGS 10.
   *
   * Only meaningful for BGS 10; the field is ignored for other
   * (company, grade) tuples. Persisted so the CH taxonomy conflation
   * of Pristine 10 UUIDs doesn't erase the tier when Drew's own
   * inventory record already carries it.
   */
  isBlackLabel?: boolean;
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

  // CF-OUR-POOL-PORTFOLIO-PRICER (Drew, 2026-07-27). Which pricing path
  // authored the current fairMarketValue / estimatedValue on this holding.
  //   "our-pool"       — hobbyiq-fmv service reading OUR sold_comps pool
  //                      by canonical hobbyiqCardId slug
  //   "legacy-engine"  — computeEstimate / rail / ladder (pre-Our-Pool
  //                      wiring OR Our-Pool returned no data + fell back)
  //   "unified-pricing" — the unified engine's exact-identity pool
  //   "sibling-estimate" — D4 PR 5: siblingCardPriceFallback (another
  //                      card × the measured parallel premium); only ever
  //                      written when the holding's exact pool is empty
  // Absent → legacy pre-CF holding, treat as "legacy-engine".
  pricingSource?: "our-pool" | "legacy-engine" | "unified-pricing" | "sibling-estimate";
  /** Extra breadcrumbs when pricingSource === "our-pool": which ladder
   *  rung won, how many comps contributed, and the exact slug that got
   *  matched. Absent on legacy-engine rows. */
  pricingSourceMeta?: {
    slug: string;
    method: string;    // HobbyIqFmvMethod, but a plain string here to keep
                       // types.ts import-cycle-free
    compsUsed: number;
    /** CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03). The PRICING confidence
     *  of the engine result that set this price surface: 0..1, how
     *  well-evidenced the dollar figure is (pool depth, comp recency, how
     *  far the rung reached from the exact card). It falls with each rung
     *  down the ladder.
     *
     *  This is NOT `holding.confidence` — that field is written only by the
     *  legacy computeEstimate path and carries a different quantity. Before
     *  this field existed the engine's pricing confidence survived only as
     *  the `conf=0.37` substring inside `estimateBasis` prose, which no
     *  consumer could read without parsing text. Written by the writer that
     *  decided the price, at the same time as the price.
     *
     *  Absent → this price surface predates the field, or came from a path
     *  that does not report a pricing confidence. Render it as unknown;
     *  never substitute a match confidence for it. */
    confidence?: number | null;
    /** CF-A-UNION-IS-ONE-CARD (2026-09-01). Present when the pool-twin union
     *  was refused because the holding's two identities named different
     *  products: the price came from the slug half alone, and this says so. */
    unionRefused?: string;
    /** CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03). The caveats
     *  this price must be read with — the SAME set the live canonical-fmv
     *  response carries for this holding, derived through the same two
     *  functions (compiq/valuationLabels.ts routes the Valuation through
     *  toCanonicalFmvResponse then labelsForResult). Codes are the sell
     *  draft's closed vocabulary:
     *
     *    speculative      the card's own sales went cold; the number is its
     *                     last real sale carried on the player's market
     *    self-anchored    at least one sale behind it is the OWNER'S OWN
     *    fallback-rung    no sale of this exact card at this grade
     *    low-confidence   thin evidence (< 0.35)
     *
     *  Drew's ruling (2026-09-01): a self-comp PUBLISHES **and is LABELED**.
     *  Before this field the label reached the card page and the sell draft
     *  and never the holding, so a portfolio row showed a self-anchored $251
     *  as if it were an ordinary market read. Written by the writer that
     *  decided the price, at the same time as the price — a label can never
     *  outlive the number it described.
     *
     *  Absent / empty → this price surface carries no caveats, or predates
     *  the field. Never infer a caveat from prose. */
    labels?: Array<{
      code: "speculative" | "self-anchored" | "fallback-rung" | "low-confidence";
      text: string;
    }>;
    /** The self-anchored ratio in machine-readable form: how many of the
     *  evidence pool's `total` sales are the owner's `own`. `own === total`
     *  is the fully self-anchored case (Drew's Verlander PSA 10: 1 of 1).
     *  Stated against the POOL, never the truncated display sample —
     *  CF-COMP-COUNT-IS-THE-POOL. Null/absent when no published sale is the
     *  owner's, which is the universal case. */
    selfAnchored?: { own: number; total: number } | null;
  };
  // CF-RUNG-LABEL (D4 "one valuation path", PR 1 — 2026-08-29). The
  // machine-readable name of the RUNG that produced this holding's current
  // price surface (fairMarketValue, or estimatedValue when fairMarketValue
  // is null). Vocabulary: FmvRungLabel in services/compiq/fmvRung.ts — a
  // plain string here to keep types.ts import-free. Written by the writer
  // that decided the price, at the same time as the price:
  //   "exact-pool-*"  the exact (identity, grade) pool — unified engine,
  //                   grade-curve tile, hobbyIqFmv direct-slug
  //   anything else   a named fallback rung (cross-grade-fallback,
  //                   sibling-parallel, grade-cross-raw, ...)
  //   null / absent   the legacy engine, which does not name its rung
  // Consumers (the divergence digest, telemetry, iOS) READ this. They
  // never infer the rung from estimateBasis prose. Every write site that
  // sets fairMarketValue also sets this, so a label can never outlive the
  // price it described.
  fmvRung?: string | null;
  // CF-EVERY-PERSISTED-VALUE-NAMES-ITS-SOURCE (C-7, 2026-09-03). The rung says
  // WHICH ladder step produced the number; `valueSource` says what KIND of
  // evidence stands behind it — "observed" (real comps in the exact pool) or
  // "estimated" (derived: a grade curve, a sibling, a family ratio). The
  // engine's own `Valuation.valueSource` carries exactly this and the holding
  // writers dropped it, so the audit found it absent on all 118 live holdings
  // and no consumer could tell a comped number from a derived one without
  // re-parsing `estimateBasis` prose.
  //
  // Same contract as fmvRung: written by the writer that decided the price, at
  // the same time as the price. A holding that carries a fairMarketValue and
  // NEITHER of these two keys came from a legacy writer, and the invariant
  // auditor's RUNG-HONESTY check now says so out loud (kind
  // "value-carries-no-rung") rather than returning silently.
  valueSource?: "observed" | "estimated" | null;
  // CF-ONE-PERSIST-HELPER (C-7, 2026-09-03). Why `fmvRung` is null, when a
  // lane genuinely cannot name a rung — "resolver fallback names no rung",
  // "legacy confidence-gated reprice", "grade ladder anchor". Written by
  // writeHoldingValuation from the `{ noRung: <reason> }` arm of its required
  // RungDeclaration, so a null rung is a STATEMENT carrying its cause rather
  // than an absence a reader has to guess at. Null when a rung was named.
  fmvRungAbsentReason?: string | null;
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
  // CF-COMP-HOLDING-WIRE-PARITY Slice 2 (audit PR #483, 2026-07-15):
  // persist the fields comp responses have always emitted but holdings
  // used to drop before the PR #482 wire additions. autoPriceHolding
  // now writes them from the engine's estimate response so the wire
  // stops emitting null placeholders. Every field is optional +
  // nullable — legacy holdings load as null, iOS decoders that PR #483
  // extends bind them defensively.
  //
  //   trendIQ                    — full TrendIQResult per estimate call;
  //                                iOS holding-detail renders the same
  //                                trendIQ tile as CompIQPricedCardView.
  //   confidence                 — 0..1 pricingConfidence lifted from
  //                                the estimate response, so the
  //                                confidence bar renders identically
  //                                to the comp panel.
  //   predictedPriceAttribution  — full attribution object (mechanism +
  //                                anchor + slope). Wire layer emits it
  //                                as the nested envelope; the legacy
  //                                flat `predictedPriceMechanism` stays
  //                                alongside for backward compat.
  trendIQ?:
    | import("../services/compiq/trendIQ.types.js").TrendIQResult
    | null;
  confidence?: number | null;
  predictedPriceAttribution?: Record<string, unknown> | null;
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

  // CF-PORTFOLIO-DETAIL-SLUG (Drew, 2026-07-26). Canonical HobbyIQ slug
  // (hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-PR]) so
  // iOS can tap a holding → POST /api/compiq/card-detail with this
  // value directly, without re-deriving from raw fields on the client.
  //
  // Populated at every write via deriveHoldingSlug() (addHolding,
  // autoPriceHolding). Read paths also compute-on-fly when absent, so
  // legacy holdings that predate this CF still surface a slug when
  // their identity fields are complete. null when identity is
  // insufficient (missing year / setName / cardNumber, or sport not
  // inferrable) — iOS falls back to legacy tap behavior in that case.
  hobbyiqCardId?: string | null;
  // CF-A-MINTED-SLUG-NEVER-REPLACES-A-PIN (D12a, 2026-08-29). HOW the slug
  // above was chosen, written at the same time as the slug:
  //   "catalog"        a catalog row matched at or above the pin gate
  //   "catalog-seeded" the catalog seeded the row from this user's card
  //   "derived"        minted from the holding's own text — the catalog had
  //                    nothing (or could not be asked); not checklist-backed
  //   "pinned"         the caller supplied it (card page, picker, import)
  // Absent on holdings written before this CF.
  hobbyiqCardIdSource?: "catalog" | "catalog-seeded" | "derived" | "pinned" | null;

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
