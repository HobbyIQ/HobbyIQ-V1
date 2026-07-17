// CF-EBAY-ACTIVE-LISTINGS-RANK (Drew, 2026-07-17). Pure match-quality
// scoring for eBay Browse item summaries against a specific card
// identity. eBay's search is fuzzy: "Eric Hartman Orange Shimmer"
// returns Orange Shimmer + Orange Wave + Orange X-Fractor + plain
// Refractor + non-Hartman "Hartman-something". This ranker filters
// and orders results so iOS renders the best 5 first.
//
// Contract: pure function, no I/O, deterministic on inputs. Tested
// by tests/ebayListingRank.test.ts.

export interface RankInputs {
  year?: number | string;
  set?: string;
  cardNumber?: string;
  parallel?: string;
  gradeCompany?: string;   // "PSA" / "BGS" / "SGC" / "CGC"; empty/undefined = Raw
  gradeValue?: string;     // "10" / "9.5" etc
  /** Known parallel names for this card family that are DIFFERENT from
   *  `parallel`. When one of them appears in the title, we penalize —
   *  "Orange Wave" in a search for "Orange Shimmer" is a wrong match. */
  knownDifferentParallels?: string[];
}

export interface ScoreBreakdown {
  score: number;
  parallelHit: boolean;
  wrongParallelHit: string | null;
  cardNumberHit: boolean;
  yearHit: boolean;
  setHit: boolean;
  gradeMatch: "correct" | "wrong-grade" | "raw-but-graded" | "not-graded" | "no-signal";
}

const MIN_SCORE_THRESHOLD = 30;

/** Tokenize a parallel name into lowercase word tokens. "Orange
 *  Shimmer Refractor" → ["orange", "shimmer", "refractor"]. */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

/** True when every token in `candidateTokens` also appears in
 *  `parallelTokens`. Used to exclude sub-parallel names (e.g.
 *  "Refractor" is a subset of "Orange Shimmer Refractor" tokens). */
function isTokenSubset(candidateTokens: string[], parallelTokens: string[]): boolean {
  if (candidateTokens.length === 0) return false;
  const set = new Set(parallelTokens);
  return candidateTokens.every((tk) => set.has(tk));
}

/** Score a title against a card identity. Positive = likely match,
 *  negative = likely mis-match. Threshold is caller-defined. */
export function scoreListing(
  title: string,
  inp: RankInputs,
): ScoreBreakdown {
  const t = String(title ?? "").toLowerCase();
  const titleTokenSet = new Set(tokenize(t));

  // Token-based parallel match: title contains ALL tokens of the
  // parallel name (in any order). "Orange Shimmer /25" matches an
  // "Orange Shimmer Refractor" search when Refractor is missing? No —
  // ALL tokens must be present. "Orange Shimmer Refractor" → title
  // needs "orange" + "shimmer" + "refractor". This lets real eBay
  // title variations still match while rejecting genuinely different
  // parallels (Orange Wave has "wave" but not "shimmer" → miss).
  const parallelTokens = inp.parallel ? tokenize(inp.parallel) : [];
  const parallelHit =
    parallelTokens.length > 0
    && parallelTokens.every((tk) => titleTokenSet.has(tk));

  let wrongParallelHit: string | null = null;
  if (inp.knownDifferentParallels && inp.knownDifferentParallels.length > 0) {
    for (const p of inp.knownDifferentParallels) {
      const candidateTokens = tokenize(p);
      if (candidateTokens.length === 0) continue;
      // Skip candidates that share all tokens with the correct parallel
      // ("Refractor" is a subset of "Orange Shimmer Refractor" — never
      // fires as a "wrong" parallel because it might be present as part
      // of the correct string).
      if (isTokenSubset(candidateTokens, parallelTokens)) continue;
      // Fire if all candidate tokens appear in the title AND at least
      // one distinguishing token (i.e. one not in the correct parallel)
      // is present. This is what makes "Orange Wave" fire while the
      // shared "Refractor" case above is skipped.
      const parallelTokenSet = new Set(parallelTokens);
      const distinguishing = candidateTokens.filter((tk) => !parallelTokenSet.has(tk));
      if (distinguishing.length === 0) continue;
      const allInTitle = candidateTokens.every((tk) => titleTokenSet.has(tk));
      if (allInTitle) { wrongParallelHit = p; break; }
    }
  }

  const cardNumberLower = inp.cardNumber?.toLowerCase().trim() ?? "";
  // Strip any leading '#' the user's cardNumber field may carry — CH's
  // tokenizer treats '#' as a signal boundary, and eBay titles usually
  // don't put '#' immediately before the number either.
  const cardNumberBare = cardNumberLower.replace(/^#+/, "");
  const cardNumberHit = !!cardNumberBare && t.includes(cardNumberBare);

  const yearStr = inp.year !== undefined && inp.year !== null ? String(inp.year) : "";
  const yearHit = !!yearStr && t.includes(yearStr);

  const setLower = inp.set?.toLowerCase().trim() ?? "";
  const setHit = !!setLower && t.includes(setLower);

  // Grade classification
  const gradeCompanyLower = inp.gradeCompany?.toLowerCase().trim() ?? "";
  const gradeValueLower = inp.gradeValue?.toLowerCase().trim() ?? "";
  const titleHasAnyGrade = /\b(psa|bgs|sgc|cgc)\s*\d/.test(t);
  let gradeMatch: ScoreBreakdown["gradeMatch"] = "no-signal";
  if (gradeCompanyLower && gradeValueLower) {
    const gradePattern = new RegExp(
      `\\b${gradeCompanyLower}\\s*${gradeValueLower.replace(".", "\\.?")}\\b`,
    );
    if (gradePattern.test(t)) gradeMatch = "correct";
    else if (titleHasAnyGrade) gradeMatch = "wrong-grade";
    else gradeMatch = "not-graded";
  } else if (!gradeCompanyLower && titleHasAnyGrade) {
    // Owner has a Raw card; the listing is graded → different product
    gradeMatch = "raw-but-graded";
  }

  let score = 0;
  if (parallelHit) score += 50;
  if (wrongParallelHit) score -= 30;
  if (cardNumberHit) score += 20;
  if (yearHit) score += 10;
  if (setHit) score += 10;
  switch (gradeMatch) {
    case "correct":       score += 20; break;
    case "wrong-grade":   score -= 15; break;
    case "raw-but-graded": score -= 30; break;
    case "not-graded":    score -=  5; break;   // grade requested but absent from title
    case "no-signal":     break;
  }

  return { score, parallelHit, wrongParallelHit, cardNumberHit, yearHit, setHit, gradeMatch };
}

/** Rank + filter + slice. Items below MIN_SCORE_THRESHOLD dropped. */
export function rankAndFilter<T extends { title: string; id?: string }>(
  items: T[],
  inp: RankInputs,
  limit = 5,
  minScore = MIN_SCORE_THRESHOLD,
): Array<T & { matchScore: number; scoreBreakdown: ScoreBreakdown }> {
  return items
    .map((it) => {
      const breakdown = scoreListing(it.title, inp);
      return { ...it, matchScore: breakdown.score, scoreBreakdown: breakdown };
    })
    .filter((x) => x.matchScore >= minScore)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, limit);
}

export const _MIN_SCORE_THRESHOLD_FOR_TESTS = MIN_SCORE_THRESHOLD;
