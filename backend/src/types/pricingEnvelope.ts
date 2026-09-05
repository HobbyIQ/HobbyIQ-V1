// CF-PRICING-ENVELOPE (Drew, 2026-07-31). Canonical pricing surface for
// a PortfolioHolding. ONE shape both iOS and the web app bind to, so
// they can never drift. Additive to PortfolioHoldingWire — legacy flat
// fields (fairMarketValue, estimatedValue, predictedPrice, etc.) remain
// during the migration window and can be deleted once both clients cut
// over to `pricing.*`.
//
// Source of design: `ios-backend-drift-audit.md` Section 5. Every field
// on the envelope corresponds to something either (a) already on the
// holding doc or wire, (b) already computed at wire-assembly time
// (bands, freshness), or (c) explicitly-nullable when the enrichment
// hasn't landed yet (composite v3, population — filled in follow-up
// once persisted onto the holding).
//
// Design principles:
//   - EVERY field has a stable type; no `any` at the boundary.
//   - Sub-objects group related fields so consumers can render whole
//     tiles from one binding (`pricing.provenance` renders the whole
//     "where this number came from" strip).
//   - null is the only "absent" sentinel; `undefined` never crosses the
//     wire.
//   - Nested optional-object convention: when the outer sub-object is
//     null, the whole tile is hidden; when the outer sub-object exists
//     but a leaf field is null, the leaf is hidden.

/** The one canonical pricing shape iOS + web both bind to. */
export interface PricingEnvelope {
  /** The one number to display for this holding. Always populated —
   *  falls back to cost basis when unpriced (never negative, never NaN). */
  headline: PricingHeadline;

  /** Verified market observation. The FMV that feeds ERP / Schedule D. */
  observed: PricingObserved;

  /** Model estimate — populated when no direct observation exists. */
  estimate: PricingEstimate | null;

  /** Which pipeline produced the number + a human-readable label. */
  method: PricingMethod;

  /** Confidence tiles — one 0..1 per axis. Only pricing is populated
   *  today; liquidity/timing reserved. */
  confidence: PricingConfidence;

  /** Forward-looking prediction. Null when no forecast is available. */
  predicted: PricingPredicted | null;

  /** Trend + momentum signals. */
  trend: PricingTrend;

  /** Comp-family tile bands derived from headline. Never null when
   *  headline.value is a number; null when unpriced. */
  bands: PricingBands | null;

  /** Where the money came from — vendor, source, anchor, single-sale
   *  surface, model expectation. */
  provenance: PricingProvenance;

  /** Quality + freshness metadata. */
  quality: PricingQuality;

  /** Composite v3 enrichment (era, ladder verdict, color equivalent).
   *  null when the holding hasn't been enriched yet. */
  composite: PricingComposite | null;

  /** Grade population data from hobbyIqFmv. null when Cardsight pop
   *  hasn't been fetched for this SKU. */
  population: PricingPopulation | null;
}

export interface PricingHeadline {
  /** Per-unit "the one number" — observed FMV when present, else the
   *  estimated value, else a cost-basis proxy (per-unit), else null. */
  value: number | null;
  /** Where the headline number came from. `unpriced` when even
   *  cost-basis is unavailable. */
  valueSource: "observed" | "estimated" | "cost-proxy" | "unpriced";
  /** Same as `value` — kept for iOS symmetry with `PricingObserved.total`. */
  perUnit: number | null;
  /** Quantity from the holding (defaults to 1). */
  quantity: number;
}

export interface PricingObserved {
  /** Verified observed FMV (per-unit). null on estimated/pending. */
  fairMarketValue: number | null;
  /** fairMarketValue × quantity when both defined; null otherwise. */
  total: number | null;
}

export interface PricingEstimate {
  /** Per-unit estimated value. */
  value: number | null;
  /** Low bound (per-unit). */
  low: number | null;
  /** High bound (per-unit). */
  high: number | null;
  /** { low, high } for convenience; null when low/high aren't both set. */
  range: { low: number; high: number } | null;
  /** Discrete confidence tier — NEVER a raw string, always the enum. */
  confidence: "estimate" | "rough" | "ballpark" | "no-data" | null;
  /** Human prose explaining why this estimate ("Grade estimated from 3
   *  raw sales × PSA 10 multiplier..."). */
  basisNote: string | null;
}

