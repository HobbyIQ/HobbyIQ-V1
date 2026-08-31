// CF-ONE-IDENTITY-DERIVATION (D12-b, 2026-08-29). The one way a holding's
// fields become a catalog identity.
//
// D9 (#1454) fixed the eBay import by deriving identity ONCE: never ask the
// matcher with an empty card number (the computed slug carries a "::" segment
// and the user-seed path would happily mint it); a missing number is asked of
// the catalog by player -- internal, unique-or-nothing, never a vendor call;
// the matcher gets the number, the parallel, the print run and the player;
// the answer is pinned as identity only at >= the bar every adoption site
// reads (ADD_SLUG_OVERRIDE_MIN_CONFIDENCE, default 0.9).
//
// The spreadsheet import needs exactly that rule, and the recurring bug shape
// in this codebase is a rule right in one place and absent in the next. So
// the rule lives here, once, and both imports call it. Pure with respect to
// the holding: the caller decides what to write from the answer.

import {
  canonicalize as canonicalizeReal,
  resolveCardNumberByPlayer as resolveCardNumberByPlayerReal,
  variationParallelsForCard as variationParallelsForCardReal,
  type CatalogMatchInput,
  type CatalogMatchResult,
  type CatalogMatchSource,
} from "../catalog/catalogMatcher.service.js";
import { canonicalVariationName, reduceVariationStockToCatalog } from "../catalog/variationVocabulary.js";
import { normalizeSetKey } from "./hobbyIqCardId.service.js";
import { judgeCardNumber, logCardNumberVerdict, isTcgVertical } from "./cardNumberIntegrity.js";

export interface IdentityFields {
  /** Slug namespace. The caller decides (sheet column, product inference, a default). */
  sport: string;
  year: number | null;
  setName: string | null;
  player: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  printRun: number | null;
  /** Who is asking. Decides whether a miss may seed a catalog row (an import may not). */
  source: CatalogMatchSource;
  /** D28: the listing / label text the fields were read from, when the caller
   *  has it. The card-number guard needs it to tell "#9" from "PSA 9", and an
   *  explicit `#X` in it outranks the row's own number. A spreadsheet import
   *  has no title; the shape rules that need no text (a `/N` print run) still
   *  apply without one. */
  title?: string | null;
}

export type IdentitySkippedReason = "no-card-number" | "no-year" | "no-set";

export interface IdentityFromFields {
  /** The card number the matcher was asked with: the row's own, or the one the
   *  catalog supplied by player. Null when neither exists. */
  cardNumber: string | null;
  cardNumberResolvedBy: "catalog-player-lookup" | null;
  /** The numbers the catalog holds for this player in this product when it
   *  could not pick one -- the caller surfaces them rather than guessing. */
  cardNumberCandidates: string[];
  /** Why the matcher was not asked. Null when it was. */
  skippedReason: IdentitySkippedReason | null;
  /** The matcher's answer. Null when skipped. */
  match: CatalogMatchResult | null;
  /** CF-A-VARIATION-IS-A-CARD (D22). The parallel the matcher was asked with
   *  when the row's own said a variation another way ("SP-CHROME" from a
   *  grader label, "Photo Variations", "SSP") — the vocabulary's spelling,
   *  with a label's stock word kept only where the product's checklist
   *  distinguishes chrome from paper. Null when the parallel stood as given. */
  parallelResolvedAs: string | null;
  /** CF-A-VARIATION-NEEDS-A-BARE-NUMBER (D37). True when the row named a
   *  variation on a PREFIXED card number (BP-/BCP-/CPA-…) that the product's
   *  checklist does not hold one for, so the variation was dropped rather
   *  than fused onto a number that never had it. */
  variationRefusedForPrefixedNumber?: boolean;
}

/** Injection seam for tests -- the two catalog reads this derivation performs. */
export interface IdentityFromFieldsDeps {
  canonicalize: (input: CatalogMatchInput) => Promise<CatalogMatchResult>;
  resolveCardNumberByPlayer: (input: {
    year: number;
    setKey: string;
    player: string;
    isAuto: boolean;
    parallel?: string | null;
  }) => Promise<{ cardNumber: string | null; candidates: string[] }>;
  /** D22: the catalog's variation rows for a card (parallel slugs), asked
   *  only when the row's parallel names a variation with a stock word. */
  variationParallelsForCard?: (input: { sport: string; year: number; setKey: string; cardNumber: string }) => Promise<string[]>;
}

