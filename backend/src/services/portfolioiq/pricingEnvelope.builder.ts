// CF-PRICING-ENVELOPE-BUILDER (Drew, 2026-07-31). Constructs the
// canonical PricingEnvelope from a persisted PortfolioHolding + the
// values already computed inside composeHoldingWireShape (fmvPerUnit,
// displayable, band multipliers). Pure function, no I/O.
//
// Contract: called with the SAME inputs composeHoldingWireShape already
// has locally, so this file never re-derives what the caller already
// computed. That keeps `pricing.headline.value` exactly equal to
// `wire.currentValue / qty` etc. — parity with existing flat fields is
// enforced by shared inputs, not by hoping two independent computations
// produce identical numbers.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type {
  PricingEnvelope,
  PricingHeadline,
  PricingObserved,
  PricingEstimate,
  PricingMethod,
  PricingConfidence,
  PricingPredicted,
  PricingTrend,
  PricingBands,
  PricingProvenance,
  PricingQuality,
  PricingComposite,
  PricingPopulation,
} from "../../types/pricingEnvelope.js";
import {
  QUICK_SALE_MULTIPLIER,
  PREMIUM_MULTIPLIER,
  SUGGESTED_LIST_MULTIPLIER,
  BUY_ZONE_LOW_MULTIPLIER,
  applyHeadlineMultiplier,
} from "../../modules/compiq/services/pricing/utils/pricing.constants.js";

export interface BuildPricingEnvelopeInputs {
  /** FMV per unit computed by computePerUnitValue(holding). null when
   *  the holding is unpriced or on the estimated/pending branches. */
  fmvPerUnit: number | null;
  /** displayable per-unit + source from computeDisplayablePerUnitValue. */
  displayable: { value: number | null; source: "observed" | "estimated" | "pending" | null };
  /** Quantity (already floor-guarded to 1 by the caller). */
  quantity: number;
  /** Freshness bucket already computed by freshnessFromPricingTimestamp. */
  freshness: "Live" | "Updated Today" | "Yesterday" | "Needs refresh";
}

export function buildPricingEnvelope(
  holding: PortfolioHolding,
  inputs: BuildPricingEnvelopeInputs,
): PricingEnvelope {
  return {
    headline: buildHeadline(holding, inputs),
    observed: buildObserved(inputs.fmvPerUnit, inputs.quantity),
    estimate: buildEstimate(holding),
    method: buildMethod(holding),
    confidence: buildConfidence(holding),
    predicted: buildPredicted(holding),
    trend: buildTrend(holding),
    bands: buildBands(inputs.fmvPerUnit),
    provenance: buildProvenance(holding),
    quality: buildQuality(holding, inputs.freshness),
    composite: buildComposite(holding),
    population: buildPopulation(holding),
  };
}

// ─── Headline ──────────────────────────────────────────────────────────

function buildHeadline(
  holding: PortfolioHolding,
  inputs: BuildPricingEnvelopeInputs,
): PricingHeadline {
  const { displayable, fmvPerUnit, quantity } = inputs;
  // Same fallback ladder computeDisplayablePerUnitValue uses:
  //   observed FMV → estimated → cost-proxy → unpriced
  let value = displayable.value;
  let valueSource: PricingHeadline["valueSource"] = "unpriced";
  if (typeof fmvPerUnit === "number" && fmvPerUnit > 0) {
    valueSource = "observed";
    value = fmvPerUnit;
  } else if (
    typeof holding.estimatedValue === "number" &&
    holding.estimatedValue > 0
  ) {
    valueSource = "estimated";
    value = holding.estimatedValue;
  } else if (
    typeof holding.purchasePrice === "number" &&
    holding.purchasePrice > 0
  ) {
    valueSource = "cost-proxy";
    value = holding.purchasePrice;
  } else {
    valueSource = "unpriced";
    value = null;
  }
  return { value, valueSource, perUnit: value, quantity };
}

// ─── Observed ──────────────────────────────────────────────────────────

