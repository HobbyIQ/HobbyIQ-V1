// CF-CARDSIGHT-UUID-NATIVE (Drew, 2026-07-13, PR #412): direct-Cardsight
// UUID search source, adjacent to the CH-routed dispatcher path.
//
// Motivation: CH's catalog snapshot uses bubble.io-format Cardsight IDs
// (e.g. "1778542140951x283396404010038530"). Those work but Cardsight's
// current /v1 API uses UUID cardIds (e.g. befe9bcc-...) and exposes the
// full parallels tree — Blue Refractor, Blue X-Fractor, Speckle, Purple,
// all 40 for a Bowman Chrome auto — as child records under a parent
// card. CH's snapshot flattens this so a search for "Eric Hartman"
// returns one bubble.io ID per parallel that CH happened to index; the
// remaining variants never surface.
//
// This module hits Cardsight's /v1/catalog/search + /v1/catalog/cards
// directly, then emits ONE CardIdentity per parent card with the full
// parallels[] array populated. iOS' picker (CompIQVariantPickerView's
// parallelHit synth) explodes those into per-parallel picker rows so
// the user can pick the exact variant.
//
// Latency: N+1 model — one search (~200ms), then top-K detail fetches
// (~150ms each, capped at 5 for latency). Falls through to empty on
// any error so the CH path stays authoritative.

import type { CardIdentity, CardParallel } from "../../types/cardIdentity.js";
import {
  searchCatalog,
  getCardDetail,
  isCardsightConfigured,
  type CardsightCatalogHit,
  type CardsightCardDetail,
} from "./cardsightSlim.client.js";

/** Detail-fetch cap so a broad search doesn't fan out N calls. */
const DETAIL_FETCH_CAP = 5;
/** Search page size — 30 covers "eric hartman" with room to spare. */
const SEARCH_PAGE_SIZE = 30;

/**
 * Fetch parent-card candidates from Cardsight's native UUID API for a
 * freetext query. Returns CardIdentity rows with parallels[] populated.
 * Returns empty on config-absent / error — never throws.
 */
export async function fetchCardsightUuidNativeCandidates(
  input: string,
): Promise<CardIdentity[]> {
  if (!isCardsightConfigured()) return [];
  const query = input.trim();
  if (query.length === 0) return [];

  let hits: CardsightCatalogHit[];
  try {
    hits = await searchCatalog(query, { take: SEARCH_PAGE_SIZE });
  } catch {
    return [];
  }
  if (!hits || hits.length === 0) return [];

  // Fetch detail for the top N in parallel (parallels[] tree lives here).
  const topHits = hits.slice(0, DETAIL_FETCH_CAP);
  const details = await Promise.all(
    topHits.map(async (hit) => {
      try {
        return await getCardDetail(hit.id);
      } catch {
        return null;
      }
    }),
  );

  // CF-EXPLODE-CARDSIGHT-PARALLELS (Drew, 2026-07-13, PR #413): each
  // Cardsight UUID parent explodes into N candidates, one per parallel
  // in detail.parallels[]. Every reconciliation / picker surface sees
  // Blue Refractor, Blue X-Fractor, Speckle, etc. as first-class rows
  // — no client-side parent-expansion needed.
  //
  // The parent card itself is NOT emitted separately here — CH's
  // bubble.io-routed path already covers the "Base" row for well-known
  // sets. Emitting the parent AND all parallels would double-render.
  //
  // Compound candidateId encoding: `cardsight:{parentId}::{parallelId}`.
  // iOS strips the `cardsight:` prefix and sends the rest as `cardId`
  // to /price-by-id. The route parses the `::` separator and threads
  // both IDs to the Cardsight-native price router.
  const candidates: CardIdentity[] = [];
  for (let i = 0; i < topHits.length; i++) {
    const hit = topHits[i];
    const detail = details[i];
    if (!detail || detail.notFound) continue;
    const rows = explodeParentIntoParallels(hit, detail, i, topHits.length);
    candidates.push(...rows);
  }
  return candidates;
}

