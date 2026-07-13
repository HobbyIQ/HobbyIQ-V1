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

  const candidates: CardIdentity[] = [];
  for (let i = 0; i < topHits.length; i++) {
    const hit = topHits[i];
    const detail = details[i];
    if (!detail || detail.notFound) continue;
    candidates.push(uuidHitToCardIdentity(hit, detail, i, topHits.length));
  }
  return candidates;
}

/**
 * Convert a Cardsight-native (UUID + detail) hit into the CardIdentity
 * wire shape. Emits:
 *   - candidateId: `cardsight:{uuid}` — the parent card. iOS strips the
 *     prefix and sends the raw UUID to /price-by-id.
 *   - parallels[]: the full parallels tree so iOS' picker synth can
 *     render one row per variant.
 *   - source: "catalog" (vendor-neutral, matches CH-routed candidates).
 *   - confidence: linear decay by search index. AI-match boost isn't
 *     applicable here (no AI matcher ran on the direct API).
 */
function uuidHitToCardIdentity(
  hit: CardsightCatalogHit,
  detail: CardsightCardDetail,
  index: number,
  total: number,
): CardIdentity {
  const yearNum = detail.year != null && Number.isFinite(Number(detail.year))
    ? Number(detail.year)
    : hit.year ?? null;
  const setName = detail.setName ?? hit.setName ?? null;
  const releaseName = detail.releaseName ?? hit.releaseName ?? null;

  const parallels: CardParallel[] = (detail.parallels ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    ...(typeof p.numberedTo === "number" ? { numberedTo: p.numberedTo } : {}),
  }));

  const span = Math.max(total, 1);
  const confidence = Math.max(0.3, 1 - (index / span) * 0.6);

  return {
    candidateId: `cardsight:${detail.id}`,
    source: "catalog",
    attribution: "ranked",
    confidence: Math.round(confidence * 100) / 100,
    player: detail.name ?? hit.player ?? hit.name ?? null,
    year: yearNum,
    brand: null,
    setName,
    cardNumber: detail.number ?? hit.number ?? null,
    parallel: null,
    variation: null,
    isAuto: /(auto|autograph)/i.test(String(setName ?? "")) ||
            /^CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA-|AU-/i.test(
              String(detail.number ?? hit.number ?? ""),
            ),
    serialNumber: null,
    grade: null,
    gradeCompany: null,
    gradeValue: null,
    certNumber: null,
    totalPopulation: null,
    populationHigher: null,
    title:
      [yearNum, releaseName, setName, detail.name, detail.number]
        .map((p) => (p == null ? "" : String(p).trim()))
        .filter((p) => p.length > 0)
        .join(" "),
    imageUrl: null,
    parallels,
    raw: { hit, detail },
  };
}