function buildObserved(
  fmvPerUnit: number | null,
  quantity: number,
): PricingObserved {
  return {
    fairMarketValue: fmvPerUnit,
    total: fmvPerUnit !== null ? fmvPerUnit * quantity : null,
  };
}

// ─── Estimate ──────────────────────────────────────────────────────────

function buildEstimate(holding: PortfolioHolding): PricingEstimate | null {
  const hasEstimate =
    typeof holding.estimatedValue === "number" ||
    typeof holding.estimateLow === "number" ||
    typeof holding.estimateHigh === "number" ||
    typeof holding.estimateBasis === "string" ||
    holding.isEstimate === true;
  if (!hasEstimate) return null;

  const low = numOrNull(holding.estimateLow);
  const high = numOrNull(holding.estimateHigh);
  const confidence = coerceConfidenceTier(holding.estimateConfidence);
  return {
    value: numOrNull(holding.estimatedValue),
    low,
    high,
    range: low !== null && high !== null ? { low, high } : null,
    confidence,
    basisNote: typeof holding.estimateBasis === "string" ? holding.estimateBasis : null,
  };
}

function coerceConfidenceTier(
  raw: unknown,
): "estimate" | "rough" | "ballpark" | "no-data" | null {
  if (raw === "estimate" || raw === "rough" || raw === "ballpark" || raw === "no-data") return raw;
  // "insufficient" is a legacy value that maps to "no-data" per
  // gradeCalibrationConfig comments.
  if (raw === "insufficient") return "no-data";
  return null;
}

// ─── Method ────────────────────────────────────────────────────────────

function buildMethod(holding: PortfolioHolding): PricingMethod {
  const src = (holding as { pricingSource?: string }).pricingSource;
  const meta = (holding as { pricingSourceMeta?: { slug?: string; method?: string; compsUsed?: number } })
    .pricingSourceMeta;
  const rung = typeof meta?.method === "string" ? meta.method : null;
  const compsUsed = typeof meta?.compsUsed === "number" ? meta.compsUsed : null;

  // Map (pricingSource, ladder rung) → canonical kind + human label.
  if (src === "our-pool") {
    const kind = mapOurPoolRungToKind(rung);
    return {
      kind,
      label: labelForKind(kind, rung),
      ladderRung: rung,
      compsUsed,
    };
  }
  if (src === "legacy-engine") {
    return { kind: "legacy-engine", label: "Legacy engine", ladderRung: null, compsUsed };
  }
  // D4 PR 5: the sibling × measured-premium estimate names itself.
  if (src === "sibling-estimate") {
    return { kind: "sibling", label: "Sibling card × parallel premium", ladderRung: "sibling-estimate", compsUsed };
  }
  // No pricingSource → the holding was priced through a fallback path
  // that didn't stamp pricingSource. Best-effort classify from other
  // hints on the holding.
  if ((holding as { modelSignal?: unknown }).modelSignal) {
    return { kind: "cardhedge-last-sale", label: "CardHedge last sale", ladderRung: null, compsUsed: 1 };
  }
  if (holding.nearestGradedAnchor) {
    return { kind: "ladder-fallback", label: "Grade-ladder rescue", ladderRung: null, compsUsed: holding.nearestGradedAnchor.sampleSize };
  }
  return { kind: "unknown", label: "—", ladderRung: null, compsUsed: null };
}

function mapOurPoolRungToKind(rung: string | null): PricingMethod["kind"] {
  switch (rung) {
    case "direct-slug":
    // D4 PR 5: hobbyIqFmv's unified branch on the exact slug — the exact pool.
    case "unified-market-value":
      return "direct-comp";
    case "cross-setkey":
    case "cross-printrun":
    case "same-printrun-cross-parallel":
    case "printrun-discovery":
      return "cross-parallel";
    case "sibling-parallel":
    case "family-baseline":
      return "sibling";
    case "grade-cross-raw":
      return "grade-cross-raw";
    case "composite-neighbor":
      return "composite-neighbor";
    default:
      return "our-pool";
  }
}

