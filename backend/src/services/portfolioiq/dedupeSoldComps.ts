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

/**
 * Collapse rows that are the same sale seen more than once.
 *
 * Rows that cannot be keyed — unparseable date, non-positive price — are
 * PASSED THROUGH untouched rather than dropped. This function exists to remove
 * duplicates, not to filter the pool; quality filtering is someone else's job
 * and silently eating rows here would be invisible at every call site.
 */
export function dedupeSoldComps<T extends DedupableComp>(
  rows: readonly T[],
  windowMinutes: number = DEDUPE_WINDOW_MINUTES,
): T[] {
  if (!Array.isArray(rows) || rows.length < 2) return rows ? [...rows] : [];
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
    let clusterAnchor = Number.NEGATIVE_INFINITY;
    for (const e of bucket) {
      // Anchor on the FIRST row of the cluster, not the previous row, so a
      // dense run of real sales an hour apart each cannot chain-collapse into
      // one. Chaining would make the window silently unbounded.
      if (e.t - clusterAnchor <= windowMs) continue;
      clusterAnchor = e.t;
      kept.push(e.row);
    }
  }

  return [...kept, ...passthrough];
}

/** How many rows a dedupe would remove, without doing it. For telemetry. */
export function countSoldCompDuplicates(
  rows: readonly DedupableComp[],
  windowMinutes: number = DEDUPE_WINDOW_MINUTES,
): number {
  return rows.length - dedupeSoldComps(rows, windowMinutes).length;
}