const DEFAULT_DEPS: IdentityFromFieldsDeps = {
  canonicalize: canonicalizeReal,
  resolveCardNumberByPlayer: resolveCardNumberByPlayerReal,
  variationParallelsForCard: variationParallelsForCardReal,
};

const str = (v: unknown): string => String(v ?? "").trim();

/**
 * The bar an automated match must clear before it is pinned as a holding's
 * identity. The same knob addHolding reads (module-private there), so every
 * adoption site -- add-card, the eBay import, the review queue, the
 * spreadsheet import -- moves together.
 */
export function identityPinMinConfidence(): number {
  const n = Number(process.env.ADD_SLUG_OVERRIDE_MIN_CONFIDENCE ?? 0.9);
  return Number.isFinite(n) ? n : 0.9;
}

/** True when the match may be written as identity. Below the bar it is a
 *  suggestion for the reviewer, never an identity. */
export function clearsIdentityBar(match: CatalogMatchResult | null | undefined): match is CatalogMatchResult {
  return !!match && match.found === true && !!match.slug && (match.confidence ?? 0) >= identityPinMinConfidence();
}

/**
 * Derive a catalog identity from a holding's fields. A skipped derivation
 * (no number / year / set) is an answer, not an error; catalog errors
 * propagate so the caller decides (the eBay import logs and leaves the
 * holding for review).
 */