/** Which pipeline produced the number. `kind` is the machine label;
 *  `label` is the human-readable render. */
export interface PricingMethod {
  kind:
    | "direct-comp"
    | "cross-parallel"
    | "sibling"
    | "grade-cross-raw"
    | "composite-neighbor"
    | "ladder-fallback"
    | "our-pool"
    | "legacy-engine"
    | "cardhedge-last-sale"
    | "resolver-fallback"
    | "manual"
    | "unknown";
  label: string;
  /** hobbyIqFmv ladder rung name when applicable, else null. */
  ladderRung: string | null;
  /** Number of comps that fed the winning rung. null when not tracked. */
  compsUsed: number | null;
}

export interface PricingConfidence {
  /** 0..1 — the PRICING confidence: how well-evidenced the dollar figure
   *  is (pool depth, comp recency, how far the rung reached from the exact
   *  card). It falls with each rung down the ladder.
   *
   *  CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03): this used to be filled
   *  from the flat `holding.confidence` field, which the canonical/unified
   *  writer never sets — so on a unified-priced holding it was whatever a
   *  previous legacy reprice happened to leave behind, published under a
   *  name that promised something else. It now prefers the engine's own
   *  pricing confidence off `pricingSourceMeta.confidence`, and falls back
   *  to the legacy field only for holdings the legacy path priced.
   *
   *  null when no path reported one — render it as unknown rather than
   *  substituting a match/identity confidence, which is a different
   *  quantity and answers a different question. */
  pricing: number | null;
  /** Reserved. Always null today; caller shouldn't render when null. */
  liquidity: number | null;
  /** Reserved. */
  timing: number | null;
}

export interface PricingPredicted {
  /** Predicted next-sale value (per-unit). */
  value: number | null;
  /** { low, high } bounds around value. */
  range: { low: number; high: number } | null;
  /** Machine mechanism string for downstream logging / debugging. */
  mechanism: string | null;
  /** Full attribution object when available (shape varies by
   *  mechanism; downstream keys are optional). */
  attribution: Record<string, unknown> | null;
  /** ISO timestamp when predicted was last computed. */
  updatedAt: string | null;
}

export interface PricingTrend {
  /** Full TrendIQ envelope. null when trend wasn't computed. */
  trendIQ: unknown | null;
  /** Direction shorthand — "flat" when no signal, otherwise the
   *  predominant slope direction. */
  movementDirection: "up" | "down" | "flat" | null;
  /** Broader-context slope %/month (playerMomentum / matchedCohort). */
  broaderTrendPctPerMonth: number | null;
  /** ISO timestamp for the trend snapshot. */
  updatedAt: string | null;
}

export interface PricingBands {
  /** headline × QUICK_SALE_MULTIPLIER (0.85). */
  quickSale: number | null;
  /** headline × PREMIUM_MULTIPLIER (1.15). */
  premium: number | null;
  /** headline × SUGGESTED_LIST_MULTIPLIER (1.05). */
  suggestedList: number | null;
  /** [low, high] — sub-quickSale, for "buy at or below". */
  buyZone: [number, number] | null;
  /** [low, high] — quickSale → headline. */
  holdZone: [number, number] | null;
  /** [low, high] — headline → premium. */
  sellZone: [number, number] | null;
}

