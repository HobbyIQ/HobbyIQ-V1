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
import { parseListingTitle } from "./ebayTitleParser.service.js";
import { sameCardNumber } from "./hobbyIqCardId.service.js";

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
    matchSource: "catalog" | "cardhedge-search" | "unchanged" | "no_match";
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
    // CF-WE-USE-OUR-INTERNAL-PROCESSES (Drew, 2026-08-28: "I do not want it
    // calling cardsight or cardhedge. We use our internal processes";
    // checklist D7c). This used to search CardHedge, take its card_id as the
    // holding's cardId, and the route then filed the comp under that vendor
    // id -- while the confirm path filed under the hiq: slug. Same purchase,
    // two identifiers, two partitions, no dedupe. The rematch now parses the
    // title with our own parser and resolves through canonicalize(); the
    // answer is the checklist slug or nothing.
    const parsed = parseListingTitle(title);
    const sport = String((holding as { sport?: string }).sport ?? "baseball");
    const year = parsed.year ?? ((holding as { cardYear?: number }).cardYear ?? null);
    const setName = parsed.setName ?? before.setName ?? null;
    const cardNumber = parsed.cardNumber ?? before.cardNumber ?? null;
    if (!year || !setName || !cardNumber) return emptyAfter("no_match");
    const proposedParallel = (parsed.parallel ?? before.parallel) as string | null;
    const finalParallel = shouldSuppressParallelChange(title, before.parallel, proposedParallel)
      ? before.parallel
      : proposedParallel;
    const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
    const match = await canonicalize({
      sport,
      year,
      setName,
      cardNumber,
      parallel: finalParallel,
      isAuto: parsed.isAuto === true || (holding as { isAuto?: boolean }).isAuto === true,
      // CF-ONE-IMPORT-ONE-IDENTITY (D9): the print run is half the key. Without
      // it a /50 card computes an un-numbered slug, reaches its checklist row
      // only at fuzzy 0.72, and the rematch refuses at the 0.9 gate forever.
      printRun: parsed.printRun ?? ((holding as { printRun?: number | null }).printRun ?? null),
      player: parsed.playerName ?? (holding as { playerName?: string }).playerName ?? null,
      source: "ebay-user-purchase",
    });
    if (!match || !match.found || !match.slug || match.confidence < 0.9) return emptyAfter("no_match", match?.confidence ?? 0);
    const after = {
      parallel: finalParallel,
      cardNumber,
      setName,
      cardId: match.slug,
      matchConfidence: match.confidence,
      matchSource: "catalog" as const,
    };
    // A hyphen-only respelling of the number is not a change (D23, ruling d).
    const numberChanged = (after.cardNumber || before.cardNumber)
      ? !sameCardNumber(after.cardNumber, before.cardNumber)
      : false;
    const changed =
      after.parallel !== before.parallel
      || numberChanged
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
