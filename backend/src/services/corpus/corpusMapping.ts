/**
 * Adapter from the CompIQ pricing route's response shape to the corpus
 * {@link BuildCorpusEntryOptions} shape. Lives in services/corpus/ so
 * route files don't need to know what's in CorpusEntry — they call this
 * one helper and pass the result to {@link writeCorpusEntry}.
 *
 * Field mapping rules (one source of truth for the route-→-corpus
 * transformation):
 *
 *   result.fairMarketValueLive  →  response.fairMarketValueLive
 *   result.confidence           →  response.confidence
 *   result.pricingEngine        →  response.pricingEngine   (default "monolith")
 *   result.engineVersion        →  response.engineVersion   (default "unknown")
 *   result.compsUsed            →  response.sampleSize      (renamed)
 *   (no source)                 →  response.marketState              (null — aspirational)
 *   (no source)                 →  response.marketStateSchemaVersion (0   — aspirational)
 *
 * `marketState` is documented as aspirational on the CorpusEntry type
 * (@aspirationalFields). The pricing engine does not yet emit a market
 * state value through the /search, /price, /price-by-id, or /bulk
 * routes. Until it does, this helper writes the null + version=0
 * sentinel, which is the documented "engine did not emit" encoding.
 *
 * querySource rule (schema v2):
 *
 *   If the pricing request includes a non-empty free-text `query`, the
 *   corpus entry stores that query with querySource: "free_text".
 *
 *   If the request doesn't include `query` (the /price-by-id case
 *   where the caller pinned the request to a Cardsight UUID), the
 *   corpus entry stores `cardId` in the `query` field with
 *   querySource: "card_id". This is "self-describing semantics" —
 *   the discriminator tells downstream analysts how to read the slot.
 *   (Pre-2026-05-30 this slot held a Card Hedge cardHedgeCardId; the
 *   CF-CARDHEDGE-HARD-CUTOVER migration moved the pinned-id namespace
 *   to Cardsight UUIDs. CF-CH-P5/P6 re-introduced CardHedge as a comp
 *   vendor — provenance is captured on response.chProvenance and the
 *   pinned id remains the Cardsight UUID for stable analytics joins.)
 *
 *   All other endpoints (/search, /price, /bulk) only carry free-text
 *   queries and so always pass querySource: "free_text". Callers are
 *   the source of truth for the discriminator; this helper does NOT
 *   infer it.
 *
 * Engine-emission contract:
 *
 *   This helper reads `result.fairMarketValueLive` directly. There is
 *   no fallback to `result.marketTier.value`. Pricing endpoints are
 *   expected to emit `fairMarketValueLive` at the top level of their
 *   response (Option X — engine symmetry; see PR #2b discussion).
 *   If a future endpoint forgets to emit it, the corpus will record
 *   `null` and the bulk-shape test will fail loudly — by design.
 */

import {
  buildCorpusEntry,
  type CorpusEntry,
} from "../../models/corpusEntry.js";

/** Loose typing for the route's response object — we only read whitelisted fields. */
interface PricingRouteResult {
  fairMarketValueLive?: number | null;
  confidence?: number | null;
  pricingEngine?: string;
  engineVersion?: string;
  compsUsed?: number | null;
  // CF-CH-P6-CORPUS: the engine attribution from P5. When set to
  // "cardhedge" this mapper synthesizes chProvenance on the corpus row;
  // any other value (including null/undefined) emits a Cardsight-style
  // row byte-identical to pre-P6 behavior (additive invariant).
  estimateSource?: string | null;
  // CF-CH-P6-CORPUS: optional richer CH attribution surfaced by the
  // engine when available. Both fields are forward-compat hooks — the
  // engine doesn't surface them yet; when it does, the chProvenance
  // block on the corpus row will pick them up without a mapper change.
  chCardId?: string | null;
  chTrustReason?: "prices_by_card_honest" | "title_cohesion_strong" | string | null;
  // CF-CH-THIN-COMP-PRIMARY (2026-06-26): comp count from CH's getCardSales
  // (the count the trust-guard accepted). Read into chProvenance.compCount
  // when the engine surfaces it. Older engines emit no value and the
  // chProvenance block omits the field entirely.
  chCompCount?: number | null;
  // ...other fields exist on the real result object; this helper ignores them.
}

