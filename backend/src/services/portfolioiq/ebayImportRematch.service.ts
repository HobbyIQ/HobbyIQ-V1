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
import { searchCards, getPriceEstimate } from "../compiq/cardhedge.client.js";

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
    // CF-EBAY-REMATCH-PRICE-VALIDATE (Drew, 2026-07-18): walk the
    // scored candidates in order; for each, fetch CH's Raw price
    // estimate and check whether it's in the ballpark of the user's
    // purchase price. Reject candidates whose price differs by more
    // than an order of magnitude (0.10× or 10×) — that's the "you
    // paid $305 but the match's Raw price is $2" failure mode from
    // the first dry-run. Falls back to unchanged when no candidate
    // survives.
    const candidates = pickRankedMatches(cards, title);
    let top: CardMatchCandidate | null = candidates[0] ?? null;
    if (purchasePrice && purchasePrice > 0 && candidates.length > 0) {
      top = await firstPriceValid(candidates, purchasePrice);
    }
    if (!top) return emptyAfter("no_match");

    // CF-EBAY-REMATCH-TITLE-GUARD (Drew, 2026-07-18): "the name says
    // what it is." Single decision function classifies each parallel
    // change into (accept / preserve-before) based on info-loss vs
    // info-swap vs info-add, with title-support as the escape hatch
    // for swaps/adds only. Losses are never authorized by title.
    const proposedParallel = (top.variant ?? before.parallel) as string | null;
    const finalParallel = shouldSuppressParallelChange(title, before.parallel, proposedParallel)
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
  // CF-EBAY-REMATCH-AUTO-ENFORCE (Drew, 2026-07-18): CH's card-search
  // may return both base + auto variants sharing the same
  // #CPA-*/#BCPA-* cardNumber (autograph subsets). Strict-mode must
  // check is_auto to keep from landing a $180 auto on a $2 base cardId.
  is_auto?: boolean;
  autograph?: boolean;
}

/** Autograph-subset cardNumber prefixes. When a title has any of
 *  these, the card is guaranteed to be an autograph — candidates
 *  without is_auto=true should be rejected outright. */
const AUTO_SUBSET_PREFIXES = ["CPA-", "BCPA-", "BSPA-", "CDA-", "BCDA-", "BDCA-", "PA-"];

function titleCardNumberImpliesAuto(cardNumber: string | null): boolean {
  if (!cardNumber) return false;
  const upper = cardNumber.toUpperCase();
  return AUTO_SUBSET_PREFIXES.some((p) => upper.startsWith(p));
}

