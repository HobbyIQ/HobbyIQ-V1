"use strict";
/**
 * rekey-id-stem-scope.cjs -- the pure query-building piece of
 * `rekey-product-setkey.cjs`'s "id stem" scan pass
 * (CF-A-PREFIX-SCAN-SCOPES-TO-WHAT-IT-KNOWS, 2026-09-26; run 36246861648).
 *
 * ── THE INCIDENT ─────────────────────────────────────────────────────────────
 *
 * apply-hop2 (run=36246861648, dispatched 2026-09-26 13:57:17Z, the Topps
 * Series 2 -> topps fold) printed "-- scanning by id stem" at 15:01:30Z and
 * then produced NO further output for 87 minutes, until GitHub Actions' own
 * 150-minute step timeout killed it at 16:28:32Z. No finishLane line, no
 * budget marker, no REPORT/APPLIED summary -- the process was still inside
 * that one scan pass when it died.
 *
 * The id-stem query at the time was:
 *
 *   SELECT * FROM c WHERE STARTSWITH(c.id, @p)      @p = "hiq:baseball:"
 *
 * card_catalog holds 31.4M rows and `id` is the row's own identity, NOT the
 * partition key -- so this is a CROSS-PARTITION prefix scan of the ENTIRE
 * baseball catalog, with the year (parts[2], line ~670) and FROM-setKey
 * (parts[3], line ~664) filters applied only CLIENT-SIDE, after every row in
 * the sport is already fetched. Running under concurrency=16 (this lane's own
 * CONCURRENCY, unrelated to Cosmos SDK retry) plus whatever else was hitting
 * card_catalog/sold_comps at the time, the scan drove sustained 429
 * throttling that the Cosmos SDK's OWN retry layer
 * (maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 --
 * rekey-product-setkey.cjs:505-508) absorbed SILENTLY, inside a single
 * `fetchNext()` call, before ever throwing back to this script's own retry()
 * wrapper (lines ~419-428). Up to 30 retries at up to 120s each is close to
 * an hour of silent retrying per page fetch, and forEachPage
 * (lines ~431-438) prints nothing between pages -- so 87 minutes of real SDK
 * throttling and 87 minutes of a genuinely hung process look IDENTICAL in the
 * runner log. Both defects (a full-catalog scan under a client-side filter,
 * and silence that hides SDK-level throttling) are fixed here.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────
 *
 * Ids are `hiq:<sport>:<year>:<setKey>[:sub-{slug}]:<number>:<parallel>:<auto>
 * [:num-N]`. When the dispatch already knows SPORT, at least one YEAR, and the
 * FROM setKey, the id-stem pass does not need to read the whole sport at all
 * -- it can ask Cosmos for exactly the rows that could possibly matter, one
 * prefix per year in scope:
 *
 *   STARTSWITH(c.id, "hiq:<sport>:<year>:<fromSetKey>:")   -- once per year
 *
 * This is a NARROWING, not a behaviour change: every row the narrowed query
 * returns is a row the old full-sport query would also have returned (its id
 * literally starts with the old, shorter prefix), and every row the old query
 * filtered out client-side by year/stem mismatch is now simply never fetched.
 * The existing client-side filters in rekey-product-setkey.cjs
 * (`parts[3] !== FROM`, the YEARS.includes check) are KEPT, unchanged, as a
 * second guard -- so a malformed or unexpected id shape is caught exactly as
 * it was before; this module only decides which prefixes to ask Cosmos for.
 *
 * When YEARS or FROM are not both known (MODE=catalog's id-stem pass is
 * shared code and some future caller might invoke it without a year axis),
 * `buildIdStemSpecs` falls back to the original full-sport-and-stem behaviour
 * byte-for-byte and flags that fallback so the caller can log a WARNING
 * naming the full scan -- never a silent full scan.
 *
 * ── SELF-CONTAINED ────────────────────────────────────────────────────────────
 *
 * No `require` of anything outside this file, matching card-number-scope.cjs
 * / market-guard.cjs / name-agreement.cjs's own contract for this script's
 * other pure decisions: pure string/array in, plain objects out, so it is
 * `require`-able and unit-testable with no Cosmos client and no dist/.
 */

/**
 * Build the query spec(s) for the "id stem" scan pass.
 *
 * @param {object} opts
 * @param {string} opts.sport     lower-cased sport, e.g. "baseball". Required
 *                                 for ANY narrowing; falls back without it.
 * @param {number[]} [opts.years] years in scope (already parsed/filtered to
 *                                 finite positive numbers by the caller, the
 *                                 same YEARS array rekey-product-setkey.cjs
 *                                 already builds). Empty/absent -> fallback.
 * @param {string} [opts.fromSetKey] the FROM setKey this dispatch is moving
 *                                 rows out of. Empty/absent -> fallback.
 * @returns {{ specs: Array<{name: string, query: string, parameters: Array<{name: string, value: string}>}>, narrowed: boolean, fallbackReason: string|null }}
 *   `specs` -- one query spec per year in scope when narrowed, or a single
 *   full-sport spec (identical to the pre-fix query) when not.
 *   `narrowed` -- true iff every spec scopes to a single (sport, year,
 *   fromSetKey) prefix.
 *   `fallbackReason` -- null when narrowed; otherwise a short string naming
 *   what was missing, for the caller to log as a WARNING.
 */
function buildIdStemSpecs({ sport, years, fromSetKey } = {}) {
  const sp = String(sport ?? "").trim().toLowerCase();
  const from = String(fromSetKey ?? "").trim().toLowerCase();
  const yrs = Array.isArray(years) ? years.filter((y) => Number.isFinite(y) && y > 0) : [];

  if (!sp) {
    return {
      specs: [idStemFallbackSpec(sp)],
      narrowed: false,
      fallbackReason: "SPORT is empty -- cannot scope even to a sport, falling back to the (empty) full-sport prefix",
    };
  }
  if (!yrs.length || !from) {
    const missing = [!yrs.length ? "years" : null, !from ? "from-setKey" : null].filter(Boolean).join(" and ");
    return {
      specs: [idStemFallbackSpec(sp)],
      narrowed: false,
      fallbackReason: `${missing} not known -- cannot narrow past sport; scanning the WHOLE "${sp}" catalog by id stem (cross-partition, full source, client-side filtered)`,
    };
  }

  const specs = yrs.map((y) => ({
    name: `id stem (${sp}/${y}/${from})`,
    query: "SELECT * FROM c WHERE STARTSWITH(c.id, @p)",
    parameters: [{ name: "@p", value: `hiq:${sp}:${y}:${from}:` }],
  }));
  return { specs, narrowed: true, fallbackReason: null };
}

/** The pre-fix query shape, byte-identical: the whole sport, no year/setKey
 *  narrowing. Kept as its own function so the fallback path is provably the
 *  SAME text the incident's query used, not a re-derivation of it. */
function idStemFallbackSpec(sport) {
  return {
    name: "id stem",
    query: "SELECT * FROM c WHERE STARTSWITH(c.id, @p)",
    parameters: [{ name: "@p", value: `hiq:${sport}:` }],
  };
}

module.exports = { buildIdStemSpecs, idStemFallbackSpec };
