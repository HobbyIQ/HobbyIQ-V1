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
  type CatalogMatchInput,
  type CatalogMatchResult,
  type CatalogMatchSource,
} from "../catalog/catalogMatcher.service.js";

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
}

const DEFAULT_DEPS: IdentityFromFieldsDeps = {
  canonicalize: canonicalizeReal,
  resolveCardNumberByPlayer: resolveCardNumberByPlayerReal,
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
  const parallel = str(f.parallel) || null;
  let cardNumber = str(f.cardNumber);
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
    };
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
  return { cardNumber, cardNumberResolvedBy, cardNumberCandidates, skippedReason: null, match };
}
