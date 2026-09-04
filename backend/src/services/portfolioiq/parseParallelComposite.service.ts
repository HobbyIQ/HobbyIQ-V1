// CF-PARSE-PARALLEL-COMPOSITE (Drew, 2026-07-30). Structured
// parallel/edition parser that returns the 5-axis composite identity
// defined in docs/parallel-vocabulary-reference.md:
//
//   { edition, colorFamily, finishModifier, isRefractor, serialRun }
//
// This is the framework-aligned replacement for the string-blob
// `parallel` field. Rollout is additive — the composite is stored
// alongside the legacy parallel string for the first phase so
// downstream can migrate at its own pace.
//
// Parsing precedence (mandatory ordering):
//   1. Edition tokens FIRST (Sapphire, Mega Box, 1st Edition, Sonic,
//      Cosmic, Lite). These reroute the whole comp pool; must be
//      detected before color to avoid pooling regular vs edition
//      variants.
//   2. Serial pattern \d+/\d+ — captured serial wins over inferred run
//   3. Color + finishModifier via the vocab registry, LONGEST-MATCH
//      FIRST (Blue Wave never resolves to Blue; Gold Vinyl never to
//      Gold). Handled inside the vocab loader.
//   4. isRefractor boolean — separate from colorFamily since e.g.
//      "Blue Refractor" and "Blue" (parallel-only) can be different
//      pools depending on product-year.

import {
  matchColorFamilyAlias,
  matchEditionAlias,
  matchFinishModifierAlias,
} from "./parallelVocabulary.service.js";
import { detectInsertSet, inferIsAuto, parseListingIdentity } from "./parseTitleIdentity.service.js";
import type { ChecklistAutoResolver } from "../catalog/checklistAutoLookup.js";

export interface ParallelComposite {
  edition: string | null;         // "SAPPHIRE" | "MEGA_BOX" | "FIRST_EDITION" | "SONIC" | "COSMIC" | "LITE" | null
  insertSet: string | null;       // "scouts-top-100" | "home-run-challenge" | "future-stars" | ... (from detectInsertSet)
  colorFamily: string | null;     // "BASE" | "REFRACTOR" | "BLUE" | ... (uppercase key from vocab)
  finishModifier: string | null;  // "SHIMMER" | "WAVE" | "SPECKLE" | ... (uppercase key from vocab)
  isRefractor: boolean;           // true when title says "refractor" or product implies (e.g., "Blue Refractor")
  // CF-COMPOSITE-AUTO-AXIS (Drew, 2026-07-30). isAuto is a first-class
  // axis of the composite identity — framework parsing order has auto/
  // relic detection as step 5. Uses the sport-aware inferIsAuto which
  // combines title text ("auto"/"autograph"/"hard signed") + baseball
  // cardNumber prefix (isCardNumberAutoSubset with ~55 prefixes) +
  // football WT/SOT prefix + setName keyword (Signatures/Autographs/
  // Ink/Penmanship/Rookie Ticket for basketball/football Panini era).
  isAuto: boolean;
  autoStyle: "on-card" | "sticker" | null;  // detected from title text; null when uncertain
  serialRun: number | null;       // captured from serial pattern or /N (X/Y denominator wins)
  serialObserved: string | null;  // raw text of the serial as captured (for jersey-match detection later)
  confidence: "high" | "medium" | "low";  // aggregate self-assessment across the composite
}

/** Extract the composite parallel identity from a listing title.
 *  cardNumber → insertSet + baseball auto-prefix detection.
 *  sport + setName → cross-sport isAuto via setName-keyword rule
 *  (Panini basketball/football era). */