function labelForKind(kind: PricingMethod["kind"], rung: string | null): string {
  switch (kind) {
    case "direct-comp":
      return "Direct comps";
    case "cross-parallel":
      return "Cross-parallel comps";
    case "sibling":
      return "Sibling parallels";
    case "grade-cross-raw":
      return "Raw × grade multiplier";
    case "composite-neighbor":
      return "Composite neighbors";
    case "our-pool":
      return rung ? `Our pool (${rung})` : "Our pool";
    case "legacy-engine":
      return "Legacy engine";
    case "cardhedge-last-sale":
      return "CardHedge last sale";
    case "ladder-fallback":
      return "Grade-ladder rescue";
    case "resolver-fallback":
      return "Multi-source resolver";
    case "manual":
      return "Manual entry";
    case "unknown":
      return "—";
  }
}

// ─── Confidence ────────────────────────────────────────────────────────

/** 0..1, or null for anything that isn't a usable confidence. */
function unitOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

/**
 * CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03).
 *
 * `confidence.pricing` must be the PRICING confidence — how well-evidenced
 * the dollar figure is. It used to read the flat `holding.confidence`
 * field, which only the legacy computeEstimate path ever writes; on a
 * unified/canonical-priced holding that field is stale or absent, so the
 * envelope published a number that answered a different question (or a
 * previous pass's answer) under the name "pricing".
 *
 * The engine's own pricing confidence now rides in `pricingSourceMeta`,
 * written by the same writer that decided the price. Prefer it. Fall back
 * to the flat field only when the price surface has no structured
 * confidence AND the legacy path is the one that priced this holding —
 * that is the population the flat field was actually written for.
 *
 * Anything else stays null: an unknown pricing confidence is reported as
 * unknown, never filled in from a different quantity.
 */
function buildConfidence(holding: PortfolioHolding): PricingConfidence {
  return { pricing: resolvePricingConfidence(holding), liquidity: null, timing: null };
}

/**
 * The single resolver for "how well-evidenced is THIS holding's price", 0..1,
 * or null when that is genuinely not recorded.
 *
 * Extracted from buildConfidence (CF-SELL-WINDOW-READS-PRICING-CONFIDENCE,
 * 2026-09-03) so every consumer that needs a pricing confidence — the report
 * envelope, the sell-window signal, the eBay sell draft — reads the SAME
 * quantity by the same rule, instead of each reaching for the flat field and
 * getting identity/match confidence under a pricing name.
 *
 * Callers must treat null as UNKNOWN and say so; it is never 1.0.
 */
export function resolvePricingConfidence(
  holding: Pick<PortfolioHolding, never> & {
    pricingSourceMeta?: { confidence?: unknown } | null;
    pricingSource?: string | null;
    confidence?: unknown;
  },
): number | null {
  const fromEngine = unitOrNull(holding.pricingSourceMeta?.confidence);
  if (fromEngine !== null) return fromEngine;

  const source = holding.pricingSource ?? null;
  // "legacy-engine", and pre-CF holdings with no pricingSource at all, are
  // the rows computeEstimate priced — the only rows whose flat `confidence`
  // came from a pricing computation.
  const legacyPriced = source === null || source === "legacy-engine";
  return legacyPriced ? unitOrNull(holding.confidence) : null;
}

// ─── Predicted ─────────────────────────────────────────────────────────

function buildPredicted(holding: PortfolioHolding): PricingPredicted | null {
  const value = numOrNull(holding.predictedPrice);
  const low = numOrNull(holding.predictedPriceLow);
  const high = numOrNull(holding.predictedPriceHigh);
  const mechanism = typeof holding.predictedPriceMechanism === "string" ? holding.predictedPriceMechanism : null;
  const updatedAt = typeof holding.predictedPriceUpdatedAt === "string" ? holding.predictedPriceUpdatedAt : null;
  const attribution =
    (holding as { predictedPriceAttribution?: unknown }).predictedPriceAttribution;
  const attributionObj =
    attribution && typeof attribution === "object" && !Array.isArray(attribution)
      ? (attribution as Record<string, unknown>)
      : mechanism
        ? { mechanism }
        : null;

  const hasAny = value !== null || low !== null || high !== null || mechanism !== null || attributionObj !== null;
  if (!hasAny) return null;
  return {
    value,
    range: low !== null && high !== null ? { low, high } : null,
    mechanism,
    attribution: attributionObj,
    updatedAt,
  };
}

