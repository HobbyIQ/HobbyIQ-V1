/**
 * CF-FUZZY-PLAYER-SEARCH (2026-07-08, Drew):
 *
 * When a search returns zero hits, try a fuzzy retry on the player
 * name. Catches typos ("Willets" → "Willits", "Ohtony" → "Ohtani")
 * and near-misspellings that CH's exact-token search misses.
 *
 * Strategy:
 *   1. Parse the query the same way parseCardQuery does — extract
 *      the player-name candidate + other tokens.
 *   2. Ask CH's autocomplete for the CLOSEST player name to the
 *      candidate. CH's autocomplete DOES handle fuzzy prefix matches
 *      well, but it's not always tried when the query has multiple
 *      tokens.
 *   3. If a close match is found (Levenshtein <= 2), re-run the
 *      search substituting the corrected player name.
 *   4. Return the corrected name and (optionally) the retry results.
 *
 * The service is intended as a FALLBACK — the primary search path
 * runs first; only when it returns zero candidates do we invoke this
 * layer.
 *
 * Silent no-throw. All errors caught, returned as null. Never blocks
 * the primary response path.
 */

/**
 * Levenshtein distance between two lowercase strings. Iterative DP,
 * O(m*n) time / O(min(m,n)) space. Handles both empty strings and
 * up to ~1000-char inputs comfortably.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  // Use the shorter string as the row so memory is bounded by min(m,n).
  const [shorter, longer] = s.length < t.length ? [s, t] : [t, s];
  let prev = new Array(shorter.length + 1);
  let curr = new Array(shorter.length + 1);
  for (let i = 0; i <= shorter.length; i++) prev[i] = i;
  for (let j = 1; j <= longer.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= shorter.length; i++) {
      const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,      // insertion
        prev[i] + 1,          // deletion
        prev[i - 1] + cost,   // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[shorter.length];
}

/**
 * Find the closest match to `candidate` from `pool`, using Levenshtein
 * distance. Returns null when no candidate is within `maxDistance`.
 * Ties broken by the earliest index in `pool`.
 */
export function closestMatch(
  candidate: string,
  pool: string[],
  maxDistance = 2,
): { match: string; distance: number } | null {
  if (!candidate || !pool.length) return null;
  const cand = candidate.trim().toLowerCase();
  let best: { match: string; distance: number } | null = null;
  for (const item of pool) {
    const distance = levenshtein(cand, item.toLowerCase());
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) {
      best = { match: item, distance };
      if (distance === 0) break;
    }
  }
  return best;
}

/**
 * Longer distance is allowed for longer names (proportional to
 * candidate length). A 12-char surname can tolerate 3 edits; a
 * 4-char surname can only tolerate 1.
 */
export function proportionalMaxDistance(candidate: string): number {
  const len = candidate.trim().length;
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}
