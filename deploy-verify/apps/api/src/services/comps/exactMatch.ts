// apps/api/src/services/comps/exactMatch.ts
// Utility for strong exact-match filtering of comps
import type { NormalizedComp } from "../../types/comps";

export interface ExactMatchOptions {
  playerName?: string;
  cardSet?: string;
  year?: number;
  cardNumber?: string;
  parallel?: string;
  grade?: string;
  grader?: string;
}

/**
 * Returns true if the comp matches all provided fields exactly (case-insensitive, trimmed).
 */
export function isExactMatch(comp: NormalizedComp, opts: ExactMatchOptions): boolean {
  if (opts.playerName && (!comp.playerName || comp.playerName.trim().toLowerCase() !== opts.playerName.trim().toLowerCase())) return false;
  if (opts.cardSet && (!comp.cardSet || comp.cardSet.trim().toLowerCase() !== opts.cardSet.trim().toLowerCase())) return false;
  if (opts.year && comp.year !== opts.year) return false;
  if (opts.cardNumber && (!comp.cardNumber || comp.cardNumber.trim().toLowerCase() !== opts.cardNumber.trim().toLowerCase())) return false;
  if (opts.parallel && (!comp.parallel || comp.parallel.trim().toLowerCase() !== opts.parallel.trim().toLowerCase())) return false;
  if (opts.grade && (!comp.grade || comp.grade.trim().toLowerCase() !== opts.grade.trim().toLowerCase())) return false;
  if (opts.grader && (!comp.grader || comp.grader.trim().toLowerCase() !== opts.grader.trim().toLowerCase())) return false;
  return true;
}

/**
 * Filters a list of comps to only those that are exact matches for the given options.
 */
export function filterExactMatches(comps: NormalizedComp[], opts: ExactMatchOptions): NormalizedComp[] {
  return comps.filter(comp => isExactMatch(comp, opts));
}
