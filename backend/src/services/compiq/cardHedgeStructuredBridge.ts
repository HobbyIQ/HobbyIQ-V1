// CF-CH-STRUCTURED-BRIDGE (Drew, 2026-07-15): structured lookup via
// CardHedge's /v1/cards/card-search endpoint. Bypass CH's AI matcher
// for backend re-pricing paths where we ALREADY know the structured
// fields (playerName, cardYear, cardNumber). The AI matcher's whole
// purpose is fuzzy user-facing search; when we have exact fields it's
// wasteful and error-prone to go through it.
//
// Companion to CF-CH-RAW-QUERY (PR #464): raw-query fix handles the
// USER free-text case (feed AI what user typed); this handles the
// BACKEND holding-reprice case (skip AI, filter by exact fields).
//
// Uses cardhedge.client.searchCards which already wraps the endpoint
// with caching + filter param handling.
//
// Env-gate: CH_STRUCTURED_BRIDGE_ENABLED=true. Fires as an additional
// tier in resolveChCardId when the AI matcher returns no match /
// low-confidence AND we have structured identity fields to work with.

import { searchCards, type CardHedgeCard } from "./cardhedge.client.js";
import type { CardIdentityHint } from "./cardsight.router.js";

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, source: "cardHedgeStructuredBridge", ...fields }));
};

const STRUCTURED_CONFIDENCE = 0.85;
const SEARCH_PAGE_SIZE = 30;

/**
 * Structured CardHedge bridge — filter by (player, year, cardNumber)
 * locally and return a single canonical cardId when we have a clear
 * winner. Returns null when the AI matcher would still be the better
 * choice (ambiguous multi-match, no card_number to disambiguate, no
 * player, catalog literally has no such card).
 *
 * The confidence stamp (0.85) is deliberately BELOW the AI matcher's
 * 0.9-1.0 range — structured-match is high-confidence but not AI-
 * verified. If both fire, the AI matcher wins on confidence.
 */
export async function structuredCardHedgeBridge(
  identity: CardIdentityHint,
): Promise<{ chCardId: string; confidence: number } | null> {
  if (process.env.CH_STRUCTURED_BRIDGE_ENABLED !== "true") return null;

  const player = identity.playerName?.trim();
  if (!player || player.length < 2) return null;
  const wantNumber = identity.number?.trim().toLowerCase();
  // Card number is the strongest disambiguator. Without it we'd pick
  // arbitrarily among all a player's cards — worse than letting the
  // AI matcher handle it. Skip when absent.
  if (!wantNumber) return null;

  const wantYear = typeof identity.cardYear === "number"
    ? identity.cardYear
    : identity.cardYear != null ? parseInt(String(identity.cardYear), 10) : null;

  let candidates: CardHedgeCard[];
  try {
    // Use playerName as `search` text AND filter — belt-and-suspenders
    // (some CH endpoints require search to be non-empty; the player
    // filter narrows further). Baseball category is hardcoded in
    // searchCards for now.
    candidates = await searchCards(player, SEARCH_PAGE_SIZE, { player }, 1);
  } catch (err) {
    log("structured_bridge.search_error", {
      player,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }
  if (candidates.length === 0) {
    log("structured_bridge.no_candidates", { player });
    return null;
  }

  // Filter by exact card number (case-insensitive). Year filter is a
  // soft constraint — if identity has a year, prefer candidates that
  // match; only if year-matched pool is empty fall back to unfiltered.
  const numberMatches = candidates.filter(
    (c) => String(c.number ?? "").trim().toLowerCase() === wantNumber,
  );
  if (numberMatches.length === 0) {
    log("structured_bridge.no_number_match", {
      player,
      wantNumber,
      candidateCount: candidates.length,
    });
    return null;
  }

  // If year is known, narrow further. Otherwise accept the number-only pool.
  let finalPool = numberMatches;
  if (wantYear != null && Number.isFinite(wantYear)) {
    const yearMatches = numberMatches.filter((c) => {
      const cy = typeof c.year === "number" ? c.year : parseInt(String(c.year ?? ""), 10);
      return Number.isFinite(cy) && cy === wantYear;
    });
    if (yearMatches.length > 0) finalPool = yearMatches;
  }

  // If parallel is known and multiple candidates remain, prefer the
  // one whose variant contains the identity.parallel string.
  const wantParallel = identity.parallel?.trim().toLowerCase();
  if (finalPool.length > 1 && wantParallel) {
    const parallelMatches = finalPool.filter((c) => {
      const v = String(c.variant ?? "").toLowerCase();
      return v.includes(wantParallel) || wantParallel.includes(v);
    });
    if (parallelMatches.length > 0) finalPool = parallelMatches;
  }

  // Take the first candidate. If exactly one → clean win. If still
  // multiple, we accept the top result — CH's search returns them
  // in relevance order which is usually the right pick.
  const winner = finalPool[0];
  if (!winner?.card_id) {
    log("structured_bridge.no_winner_card_id", { player, poolSize: finalPool.length });
    return null;
  }

  log("structured_bridge.served", {
    player,
    wantNumber,
    wantYear,
    wantParallel,
    chCardId: winner.card_id,
    matchedVariant: winner.variant,
    finalPoolSize: finalPool.length,
    initialCandidateCount: candidates.length,
  });

  return {
    chCardId: winner.card_id,
    confidence: STRUCTURED_CONFIDENCE,
  };
}
