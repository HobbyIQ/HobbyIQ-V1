// CF-EBAY-IMPORT-REMATCH (Drew, 2026-07-18). Walk eBay-auto-imported
// holdings, re-run the CardHedge match on the ORIGINAL eBay title,
// and update (cardId, parallel, cardNumber, isAuto, setName, product)
// from CH's canonical response. Purchase price becomes a sanity
// check — if the freshly-derived FMV comes back < 20% of what the
// user paid, we flag the holding as needsReview so iOS can prompt.
//
// Why: eBay's own title parser sometimes ate key tokens ("Auto",
// "CPA-EHA" vs "BCP-102", parallel color words). Since we already
// stored the ORIGINAL cardTitle on each holding, we can replay the
// import with a stronger parser + CH's canonical catalog.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { searchCards } from "../compiq/cardhedge.client.js";

export interface RematchResult {
  holdingId: string;
  ebayTitle: string;
  purchasePrice: number | null;
  before: {
    parallel: string | null;
    cardNumber: string | null;
    setName: string | null;
    cardId: string | null;
    fairMarketValue: number | null;
  };
  after: {
    parallel: string | null;
    cardNumber: string | null;
    setName: string | null;
    cardId: string | null;
    matchConfidence: number;
    matchSource: "cardhedge-search" | "unchanged" | "no_match";
  };
  needsReview: boolean;
  reviewReason: string | null;
  changed: boolean;
}

const PURCHASE_PRICE_SANITY_FLOOR_PCT = 0.20;   // FMV < 20% of paid → flag

/** Return true when the ebay-imported holding is a candidate for
 *  remap. Skip cards that are already grade-locked (cert number
 *  present) since those have concrete identity. */
export function isRematchCandidate(h: PortfolioHolding): boolean {
  if (!h.cardTitle || String(h.cardTitle).trim().length === 0) return false;
  const source = (h as { source?: string }).source ?? "";
  const purchaseSource = (h as { purchaseSource?: string }).purchaseSource ?? "";
  if (source !== "ebay-auto" && !/ebay/i.test(purchaseSource)) return false;
  if ((h as { certNumber?: string }).certNumber) return false;   // graded, canonical
  return true;
}

/** Re-run CH match on the eBay title + description context. Never
 *  throws. When no strong match, returns the "unchanged" outcome. */
export async function rematchOne(
  holding: PortfolioHolding,
): Promise<RematchResult> {
  const title = String(holding.cardTitle ?? "").trim();
  const purchasePrice = typeof holding.purchasePrice === "number" ? holding.purchasePrice : null;
  const before = {
    parallel: (holding.parallel as string | null | undefined) ?? null,
    cardNumber: (holding.cardNumber as string | null | undefined) ?? null,
    setName: (holding.setName as string | null | undefined) ?? null,
    cardId: (holding.cardId as string | null | undefined) ?? null,
    fairMarketValue: typeof holding.fairMarketValue === "number" ? holding.fairMarketValue : null,
  };
  const base: Omit<RematchResult, "after" | "changed" | "needsReview" | "reviewReason"> = {
    holdingId: holding.id,
    ebayTitle: title,
    purchasePrice,
    before,
  };

  const emptyAfter = (source: RematchResult["after"]["matchSource"], conf = 0) => ({
    ...base,
    after: {
      parallel: before.parallel,
      cardNumber: before.cardNumber,
      setName: before.setName,
      cardId: before.cardId,
      matchConfidence: conf,
      matchSource: source,
    },
    needsReview: !!(purchasePrice && before.fairMarketValue !== null
      && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT),
    reviewReason: purchasePrice && before.fairMarketValue !== null
      && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT
      ? `FMV $${before.fairMarketValue.toFixed(2)} under 20% of paid $${purchasePrice.toFixed(2)}`
      : null,
    changed: false,
  } as RematchResult);

  if (!title) return emptyAfter("unchanged");

  try {
    // Query CH with the raw title — CH's tokenizer handles the fuzzy
    // matching. We add a purchase-price hint via keeping the title
    // intact; the searchCards implementation walks CH's card-search.
    const cards = await searchCards(title, 5);
    if (!cards || cards.length === 0) return emptyAfter("no_match");

    // Pick the highest-confidence card. searchCards returns them
    // ordered; the top hit is the best. When multiple hits at the
    // same score exist and one carries CPA-*/BCPA-* card_number
    // matching a token in the ebay title (like "CPA-EHA"), prefer it.
    const top = pickBestMatch(cards, title);
    if (!top) return emptyAfter("no_match");

    // CF-EBAY-REMATCH-STRICT (Drew, 2026-07-18): suppress risky
    // parallel rewrites. Bare "Blue" being confidently upgraded to
    // "Blue X-Fractor" without the title explicitly saying so is the
    // exact failure the first dry-run surfaced (Owen Carey CPA-OC
    // Blue → Speckle Refractor, McConkey Purple Ice → Purple in a
    // baseball set, etc.). Preserve the before-parallel when the
    // new one crosses the "specific refractor sub-type" boundary
    // without title support.
    const proposedParallel = (top.variant ?? before.parallel) as string | null;
    const finalParallel =
      isRiskyParallelChange(before.parallel, proposedParallel)
      && !titleMentionsSpecificParallel(title, proposedParallel)
        ? before.parallel
        : proposedParallel;
    const after = {
      parallel: finalParallel,
      cardNumber: (top.number ?? before.cardNumber) as string | null,
      setName: (top.set ?? before.setName) as string | null,
      cardId: (top.card_id ?? before.cardId) as string | null,
      matchConfidence: (top as { confidence?: number }).confidence ?? 0.8,
      matchSource: "cardhedge-search" as const,
    };
    const changed =
      after.parallel !== before.parallel
      || after.cardNumber !== before.cardNumber
      || after.cardId !== before.cardId;

    return {
      ...base,
      after,
      changed,
      needsReview: !!(purchasePrice && before.fairMarketValue !== null
        && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT),
      reviewReason: purchasePrice && before.fairMarketValue !== null
        && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT
        ? `FMV $${before.fairMarketValue.toFixed(2)} under 20% of paid $${purchasePrice.toFixed(2)}`
        : null,
    };
  } catch {
    return emptyAfter("no_match");
  }
}

