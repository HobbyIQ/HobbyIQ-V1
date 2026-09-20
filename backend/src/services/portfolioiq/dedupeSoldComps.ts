// CF-DEDUPE-SOLD-COMPS (2026-08-22).
//
// The same sale reaches sold_comps more than once. cardsight, cardhedge and
// tca-ebay each ingest the same eBay transaction, and cardhedge alone writes
// it twice with different timestamp precision. Measured on Shohei Ohtani 2018
// Bowman Chrome #1 — 1,238 rows in a 180d window, 340 of them (27%) duplicates:
//
//   $1,826.00 on 07-06   cardsight@00:26:48  cardhedge@00:33:21  cardhedge@00:33:00
//   $2,146.21 on 07-14   cardsight@23:30:01  cardhedge@23:35:26  cardhedge@23:35:00
//
// Identical price to the cent, minutes apart, three rows, one sale.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. Duplicates do not just inflate a count.
// unifiedPricing's leading edge is the MEDIAN OF THE LAST 3 SALES, so two
// copies of one sale outvote every other recent sale and become the answer.
// That is how this card reported "-9.7%, falling" while its own 224 PSA 9
// sales were rising +16%/month, and why its market value read ~$650 low.
//
// THE KEY, and why each part of it is there:
//
//   same card    - obvious.
//   same grade   - a raw and a PSA 10 at the same price on the same day are
//                  two different sales, not one.
//   same price   - to the cent. Two genuinely distinct sales landing on the
//                  identical cent within the hour is vanishingly unlikely;
//                  $2,146.21 twice in five minutes is not a coincidence.
//   within 60m   - measured, not chosen. Sweeping the window on real data:
//                  0m removes 109, 1m 277, 15m 335, 30m 339, 60m 340, then
//                  180m 349, 24h 412. It plateaus at an hour — one extra row
//                  between 30m and 60m — and everything past that is real
//                  sales at a repeated price later in the day.
//
// NON-DESTRUCTIVE. This collapses on READ. Nothing is deleted, so a wrong call
// here costs a query's accuracy, not data. Because rows are clustered on an
// IDENTICAL price, which row survives cannot change any computed price — only
// which source/url is attributed — so we keep the earliest, the record closest
// to the sale itself.

/** Minimum a row must carry to be deduped. Extra fields pass through. */
export interface DedupableComp {
  price?: unknown;
  soldAt?: unknown;
  gradeCompany?: unknown;
  gradeValue?: unknown;
  source?: unknown;
  sourceExternalId?: unknown;
  id?: unknown;
}

/** Measured plateau. Override per-caller only with a reason. */
export const DEDUPE_WINDOW_MINUTES = 60;

function gradeKey(r: DedupableComp): string {
  const company = typeof r.gradeCompany === "string" && r.gradeCompany.trim()
    ? r.gradeCompany.trim().toUpperCase()
    : "RAW";
  const value = typeof r.gradeValue === "number" && Number.isFinite(r.gradeValue)
    ? String(r.gradeValue)
    : "";
  return `${company}:${value}`;
}

export interface DedupeOptions {
  windowMinutes?: number;
  /**
   * When set, two rows in the same (gradeKey, price) cluster collapse only
   * when this ALSO returns true for the pair — never on the gradeKey|price
   * coincidence alone. Undefined (the default, and the FMV path's behavior,
   * unchanged) collapses on the coincidence alone, as documented above.
   */
  onlyWhen?: (a: DedupableComp, b: DedupableComp) => boolean;
}

/** `ch-daily::<price_history_id>` (bare) vs the LEGACY synthetic
 *  `ch-daily::<cardId>::<soldAt>::<cents>` (composite — embeds soldAt as its
 *  own "::"-delimited segment) vs `ch-comp::…` vs anything else. Mirrors
 *  scripts/lib/chSoldCompId.cjs's `isLongSyntheticShape` / census-ch-daily-
 *  external-id-reuse.cjs's "bare"/"composite" vocabulary — this is the SAME
 *  writer-shape distinction, not a new one invented for this predicate. */
function chWriterShape(r: DedupableComp): string | null {
  const ext = typeof r.sourceExternalId === "string" ? r.sourceExternalId : "";
  const idStr = typeof r.id === "string" ? r.id : "";
  const s = ext || idStr;
  if (!s) return null;
  if (s.startsWith("ch-comp::") || s.includes("::ch-comp::")) return "ch-comp";
  const dailyMatch = s.match(/ch-daily::(.*)$/);
  if (!dailyMatch) return null;
  // Bare: ch-daily::<token>, exactly one segment after the prefix. Composite
  // (legacy synthetic): ch-daily::<cardId>::<soldAt>::<cents>, three or more.
  const segs = dailyMatch[1].split("::");
  return segs.length >= 3 ? "ch-daily-composite" : "ch-daily-bare";
}

