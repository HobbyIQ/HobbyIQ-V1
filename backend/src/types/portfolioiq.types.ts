export interface PortfolioHolding {
  id: string;
  playerName?: string;
  cardTitle?: string;
  cardYear?: number;
  brand?: string;
  setName?: string;
  cardNumber?: string;
  product?: string;
  parallel?: string;
  serialNumber?: string;
  isAuto?: boolean;
  isPatch?: boolean;
  variation?: string;
  bowmanFirst?: boolean;
  grade?: string;
  gradingCompany?: string;
  gradeCompany?: string;
  gradeValue?: number;
  quantity?: number;
  purchasePrice?: number;
  totalCostBasis?: number;
  purchaseDate?: string | number;
  purchaseSource?: string;
  feesPaid?: number;
  taxPaid?: number;
  shippingPaid?: number;
  listingUrl?: string;
  listingPrice?: number;
  currentValue?: number;
  quickSaleValue?: number;
  fairMarketValue?: number;
  suggestedListPrice?: number;
  premiumValue?: number;
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
  // the iOS dashboard can render direction (▲/▼/—) + magnitude without
  // re-querying /estimate per holding. Populated only when computeEstimate
  // returns a trendIQ object (success path); fallback paths leave these
  // null. Movement fields are FORWARD-looking (TrendIQ composite); the
  // BACKWARD-looking trend field elsewhere on this type reflects historical
  // momentum from comp history alone.
  movementDirection?: string | null;
  movementComposite?: number | null;
  movementImpliedPct?: number | null;
  movementCoverage?: string | null;
  movementUpdatedAt?: string | null;
  netEstimatedValue?: number;
  totalProfitLoss?: number;
  totalProfitLossPct?: number;
  verdict?: string;
  recommendation?: string;
  trend?: string;
  riskLevel?: string;
  marketSpeed?: string;
  marketPressure?: string;
  expectedDaysToSell?: number;
  confidence?: number;
  compsUsed?: number;
  parallelDetected?: string;
  explanationBullets?: string[];
  freshnessStatus?: string;
  lastUpdated?: string | number;
  statusCategory?: string;
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
  cardsightCardId?: string | null;
}
