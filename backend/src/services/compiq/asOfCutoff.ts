/**
 * CF-AS-OF-IS-AN-UPPER-BOUND (#1651, the engine backtest, 2026-09-02) — the
 * cutoff, and why it is not simply `new Date(asOfMs).toISOString()`.
 *
 * THE DEFECT THIS MODULE EXISTS FOR, found by running the backtest against the
 * live pool rather than by reading the query:
 *
 * `c.soldAt` is a STRING in sold_comps, and Cosmos compares it as one. The
 * container holds the same instant written three different ways, because three
 * ingest paths serialize it three different ways (measured 2026-09-02 over
 * 4,000 rows since 2026-06-01):
 *
 *     2026-06-04T23:09:00+00:00     3,062 rows   (cardhedge)
 *     2026-06-04T23:09:00.000Z        878 rows
 *     2026-06-04T23:09:00Z             60 rows
 *
 * Those three sort in an order that has nothing to do with time, because `+`
 * (0x2B) < `.` (0x2E) < `Z` (0x5A) in ordinal comparison:
 *
 *     "…T23:09:00+00:00"  <  "…T23:09:00.000Z"      -> TRUE
 *
 * So a backtest that set its ceiling to the ISO form of the held-out sale's
 * timestamp — `…00.000Z` — did NOT exclude that very sale when the row happened
 * to be stored in `+00:00` form. It let it straight through `c.soldAt < @asOf`.
 *
 * That is the exact failure the whole as-of design is meant to prevent, and it
 * is worth stating how it presented, because it is the reason a green test
 * suite was not enough: the engine priced the card at $29.99 off a pool of ONE
 * comp — the sale being predicted — and "predicted" it to the cent. It does not
 * look like a bug in a report. It looks like an extremely accurate engine. The
 * fixture tests all passed, because fixtures were written in one format.
 *
 * THE FIX. Cut at the START of the instant's second, spelled in the form that
 * sorts BELOW every serialization of that second:
 *
 *     2026-06-04T23:09:00+00:00  ->  cutoff "2026-06-04T23:09:00"
 *
 * A bare `YYYY-MM-DDTHH:MM:SS` prefix is <= every string that begins with those
 * 19 characters (a prefix always sorts before any extension of itself), and
 * strictly less than every LATER second in every format, since the comparison
 * is then decided within the first 19 characters. So `c.soldAt < @asOf` drops
 * the whole second the held-out sale falls in, whatever spelling it was stored
 * in, and keeps everything before it.
 *
 * The cost is deliberate and stated: sales in the SAME SECOND as the held-out
 * sale are also excluded. That is the right trade — a sale in the same second
 * is not information the engine could have acted on, and the alternative is a
 * ceiling whose correctness depends on which ingest wrote the row.
 *
 * BELT AND BRACES. `isBeforeAsOf` re-checks by PARSED TIME in process, so a row
 * in some fourth format nobody has seen yet cannot slip past the string bound.
 * The query bound is the one that matters for RU cost; this one is the one that
 * cannot be fooled by a serialization.
 */

/** The string cutoff for `c.soldAt < @asOf`, given an as-of instant.
 *
 *  Truncated to the second and spelled without a zone suffix, so it sorts at
 *  or below every serialization of that second and strictly below every later
 *  one. See the header for why the obvious `toISOString()` is wrong. */
export function asOfCutoffString(asOfMs: number): string {
  // "2026-06-04T23:09:00.000Z" -> "2026-06-04T23:09:00"
  return new Date(asOfMs).toISOString().slice(0, 19);
}

/** True when a stored `soldAt` is strictly before the as-of instant, by PARSED
 *  time. The in-process guard behind the query bound.
 *
 *  A row whose timestamp cannot be parsed is treated as NOT before the cutoff —
 *  it is excluded. An unreadable date is not evidence of anything, and the
 *  failure mode of admitting it is a silently inflated accuracy number. */
export function isBeforeAsOf(soldAt: unknown, asOfMs: number | null): boolean {
  if (asOfMs === null) return true;
  const t = Date.parse(String(soldAt ?? ""));
  if (!Number.isFinite(t)) return false;
  // Same second as the held-out sale is excluded, matching the string bound so
  // the two filters can never disagree about a row.
  return t < Math.floor(asOfMs / 1000) * 1000;
}