/**
 * CF-VOLUME-READERS-NEED-DISTINCT-WRITERS (2026-09-20). The gradeKey|price
 * coincidence rule alone is right for a THIN pool (the FMV leading edge,
 * the observed grade curve, a card-detail comp list): two sales of a
 * $2,000 card at the identical cent within an hour really are, almost
 * always, one CardHedge sale written twice. It is WRONG for a volume-
 * counting surface on a common: 30 genuine $1.99 sales of the same card in
 * one hour are 30 real sales, and collapsing them on price+time alone
 * would misreport a real high-volume card as illiquid.
 *
 * This predicate is the "are these two rows actually the SAME sale, not
 * just the same price" check for that shape: collapse only when the two
 * rows are DIFFERENT WRITER SHAPES — the CardHedge dual-id bug's actual
 * signature (one sale, written by two different code paths, so it carries
 * two different id shapes) — never two rows of the identical shape, which
 * is what 30 genuine same-price sales from the SAME feed look like.
 *
 * Passed as `onlyWhen` to the three volume-counting call sites
 * (marketMoversSnapshot.service.ts's raw scan, marketIndex.service.ts's
 * fetchSales, rollup-sold-comps-daily.cjs) — never the default, and never
 * used by unifiedPricing.service.ts or any other thin-pool reader.
 */
export function distinctWriterShape(a: DedupableComp, b: DedupableComp): boolean {
  const sourceA = typeof a.source === "string" ? a.source : "";
  const sourceB = typeof b.source === "string" ? b.source : "";
  if (sourceA && sourceB && sourceA !== sourceB) return true;
  if (sourceA === "cardhedge" && sourceB === "cardhedge") {
    const shapeA = chWriterShape(a);
    const shapeB = chWriterShape(b);
    if (shapeA && shapeB) return shapeA !== shapeB;
  }
  return false;
}

/**
 * Collapse rows that are the same sale seen more than once.
 *
 * Rows that cannot be keyed — unparseable date, non-positive price — are
 * PASSED THROUGH untouched rather than dropped. This function exists to remove
 * duplicates, not to filter the pool; quality filtering is someone else's job
 * and silently eating rows here would be invisible at every call site.
 *
 * `windowMinutes` accepts a bare number (the pre-existing signature, kept
 * for every call site that has never needed `onlyWhen`) or a `DedupeOptions`
 * object.
 */
export function dedupeSoldComps<T extends DedupableComp>(
  rows: readonly T[],
  windowMinutesOrOptions: number | DedupeOptions = DEDUPE_WINDOW_MINUTES,
): T[] {
  if (!Array.isArray(rows) || rows.length < 2) return rows ? [...rows] : [];
  const opts: DedupeOptions = typeof windowMinutesOrOptions === "number"
    ? { windowMinutes: windowMinutesOrOptions }
    : windowMinutesOrOptions;
  const windowMinutes = opts.windowMinutes ?? DEDUPE_WINDOW_MINUTES;
  const onlyWhen = opts.onlyWhen;
  const windowMs = Math.max(0, windowMinutes) * 60_000;

  const keyable: Array<{ row: T; t: number; k: string }> = [];
  const passthrough: T[] = [];

  for (const row of rows) {
    const price = Number(row.price);
    const t = Date.parse(String(row.soldAt ?? ""));
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(t)) {
      passthrough.push(row);
      continue;
    }
    keyable.push({ row, t, k: `${gradeKey(row)}|${price.toFixed(2)}` });
  }

  const byKey = new Map<string, Array<{ row: T; t: number }>>();
  for (const e of keyable) {
    const bucket = byKey.get(e.k);
    if (bucket) bucket.push({ row: e.row, t: e.t });
    else byKey.set(e.k, [{ row: e.row, t: e.t }]);
  }

  const kept: T[] = [];
  for (const bucket of byKey.values()) {
    bucket.sort((a, b) => a.t - b.t);
    let clusterAnchor: { row: T; t: number } | null = null;
    for (const e of bucket) {
      // Anchor on the FIRST row of the cluster, not the previous row, so a
      // dense run of real sales an hour apart each cannot chain-collapse into
      // one. Chaining would make the window silently unbounded.
      if (
        clusterAnchor !== null
        && e.t - clusterAnchor.t <= windowMs
        && (onlyWhen === undefined || onlyWhen(clusterAnchor.row, e.row))
      ) {
        continue;
      }
      clusterAnchor = e;
      kept.push(e.row);
    }
  }

  return [...kept, ...passthrough];
}

/** How many rows a dedupe would remove, without doing it. For telemetry. */
export function countSoldCompDuplicates(
  rows: readonly DedupableComp[],
  windowMinutesOrOptions: number | DedupeOptions = DEDUPE_WINDOW_MINUTES,
): number {
  return rows.length - dedupeSoldComps(rows, windowMinutesOrOptions).length;
}