/**
 * Discriminated args for building a corpus entry from a pricing route
 * result. Callers pass the query slot and the discriminator explicitly;
 * the helper does NOT infer querySource from arg presence (callers are
 * the source of truth for what semantic they want to record).
 */
export interface CorpusEntryFromPricingResultArgs {
  /**
   * Value to store in the corpus `query` field. Interpretation depends
   * on `querySource`: a literal user search string ("free_text") or a
   * Card Hedge cardHedgeCardId ("card_id").
   */
  query: string;

  /** Discriminator describing how to read `query`. See JSDoc above. */
  querySource: "free_text" | "card_id";

  /** Route path that produced the response. */
  endpoint: string;

  /** Wall-clock milliseconds spent producing the response. */
  durationMs: number;

  /** The route's JSON response object (post-cache). */
  result: PricingRouteResult | null | undefined;
}

/**
 * Build a {@link CorpusEntry} from the inputs available at a CompIQ
 * route handler's response site.
 */
export function corpusEntryFromPricingResult(
  args: CorpusEntryFromPricingResultArgs,
): CorpusEntry {
  // CF-CH-P6-CORPUS: when the engine attributed this estimate to
  // CardHedge (estimateSource === "cardhedge", set by P5), synthesize
  // a chProvenance block carrying vendor + the optional id/trust hooks.
  // For any other estimateSource (or undefined) the block is omitted
  // entirely, preserving byte-identical Cardsight-row emission.
  //
  // Explicit construction (not conditional-spread) keeps the inferred
  // type aligned with BuildCorpusEntryOptions.response.chProvenance —
  // conditional spreads produce `string | undefined` keys which tsc
  // strict rejects against a `chCardId?: string` field.
  type ChProv = {
    vendor: "cardhedge";
    chCardId?: string;
    trustReason?: "prices_by_card_honest" | "title_cohesion_strong";
    compCount?: number;
  };
  let chProvenance: ChProv | undefined;
  // CF-CH-THIN-COMP-PRIMARY (2026-06-26): "cardhedge-last-sale" is the
  // n==1 thin-CH variant of "cardhedge" — same vendor provenance, with
  // chProvenance.compCount carrying the singular sale's count. Both
  // estimateSource values synthesize the same chProvenance block; any
  // other value (or undefined) emits a Cardsight-shape row byte-identical
  // to pre-P6 behavior (additive invariant preserved).
  const isChSource =
    args.result?.estimateSource === "cardhedge" ||
    args.result?.estimateSource === "cardhedge-last-sale";
  if (isChSource) {
    chProvenance = { vendor: "cardhedge" };
    if (typeof args.result?.chCardId === "string" && args.result.chCardId) {
      chProvenance.chCardId = args.result.chCardId;
    }
    if (
      args.result?.chTrustReason === "prices_by_card_honest" ||
      args.result?.chTrustReason === "title_cohesion_strong"
    ) {
      chProvenance.trustReason = args.result.chTrustReason;
    }
    if (
      typeof args.result?.chCompCount === "number" &&
      Number.isFinite(args.result.chCompCount) &&
      args.result.chCompCount > 0
    ) {
      chProvenance.compCount = Math.floor(args.result.chCompCount);
    }
  }

  return buildCorpusEntry({
    query: args.query,
    querySource: args.querySource,
    endpoint: args.endpoint,
    durationMs: args.durationMs,
    clock: { iso: () => new Date().toISOString() },
    response: {
      fairMarketValueLive: args.result?.fairMarketValueLive ?? null,
      confidence: args.result?.confidence ?? null,
      pricingEngine: args.result?.pricingEngine ?? "monolith",
      engineVersion: args.result?.engineVersion ?? "unknown",
      marketState: null,
      marketStateSchemaVersion: 0,
      sampleSize: args.result?.compsUsed ?? null,
      ...(chProvenance ? { chProvenance } : {}),
    },
  });
}