// ─── Trend ─────────────────────────────────────────────────────────────

function buildTrend(holding: PortfolioHolding): PricingTrend {
  const trendIQ = (holding as { trendIQ?: unknown }).trendIQ ?? null;
  const rawDirection = holding.movementDirection;
  const direction: PricingTrend["movementDirection"] =
    rawDirection === "up" || rawDirection === "down" || rawDirection === "flat" ? rawDirection : null;
  // trendIQ.components.playerMomentum.multiplier is an aggregate ratio.
  // The broader-trend %/month is best derived downstream; expose null
  // here rather than fabricate.
  const broaderTrendPctPerMonth =
    trendIQ && typeof trendIQ === "object" && "impliedPct" in trendIQ &&
    typeof (trendIQ as { impliedPct?: unknown }).impliedPct === "number"
      ? ((trendIQ as { impliedPct: number }).impliedPct)
      : null;
  return {
    trendIQ,
    movementDirection: direction,
    broaderTrendPctPerMonth,
    updatedAt: typeof holding.movementUpdatedAt === "string" ? holding.movementUpdatedAt : null,
  };
}

// ─── Bands ─────────────────────────────────────────────────────────────

function buildBands(fmvPerUnit: number | null): PricingBands | null {
  if (fmvPerUnit === null) return null;
  const quickSale = fmvPerUnit * QUICK_SALE_MULTIPLIER;
  const premium = fmvPerUnit * PREMIUM_MULTIPLIER;
  const suggestedList = fmvPerUnit * SUGGESTED_LIST_MULTIPLIER;
  return {
    quickSale,
    premium,
    suggestedList,
    buyZone: [
      applyHeadlineMultiplier(fmvPerUnit, QUICK_SALE_MULTIPLIER * BUY_ZONE_LOW_MULTIPLIER) ?? 0,
      applyHeadlineMultiplier(fmvPerUnit, QUICK_SALE_MULTIPLIER) ?? 0,
    ],
    holdZone: [
      applyHeadlineMultiplier(fmvPerUnit, QUICK_SALE_MULTIPLIER) ?? 0,
      fmvPerUnit,
    ],
    sellZone: [fmvPerUnit, applyHeadlineMultiplier(fmvPerUnit, PREMIUM_MULTIPLIER) ?? 0],
  };
}

// ─── Provenance ────────────────────────────────────────────────────────

/** CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03). The label set
 *  the price writer stamped into `pricingSourceMeta`, validated on the way
 *  out. A malformed or absent stamp yields `[]` — the wire never invents a
 *  caveat, and never drops one it was given. */
export function pricingLabelsOf(
  holding: PortfolioHolding,
): PricingProvenance["pricingLabels"] {
  const raw = (holding as {
    pricingSourceMeta?: { labels?: unknown } | null;
  }).pricingSourceMeta?.labels;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    const code = (l as { code?: unknown })?.code;
    const text = (l as { text?: unknown })?.text;
    return typeof code === "string" && typeof text === "string"
      ? [{ code: code as "speculative" | "self-anchored" | "fallback-rung" | "low-confidence", text }]
      : [];
  });
}