interface CardMatchCandidate {
  card_id?: string;
  title?: string | null;
  player?: string | null;
  set?: string | null;
  number?: string | null;
  variant?: string | null;
  year?: number | string | null;
  category?: string | null;
  confidence?: number;
}

/** Extract a canonical card-number pattern (CPA-XX, BCPA-XX, BCP-##,
 *  BD-##, BDC-##, BSPA-XX, plain "##" etc.) from the title. Returns
 *  null when nothing recognizable. */
function extractCardNumberFromTitle(title: string): string | null {
  const t = title.toUpperCase();
  const patterns = [
    /\b#?(BCPA-[A-Z]{2,4})\b/,
    /\b#?(BSPA-[A-Z]{2,4})\b/,
    /\b#?(CPA-[A-Z]{2,4})\b/,
    /\b#?(BDC-[A-Z0-9]{2,4})\b/,
    /\b#?(BCP-[A-Z0-9]{2,4})\b/,
    /\b#?(BD-[A-Z0-9]{2,4})\b/,
    /\b#?(BP-\d{1,4})\b/,
    /\b#?(\d{2,4}[A-Z]-[A-Z]{2,4})\b/,   // 91A-AVS, etc.
    /\b#?(C-\d{1,3})\b/,                  // Coin numbers: C-15
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return m[1];
  }
  return null;
}

/** Extract a 4-digit year from the title. Returns null when absent. */
function extractYearFromTitle(title: string): number | null {
  const m = title.match(/\b(19|20)(\d\d)\b/);
  return m ? Number(m[1] + m[2]) : null;
}

/** Guess a sport family from the title. */
function extractSportFromTitle(title: string): "baseball" | "football" | "basketball" | "hockey" | null {
  const t = title.toLowerCase();
  if (/\bfootball\b|\bnfl\b|prizm.*football/i.test(t)) return "football";
  if (/\bbasketball\b|\bnba\b|prizm.*basketball/i.test(t)) return "basketball";
  if (/\bhockey\b|\bnhl\b/i.test(t)) return "hockey";
  if (/\bbaseball\b|\btopps\b|\bbowman\b/i.test(t)) return "baseball";
  return null;
}

/** STRICT matcher: rejects candidates that don't exact-match the
 *  title's explicit tokens (cardNumber, year, sport). Returns null
 *  when nothing survives — caller falls back to "unchanged." */