/**
 * CF-EXPLODE-CARDSIGHT-PARALLELS (Drew, 2026-07-13, PR #413): explode a
 * Cardsight UUID parent into N candidates — one per parallel — so every
 * reconciliation / picker / iOS-native surface sees each variant as a
 * first-class row without any client-side expansion.
 *
 * Row identity: `candidateId: cardsight:{parentId}::{parallelId}`.
 * The `::` separator is chosen because UUIDs contain hyphens but never
 * consecutive colons. iOS strips the `cardsight:` prefix (existing
 * behavior) and passes the rest as `cardId` to /price-by-id; the route
 * parses `::` and routes to Cardsight-native pricing with both IDs.
 *
 * The parent card itself (Base row) is NOT emitted here because CH's
 * bubble.io-routed path already covers it in the standard candidate
 * list. Emitting the parent AND all parallels would double-render.
 *
 * Some parallels have "informational" names (e.g. "Breaker Delight
 * Exclusive Parallels:", "Retail Exclusive Parallels:") that Cardsight
 * uses as headers for sub-groups. Those are filtered out — they aren't
 * real variants.
 */
function explodeParentIntoParallels(
  hit: CardsightCatalogHit,
  detail: CardsightCardDetail,
  parentIndex: number,
  totalParents: number,
): CardIdentity[] {
  const yearNum = detail.year != null && Number.isFinite(Number(detail.year))
    ? Number(detail.year)
    : hit.year ?? null;
  const setName = detail.setName ?? hit.setName ?? null;
  const releaseName = detail.releaseName ?? hit.releaseName ?? null;
  const cardNumber = detail.number ?? hit.number ?? null;
  const player = detail.name ?? hit.player ?? hit.name ?? null;
  const isAuto =
    /(auto|autograph)/i.test(String(setName ?? "")) ||
    /^CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA-|AU-/i.test(
      String(cardNumber ?? ""),
    );

  const cleanedParallels: CardParallel[] = (detail.parallels ?? [])
    .filter((p) => p.id && p.name && !isSubgroupHeader(p.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      ...(typeof p.numberedTo === "number" ? { numberedTo: p.numberedTo } : {}),
    }));

  // Confidence decays parent-by-parent (top parents rank higher than
  // trailing parents), then within a parent by parallel index. Slight
  // per-parallel decay so PSA-like popularity ranking is preserved when
  // the picker sorts by confidence descending.
  const parentSpan = Math.max(totalParents, 1);
  const parentConfidence = Math.max(0.3, 1 - (parentIndex / parentSpan) * 0.6);

  return cleanedParallels.map((par, parIndex) => {
    const perParallelDrop = Math.min(0.05, parIndex * 0.001);
    const confidence = Math.max(0.3, parentConfidence - perParallelDrop);
    return {
      candidateId: `cardsight:${detail.id}::${par.id}`,
      source: "catalog",
      attribution: "ranked",
      confidence: Math.round(confidence * 100) / 100,
      player,
      year: yearNum,
      brand: null,
      setName,
      cardNumber,
      parallel: par.name,
      variation: null,
      isAuto,
      serialNumber: null,
      grade: null,
      gradeCompany: null,
      gradeValue: null,
      certNumber: null,
      totalPopulation: null,
      populationHigher: null,
      title:
        [yearNum, releaseName, setName, player, cardNumber, par.name]
          .map((p) => (p == null ? "" : String(p).trim()))
          .filter((p) => p.length > 0)
          .join(" "),
      imageUrl: null,
      // No parallels[] on exploded rows — the row IS the parallel.
      parallels: [],
      raw: { hit, detail, parallel: par },
    };
  });
}

/**
 * Cardsight sometimes uses parallel entries as sub-group headers
 * ("Breaker Delight Exclusive Parallels:", "Retail Exclusive Parallels:",
 * "Variety Pack Exclusive Parallels:") — trailing colon is the tell.
 * Skip these when exploding into candidate rows.
 */
function isSubgroupHeader(name: string): boolean {
  return name.trim().endsWith(":");
}