/** CF-WITHHELD-REACHES-THE-GLASS (Drew, 2026-09-05). The refusal block the
 *  one-valuation-path writer stamped when it declined to publish a price,
 *  validated on the way out.
 *
 *  The `reason` is the load-bearing field and the ONLY required one: without
 *  a recognised reason there is no sentence the UI could honestly show, so a
 *  malformed stamp yields `null` (no refusal claimed) rather than a partial
 *  object that would render as an empty explanation. An unrecognised reason
 *  string is treated the same way — this wire never invents a cause, and a
 *  vocabulary the client does not know is worse than silence.
 *
 *  Every OTHER field is independently optional, because they genuinely vary
 *  by branch: a cost-basis-floor refusal has a `proposed` number (the market
 *  read it refused) while an identity-not-in-catalog refusal computed nothing
 *  and has none. Null there means "no number existed", never "hidden". */
export function withheldOf(
  holding: PortfolioHolding,
): PricingProvenance["withheld"] {
  const raw = (holding as {
    pricingSourceMeta?: { withheld?: unknown } | null;
  }).pricingSourceMeta?.withheld;
  if (!raw || typeof raw !== "object") return null;

  const reason = (raw as { reason?: unknown }).reason;
  if (
    reason !== "cost-basis-floor"
    && reason !== "no-checklist-match"
    && reason !== "identity-not-in-catalog"
    && reason !== "pool-migrating"
  ) {
    return null;
  }

  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  return {
    reason,
    blockingId: str((raw as { blockingId?: unknown }).blockingId),
    blockingCount: num((raw as { blockingCount?: unknown }).blockingCount),
    proposed: num((raw as { proposed?: unknown }).proposed),
    retained: num((raw as { retained?: unknown }).retained),
    retentionRefused: str((raw as { retentionRefused?: unknown }).retentionRefused),
    retainedRung: str((raw as { retainedRung?: unknown }).retainedRung),
  };
}

/** The self-anchored ratio the writer stamped: how many of the pool's
 *  `total` sales behind this price are the owner's `own`. Null unless both
 *  halves are finite non-negative numbers with `own > 0` — a ratio that
 *  cannot be stated is not stated. */
export function selfAnchoredOf(
  holding: PortfolioHolding,
): { own: number; total: number } | null {
  const raw = (holding as {
    pricingSourceMeta?: { selfAnchored?: unknown } | null;
  }).pricingSourceMeta?.selfAnchored;
  if (!raw || typeof raw !== "object") return null;
  const own = (raw as { own?: unknown }).own;
  const total = (raw as { total?: unknown }).total;
  if (typeof own !== "number" || !Number.isFinite(own) || own <= 0) return null;
  if (typeof total !== "number" || !Number.isFinite(total) || total < own) return null;
  return { own, total };
}

function buildProvenance(holding: PortfolioHolding): PricingProvenance {
  const vendor = coerceVendor((holding as { sourceVendor?: string }).sourceVendor);
  const vendorUpdatedAt =
    typeof (holding as { sourceVendorUpdatedAt?: string }).sourceVendorUpdatedAt === "string"
      ? (holding as { sourceVendorUpdatedAt: string }).sourceVendorUpdatedAt
      : null;
  const pricingSource = coercePricingSource((holding as { pricingSource?: string }).pricingSource);
  const meta = (holding as { pricingSourceMeta?: { slug?: string; method?: string; compsUsed?: number; confidence?: unknown } })
    .pricingSourceMeta;
  const pricingSourceMeta =
    meta && typeof meta.slug === "string" && typeof meta.method === "string" && typeof meta.compsUsed === "number"
      ? {
          slug: meta.slug,
          method: meta.method,
          compsUsed: meta.compsUsed,
          // The engine's pricing confidence for THIS price surface. Absent
          // on price surfaces written before CF-REPORT-CONFIDENCE-IS-PRICING.
          confidence: unitOrNull(meta.confidence),
        }
      : null;

  return {
    vendor,
    vendorUpdatedAt,
    pricingSource,
    pricingSourceMeta,
    // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the same
    // validated read the list wire does, so the detail sheet and the row
    // cannot disagree about whether a price is self-anchored.
    pricingLabels: pricingLabelsOf(holding),
    selfAnchored: selfAnchoredOf(holding),
    // CF-WITHHELD-REACHES-THE-GLASS (Drew, 2026-09-05). Read INDEPENDENTLY of
    // `pricingSourceMeta` above: that projection is gated on slug+method+
    // compsUsed all being present, and a refusal with no pool at all
    // (identity-not-in-catalog) carries none of them. Gating the refusal on
    // the published-price shape is precisely how it stayed invisible.
    withheld: withheldOf(holding),
    nearestGradedAnchor: holding.nearestGradedAnchor ?? null,
    lastSaleSurface: holding.lastSaleSurface ?? null,
    modelExpectation: (holding as { modelExpectation?: unknown }).modelExpectation ?? null,
    modelSignal: (holding as { modelSignal?: unknown }).modelSignal ?? null,
  };
}

