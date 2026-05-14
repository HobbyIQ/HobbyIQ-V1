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
 *   where the caller pinned the request to a Card Hedge card_id), the
 *   corpus entry stores `cardHedgeCardId` in the `query` field with
 *   querySource: "card_id". This is "self-describing semantics" —
 *   the discriminator tells downstream analysts how to read the slot.
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
    },
  });
}
