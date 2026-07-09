/**
 * CF-SAME-PLAYER-SIBLINGS (2026-07-08, Drew):
 *
 * Given a resolved card identity, fetch the SAME player's OTHER
 * variants in the SAME set. Powers a "similar cards" surface on iOS
 * — when a user opens a card panel, they see a carousel of the same
 * player's other parallels (Blue Refractor, Purple, Orange Auto,
 * etc.) with prices, so they can jump between variants.
 *
 * The current sibling-fallback service (siblingCardPriceFallback)
 * has similar plumbing but a different purpose: it PICKS ONE sibling
 * to anchor pricing on. This service is the enumeration variant —
 * returns the full list, sorted by relevance (highest sales first).
 *
 * Cache: results cached 12h per (year, set, player) key so cheap
 * card-panel repeat-hits don't re-fetch CH.
 *
 * Never throws — errors return an empty array so the panel renders
 * without the sibling carousel.
 */

import { searchCards as chSearchCards, type CardHedgeCard } from "./cardhedge.client.js";

const SIBLING_TAKE_DEFAULT = 20;
const SIBLING_CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // 12h

const siblingCache = new Map<
  string,
  { value: SamePlayerSibling[]; expiresAt: number }
>();

export interface SamePlayerSibling {
  cardId: string;
  variant: string;
  subset: string | null;
  isAuto: boolean;
  averagePrice90d: number | null;
  sales90d: number;
  /** True when this row is the same card_id as the caller passed in.
   *  iOS should filter it out of the "similar cards" surface. */
  isSelf: boolean;
}

export interface SamePlayerSiblingsInput {
  /** Optional — when provided, the returned list marks the matching
   *  row with `isSelf: true` so iOS can filter it out. */
  selfCardId?: string;
  year: number;
  set: string;
  playerName: string;
}

/**
 * Fetches the same player's other variants in the same set. Returns
 * empty array on any error (never throws) so the caller's response
 * body still renders cleanly.
 */
export async function getSamePlayerSiblings(
  input: SamePlayerSiblingsInput,
  opts: { take?: number } = {},
): Promise<SamePlayerSibling[]> {
  if (!input.playerName || !input.set || !input.year) return [];
  const take = opts.take ?? SIBLING_TAKE_DEFAULT;

  const cacheKey = `${input.year}|${normalize(input.set)}|${normalize(input.playerName)}|${take}`;
  const now = Date.now();
  const cached = siblingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return markSelf(cached.value, input.selfCardId);
  }

  try {
    const search = `${input.year} ${input.set} ${input.playerName}`;
    const results: CardHedgeCard[] = await chSearchCards(search, take * 2, {
      player: input.playerName,
      set: `${input.year} ${input.set}`,
    });

    const siblings: SamePlayerSibling[] = [];
    for (const c of results) {
      if (!c.card_id || !c.variant) continue;
      const player = (c.player ?? "").trim().toLowerCase();
      // Guard against CH's known mis-attribution (player field says X but
      // description clearly names a different player). Same guard as
      // CF-SIBLING-PICKER-SURNAME-GUARD in siblingCardPriceFallback.
      const surname = extractSurname(input.playerName);
      const textBlob = `${c.title ?? ""} ${c.name ?? ""} ${c.subset ?? ""}`.toLowerCase();
      const surnameOK = !surname || textBlob.includes(surname);
      const playerOK = player && player === input.playerName.trim().toLowerCase();
      if (!surnameOK && !playerOK) continue;

      const priceRaw = (c as { price?: string | number }).price;
      const salesRaw = (c as { "90_day_sales"?: number | string })["90_day_sales"];
      const averagePrice90d =
        priceRaw != null && Number.isFinite(parseFloat(String(priceRaw))) && parseFloat(String(priceRaw)) > 0
          ? Math.round(parseFloat(String(priceRaw)) * 100) / 100
          : null;
      const sales90d = Number.isFinite(Number(salesRaw)) ? Number(salesRaw) : 0;
      const isAuto = detectAutoFromCard(c);

      siblings.push({
        cardId: c.card_id,
        variant: c.variant,
        subset: c.subset ?? null,
        isAuto,
        averagePrice90d,
        sales90d,
        isSelf: false,
      });
    }

    // Sort: prefer active-trading first (higher 90d_sales), then higher
    // price, then variant name alphabetical.
    siblings.sort((a, b) => {
      if (b.sales90d !== a.sales90d) return b.sales90d - a.sales90d;
      if ((b.averagePrice90d ?? 0) !== (a.averagePrice90d ?? 0)) {
        return (b.averagePrice90d ?? 0) - (a.averagePrice90d ?? 0);
      }
      return a.variant.localeCompare(b.variant);
    });

    const trimmed = siblings.slice(0, take);
    siblingCache.set(cacheKey, { value: trimmed, expiresAt: now + SIBLING_CACHE_TTL_MS });
    return markSelf(trimmed, input.selfCardId);
  } catch (err) {
    console.warn(
      `[samePlayerSiblings] failed for ${input.year} ${input.set} ${input.playerName}: ${(err as Error)?.message ?? err}`,
    );
    return [];
  }
}

function markSelf(list: SamePlayerSibling[], selfCardId?: string): SamePlayerSibling[] {
  if (!selfCardId) return list;
  return list.map((s) => ({ ...s, isSelf: s.cardId === selfCardId }));
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Extract last-name token for the same guard used in
 * siblingCardPriceFallback. Duplicated intentionally — this leaf
 * service should not depend on siblingCardPriceFallback's internals.
 */
function extractSurname(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const parts = fullName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
  let last = parts[parts.length - 1];
  if (suffixes.has(last) && parts.length >= 2) {
    last = parts[parts.length - 2];
  }
  if (last.length < 4) return null;
  return last;
}

/**
 * Detect auto from CardHedgeCard fields. Same logic as
 * extractCardClass in compiq.routes.ts.
 */
function detectAutoFromCard(c: CardHedgeCard): boolean {
  const subset = (c.subset ?? "").toLowerCase();
  if (subset.includes("auto") || subset.includes("signat")) return true;
  const title = (c.title ?? "").toLowerCase();
  const name = (c.name ?? "").toLowerCase();
  const blob = `${title} ${name}`;
  if (blob.includes(" auto") || blob.includes("autograph")) return true;
  const number = String(c.number ?? "").toLowerCase();
  const AUTO_PREFIX_RE = /(?:^|\b)(?:cpa|bcp-a|bcpa|bpa|pa|cra|ra|bcra|bsa|bca|tca|usa|au|bba|bspa|fa|roa)[- ]/i;
  if (number && AUTO_PREFIX_RE.test(number)) return true;
  return false;
}

/** Test hook. */
export function _resetSiblingsCacheForTesting(): void {
  siblingCache.clear();
}