function coerceVendor(raw: unknown): PricingProvenance["vendor"] {
  if (raw === "cardhedge" || raw === "cardsight" || raw === "hobbyiq-pool" || raw === "ebay" || raw === "manual") {
    return raw;
  }
  return null;
}

function coercePricingSource(raw: unknown): PricingProvenance["pricingSource"] {
  if (raw === "our-pool" || raw === "legacy-engine") return raw;
  return null;
}

// ─── Quality ───────────────────────────────────────────────────────────

function buildQuality(
  holding: PortfolioHolding,
  freshness: "Live" | "Updated Today" | "Yesterday" | "Needs refresh",
): PricingQuality {
  // score / flaggedCompCount / sources are hobbyIqFmv-inline fields that
  // are NOT persisted onto the holding today (per audit Section 1.10).
  // Emit null / empty here; a follow-up CF persists them so this section
  // can be populated end-to-end.
  return {
    score: null,
    flaggedCompCount: null,
    sources: [],
    freshness,
    lastPricedAt:
      typeof holding.predictedPriceUpdatedAt === "string"
        ? holding.predictedPriceUpdatedAt
        : typeof holding.movementUpdatedAt === "string"
          ? holding.movementUpdatedAt
          : typeof holding.lastUpdated === "string"
            ? holding.lastUpdated
            : null,
  };
}

// ─── Composite v3 ──────────────────────────────────────────────────────

function buildComposite(holding: PortfolioHolding): PricingComposite | null {
  // The composite v3 enrichment writes to sold_comps rows, not to the
  // holding doc. Placeholder null until CF-PERSIST-COMPOSITE-ON-HOLDING
  // ships. Kept in the envelope now so iOS + web bind against the final
  // shape from day one — the field becomes populated later without any
  // client-side change.
  const composite = (holding as { composite?: Record<string, unknown> }).composite;
  if (!composite || typeof composite !== "object") return null;
  return {
    era: str(composite.era),
    colorFamily: str(composite.colorFamily),
    finishModifier: str(composite.finishModifier),
    edition: str(composite.edition),
    ladderVerdict: str(composite.ladderVerdict),
    paniniColorEquivalent: str(composite.paniniColorEquivalent),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ─── Population ────────────────────────────────────────────────────────

function buildPopulation(holding: PortfolioHolding): PricingPopulation | null {
  // Same story as composite — population lives on the hobbyIqFmv response
  // today, not on the holding. Read a field from the holding if present
  // (future-proof), else return null.
  const pop = (holding as { population?: Record<string, unknown> }).population;
  if (!pop || typeof pop !== "object") return null;
  return {
    psa: coercePopGrader(pop.psa),
    bgs: coercePopGrader(pop.bgs),
    sgc: coercePopGrader(pop.sgc),
    cgc: coercePopGrader(pop.cgc),
  };
}

function coercePopGrader(v: unknown): { total: number; byGrade: Record<string, number> } | null {
  if (!v || typeof v !== "object") return null;
  const total = (v as { total?: unknown }).total;
  const byGrade = (v as { byGrade?: unknown }).byGrade;
  if (typeof total !== "number" || !byGrade || typeof byGrade !== "object") return null;
  return { total, byGrade: byGrade as Record<string, number> };
}

// ─── util ──────────────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