export async function resolveIdentityFromFields(
  f: IdentityFields,
  deps: IdentityFromFieldsDeps = DEFAULT_DEPS,
): Promise<IdentityFromFields> {
  const year = typeof f.year === "number" && Number.isFinite(f.year) && f.year > 0 ? f.year : null;
  const setName = str(f.setName);
  const player = str(f.player);
  // CF-A-VARIATION-IS-A-CARD (D22). A holding's parallel that names a
  // variation any way sellers and grader labels do — "Photo Variations",
  // "SSP", "SP-CHROME" — is asked of the catalog in the vocabulary's one
  // spelling, so the holding CAN be the variation through the field it has.
  const given = str(f.parallel) || null;
  let variation = canonicalVariationName(given);
  let parallel = variation ?? given;
  let variationRefusedForPrefixedNumber = false;
  let parallelResolvedAs: string | null = variation && variation !== given ? variation : null;
  // D28 (CF-A-CARD-NUMBER-IS-NOT-A-GRADE). The number arrives here from the
  // eBay title parser, from a spreadsheet cell, or from slab OCR, and each of
  // those has handed over a grade at least once -- Harrison's holding reached
  // `topps-chrome:9` through exactly this field. Judge it before it becomes an
  // identity: an explicit `#X` in the title outranks it, and a number the text
  // shows to be a grade / print run / year / ordinal / lot is refused. A
  // refusal is not a dead end: the by-player lookup below is what a row with
  // no number gets, which is the right answer for a row whose number was
  // never a number.
  const givenNumber = str(f.cardNumber);
  const numberVerdict = judgeCardNumber(givenNumber, f.title ?? null, { isTcg: isTcgVertical(f.sport) });
  if (givenNumber && (numberVerdict.vendorDisagrees || numberVerdict.rejected)) {
    logCardNumberVerdict("identity-from-fields", numberVerdict, { candidate: givenNumber, title: f.title ?? null });
  }
  let cardNumber = numberVerdict.cardNumber ?? "";
  let cardNumberResolvedBy: IdentityFromFields["cardNumberResolvedBy"] = null;
  let cardNumberCandidates: string[] = [];

  // A row that names no card number is not a dead end: the catalog knows
  // which number this player carries in this product at this parallel, when
  // it is exactly one. Internal lookup -- never a vendor call.
  if (!cardNumber && year && setName && player) {
    const byPlayer = await deps.resolveCardNumberByPlayer({ year, setKey: setName, player, isAuto: f.isAuto, parallel });
    if (byPlayer.cardNumber) {
      cardNumber = byPlayer.cardNumber;
      cardNumberResolvedBy = "catalog-player-lookup";
    } else if (byPlayer.candidates.length > 1) {
      cardNumberCandidates = byPlayer.candidates;
    }
  }

  // Never ask the matcher with an empty card number: the computed slug would
  // carry a "::" segment, and the user-seed path would happily mint it.
  if (!cardNumber || !year || !setName) {
    return {
      cardNumber: cardNumber || null,
      cardNumberResolvedBy,
      cardNumberCandidates,
      skippedReason: !cardNumber ? "no-card-number" : !year ? "no-year" : "no-set",
      match: null,
      parallelResolvedAs,
      variationRefusedForPrefixedNumber,
    };
  }

  // CF-A-VARIATION-NEEDS-A-BARE-NUMBER (D37, 2026-08-30). A photo/image
  // variation is a SECOND PRINTING OF A BASE CARD and shares that card's
  // number, so it lives where the base set's numbering lives: a bare numeric.
  // Prefixed runs (BP-, BCP-, CPA-, BTP-, ...) are separate subsets that carry
  // their own variation sections when they have any, under their own prefix.
  //
  // 2026 Bowman is the worked example. Its four variation subsets are
  //   Base Rookie Red RC Logo Variation   40 cards, ALL bare numeric
  //   Base Etched in Glass Variation      12 cards, ALL bare numeric
  //   Chrome Prospects Etched in Glass    11 cards, ALL BCP-
  //   Anime Kanji Variation                7 cards, ALL BA-
  // #18 is Roman Anthony (Base) and HAS a Logo Variation; BP-18 is Blaine
  // Bullard (Paper Prospects) and does not. The D37 tail row
  //   hiq:baseball:2026:bowman-paper:bp-18:logo-variation
  // fused the two: a Paper-Prospects number wearing a base-set subset. It came
  // from a stored parallel of "Logo Variation" on a holding whose eBay title
  // actually reads "Logo Pattern" — the Bowman Logo Pattern rung, a real
  // parallel of BP-18 in this release's Paper Prospects ladder.
  //
  // The guard is structural, not a name list: a BASE-anchored variation (the
  // plain image variation, or a kind with no prefix of its own) never attaches
  // to a prefixed number. The catalog still decides WHICH variation a card
  // has; this only refuses the fusion that no checklist can back. A prefixed
  // number keeps a variation the catalog actually holds for it, which is how
  // BCP-139's Etched in Glass survives.
  if (variation && /^[A-Za-z]+-/.test(String(cardNumber).trim()) && deps.variationParallelsForCard) {
    let held: string[] = [];
    try { held = await deps.variationParallelsForCard({ sport: f.sport, year, setKey: normalizeSetKey(setName), cardNumber }); } catch { held = []; }
    const slugOfName = (t: string): string => t.toLowerCase().replace(/[^a-z0-9&]+/g, "-").replace(/^-+|-+$/g, "");
    const want = slugOfName(variation);
    const backed = held.some((h) => slugOfName(String(h ?? "")) === want);
    if (!backed) {
      // The checklist does not put this variation on this prefixed number.
      // Fall back to the card itself rather than minting the fusion.
      variationRefusedForPrefixedNumber = true;
      parallel = "Base";
      parallelResolvedAs = "Base";
      variation = null;
    }
  }

  // A grader label's stock word ("SP-CHROME") is the card's only where the
  // product's checklist distinguishes chrome from paper; otherwise the
  // plain variation is the card, and the label's word would only miss it.
  if (variation && /\b(?:chrome|paper)\b/i.test(variation) && deps.variationParallelsForCard) {
    let slugs: string[] = [];
    try { slugs = await deps.variationParallelsForCard({ sport: f.sport, year, setKey: normalizeSetKey(setName), cardNumber }); } catch { slugs = []; }
    const reduced = reduceVariationStockToCatalog(variation, slugs);
    if (reduced && reduced !== parallel) { parallel = reduced; parallelResolvedAs = reduced; }
  }

  const match = await deps.canonicalize({
    sport: f.sport,
    year,
    setName,
    cardNumber,
    parallel,
    isAuto: f.isAuto,
    printRun: f.printRun,
    player: player || null,
    source: f.source,
  });
  return { cardNumber, cardNumberResolvedBy, cardNumberCandidates, skippedReason: null, match, parallelResolvedAs, variationRefusedForPrefixedNumber };
}
