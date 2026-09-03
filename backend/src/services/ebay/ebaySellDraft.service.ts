/**
 * CF-EBAY-SELL-LOOP (Drew, 2026-09-02). "From a holding, List on eBay."
 *
 * The draft a seller sees before anything is published: title, price,
 * condition, description — every one of them derived from HobbyIQ's own
 * numbers, and every one of them able to say WHERE it came from.
 *
 * WHAT THIS MODULE IS FOR
 * -----------------------
 * `/api/ebay/listings/prepare` already assembled identity, condition,
 * photos and category aspects from the holding. The one thing it could
 * not do honestly was the PRICE. It read:
 *
 *     h.predictedPrice ?? h.fairMarketValue ?? h.estimatedValue
 *
 * — a stored snapshot, written by whatever repriced the holding last,
 * with no record of which rung produced it, how old it is, or whether it
 * was speculative. A seller pricing a card off that number is pricing off
 * a field, not off the engine, and cannot be told what the number means.
 *
 * THE DOCTRINE THIS ENFORCES
 * --------------------------
 * The price in a draft is the ENGINE's canonical projection with its
 * label, never a client-side number and never a stored one recomputed by
 * hand. FMV is the projected next sale from the comp pool's trend — never
 * a median, never a mean (feedback_no_medians_project_next_sale). So this
 * module calls computeCanonicalFmv and serves what it answers, together
 * with `rungLabel` from the closed vocabulary in fmvRung.ts.
 *
 * It computes NOTHING. There is no multiplier here, no blend, no rounding
 * policy that could move a price, no fallback that invents a number when
 * the engine declined. When the engine returns null the draft has no
 * price and says so — the seller fills it in themselves, and the draft
 * reports that the number is theirs, not ours.
 *
 * LABELS TRAVEL INTO THE DRAFT TEXT
 * ---------------------------------
 * A speculative or self-anchored value does not get to arrive in a
 * listing description looking like a market price. Three carry-throughs,
 * all of them visible to the seller AND written into the description
 * block when the basis is disclosed:
 *
 *   - `player-index-projection` — the card's own pool went cold and the
 *     number rode the PLAYER's index forward. Speculative, and the word
 *     appears (project_player_trend_speculation_rung).
 *   - a pool whose comps include the seller's OWN purchase — self-
 *     anchored, and it says so (project_self_comp_publish_labeled: own
 *     purchase anchors WITH label).
 *   - any rung that is not an exact-pool rung — the number came from a
 *     neighbouring parallel, a family baseline or another grade, and the
 *     honest sentence names that.
 *
 * The exact-pool test is `isExactPoolRung`, the same predicate the
 * divergence digest uses. There is one vocabulary, and this is it.
 */

import {
  computeCanonicalFmv,
  type CanonicalFmvResult,
} from "../compiq/canonicalFmv.service.js";
import { isExactPoolRung, type FmvRungLabel } from "../compiq/fmvRung.js";
import { isOwnCompForSingleUserContext } from "../compiq/selfComp.js";
import {
  deriveSellWindowSignal,
  type SellWindowSignal,
} from "../signals/sellWindow.service.js";
import type { TrendIQResult } from "../compiq/trendIQ.types.js";

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** The holding fields the composer reads. A loose shape on purpose: the
 *  prepare route hands us a raw Cosmos holding record, and every field
 *  here is optional because a holding under review may be missing any of
 *  them. Nothing is defaulted into a value that could move a price. */
export interface SellDraftHolding {
  cardId?: string | null;
  hobbyiqCardId?: string | null;
  playerName?: string | null;
  cardYear?: number | null;
  product?: string | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  grade?: string | null;
  printRun?: number | null;
  isAuto?: boolean | null;
  sport?: string | null;
  /** Persisted trend result — the sell-window signal's only input. */
  trendIQ?: TrendIQResult | null;
  confidence?: number | null;
  lastUpdated?: string | null;
}