function candidateIsAuto(c: CardMatchCandidate): boolean {
  if (c.is_auto === true) return true;
  if (c.autograph === true) return true;
  const cat = String(c.category ?? "").toLowerCase();
  if (cat.includes("autograph") || cat.includes(" auto")) return true;
  const set = String(c.set ?? "").toLowerCase();
  if (set.includes("autograph")) return true;
  const variant = String(c.variant ?? "").toLowerCase();
  if (variant.includes("auto")) return true;
  return false;
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

/** CF-EBAY-REMATCH-PRICE-VALIDATE (2026-07-18): the price-validator
 *  wants to walk candidates in ranked order and test each against
 *  the user's purchase price. `pickRankedMatches` returns the same
 *  strict-filtered survivors as `pickBestMatch` but as an ordered
 *  list, not just the top. */
export function pickRankedMatches(
  cards: CardMatchCandidate[],
  title: string,
): CardMatchCandidate[] {
  const survivors = strictSurvivors(cards, title);
  return survivors.map((s) => s.c);
}

/** Test each candidate's CH Raw price estimate against the user's
 *  purchase price. Return the first candidate whose CH Raw price is
 *  within [purchasePrice × 0.10, purchasePrice × 10] — i.e. within
 *  an order of magnitude. Wider bands might over-accept; narrower
 *  might over-reject. Order-of-magnitude is defensible against the
 *  100× swings the first dry-run produced (e.g. $305 paid vs $2 raw
 *  = 150× off).
 *
 *  Falls back to the top ranked candidate when we can't fetch any
 *  price at all (CH down, cardId unknown). Returns null when every
 *  candidate has a fetched price AND none are in range. */
async function firstPriceValid(
  ranked: CardMatchCandidate[],
  purchasePrice: number,
): Promise<CardMatchCandidate | null> {
  if (ranked.length === 0) return null;
  const lowFloor = purchasePrice * 0.10;
  const highCeil = purchasePrice * 10;
  let anyPriceFetched = false;

  for (const c of ranked) {
    if (!c.card_id) continue;
    try {
      // Raw is the shared grade across autos/non-autos/graded holdings.
      // If the caller's holding is graded, the observed rail derived
      // downstream will re-price at the right tier — Raw here is the
      // "does the SKU value make sense at all" gate.
      const est = await getPriceEstimate(c.card_id, "Raw");
      const price = est?.price ?? null;
      if (price === null || !Number.isFinite(price) || price <= 0) continue;
      anyPriceFetched = true;
      if (price >= lowFloor && price <= highCeil) return c;
    } catch { /* ignore, try next candidate */ }
  }
  // No survivor: if we NEVER got a price back, fall back to top
  // ranked. If we did get prices but none passed, it means every
  // in-range option was rejected → prefer unchanged (null).
  return anyPriceFetched ? null : ranked[0];
}

/** Shared strict-filter + score. Returns ranked survivor list.
 *  Both pickBestMatch and pickRankedMatches use this. */
function strictSurvivors(
  cards: CardMatchCandidate[],
  title: string,
): Array<{ c: CardMatchCandidate; score: number }> {
  if (cards.length === 0) return [];

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
    // (CH encodes auto-ness in the cardNumber prefix — CPA-/BCPA-/BSPA-
    // etc. — so cardNumber-exact match already guarantees any auto-only
    // subset is preserved. A separate is_auto check was tried in PR #568
    // and reverted: CH does not populate an is_auto boolean field, so
    // requiring it hard-rejected every valid auto candidate.)
    if (titleCardNumber && num !== titleCardNumber.toUpperCase()) return [];
    // 1b. auto enforcement: when the title's cardNumber is from an
    // autograph subset (CPA-*, BCPA-*, BSPA-*, etc.), candidates that
    // aren't autos are rejected. This is the fix for the $180-auto-
    // landing-on-$2-base failure mode after PR #563.
    if (titleCardNumber && titleCardNumberImpliesAuto(titleCardNumber) && !candidateIsAuto(c)) return [];
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

  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  // Require minimum score — CH's confidence baseline is 50, so anything
  // below 90 (0.5 baseline + 40 for card-number exact) means we didn't
  // hit even one strong signal. Drop.
  return scored.filter((s) => s.score >= 90);
}

/** STRICT matcher: rejects candidates that don't exact-match the
 *  title's explicit tokens (cardNumber, year, sport). Returns null
 *  when nothing survives — caller falls back to "unchanged." */
function pickBestMatch(
  cards: CardMatchCandidate[],
  title: string,
): CardMatchCandidate | null {
  const survivors = strictSurvivors(cards, title);
  return survivors[0]?.c ?? null;
}

/** Word-list constants shared between title-guard functions. */
const BARE_COLORS = ["blue", "orange", "red", "green", "gold", "purple", "black", "pink", "yellow", "sepia"];
// Distinctive parallel sub-types. NOTE: "aqua" is treated as a
// distinctive sub (not a bare color) because in the Bowman/Topps
// vocabulary Aqua Refractor is a specific SKU, not a generic color.
const DISTINCTIVE_SUBS = [
  "x-fractor", "xfractor", "shimmer", "speckle", "wave",
  "reptilian", "lazer", "sapphire", "aqua", "ice", "mojo",
  "sepia", "true",
  // Bowman/Topps parallel keywords added 2026-07-18 after v4 leaked
  // "Blue" → "Sky Blue Border" (title said just "Blue").
  "border", "sky", "pattern", "geometric", "logofractor", "logo",
  "prizm", "hyper", "silver", "cracked",
];

function hasWord(s: string, word: string): boolean {
  return new RegExp(`\\b${word.replace("-", "\\-")}\\b`).test(s);
}

/** True when the eBay title explicitly mentions the specific parallel
 *  the matcher wants to upgrade to (e.g. actually says "X-Fractor"). */
export function titleMentionsSpecificParallel(title: string, proposedParallel: string | null): boolean {
  if (!proposedParallel) return false;
  const t = title.toLowerCase();
  const p = proposedParallel.toLowerCase().trim();
  const distinctiveTokens = DISTINCTIVE_SUBS.filter((w) => p.includes(w));
  if (distinctiveTokens.length === 0) return true;   // no distinctive token to check
  // Title match: check the exact token AND its dash-stripped form
  // (e.g. "x-fractor" and "xfractor" are interchangeable in the wild).
  return distinctiveTokens.every((tok) => {
    const stripped = tok.replace("-", "");
    return t.includes(tok) || t.includes(stripped);
  });
}

/** CF-EBAY-REMATCH-TITLE-GUARD (Drew, 2026-07-18). Classifies a
 *  proposed parallel change against the eBay title. Returns true when
 *  the change should be SUPPRESSED (preserve before-parallel).
 *
 *  Categories:
 *   - LOSS (color or sub-parallel dropped) → always suppress. Title
 *     cannot authorize losing existing info; a proposal that's
 *     strictly less specific than before is worse.
 *   - SWAP (color or sub-parallel replaced with different one) →
 *     suppress unless title literally names the new value.
 *   - ADD (adding color/sub to a vaguer before) → suppress unless
 *     title literally names the new value.
 *   - CANONICAL EXTENSION (same color + same sub, adding "Refractor"
 *     suffix) → allow.
 *
 *  Failure modes this catches (from Drew's v3 dry-run):
 *   1. Bare "Blue" → "Blue X-Fractor" (title doesn't say X-Fractor)
 *   2. Refractor ↔ X-Fractor swap
 *   3. Color LOSS: "Gold" → "Base", "Blue Refractor" → "Refractor"
 *   4. Color SWAP: "Green X" → "Blue X" (unless title says Blue)
 *   5. Sub-parallel LOSS: "Gold Wave Refractor" → "Gold"
 *   6. Sub-parallel SWAP: "Orange Shimmer" → "Orange Wave Refractor",
 *      "Reptilian Refractor" → "Lazer Refractor" (unless title says
 *      the new sub — e.g. "Speckle Refractors" in title allows the
 *      Aqua → Speckle upgrade).
 *   7. Adding sub-parallel: "Refractor" → "Reptilian Refractor". */
export function shouldSuppressParallelChange(
  title: string,
  before: string | null,
  proposed: string | null,
): boolean {
  if (!before || !proposed) return false;
  const b = before.toLowerCase().trim();
  const a = proposed.toLowerCase().trim();
  if (b === a) return false;

  const t = title.toLowerCase();
  const bColor = BARE_COLORS.find((c) => hasWord(b, c));
  const aColor = BARE_COLORS.find((c) => hasWord(a, c));
  const bSub = DISTINCTIVE_SUBS.find((w) => hasWord(b, w));
  const aSub = DISTINCTIVE_SUBS.find((w) => hasWord(a, w));

  // LOSS — never authorized by title. Color loss covers "Gold" → "Base"
  // and "Blue Refractor" → "Refractor" (drops color). Sub loss covers
  // "Gold Wave Refractor" → "Gold" (drops Wave).
  if (bColor && !aColor) return true;
  if (bSub && !aSub) return true;

  // SWAP — color swap suppressed unless title has the new color;
  // sub-parallel swap suppressed unless title mentions the new sub.
  if (bColor && aColor && bColor !== aColor && !hasWord(t, aColor)) return true;
  if (bSub && aSub && bSub !== aSub && !titleMentionsSpecificParallel(title, proposed)) return true;

  // Refractor ↔ X-Fractor swap (character-level, not word-boundary).
  if (b.includes("refractor") && a.includes("x-fractor") && !b.includes("x-fractor")
      && !titleMentionsSpecificParallel(title, proposed)) return true;
  if (b.includes("x-fractor") && a.includes("refractor") && !a.includes("x-fractor")
      && !titleMentionsSpecificParallel(title, proposed)) return true;

  // ADD — bare-color before to specific-sub after; suppress unless
  // title actually mentions the new sub.
  const isBareColor = (s: string) => BARE_COLORS.includes(s);
  if (isBareColor(b) && !isBareColor(a) && !titleMentionsSpecificParallel(title, proposed)) return true;
  if (!bSub && aSub && !titleMentionsSpecificParallel(title, proposed)) return true;

  return false;
}

/** LEGACY: kept exported for the pinning tests. Classifies category
 *  only — the caller must combine with `titleMentionsSpecificParallel`
 *  to make the final decision. Prefer `shouldSuppressParallelChange`. */
export function isRiskyParallelChange(before: string | null, after: string | null): boolean {
  if (!before || !after) return false;
  const b = before.toLowerCase().trim();
  const a = after.toLowerCase().trim();
  if (b === a) return false;
  const isBareColor = (s: string) => BARE_COLORS.includes(s);
  if (isBareColor(b) && !isBareColor(a)) return true;
  if (b.includes("refractor") && a.includes("x-fractor") && !b.includes("x-fractor")) return true;
  if (b.includes("x-fractor") && a.includes("refractor") && !a.includes("x-fractor")) return true;
  const bColor = BARE_COLORS.find((c) => hasWord(b, c));
  const aColor = BARE_COLORS.find((c) => hasWord(a, c));
  if (bColor && !aColor) return true;
  if (bColor && aColor && bColor !== aColor) return true;
  const bSub = DISTINCTIVE_SUBS.find((w) => hasWord(b, w));
  const aSub = DISTINCTIVE_SUBS.find((w) => hasWord(a, w));
  if (bSub && !aSub) return true;
  if (bSub && aSub && bSub !== aSub) return true;
  if (!bSub && aSub) return true;
  return false;
}
