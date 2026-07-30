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
import { detectInsertSet } from "./parseTitleIdentity.service.js";

export interface ParallelComposite {
  edition: string | null;         // "SAPPHIRE" | "MEGA_BOX" | "FIRST_EDITION" | "SONIC" | "COSMIC" | "LITE" | null
  insertSet: string | null;       // "scouts-top-100" | "home-run-challenge" | "future-stars" | ... (from detectInsertSet)
  colorFamily: string | null;     // "BASE" | "REFRACTOR" | "BLUE" | ... (uppercase key from vocab)
  finishModifier: string | null;  // "SHIMMER" | "WAVE" | "SPECKLE" | ... (uppercase key from vocab)
  isRefractor: boolean;           // true when title says "refractor" or product implies (e.g., "Blue Refractor")
  serialRun: number | null;       // captured from serial pattern or /N (X/Y denominator wins)
  serialObserved: string | null;  // raw text of the serial as captured (for jersey-match detection later)
  confidence: "high" | "medium" | "low";  // aggregate self-assessment across the composite
}

/** Extract the composite parallel identity from a listing title.
 *  cardNumber is used to detect insertSet (via detectInsertSet); the
 *  rest of extraction is product-agnostic. */
export function parseParallelComposite(title: string, cardNumber?: string | null): ParallelComposite {
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

  // Confidence:
  //   high    — edition/color known, plus serial matches or explicit refractor
  //   medium  — some tokens matched but ambiguous
  //   low     — nothing structured matched
  let confidence: ParallelComposite["confidence"] = "low";
  if (edition && colorFamily) confidence = "high";
  else if (colorFamily && (isRefractor || serialRun != null)) confidence = "high";
  else if (colorFamily || edition || insertSet) confidence = "medium";

  return {
    edition,
    insertSet,
    colorFamily,
    finishModifier,
    isRefractor,
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
