// CF-MOVER-CREDIBILITY (Drew, 2026-08-20: "I am not seeing the sales index
// move").
//
// The index was never frozen. It was showing NOISE, and noise is stable — so
// the same junk sat at the top every day and the list looked dead.
//
// Measured on the live 7-day baseball window: 463,374 comps, 24,962 qualifying
// movers. No shortage of signal. But ranked by deltaPct with only an
// abs(deltaUSD) >= $1 guard, the top was entirely artifacts:
//
//   +190376%   $10.50 -> $20,000     Leaf Eclectic George MacIntyre
//   + 99900%   $0.01  -> $10         a ONE CENT listing
//   + 96567%   $0.45  -> $435
//   + 81718%   $0.11  -> $90         a team card
//   + 53025%   $0.16  -> $85
//
//   ...and every single top loser was exactly -100%, landing on $0.01-$1.
//
// A $0.01 sale generates a 99,900% "gain" from a one-dollar move, so it clears
// the old guard and outranks every genuine mover permanently. The top 20 was
// structurally reserved for cards that trade for pennies.
//
// WHY A FLOOR RATHER THAN A CAP ALONE. Percentage change is unstable near zero;
// no cap fixes that, because the instability is in the denominator. A card whose
// prior median is a penny cannot produce a meaningful percentage no matter what
// ceiling is applied. So credibility is judged on the PRIOR price first.
//
// SEVERAL LISTINGS ALSO SAY THEY ARE DAMAGED. Real titles from the top of the
// index carry "READ" / "READ FREE" — seller shorthand for a flaw described in
// the description. Those are real sales of damaged goods, not market moves.

export interface MoverCandidate {
  priorMedian: number;
  currentMedian: number;
  deltaPct: number;
  deltaUSD: number;
  salesInWindow: number;
}

export interface MoverCredibilityOptions {
  /** A prior median below this cannot produce a meaningful percentage. */
  minPriorUsd?: number;
  /** A move must be worth noticing in absolute terms too. */
  minAbsUsd?: number;
  /**
   * Largest plausible weekly FOLD change, in either direction.
   *
   * A percentage cap cannot do this job and the test caught it: a gain is
   * unbounded while a loss is floored at -100%, so `maxAbsPct: 400` rejects a
   * 5x rise and happily admits $5,449 -> $13.50 — a 404-fold COLLAPSE reading
   * as a mere -99.75%. Fold change is symmetric, which is what the phenomenon
   * actually is.
   */
  maxFoldChange?: number;
}

export const MOVER_DEFAULTS = {
  // $5 is deliberately low: it excludes penny and near-penny listings without
  // discarding genuinely cheap cards, which are most of the hobby by count.
  minPriorUsd: 5,
  minAbsUsd: 2,
  // A card doubling or halving in a week is remarkable but real. A FIVE-fold
  // swing in seven days, at these sample sizes, is a mis-slugged pool or a
  // damaged copy rather than a market.
  maxFoldChange: 5,
} as const;

/** Seller shorthand for a described flaw. These are real sales, but of a
 *  damaged card — they belong in neither half of a price comparison. */
const DAMAGED_TITLE_RE =
  /\bread\b|\breads\b|\bdamaged?\b|\bcreased?\b|\bcrease\b|\btorn\b|\bwater\s*damage\b|\bmiscut\b|\bstain(ed)?\b|\bwrinkl(e|ed)\b|\bpoor\s+condition\b|\bas[- ]is\b/i;

/**
 * Is this title describing a damaged card?
 *
 * Word-boundary anchored on purpose. Without \b, "read" matches "Bread",
 * "Ready" and "Threads" — and "Threads" is a Panini product line, so an
 * unanchored match would silently drop an entire set from the index.
 */
export function looksDamaged(title: string | null | undefined): boolean {
  return DAMAGED_TITLE_RE.test(String(title ?? ""));
}

/**
 * Should this candidate be allowed into the ranked index?
 *
 * Returns a reason when rejected so the endpoint can report WHY the list is
 * short rather than silently returning fewer rows — an index that quietly
 * filters everything is indistinguishable from one that is broken, which is
 * how this defect stayed invisible.
 */
export function moverCredibility(
  m: MoverCandidate,
  opts: MoverCredibilityOptions = {},
): { ok: true } | { ok: false; reason: string } {
  const minPrior = opts.minPriorUsd ?? MOVER_DEFAULTS.minPriorUsd;
  const minAbs = opts.minAbsUsd ?? MOVER_DEFAULTS.minAbsUsd;
  const maxFold = opts.maxFoldChange ?? MOVER_DEFAULTS.maxFoldChange;

  if (!(m.priorMedian > 0) || !(m.currentMedian > 0)) return { ok: false, reason: "non-positive median" };
  if (m.priorMedian < minPrior) return { ok: false, reason: `prior median < $${minPrior}` };
  if (m.currentMedian < minPrior) return { ok: false, reason: `current median < $${minPrior}` };
  if (Math.abs(m.deltaUSD) < minAbs) return { ok: false, reason: `abs move < $${minAbs}` };
  const fold = Math.max(m.priorMedian, m.currentMedian) / Math.min(m.priorMedian, m.currentMedian);
  if (fold > maxFold) return { ok: false, reason: `${fold.toFixed(1)}x swing > ${maxFold}x` };
  return { ok: true };
}
