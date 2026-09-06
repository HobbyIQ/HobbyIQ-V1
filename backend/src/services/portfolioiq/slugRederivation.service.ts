// CF-SLUG-REDERIVATION (Drew, 2026-08-14). Phase 2 + 3 of the slug
// cleanup: repair rows that already carry a wrong slug, and collapse the
// non-canonical sport vocabulary while we are there.
//
// Phase 1 (slugGuard) stopped NEW bad slugs. It does nothing for the
// rows already in the pool, and it cannot — refusing to mint a slug is
// not the same as repairing one. This module is the repair.
//
// WHAT IS BROKEN, measured 2026-08-14 on 5,755,979 sold_comps rows:
//
//   hiq:hockey:197:bowman:8:base:no-auto
//     ↳ actual card, from its own title:
//       "1978 Kellogg's 3-D Super Stars Baseball #8"  (Rich Gossage)
//
// The titles carry the truth. Every corrupt row sampled had its real
// identity sitting in the title while the structured fields held a
// caller-side default (`bowman`), a wrong sport, or a truncated year.
//
// THE ONLY-IMPROVE RULE, and why it is shaped this way
//
// Re-deriving every row would churn ~5.7M documents and risks demoting
// slugs that are already correct — the exact failure the slug-recompute
// doctrine warns about. So the rule is deliberately narrow and asymmetric:
//
//   - If the row's CURRENT fields pass slugGuard, it is left ALONE.
//     Not re-derived, not re-checked against the title, not touched.
//     A passing slug is treated as correct even if the title might
//     disagree; second-guessing it is how good data gets demoted.
//   - Only when the current fields FAIL the guard do we consult the
//     title, and only when the re-derived fields PASS do we write.
//   - If re-derivation still fails the guard, the row is left unkeyed
//     and counted. Absent beats wrong, same as Phase 1.
//
// The one exception is sport vocabulary: a row can pass the guard while
// still STORING a non-canonical sport ("ice hockey"), because the guard
// canonicalizes on read. Those rows get the stored value normalized
// without otherwise touching identity. That is Phase 3.

import { computeHobbyIqCardId, normalizeSetKey } from "./hobbyIqCardId.service.js";
import { guardSlugInputs, normalizeSportStrict } from "./slugGuard.service.js";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
} from "./parseTitleIdentity.service.js";

/** A card year embedded in a title: "1978 Kellogg's ...", "2026 Bowman".
 *  The `(?<!#)` is load-bearing: "Card #1978" is a CARD NUMBER, and a
 *  plain word boundary happily matches it because "#" is a non-word
 *  character. Reading a card number as the year is exactly the class of
 *  error this sweep exists to remove. */
