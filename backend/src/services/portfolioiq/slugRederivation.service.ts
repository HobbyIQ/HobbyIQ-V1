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
const TITLE_YEAR_RE = /(?<!#)\b(19[3-9]\d|20[0-4]\d)\b/;

/** Season-spanning years, e.g. "2024-25 Upper Deck" — take the FIRST.
 *  Hockey and basketball products are routinely labelled this way and
 *  the leading year is the catalog year. */
const TITLE_SEASON_RE = /\b(19[3-9]\d|20[0-4]\d)\s*[-/]\s*\d{2}\b/;

export function extractYearFromTitle(title: string | null | undefined): number | null {
  const t = String(title ?? "");
  if (!t) return null;
  const season = t.match(TITLE_SEASON_RE);
  if (season) {
    const y = Number(season[1]);
    if (Number.isFinite(y)) return y;
  }
  const m = t.match(TITLE_YEAR_RE);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
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