export interface PricingProvenance {
  /** Winning vendor for this holding's price. */
  vendor:
    | "cardhedge"
    | "cardsight"
    | "hobbyiq-pool"
    | "ebay"
    | "manual"
    | null;
  vendorUpdatedAt: string | null;
  /** hobbyIqFmv path indicator — "our-pool" when priceHoldingFromOurPool
   *  rescued, "legacy-engine" when computeEstimate served. */
  pricingSource: "our-pool" | "legacy-engine" | "unified-pricing" | "sibling-estimate" | null;
  /** Metadata about the winning our-pool call. */
  pricingSourceMeta:
    | { slug: string; method: string; compsUsed: number; confidence: number | null }
    | null;
  /** CF-WITHHELD-REACHES-THE-GLASS (Drew, 2026-09-05).
   *
   *  A REFUSAL, carried to the client. The one-valuation-path writer already
   *  records why it declined to publish a price (holdingValuation.ts), but
   *  until now that block died at this boundary: `buildProvenance` read only
   *  {slug, method, compsUsed} off `pricingSourceMeta`, so every withheld
   *  holding reached the UI as an indistinguishable null and the glass could
   *  say nothing truer than "—". Drew's audit finding, 2026-09-05.
   *
   *  Present ONLY on a row the engine refused to price. Absent means the row
   *  was published normally — it does NOT mean "withheld for an unknown
   *  reason", and a reader must not invent one.
   *
   *  OPTIONAL on the wire: a worker that has not redeployed will not send it,
   *  and every consumer must render correctly without it. That is the same
   *  additive contract `sellSignal` and the day-change fields keep. */
  withheld?: {
    /** The machine-readable cause, closed vocabulary. The UI maps each to
     *  its own sentence AND its own "what would unlock this" — they are four
     *  different problems with four different fixes, and collapsing them to
     *  one sentence is what the audit found on the DailyIQ column. */
    reason:
      | "cost-basis-floor"
      | "no-checklist-match"
      | "identity-not-in-catalog"
      | "pool-migrating";
    /** The pool that blocked it, and that pool's size. */
    blockingId: string | null;
    blockingCount: number | null;
    /** The market number the engine COMPUTED and then refused to publish.
     *  Null when nothing was computed (no pool at all) — null therefore
     *  means "there was no number", never "we are hiding one". This is the
     *  evidence that makes a cost-basis-floor refusal legible: "market shows
     *  $X, held below 15% of your $Y basis". */
    proposed: number | null;
    /** What the row carries now, and why a retention was refused. */
    retained: number | null;
    retentionRefused: string | null;
    /** The rung the retained number WAS priced under — history, not a claim
     *  about this pass. Deliberately not `fmvRung`. */
    retainedRung?: string | null;
  } | null;
  /** CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03). The caveats
   *  this price must be read with, exactly as the writer stamped them — the
   *  same set the live canonical-fmv response carries for this holding. The
   *  holding DETAIL surface reads them here; the list row reads the flat
   *  `pricingLabels` on the wire. One source, two shapes. */
  pricingLabels: Array<{
    code: "speculative" | "self-anchored" | "fallback-rung" | "low-confidence";
    text: string;
  }>;
  /** The self-anchored ratio: `own` of the pool's `total` sales behind this
   *  price are the owner's. Null when none is. */
  selfAnchored: { own: number; total: number } | null;
  /** Grade-ladder rescue anchor. */
  nearestGradedAnchor: {
    grade: string;
    price: number;
    daysOld: number;
    sampleSize: number;
    confidence: number;
  } | null;
  /** Single trusted CH last-sale surface. */
  lastSaleSurface: {
    price: number;
    date: string | null;
    compCount: number;
  } | null;
  /** Model expectation object from CH thin-comp primary path. */
  modelExpectation: unknown | null;
  /** Model signal from CH thin-comp primary path. */
  modelSignal: unknown | null;
}

export interface PricingQuality {
  /** 0..1 quality score from hobbyIqFmv.quality. */
  score: number | null;
  /** How many comps were dropped as flagged. */
  flaggedCompCount: number | null;
  /** Distinct sources that contributed to the winning pool. */
  sources: string[];
  /** Discrete freshness bucket used by iOS chips. */
  freshness: "Live" | "Updated Today" | "Yesterday" | "Needs refresh";
  /** ISO timestamp when the price was last written. */
  lastPricedAt: string | null;
}

export interface PricingComposite {
  era: string | null;
  colorFamily: string | null;
  finishModifier: string | null;
  edition: string | null;
  ladderVerdict: string | null;
  paniniColorEquivalent: string | null;
}

export interface PricingPopulation {
  psa: { total: number; byGrade: Record<string, number> } | null;
  bgs: { total: number; byGrade: Record<string, number> } | null;
  sgc: { total: number; byGrade: Record<string, number> } | null;
  cgc: { total: number; byGrade: Record<string, number> } | null;
}