const TITLE_YEAR_RE = /(?<!#)\b(19[3-9]\d|20[0-4]\d)\b/g;

/** Season-spanning years — "2024-25 Upper Deck", "2020-2021 Panini Donruss",
 *  "1986-1987 O-Pee-Chee". The LEADING year is the catalog year; hockey and
 *  basketball products are routinely labelled this way.
 *
 *  CF-A-SEASON-SPANS-TWO-DIGITS-OR-FOUR (Drew, 2026-09-06). The trailing half
 *  used to be `\d{2}` only, so "2020-2021" did not read as a season at all and
 *  the two halves were seen as two independent years.
 *
 *  CF-A-CARD-NUMBER-IS-NOT-A-SEASON (Drew, 2026-09-06). This pattern also
 *  lacked the `(?<!#)` its sibling above carries, so "#1974-61" — the card
 *  NUMBER of a Topps Originals Buyback — parsed as the season "1974-61". A
 *  card number does not become a season by having a hyphen in it. Observed:
 *
 *    "2015 Topps - Originals Buybacks Luis Aparicio #1974-61"  ->  1974 */
const TITLE_SEASON_RE = /(?<!#)\b(19[3-9]\d|20[0-4]\d)\s*[-/]\s*(?:\d{2}|(?:19|20)\d{2})\b/g;

/** Text that, when it IMMEDIATELY follows a year, marks that year as the
 *  design being homaged rather than the year the card was issued. "1990 Foil
 *  2025 Topps Update" is a 2025 card wearing a 1990 design.
 *
 *  The trailing ordinal alternative catches the anniversary shape, where the
 *  homaged year is followed by how long ago it was rather than by a product
 *  word: "1991 35th Anniversary ... 2026 Topps Flagship" is a 2026 card. */
const HOMAGE_AFTER_YEAR_RE =
  /^\s*(?:foil|insert|design|anniversar|reprint|buyback|throwback|retro|tribute|style|all[-\s]?star|rookies\b|mini(?:s)?\b|variation|\d{1,3}(?:st|nd|rd|th)\b)/i;

/** Spans that LOOK like years but are not the card's year, removed before the
 *  scan: serial print runs ("/2000", "#d/2000") and a player's death year
 *  ("d.2011", "D-2015"). Both are common in vintage listings and both sit
 *  where a naive reader would take them for the issue year. */
function stripNonYearNumerics(t: string): string {
  return t
    .replace(/\bserial\b/gi, " ")
    .replace(/#?\s*d?\s*\/\s*\d{1,5}\b/g, " ")
    .replace(/\bd[.\-\s]?(?:19|20)\d{2}\b/gi, " ");
}

/** The year a title STATES for the card, or null when it states none.
 *
 *  CF-THE-FIRST-YEAR-IS-THE-PRODUCT-YEAR (Drew, 2026-09-06). Position in the
 *  title decides, not which pattern happened to be tried first. This function
 *  used to test the season pattern across the WHOLE string before it ever
 *  looked for a plain year, so a homaged season late in a title beat the
 *  product year that opened it:
 *
 *    "2007 Topps Kevin Durant 1957-58 Variation #112 PSA 9"  ->  1957
 *
 *  That is a 2007 Topps card whose DESIGN homages 1957-58. The convention every
 *  seller follows is positional: the product year LEADS the title. MEASURED
 *  over 5,995 live tca-ebay rows (soldAt >= 2026-08-20), taking the first
 *  stated year agrees with the stored cardYear on 99.78% of them; the previous
 *  season-first reading and a maker-token-anchored alternative both scored
 *  worse (99.72% and 99.62%).
 *
 *  THE ONE EXCEPTION IS EARNED, NOT ASSUMED. A modern retro insert puts the
 *  PLAYER first and the homaged year second — "Pete Crow-Armstrong 1990 Foil
 *  2025 Topps Update" is a 2025 card — so a year immediately followed by a
 *  homage word is demoted when a later year survives. That lifts agreement to
 *  99.85%. A 2023 Topps Heritage card homaging a 1954 design keeps 2023 under
 *  both halves of the rule: its product year leads.
 *
 *  What this never does is read the SALE date. See yearTheTitleAllows.ts. */
export function extractYearFromTitle(title: string | null | undefined): number | null {
  const raw = String(title ?? "");
  if (!raw) return null;
  const t = stripNonYearNumerics(raw);

  const found: Array<{ index: number; end: number; year: number }> = [];
  const collect = (re: RegExp): void => {
    // Belt-and-braces: a /g regex kept at module scope carries lastIndex
    // between calls. The loop below always runs to exhaustion, which resets it
    // to 0 on its own, so this is unreachable today — it is here so that a
    // later early-return inside the loop cannot silently make the SECOND call
    // on a given title start scanning from the middle of it.
    re.lastIndex = 0;
    for (let m = re.exec(t); m !== null; m = re.exec(t)) {
      const y = Number(m[1]);
      if (!Number.isFinite(y)) continue;
      if (found.some((f) => f.index === m!.index)) continue; // season wins its own index
      found.push({ index: m.index, end: m.index + m[0].length, year: y });
    }
  };
  collect(TITLE_SEASON_RE);
  collect(TITLE_YEAR_RE);
  if (!found.length) return null;
  found.sort((a, b) => a.index - b.index);
  if (found.length === 1) return found[0].year;

  // Demote years that a homage word immediately follows, but only while a
  // later year is left to take the place — a title that is ALL homage markers
  // still has to answer with something, and the first year is that answer.
  const survivors = found.filter((f) => !HOMAGE_AFTER_YEAR_RE.test(t.slice(f.end)));
  return (survivors.length ? survivors : found)[0].year;
}

export interface RederiveRow {
  hobbyiqCardId?: string | null;
  sport?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean;
  title?: string | null;
}

export type RederiveAction =
  | "ok-untouched"        // current fields pass the guard — left alone
  | "sport-normalized"    // guard passes but stored sport was non-canonical
  | "rederived"           // guard failed, title produced a valid identity
  | "unrecoverable";      // guard failed and the title could not fix it

export interface RederiveResult {
  action: RederiveAction;
  /** Present for sport-normalized + rederived. */
  sport?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean;
  hobbyiqCardId?: string | null;
  /** Why the row could not be recovered — for triage, not control flow. */
  reasons?: string[];
}

/**
 * Decide what should happen to one row. Pure — no I/O, no Cosmos.
 *
 * Returning "ok-untouched" is the common case by design; the sweep must
 * skip the overwhelming majority of rows cheaply.
 */
export function rederiveRow(row: RederiveRow): RederiveResult {
  const currentGuard = guardSlugInputs({
    sport: row.sport,
    year: row.cardYear,
    normalizedSetKey: normalizeSetKey(row.setName ?? ""),
    cardNumber: row.cardNumber ?? "",
  });

  if (currentGuard.ok) {
    // Phase 3: the identity is sound, but the STORED sport string may
    // still be vendor spelling ("ice hockey", "non-sports"). The guard
    // canonicalizes on read, so this never surfaces as a failure — it
    // just quietly fragments any query that groups by sport.
    const canonical = currentGuard.sport;
    if (canonical && row.sport !== canonical) {
      return {
        action: "sport-normalized",
        sport: canonical,
        hobbyiqCardId: computeHobbyIqCardId({
          sport: canonical,
          year: row.cardYear as number,
          setKey: row.setName ?? "",
          cardNumber: row.cardNumber ?? "",
          parallel: row.parallel ?? "Base",
          isAuto: row.isAuto ?? false,
        }),
      };
    }
    return { action: "ok-untouched" };
  }

  // Guard failed — consult the title.
  const title = String(row.title ?? "").trim();
  if (!title) {
    return { action: "unrecoverable", reasons: [...currentGuard.reasons, "no-title"] };
  }

  const parsed = parseListingIdentity(title);
  // inferSportFromTitle defaults its fallback to "baseball"; pass an
  // empty fallback so an unreadable title yields nothing rather than
  // silently minting a baseball row.
  const sportRaw = inferSportFromTitle(title, "");
  const sport = normalizeSportStrict(sportRaw) ?? normalizeSportStrict(row.sport);
  const cardYear = extractYearFromTitle(title) ?? (row.cardYear ?? null);
  const cardNumber = parsed.cardNumber ?? row.cardNumber ?? "";
  const setKeyRaw = inferSetKeyFromTitle(title, cardNumber) || row.setName || "";

  // CF-BOWMAN-DEFAULT-NOT-EVIDENCE (Drew, 2026-08-14).
  // inferSetKeyFromTitle ends with "only default to Bowman when the
  // title looks baseball-ish" and returns "Bowman". That default is a
  // guess, not a reading, and it is where the 10,234 setKey=bowman rows
  // in the sport='hockey' bucket came from — e.g. a Kellogg's card.
  //
  // A defaulted Bowman would sail through the guard (bowman IS a valid
  // setKey), producing a confident wrong slug — precisely what this
  // sweep exists to remove. So only accept Bowman when the title
  // actually says so; otherwise the row stays unkeyed for a later pass
  // with a better parser.
  const setKeyNorm = normalizeSetKey(setKeyRaw);
  if (setKeyNorm.startsWith("bowman") && !/bowman/i.test(title)) {
    return { action: "unrecoverable", reasons: ["rederived:setkey-bowman-default-unsupported"] };
  }
  // CF-UNKNOWN-IS-ALSO-A-GUESS (2026-08-16). The guard above catches the
  // parser's old "Bowman" fallback. Narrowing that fallback
  // (CF-BRANDS-BEFORE-THE-FALLBACK) means an unrecognised product now returns
  // "Unknown" instead — which slipped straight past this check and would have
  // written hiq:...:unknown:... as if it were an identity.
  //
  // It is not one. There are already 756,574 comps carrying an ":unknown:"
  // setKey; they match no checklist and never will. A row we cannot name is
  // left unkeyed for a later pass with a better vocabulary, which is exactly
  // what the Bowman guard exists to do.
  if (setKeyNorm === "unknown" || setKeyNorm === "") {
    return { action: "unrecoverable", reasons: ["rederived:setkey-unknown-unsupported"] };
  }

  const nextGuard = guardSlugInputs({
    sport,
    year: cardYear,
    normalizedSetKey: setKeyNorm,
    cardNumber,
  });

  if (!nextGuard.ok) {
    return {
      action: "unrecoverable",
      reasons: nextGuard.reasons.map((r) => `rederived:${r}`),
    };
  }

  const isAuto = parsed.isAuto || (row.isAuto ?? false);
  const parallel = parsed.parallel || row.parallel || "Base";

  return {
    action: "rederived",
    sport: nextGuard.sport,
    cardYear,
    setName: setKeyRaw,
    cardNumber,
    parallel,
    isAuto,
    hobbyiqCardId: computeHobbyIqCardId({
      sport: nextGuard.sport as string,
      year: cardYear as number,
      setKey: setKeyRaw,
      cardNumber,
      parallel,
      isAuto,
      printRun: parsed.printRun,
    }),
  };
}