/** Why the draft carries no engine price. */
export type SellDraftPriceStatus =
  /** The engine answered with a number. */
  | "engine"
  /** The engine ran and declined (no rung produced a value). */
  | "engine-declined"
  /** The holding has no identity to price — nothing to ask the engine. */
  | "no-identity"
  /** The engine call itself failed. */
  | "engine-error";

/** A label the seller must see, and that travels into the description. */
export interface SellDraftLabel {
  /** Machine-readable, for clients that want to style it. */
  code: "speculative" | "self-anchored" | "fallback-rung" | "low-confidence";
  /** The sentence shown to the seller and written into the draft text. */
  text: string;
}

export interface SellDraftPricing {
  status: SellDraftPriceStatus;
  /** The engine's projected next sale, in cents. Null when not `engine`. */
  priceCents: number | null;
  /** The rung that produced it — the closed fmvRung.ts vocabulary. */
  rungLabel: FmvRungLabel | null;
  /** True iff the number came from the exact (identity, grade) pool. */
  exactPool: boolean;
  /** Engine confidence, 0..1. */
  confidence: number | null;
  /** The engine's own provenance sentence. Never rewritten here. */
  basis: string | null;
  /** How many comps fed the projection — the EVIDENCE POOL total from
   *  the engine (`provenance.compCount`), not the length of the display
   *  sample. `provenance.comps` is truncated to 8-10 rows by
   *  canonicalFmv.service.ts, so its length would understate a 726-comp
   *  pool as "8 sales" in buyer-facing listing text. */
  compCount: number;
  /** Observed range behind the point projection, when the engine gave one. */
  range: { n: number; min: number; median: number; max: number } | null;
  /** ISO timestamp of the compute. */
  computedAt: string | null;
  /** Labels that MUST be shown and MUST reach the description. */
  labels: SellDraftLabel[];
  /** Why there is no price, when status is not `engine`. */
  declineReason: string | null;
}

export interface SellDraftPriceContext {
  pricing: SellDraftPricing;
  /** The sell-window signal for this holding, when one fires. Never
   *  affects the price — it says WHEN, not WHAT. */
  sellSignal: SellWindowSignal | null;
}

// ---------------------------------------------------------------------------
// Label derivation
// ---------------------------------------------------------------------------

/** Confidence below which the draft says so in words. Matches the sell-
 *  window module's MIN_CONFIDENCE floor — the same line the rest of the
 *  seller surface already treats as "thin". */
export const DRAFT_LOW_CONFIDENCE = 0.35;

/**
 * The number of sales a reader is entitled to hear, for THIS result.
 *
 * CF-COMP-COUNT-IS-THE-POOL (Drew, 2026-09-02). The engine reports the
 * evidence pool on `provenance.compCount`; `provenance.comps` is only a
 * display sample, truncated to the first 8-10 rows
 * (canonicalFmv.service.ts slices it at every rung that has comps). A
 * card with 726 same-parallel comps would otherwise tell a buyer "Based
 * on 8 sales", and a self-anchored draft would say "1 of 8" when the
 * truth is "1 of 15".
 *
 * Rungs 4-5 anchor on a family median rather than a comp pool and report
 * `compCount: null` — those drafts say nothing about sale counts, which
 * is why null degrades to the sample length (itself empty there, so the
 * "Based on N sales" line is correctly suppressed). The sample is the
 * fallback for results minted before this field existed, and it can only
 * understate, never overstate.
 */
function evidenceCount(result: CanonicalFmvResult): number {
  const total = result.provenance?.compCount;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
    return Math.floor(total);
  }
  return (result.provenance?.comps ?? []).length;
}

/** Comp sources that mean "this sale was the seller's own transaction".
 *  soldCompsStore keys a holding-derived comp `holding::<id>`; an import
 *  that carried a real eBay order id keeps that id but is still flagged
 *  by `verifiedByUser`. Either one makes the pool self-anchored. */
// CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). This predicate used to test
// only `verifiedByUser === true` or a `holding::` source prefix. A D38 eBay
// import satisfies NEITHER: it writes source "ebay-user-purchase" with
// verifiedByUser FALSE on purpose (the identity came from the matcher, not
// from the user confirming it by hand -- ebayImportRematch.routes.ts:186).
// So the Verlander/Caglianone/Judge rows were self-comps that no surface ever
// recognised as the user's own, and the "self-anchored" label never fired on
// the very rows it exists for. Delegates to the shared predicate now.
function isSelfComp(c: { source: string; verifiedByUser: boolean }): boolean {
  return isOwnCompForSingleUserContext(c);
}

/**
 * The labels a result must carry into the draft.
 *
 * Order is deliberate — speculative first, because it is the strongest
 * claim about the number's softness, then self-anchored, then the generic
 * fallback-rung note, then confidence. A draft can carry several.
 */
export function labelsForResult(result: CanonicalFmvResult): SellDraftLabel[] {
  const labels: SellDraftLabel[] = [];
  const rung = result.rungLabel ?? null;

  if (rung === "player-index-projection") {
    labels.push({
      code: "speculative",
      text:
        "Speculative: this card's own sales went cold, so the estimate is its " +
        "last real sale carried forward on the player's market — not a recent " +
        "sale of this card.",
    });
  }

  // `provenance.comps` is a DISPLAY SAMPLE (truncated to 8-10 by
  // canonicalFmv.service.ts). The honest denominator is the engine's
  // own pool total; fall back to the sample only when the rung reports
  // no count at all.
  const comps = result.provenance?.comps ?? [];
  const poolTotal = evidenceCount(result);
  const selfComps = comps.filter(isSelfComp);
  if (selfComps.length > 0) {
    // Self-comps are counted in the sample but stated against the pool,
    // so a truncated sample can only understate the ratio, never claim
    // more of the pool is self-anchored than actually is.
    const allSelf = selfComps.length === poolTotal;
    labels.push({
      code: "self-anchored",
      text: allSelf
        ? "Self-anchored: the only sale behind this estimate is your own purchase " +
          "of this card. No independent sale supports it yet."
        : `Partly self-anchored: ${selfComps.length} of ${poolTotal} sales behind ` +
          "this estimate are your own.",
    });
  }

  // A fallback rung is worth saying only when the stronger labels have not
  // already explained the softness — player-index-projection IS a fallback
  // rung, and saying so twice adds nothing.
  if (rung && !isExactPoolRung(rung) && rung !== "player-index-projection") {
    labels.push({
      code: "fallback-rung",
      text:
        "Estimated: no sales of this exact card at this grade, so the price " +
        `comes from a related pool (${rung}).`,
    });
  }

  if (typeof result.confidence === "number" && result.confidence < DRAFT_LOW_CONFIDENCE) {
    labels.push({
      code: "low-confidence",
      text:
        `Low confidence (${result.confidence.toFixed(2)}) — thin evidence behind ` +
        "this number. Check the comps before you list.",
    });
  }

  return labels;
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/** The identity to price against, or null when there is none. */
function identityOf(h: SellDraftHolding): string | null {
  const hiq = String(h.hobbyiqCardId ?? "").trim();
  if (hiq) return hiq;
  const cardId = String(h.cardId ?? "").trim();
  return cardId || null;
}

/**
 * Price a holding for a listing draft.
 *
 * The ONLY price path for the sell loop. Calls the engine, serves what it
 * answers, and derives the labels — it never computes, adjusts or floors
 * a number, and on any decline it returns a null price rather than a
 * guess. `computeFmv` is injectable so the pins can drive it without a
 * pool; production callers pass nothing.
 */
export async function composeSellDraftPricing(
  holding: SellDraftHolding,
  deps?: {
    computeFmv?: (
      input: Parameters<typeof computeCanonicalFmv>[0],
    ) => Promise<CanonicalFmvResult>;
  },
): Promise<SellDraftPriceContext> {
  // The sell signal rides on the holding's already-persisted trend, so it
  // is derived the same way the portfolio envelope derives it — pure,
  // synchronous, zero pool reads, and it can never move the price.
  const sellSignal = deriveSellWindowSignal({
    trendIQ: holding.trendIQ ?? null,
    confidence: typeof holding.confidence === "number" ? holding.confidence : null,
    trendUpdatedAt: typeof holding.lastUpdated === "string" ? holding.lastUpdated : null,
  });

  const empty = (
    status: SellDraftPriceStatus,
    declineReason: string,
  ): SellDraftPriceContext => ({
    pricing: {
      status,
      priceCents: null,
      rungLabel: null,
      exactPool: false,
      confidence: null,
      basis: null,
      compCount: 0,
      range: null,
      computedAt: null,
      labels: [],
      declineReason,
    },
    sellSignal,
  });

  const cardId = identityOf(holding);
  if (!cardId) {
    return empty(
      "no-identity",
      "This holding has no confirmed card identity, so HobbyIQ has no pool to " +
        "price it from. Set the identity first, or enter your own price.",
    );
  }

  const compute = deps?.computeFmv ?? computeCanonicalFmv;

  let result: CanonicalFmvResult;
  try {
    result = await compute({
      cardId,
      parallel: holding.parallel ?? null,
      gradeCompany: holding.gradeCompany ?? null,
      gradeValue: typeof holding.gradeValue === "number" ? holding.gradeValue : null,
      cardYear: typeof holding.cardYear === "number" ? holding.cardYear : null,
      product: holding.product ?? holding.setName ?? null,
      player: holding.playerName ?? null,
      cardNumber: holding.cardNumber ?? null,
    });
  } catch (err) {
    return empty(
      "engine-error",
      `Pricing engine unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.fmv === null || !(result.fmv > 0)) {
    const ctx = empty(
      "engine-declined",
      result.provenance?.summary ??
        "HobbyIQ has no sales it trusts for this card, so it is not projecting a price.",
    );
    // A decline still reports the rung that declined — `no-basis` is a
    // rung name, and a reader deserves it.
    ctx.pricing.rungLabel = result.rungLabel ?? null;
    ctx.pricing.computedAt = result.computedAt ?? null;
    return ctx;
  }

  const range = result.recentRange
    ? {
        n: result.recentRange.n,
        min: result.recentRange.min,
        median: result.recentRange.median,
        max: result.recentRange.max,
      }
    : null;

  return {
    pricing: {
      status: "engine",
      // Cents, from the engine's dollars. Rounding to the cent is a
      // representation change, not a valuation one.
      priceCents: Math.round(result.fmv * 100),
      rungLabel: result.rungLabel ?? null,
      exactPool: isExactPoolRung(result.rungLabel),
      confidence: typeof result.confidence === "number" ? result.confidence : null,
      basis: result.provenance?.summary ?? null,
      compCount: evidenceCount(result),
      range,
      computedAt: result.computedAt ?? null,
      labels: labelsForResult(result),
      declineReason: null,
    },
    sellSignal,
  };
}

// ---------------------------------------------------------------------------
// The description block
// ---------------------------------------------------------------------------

/** HTML-escape — the basis sentence and the labels are engine-authored,
 *  but they reach a listing body, so they get escaped like any other
 *  interpolated text. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain-English sibling of a rung label, for the one line a buyer reads.
 *  The rung label itself is machine vocabulary. Any rung without an entry
 *  falls back to the label — better a raw rung name than a friendly wrong
 *  one. */
const RUNG_PROSE: Partial<Record<FmvRungLabel, string>> = {
  "exact-pool-projection": "the sales trend for this exact card and grade",
  "exact-pool-last-sale": "the most recent sale of this exact card and grade",
  "exact-pool-leading-edge": "the newest sales of this exact card and grade",
  "exact-pool-weighted-median": "recent sales of this exact card and grade",
  "exact-pool-median": "sales of this exact card and grade",
  "exact-pool-trajectory": "this card's own sales at this grade",
  "graded-pool-inverse": "this card's own graded sales, scaled to this grade",
  "cross-grade-fallback": "this card's sales at another grade",
  "grade-curve-estimate": "an estimated grade curve, not sales at this grade",
  "player-index-projection": "this card's last real sale, carried on the player's market",
  "sibling-estimate": "a related card of the same player",
};

/**
 * The seller-facing basis block appended to a listing description.
 *
 * It is HONEST by construction: it names the rung in plain words, quotes
 * the comp count and range when there is one, and reproduces EVERY label
 * verbatim. A speculative or self-anchored price cannot reach a buyer
 * without the sentence that says so — that is the whole point of the
 * block, and why the labels are not summarised or dropped when there are
 * several.
 *
 * Returns "" when there is no engine price. A draft with a seller-entered
 * price makes no claim on HobbyIQ's behalf, so it gets no HobbyIQ basis.
 */
export function buildBasisBlock(pricing: SellDraftPricing): string {
  if (pricing.status !== "engine" || pricing.priceCents === null) return "";

  const lines: string[] = [];
  const price = (pricing.priceCents / 100).toFixed(2);

  lines.push("<hr/>");
  lines.push("<b>How this price was set</b>");

  const prose = pricing.rungLabel ? RUNG_PROSE[pricing.rungLabel] : null;
  const from =
    prose ?? (pricing.rungLabel ? `rung: ${pricing.rungLabel}` : "HobbyIQ's pricing engine");
  lines.push(`Asking $${price} — HobbyIQ's projected next sale, from ${esc(from)}.`);

  if (pricing.compCount > 0) {
    const sales = `${pricing.compCount} sale${pricing.compCount === 1 ? "" : "s"}`;
    if (pricing.range && pricing.range.n > 0) {
      lines.push(
        `Based on ${sales} (observed range $${pricing.range.min.toFixed(2)}-` +
          `$${pricing.range.max.toFixed(2)}, median $${pricing.range.median.toFixed(2)}).`,
      );
    } else {
      lines.push(`Based on ${sales}.`);
    }
  }

  // Every label, verbatim. This is the honesty contract.
  for (const l of pricing.labels) {
    lines.push(`<i>${esc(l.text)}</i>`);
  }

  lines.push("<small>Priced with HobbyIQ. Projection, not a guarantee.</small>");

  return lines.join("<br/>");
}

/**
 * Compose the full listing description: the seller's own body (or the
 * generated card block the listing service builds) followed by the basis
 * block. Kept separate from buildBasisBlock so a caller can render the
 * basis on its own in a review UI without duplicating the body.
 */
export function appendBasisBlock(body: string, pricing: SellDraftPricing): string {
  const block = buildBasisBlock(pricing);
  if (!block) return body;
  return body ? `${body}<br/><br/>${block}` : block;
}

/**
 * The one-line summary a seller sees next to the price field, before any
 * of this reaches a listing. Mirrors the block's honesty in a single
 * sentence: what the number is, and the loudest label on it.
 */
export function priceSummaryLine(pricing: SellDraftPricing): string {
  if (pricing.status !== "engine" || pricing.priceCents === null) {
    return pricing.declineReason ?? "No HobbyIQ price for this card - enter your own.";
  }
  const price = (pricing.priceCents / 100).toFixed(2);
  const prose = pricing.rungLabel ? RUNG_PROSE[pricing.rungLabel] : null;
  const head = `$${price} - projected next sale from ${prose ?? pricing.rungLabel ?? "HobbyIQ"}`;
  const loudest = pricing.labels[0];
  return loudest ? `${head}. ${loudest.text}` : `${head}.`;
}