export function parseParallelComposite(
  title: string,
  cardNumber?: string | null,
  opts?: {
    sport?: string | null;
    setName?: string | null;
    // CF-A-CARDNUMBER-PREFIX-IS-SUFFICIENT-NEVER-NECESSARY (2026-09-04). The
    // product coordinates + an injected checklist index, so a shared-number
    // autograph (2011 Topps Chrome #173 Freddie Freeman AUTO, which carries
    // the BASE card's number) can be read as the auto it is. Optional
    // throughout: with no resolver the composite behaves exactly as before.
    year?: number | null;
    setKey?: string | null;
    checklistAuto?: ChecklistAutoResolver | null;
    autoCorroboration?: boolean;
  }
): ParallelComposite {
  const t = String(title ?? "").toLowerCase();

  // ─── Step 1: Edition (must run first) ─────────────────────────────
  const editionMatch = matchEditionAlias(t);
  const edition = editionMatch?.canonical ?? null;

  // ─── Step 1b: Insert set (via cardNumber prefix) ──────────────────
  // Runs alongside edition; both are orthogonal to color/finish axes.
  const insertSet = detectInsertSet(cardNumber ?? null);

  // ─── Step 2: Serial pattern ───────────────────────────────────────
  const { serialRun, serialObserved } = extractSerial(t);

  // ─── Step 3 + 4: Color + finish ───────────────────────────────────
  const colorMatch = matchColorFamilyAlias(t);
  const finishMatch = matchFinishModifierAlias(t);
  const colorFamily = colorMatch?.canonical ?? null;
  const finishModifier = finishMatch?.canonical ?? null;

  // isRefractor: explicit "refractor" word in title (any position)
  // OR the color match's alias contained "refractor" (e.g., "blue refractor").
  const isRefractor = /\brefractor\b/i.test(title)
    || (colorMatch?.value.aliases.some(a => /\brefractor\b/i.test(a)) ?? false);

  // ─── Step 5: Auto/relic (framework parsing order) ────────────────
  // Sport-aware via inferIsAuto — combines title text + cardNumber
  // prefix + setName keyword. Reuse parseListingIdentity for the
  // title-text extraction (isAuto + autoStyle in one call).
  const legacyParsed = parseListingIdentity(title);
  const isAuto = inferIsAuto({
    sport: opts?.sport ?? null,
    cardNumber: cardNumber ?? null,
    setName: opts?.setName ?? null,
    titleHasAutoText: legacyParsed.isAuto,
    year: opts?.year ?? null,
    setKey: opts?.setKey ?? null,
    checklistAuto: opts?.checklistAuto ?? null,
    // The title's own auto words are the usual corroboration. They cannot
    // arrive via titleHasAutoText (which short-circuits inferIsAuto), so the
    // same reading is passed explicitly for the checklist rule to gate on.
    autoCorroboration: opts?.autoCorroboration ?? legacyParsed.isAuto === true,
  });
  const autoStyle = legacyParsed.autoStyle;

  // Confidence:
  //   high    — edition/color known, plus serial matches or explicit refractor
  //   medium  — some tokens matched but ambiguous
  //   low     — nothing structured matched
  let confidence: ParallelComposite["confidence"] = "low";
  if (edition && colorFamily) confidence = "high";
  else if (colorFamily && (isRefractor || serialRun != null)) confidence = "high";
  else if (colorFamily || edition || insertSet || isAuto) confidence = "medium";

  return {
    edition,
    insertSet,
    colorFamily,
    finishModifier,
    isRefractor,
    isAuto,
    autoStyle,
    serialRun,
    serialObserved,
    confidence,
  };
}

/** Extract serial from title. X/Y form (denominator = print run,
 *  with X/Y also captured for later jersey-match analysis). Falls
 *  back to /N standalone with sanity bound (1..5000; anything higher
 *  is likely a year like "/2024" or a page number). */
function extractSerial(lowercaseTitle: string): { serialRun: number | null; serialObserved: string | null } {
  // X/Y where X and Y are numbers. Both must be small enough to be a
  // real serial (X <= 9999, Y <= 9999).
  const xy = lowercaseTitle.match(/(?:^|[^0-9])(\d{1,4})\/(\d{1,4})(?:\D|$)/);
  if (xy) {
    const y = Number(xy[2]);
    // Reject if denominator > 5000 (likely a date "5/2024" pattern).
    if (y > 0 && y <= 5000) {
      return { serialRun: y, serialObserved: `${xy[1]}/${xy[2]}` };
    }
  }
  // Standalone /N (no preceding X).
  const slash = lowercaseTitle.match(/\/(\d{1,4})(?:\D|$)/);
  if (slash) {
    const n = Number(slash[1]);
    if (n > 0 && n <= 5000) {
      return { serialRun: n, serialObserved: `/${slash[1]}` };
    }
  }
  return { serialRun: null, serialObserved: null };
}

/** Convenience: returns true when the composite indicates edition ≠
 *  null. Used by the chrome-implied setKey fix to avoid collapsing
 *  Sapphire/Mega/1st-Edition into base chrome. */
export function hasNonBaseEdition(title: string): boolean {
  return parseParallelComposite(title).edition != null;
}
