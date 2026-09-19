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
  // inferSportFromTitle has NO explicit baseball branch — baseball is only its
  // FALLBACK. So the two-probe trick below can never confirm baseball, and a
  // title literally reading "1969 Topps Baseball" came back reason="defaulted".
  // That understates confidence badly, since baseball is the largest vertical.
  if (/(baseball|mlb)/i.test(title)) return "baseball";
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
  /** Vendor marketplace ("TCGplayer", "eBay"). CF-TCG-SPORTS-COLLIDING-SETS-
   *  NEED-A-MARKER: a TCG-only platform proves the vertical for set names that
   *  would be ambiguous on their own. */
  platform?: string | null;
  /** Vendor product category ("tcg", "sports"). */
  category?: string | null;
  /** Vendor set name, when supplied separately from the title. */
  setName?: string | null;
  /** Used only when nothing else resolves. Explicit so the caller owns it. */
  fallback?: string;
}): VerticalResolution {
  const declared = String(input.declared ?? "").trim().toLowerCase();
  const title = String(input.title ?? "");

  // A declared TCG vertical is authoritative — the feed knows better than a
  // keyword scan of a title.
  const tcg = classifyTcg({
    sport: declared,
    title,
    hobbyiqCardId: input.hobbyiqCardId,
    platform: input.platform,
    category: input.category,
    setName: input.setName,
  });
  if (tcg.isTcg) {
    return {
      vertical: tcg.vertical ?? "pokemon",
      confident: true,
      reason: "tcg-detector",
    };
  }

  if (declared) return { vertical: declared, confident: true, reason: "explicit" };

  // Baseball is checked HERE rather than inside provenSport. inferSportFromTitle
  // has no explicit baseball branch — baseball is only its FALLBACK — so the
  // two-probe trick can never confirm it, and a title literally reading
  // "1969 Topps Baseball" reported reason="defaulted". That understates
  // confidence on the largest vertical, which is exactly the signal we added
  // this function to expose.
  if (/(baseball|mlb)/i.test(title)) {
    return { vertical: "baseball", confident: true, reason: "sport-keyword" };
  }

  const sport = provenSport(title);
  if (sport) return { vertical: sport, confident: true, reason: "sport-keyword" };

  // Nothing identified it.
  //
  // CF-NO-DEFAULT-SPORT (#1924 follow-up, 2026-09-07). This used to read
  // `input.fallback ?? "baseball"` -- so a caller that passed NO fallback,
  // having deliberately declined to guess, was handed the very default this
  // module was written to expose. The hardcoded half is gone: a caller that
  // names no fallback now gets `""`, and `confident: false` beside it says
  // why. Callers that DO pass a fallback are unchanged (dataCleanJob passes
  // the row's own already-resolved sport, which is a real prior, not a guess).
  //
  // The measured cost of the old default: 82.9% of the 94,275 sport-mismatched
  // sold_comps rows the #1924 census found originate in baseball.
  return {
    vertical: input.fallback ?? "",
    confident: false,
    reason: "defaulted",
  };
}
