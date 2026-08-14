// CF-VERTICAL-NOT-SPORT (Drew, 2026-08-13: "so maybe calling it sport is
// wrong?" → "change the name to a more appropriate name").
//
// It is wrong, and the name caused a real bug rather than just reading badly.
//
//   export function inferSportFromTitle(title: string, fallback = "baseball")
//
// Because the concept was called a SPORT, "which sport?" always had an answer,
// and baseball was the safe-looking guess. So every product the classifier could
// not identify silently became a baseball card:
//
//   Pokemon EX Sandstorm  ->  hiq:baseball:2003:ex-sandstorm:87100:base:no-auto
//   Charizard VSTAR       ->  sport=hockey
//
// Those slugs can never match anything, because no baseball catalog contains
// Pokemon sets. The corroborating number: card_catalog is 23,873,658 baseball
// rows out of 25.5M — 93.6% — which is not a real distribution for a catalog
// that also covers football, basketball, hockey and TCG. That is the default
// accumulating.
//
// What this is really resolving is a VERTICAL: baseball, football, basketball,
// hockey, pokemon, yugioh, one-piece. TCG is not a sport, and modelling it as
// one is what made "default to baseball" seem reasonable.
//
// SCOPE. The persisted field stays named `sport` — it is the second segment of
// every slug across 25.5M catalog rows and 5.5M comps, and renaming it would be
// a schema migration that changes no behaviour (hiq:pokemon:… already matches;
// 402,809 Pokemon comps have promoted through it). This module renames the
// DECISION, which is where the harm was. The field rename is a mechanical
// follow-up for after go-live.

import { classifyTcg } from "./tcgVertical.service.js";
import { inferSportFromTitle } from "./parseTitleIdentity.service.js";

/** Verticals the pipeline can resolve. `sport` is the legacy field name. */
export type Vertical =
  | "baseball" | "football" | "basketball" | "hockey" | "soccer"
  | "pokemon" | "yugioh" | "anime-tcg" | "tcg-other" | "mtg" | "lorcana"
  | "non-sport";

export interface VerticalResolution {
  /** Best available vertical. Never null so callers keep working. */
  vertical: string;
  /**
   * FALSE when nothing in the input identified the vertical and we fell back.
   *
   * This is the whole point of the rename: the old function returned "baseball"
   * for both "this is a baseball card" and "I have no idea", and those are very
   * different claims. Callers can now record the difference, which makes the
   * misclassification measurable instead of invisible.
   */
  confident: boolean;
  /** How it was decided — stamped on rows so the call is auditable. */
  reason: "tcg-detector" | "sport-keyword" | "explicit" | "defaulted";
}

/** The sport words inferSportFromTitle can actually prove. Kept in sync by the
 *  probe below rather than duplicated: we ask it with two different fallbacks
 *  and only trust an answer it gives consistently. */
function provenSport(title: string): string | null {
  // Ask twice with different fallbacks. A real keyword match returns the same
  // sport both times; a fallback returns whatever we passed in. This avoids
  // duplicating the keyword table and drifting from it.
  const a = inferSportFromTitle(title, "__a__");
  const b = inferSportFromTitle(title, "__b__");
  return a === b && a !== "__a__" && a !== "__b__" ? a : null;
}

/**
 * Resolve the vertical for a listing.
 *
 * Order matters: TCG is checked FIRST, because a Pokemon title contains no
 * sport keyword and would otherwise fall straight through to the default.
 */
export function resolveVertical(input: {
  title?: string | null;
  /** Vendor-supplied vertical, when the feed already knows. */
  declared?: string | null;
  hobbyiqCardId?: string | null;
  /** Used only when nothing else resolves. Explicit so the caller owns it. */
  fallback?: string;
}): VerticalResolution {
  const declared = String(input.declared ?? "").trim().toLowerCase();
  const title = String(input.title ?? "");

  // A declared TCG vertical is authoritative — the feed knows better than a
  // keyword scan of a title.
  const tcg = classifyTcg({ sport: declared, title, hobbyiqCardId: input.hobbyiqCardId });
  if (tcg.isTcg) {
    return {
      vertical: tcg.vertical ?? "pokemon",
      confident: true,
      reason: "tcg-detector",
    };
  }

  if (declared) return { vertical: declared, confident: true, reason: "explicit" };

  const sport = provenSport(title);
  if (sport) return { vertical: sport, confident: true, reason: "sport-keyword" };

  // Nothing identified it. Return the fallback but say so, so the caller can
  // record `vertical-defaulted` and we can finally measure how big this is.
  return {
    vertical: input.fallback ?? "baseball",
    confident: false,
    reason: "defaulted",
  };
}
