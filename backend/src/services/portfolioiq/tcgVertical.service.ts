// CF-TCG-HOLDING-GROUP (Drew, 2026-08-13: "let's just tag them as TCG and into
// a holding group").
//
// Trading-card-game sales (Pokemon, One Piece, Yu-Gi-Oh, Magic, Lorcana) flow
// in from the same vendor feeds as sports cards, but there is no TCG catalog to
// match them against — the sport→vertical schema refactor is the parked
// blocker. So every TCG sale reaches recordSoldComp, fails the catalog match,
// and is skipped under CATALOG_MATCH_ONLY_ENABLED.
//
// Measured 2026-08-13 over 20,000 staging rows: 7.7% are TCG. They cannot be
// matched by any amount of checklist ingestion, yet they:
//
//   - sit permanently in the unmatched backlog, making coverage look worse
//     than it is (33% matched, and this is part of why)
//   - file checklist seeds for sets no sports checklist will ever cover, which
//     is why the seed queue GREW from 2,285 to 2,754 while we were draining it
//   - compute nonsense slugs — "hiq:baseball:2003:ex-sandstorm:87100" is a
//     Pokemon EX Sandstorm card wearing a baseball slug
//
// Routing them to their own holding status keeps the sales — they are real
// transactions and the vertical is coming — while taking them out of a pipeline
// that structurally cannot serve them. Nothing is deleted; when the TCG vertical
// lands, this population is exactly the seed corpus for it.

/** Vertical labels the pipeline already assigns to non-sport product. */
const TCG_VERTICALS: ReadonlySet<string> = new Set([
  "pokemon",
  "anime-tcg",
  "yugioh",
  "tcg-other",
  "mtg",
  "lorcana",
]);

/**
 * Titles that are unmistakably TCG even when the row was filed under a SPORT.
 *
 * This is the misclassified tail — measured at ~0.6% of staging rows, e.g. a
 * Charizard VSTAR carrying `sport=hockey`. Deliberately narrow: every term here
 * is a product line or a character that has no sports-card homonym, because a
 * false positive would pull a real sports sale out of the pool. "Prizm",
 * "Chrome" and colour words are absent for that reason.
 */
const TCG_TITLE_PATTERNS: readonly RegExp[] = [
  /\bpokemon\b/i,
  /\bpikachu\b/i,
  /\bcharizard\b/i,
  /\bvstar\b|\bvmax\b/i,
  /\bswsh\b|\bsword\s*&?\s*shield\b/i,
  /\bscarlet\s*&?\s*violet\b/i,
  /\bcall of legends\b|\bmajestic dawn\b|\bstormfront\b|\bex sandstorm\b/i,
  /\bpop series\b/i,
  /\byu-?gi-?oh\b/i,
  /\bone piece\b/i,
  /\blorcana\b/i,
  /\bmagic:? the gathering\b/i,
];

export interface TcgClassification {
  isTcg: boolean;
  /** Why it was classified — recorded on the row so the call is auditable. */
  reason?: "vertical-field" | "title-pattern";
  /** The vertical when known from the sport field. */
  vertical?: string;
}

/**
 * Decide whether a staged sale is TCG rather than a sports card.
 *
 * The `sport` field is trusted FIRST because the pipeline already resolves most
 * TCG product correctly (1,194 of 1,532 TCG rows in the sample carried
 * `pokemon`). The title patterns only catch the misfiled remainder.
 */
export function classifyTcg(input: {
  sport?: string | null;
  title?: string | null;
  hobbyiqCardId?: string | null;
}): TcgClassification {
  const sport = String(input.sport ?? "").trim().toLowerCase();
  if (sport && TCG_VERTICALS.has(sport)) {
    return { isTcg: true, reason: "vertical-field", vertical: sport };
  }

  // Check the title AND the slug: the slug carries the setKey, which is where
  // "ex-sandstorm" / "swsh-sword-shield-promo-cards" survive even when the
  // title is terse.
  //
  // Hyphens become spaces first — slugs are hyphenated ("call-of-legends") while
  // the patterns are written in prose form ("call of legends"), so without this
  // every slug-only detection silently missed.
  const hay = `${input.title ?? ""} ${input.hobbyiqCardId ?? ""}`.replace(/-/g, " ");
  if (TCG_TITLE_PATTERNS.some((re) => re.test(hay))) {
    return { isTcg: true, reason: "title-pattern" };
  }
  return { isTcg: false };
}
