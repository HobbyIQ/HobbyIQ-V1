// CF-PARALLEL-COLLECTOR-ALIASES (Drew, 2026-07-13, PR #410): display-time
// name translation from Cardsight-canonical parallel labels to the names
// collectors actually use in the market.
//
// Motivation: Cardsight indexes the 2026 Bowman Chrome CPA-EHA /150 as
// "Blue X-Fractor". Collectors, sellers, and eBay listings almost
// universally call it "Blue Refractor". When a user searches "Blue
// Refractor Eric Hartman" and the app shows a card labeled "Blue
// X-Fractor", they second-guess whether it's the same card — even though
// the underlying cardId is correct.
//
// This module rewrites the display-facing `parallel` string at the
// dispatcher's search-hit composer (see routedCardToIdentity in
// dispatcher.ts). The underlying cardId is unchanged; the resolver, the
// pricing engine, and every downstream consumer of the cardId continue
// to work identically. Only the human-facing label shifts.
//
// The mapping is intentionally conservative — one entry per known
// Cardsight-canonical / collector-common mismatch, gated by cardNumber
// prefix so we don't accidentally rename a genuine X-Fractor (a
// different parallel exists in some sets — Topps Chrome TCA-* / TSA-*
// autos, for example) into a Refractor.
//
// Add a new alias by dropping a row into COLLECTOR_ALIASES with:
//   - cardNumberPrefixes: patterns that gate the rewrite (e.g. ["CPA-"])
//   - cardsightName: the parallel string as Cardsight emits it (case-insensitive match)
//   - collectorName: the parallel string collectors use
//   - reason: a short prose reason for the alias (for the log line)
//
// Each rewrite is logged so we can audit hit rate + verify we're only
// rewriting where intended.

export interface ParallelAlias {
  cardNumberPrefixes: readonly string[];
  cardsightName: string;
  collectorName: string;
  reason: string;
}

// Curated aliases — add rows here as they're confirmed by user reports.
// Each entry MUST include at least one cardNumberPrefix so the rewrite
// is scoped, never blanket.
//
// EMPTY BY DESIGN AS OF 2026-07-13 revert (Drew): the previous alias row
// mapped Cardsight "Blue X-Fractor" → collector "Blue Refractor" for
// CPA-* card numbers, on the assumption that Cardsight was using a
// different name for the same physical card. Drew confirmed these are
// TWO DISTINCT VARIANTS in 2026 Bowman Chrome CPA-EHA:
//   - Blue Refractor lives on CardHedge (cardId befe9bcc-e7e8-…)
//   - Blue X-Fractor lives on Cardsight (cardId 1778542140951x…)
// Aliasing between them would show users the wrong variant with the
// right-sounding name — a materially worse UX than the label confusion
// the alias was meant to fix. Table is intentionally empty until we
// find a case where two vendors use different names for THE SAME card.
const COLLECTOR_ALIASES: readonly ParallelAlias[] = [];

/**
 * Normalize a search-hit's parallel label from Cardsight-canonical to
 * collector-common. Returns the input unchanged when no alias matches.
 * Case-insensitive on parallel names; case-sensitive on card-number
 * prefix (prefixes are always uppercase alpha).
 */
export function applyCollectorAlias(
  parallel: string | null | undefined,
  cardNumber: string | null | undefined,
): { parallel: string | null; aliased: boolean; alias?: ParallelAlias } {
  if (!parallel || typeof parallel !== "string") {
    return { parallel: parallel ?? null, aliased: false };
  }
  if (!cardNumber || typeof cardNumber !== "string") {
    return { parallel, aliased: false };
  }
  const parallelLower = parallel.trim().toLowerCase();
  const cardNumberUpper = cardNumber.trim().toUpperCase();
  for (const alias of COLLECTOR_ALIASES) {
    if (alias.cardsightName.toLowerCase() !== parallelLower) continue;
    const prefixHit = alias.cardNumberPrefixes.some((p) =>
      cardNumberUpper.startsWith(p),
    );
    if (!prefixHit) continue;
    return { parallel: alias.collectorName, aliased: true, alias };
  }
  return { parallel, aliased: false };
}

/**
 * REVERSE direction: expand a collector-common query into the set of
 * Cardsight-canonical variants it might refer to. Used by the search
 * layer so a user typing "Blue Refractor" also surfaces "Blue X-Fractor"
 * hits without requiring them to know Cardsight's naming.
 *
 * Returns the input unchanged plus any aliases whose collectorName
 * substring-matches. Callers can OR-join the expansion into their
 * vendor query.
 */
export function expandCollectorQuery(query: string): {
  original: string;
  expansions: string[];
} {
  const qLower = query.toLowerCase();
  const expansions: string[] = [];
  for (const alias of COLLECTOR_ALIASES) {
    if (qLower.includes(alias.collectorName.toLowerCase())) {
      expansions.push(alias.cardsightName);
    }
  }
  return { original: query, expansions };
}

/** Read-only view for tests + audits. */
export function _listCollectorAliases(): readonly ParallelAlias[] {
  return COLLECTOR_ALIASES;
}
