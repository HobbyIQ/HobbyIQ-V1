/**
 * CF-THE-LEGACY-WIRE-HAS-A-VOCABULARY-TOO (2026-09-05).
 *
 * `source` on the free-text wires (`/api/compiq/search` and its `/price`
 * alias) is NOT the rung vocabulary. Those routes still answer from the
 * legacy CardHedge estimate pipeline, whose `est.source` is set dynamically
 * at a dozen sites in `compiqEstimate.service.ts` and then read out by the
 * route as `(est.source as string | undefined) ?? "live"`.
 *
 * D16 (#1483) put `/price-by-id` behind `computeCanonicalValuation`, so THAT
 * wire's `source` became the rung (`fmvRung.ts` owns it). The free-text wires
 * did not move, so two vocabularies are live at once and a consumer that
 * knows only one of them will reject good responses from the other.
 *
 * That is exactly how this file came to exist. The Tier 1 harness asserted
 * `source` against a hand-maintained list; #1809 taught it to ask
 * `FMV_RUNG_LABELS`, which fixed the rung half — and the harness stayed red,
 * because the legacy half answered `"projected"`, a value no list held. The
 * lesson `fmvRung.ts` already records applies identically here:
 *
 *     "the persist layer no longer keeps a list: it asks the vocabulary."
 *
 * So the legacy pipeline gets a declared vocabulary too, next to the code
 * that emits it, and every consumer asks THIS rather than keeping a private
 * copy that silently falls behind.
 *
 * SCOPE. Response-level `source` values only. The per-sale provenance field
 * on a comp row (`source: "cardhedge"`, `"ebay"`, `"sold_comps"`) is a
 * different field on a different object and is deliberately not listed here.
 *
 * Pure data: no I/O, no clock.
 */

/**
 * Every value the legacy estimate pipeline can put on a free-text response's
 * `source`. Grouped by where it is decided; each entry is emitted by
 * `compiqEstimate.service.ts` unless noted.
 */
export const LEGACY_ESTIMATE_SOURCES = [
  // The ordinary answer: a real pool priced the card.
  "live",

  // CF-AUTO-PROJECTION-FALLBACK. `applyAutoProjectionFallbacks`
  // (compiq.routes.ts) UPGRADES a comp-less autograph estimate to a
  // projection from a sibling auto or a base card × the auto premium, and
  // relabels the response so the client can tell a projection from a
  // measured price. Three assignment sites, one meaning.
  "projected",

  // Refusals — the engine has an identity but declines to price it.
  //
  // CF-A-POISONED-CACHE-REFUSES (compiq.routes.ts,
  // `buildUnresolvedRouteResponse`). /price-by-id detects a MISMATCH between
  // the id it was asked for and the id the cached payload carries — Frazier's
  // card_id under Trout's key — recomputes once bypassing the cache, and when
  // the fresh result is STILL mismatched answers this shape rather than
  // pricing the wrong card and re-poisoning the cache. It is a route-level
  // refusal, so it carries no rungLabel, valueSource or fmvReason at all,
  // which is how it reads on the wire and why it belongs here rather than in
  // the rung vocabulary.
  "unresolved",
  "no-recent-comps",   // catalog HIT, no sales
  "catalog-miss",      // catalog MISS — zero candidates
  "variant-mismatch",  // the comps found are a different variant
  "unsupported_sport", // identified as a sport outside launch scope
  "out-of-scope",      // pre-modern, intentionally out of launch scope
  "upstream-timeout",  // an upstream vendor exceeded its budget (HTTP 200)

  // Pooled / synthesised answers.
  "sibling-pool",       // pinned parallel empty; siblings of the base card pooled
  "neighbor-synthesis", // synthesised from neighbouring parallels
  "ebay",               // eBay-sourced pricing path

  // CF-NO-NULL-PRICING (2026-07-11) — the tiered fallback stack. These names
  // predate the rung vocabulary and are still what the legacy wire emits.
  "product-family-projection",  // parent-product median × family multiplier
  "parallel-floor-projection",  // parent median × parallel print-run floor
  "scarcity-prior-floor",       // product-year cross-player anchor × parallel floor
  "reference-catalog-baseline", // era baseline × ladder tier
  "setdoc-baseline",            // era × set-type baseline (last resort)
] as const;

export type LegacyEstimateSource = (typeof LEGACY_ESTIMATE_SOURCES)[number];

const LEGACY_SOURCE_SET: ReadonlySet<string> = new Set<string>(LEGACY_ESTIMATE_SOURCES);

/** True iff the label is a source the legacy estimate pipeline can emit. */
export function isLegacyEstimateSource(label: unknown): label is LegacyEstimateSource {
  return typeof label === "string" && LEGACY_SOURCE_SET.has(label);
}