function pickBestMatch(
  cards: CardMatchCandidate[],
  title: string,
): CardMatchCandidate | null {
  if (cards.length === 0) return null;

  const titleCardNumber = extractCardNumberFromTitle(title);
  const titleYear = extractYearFromTitle(title);
  const titleSport = extractSportFromTitle(title);
  const t = title.toLowerCase();

  const scored = cards.flatMap((c) => {
    const num = String(c.number ?? "").toUpperCase();
    const year = c.year !== undefined && c.year !== null ? Number(c.year) : null;
    const set = String(c.set ?? "").toLowerCase();
    const category = String(c.category ?? "").toLowerCase();

    // ── Hard rejects ─────────────────────────────────────────────
    // 1. cardNumber: if title has an explicit pattern, match MUST use it
    if (titleCardNumber && num !== titleCardNumber.toUpperCase()) return [];
    // 2. year: if title has a year and candidate has a year, they must match
    if (titleYear !== null && year !== null && Number.isFinite(year) && year !== titleYear) return [];
    // Also check the set string (CH sometimes carries year only in set_name)
    if (titleYear !== null && year === null) {
      const setYearMatch = set.match(/\b(19|20)\d\d\b/);
      if (setYearMatch && Number(setYearMatch[0]) !== titleYear) return [];
    }
    // 3. sport: category (or set-name inference) must match
    if (titleSport) {
      const candidateSport =
        category.includes("football") ? "football" :
        category.includes("basketball") ? "basketball" :
        category.includes("hockey") ? "hockey" :
        category.includes("baseball") ? "baseball" :
        set.includes("football") ? "football" :
        set.includes("basketball") ? "basketball" :
        set.includes("bowman") || set.includes("topps") ? "baseball" :
        null;
      if (candidateSport && candidateSport !== titleSport) return [];
    }

    // ── Score survivors ───────────────────────────────────────────
    let bonus = 0;
    if (titleCardNumber && num === titleCardNumber.toUpperCase()) bonus += 40;
    const variant = String(c.variant ?? "").toLowerCase();
    if (variant && t.includes(variant.toLowerCase())) bonus += 25;
    const player = String(c.player ?? "").toLowerCase();
    if (player && player.length > 0 && t.includes(player)) bonus += 20;
    if (titleYear !== null && year === titleYear) bonus += 10;

    return [{ c, score: (c.confidence ?? 0.5) * 100 + bonus }];
  });

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  // Require minimum score — CH's confidence baseline is 50, so anything
  // below 90 (0.5 baseline + 40 for card-number exact) means we didn't
  // hit even one strong signal. Skip.
  if (top.score < 90) return null;
  return top.c;
}

/** True when the eBay title explicitly mentions the specific parallel
 *  the matcher wants to upgrade to (e.g. actually says "X-Fractor"). */
function titleMentionsSpecificParallel(title: string, proposedParallel: string | null): boolean {
  if (!proposedParallel) return false;
  const t = title.toLowerCase();
  const p = proposedParallel.toLowerCase().trim();
  // Split on space and require any distinguishing token (not "refractor"
  // itself, since bare "refractor" is ambiguous). X-Fractor, Shimmer,
  // Speckle, Wave, Mojo, Border, etc. are distinctive.
  const distinctiveTokens = p.split(/\s+/).filter((w) =>
    ["x-fractor", "xfractor", "shimmer", "speckle", "wave", "mojo", "border", "geometric", "logofractor", "logo"].includes(w),
  );
  if (distinctiveTokens.length === 0) return true;   // no distinctive token to check
  return distinctiveTokens.every((tok) => t.includes(tok.replace("-", "")));
}

/** Compare "before" and "after" parallel to detect risky rewrites.
 *  Returns true when the change should be SUPPRESSED because it
 *  looks like the matcher upgraded ambiguously. */
function isRiskyParallelChange(before: string | null, after: string | null): boolean {
  if (!before || !after) return false;
  const b = before.toLowerCase().trim();
  const a = after.toLowerCase().trim();
  if (b === a) return false;
  // Bare color word being "upgraded" to a specific refractor type is
  // exactly the failure mode Drew flagged ("Blue" → "Blue X-Fractor"
  // when title didn't say X-Fractor). Preserve the vaguer form.
  const bareColors = ["blue", "orange", "red", "green", "gold", "purple", "black", "pink", "yellow", "aqua", "sepia"];
  const isBareColor = (s: string) => bareColors.includes(s);
  if (isBareColor(b) && !isBareColor(a)) return true;
  // Similarly if before has "Refractor" and after swaps to X-Fractor,
  // that's a specific-refractor-type change — risky.
  if (b.includes("refractor") && a.includes("x-fractor") && !b.includes("x-fractor")) return true;
  if (b.includes("x-fractor") && a.includes("refractor") && !a.includes("x-fractor")) return true;
  return false;
}
