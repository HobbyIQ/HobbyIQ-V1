/**
 * anomaly-scan-units.cjs -- pure unit enumeration + predicate math for
 * anomaly-force-scan.cjs. No I/O, no Cosmos, no clock, so the boundary math
 * can be pinned by a unit test the same way scripts/lib/split-identity.cjs
 * and rematch-sold-comps.cjs's own unit helpers are.
 *
 * CF-CLEANLINESS-ANOMALY-BUDGET (2026-09-11). detectAnomalies({force:true})
 * (services/portfolioiq/anomalyDetection.service.ts) walks the WHOLE
 * sold_comps container in one unbounded cross-partition query -- no paging
 * cap, no wall-clock budget -- so the nightly forced rescan has gone two
 * nights straight without a single terminal answer inside poll-admin-job
 * .cjs's 1,501s ceiling (see that service's own CF-CLEANLINESS-ANOMALY-BUDGET
 * comment). This file is the UNIT AXIS the budgeted lane scans by instead of
 * one unbounded walk: (cardYear, sportClass), the same composite axis
 * rematch-sold-comps.cjs measured and documented (GROUP BY cardYear over the
 * live pool, 2026-09-01: 16,336,293 rows in 136 year buckets, four years each
 * 2.5-5x an even share) -- reused here rather than re-derived, per
 * feedback_ratio_similarity_is_not_identity: the same field names, the same
 * SPORT_CLASSES vocabulary, the same yearKind split for absent vs explicit
 * null (49 rows carry no cardYear field at all, 4,017 carry an explicit null,
 * measured 2026-09-01 -- two populations, not one, and folding them into a
 * single predicate would either double-count or drop one entirely).
 *
 * WHY A STATIC YEAR RANGE, NOT A LIVE DISTINCT QUERY. rematch-sold-comps.cjs
 * ships a MEASURED shard table (data/rematch-shard-table.json) sized for
 * parallel fan-out across 32 dispatch slots. This lane is not a fan-out: it
 * is one nightly dispatch that resumes itself across budget stops via a
 * crawl_state cursor (see anomaly-force-scan.cjs), so it does not need a
 * pre-measured, row-balanced packing -- it needs a CHEAP, DETERMINISTIC
 * enumeration it can walk in a stable order across relaunches. A
 * `SELECT DISTINCT VALUE c.cardYear FROM c` is itself an unbounded
 * cross-partition scan of the exact shape this change exists to remove, so
 * the year axis is a static bounded range instead: 1869 (the earliest
 * confirmed sports card year in any hobby reference this repo carries) to
 * CURRENT_YEAR + 1 (next year's early-release product), plus the two
 * explicit absent/null buckets rematch-sold-comps proved are real
 * populations. A year with zero rows in the pool costs one cheap
 * empty-paged query and moves on -- see anomaly-force-scan.cjs's per-unit
 * budget check, which is sized for exactly that.
 */
"use strict";

/** The same four named sport classes rematch-sold-comps.cjs uses, plus
 *  "other" for every sport value outside them (or no sport at all). Not
 *  re-measured here -- reusing an already-measured vocabulary is the point. */
const SPORT_CLASSES = Object.freeze(["baseball", "football", "basketball", "pokemon"]);
const SPORT_CLASSES_WITH_OTHER = Object.freeze([...SPORT_CLASSES, "other"]);

/** Earliest cardYear this lane's static range covers. 1869 predates every
 *  card product in any checklist source this repo ingests; a real row
 *  carrying an earlier year is vanishingly unlikely and, if it exists, is
 *  reached by the "absent"/"null" buckets' sibling only when the field is
 *  truly missing -- a garbage year value still SITS inside a normal unit's
 *  predicate (`c.cardYear = @y`) and is simply a unit whose row count never
 *  shows up, which is the same cost as any other empty unit. */
const MIN_CARD_YEAR = 1869;

/**
 * Latest cardYear the static range covers: next calendar year, to admit
 * early-released "YEAR+1" product (2026 Bowman Chrome shipping in 2025, for
 * example) without re-deriving the bound from a live query. `now` is
 * injectable so the boundary is deterministic under test.
 */
function maxCardYear(now = new Date()) {
  return now.getUTCFullYear() + 1;
}

/**
 * Every (cardYear, sportClass) unit this lane will walk, in a STABLE order
 * (ascending year, then SPORT_CLASSES_WITH_OTHER order) so a cursor recorded
 * as "last unit index N" always means the same unit across every dispatch
 * within a given `now`. The absent/null year buckets sort FIRST (index 0/1
 * per sport class is reserved before any real year) so they are found early
 * rather than only after a multi-thousand-unit numeric sweep.
 *
 * @param {object} [opts]
 * @param {number} [opts.minYear] override MIN_CARD_YEAR (tests only)
 * @param {number} [opts.maxYear] override maxCardYear() (tests only)
 * @returns {{ index: number, yearKind: "absent"|"null"|"value", year: number|null, sportClass: string }[]}
 */
function enumerateUnits(opts = {}) {
  const minYear = Number.isFinite(opts.minYear) ? opts.minYear : MIN_CARD_YEAR;
  const maxYear = Number.isFinite(opts.maxYear) ? opts.maxYear : maxCardYear();
  if (maxYear < minYear) {
    throw new Error(`anomaly-scan-units: maxYear ${maxYear} < minYear ${minYear}`);
  }
  const units = [];
  let index = 0;
  for (const yearKind of ["absent", "null"]) {
    for (const sportClass of SPORT_CLASSES_WITH_OTHER) {
      units.push({ index: index++, yearKind, year: null, sportClass });
    }
  }
  for (let year = minYear; year <= maxYear; year++) {
    for (const sportClass of SPORT_CLASSES_WITH_OTHER) {
      units.push({ index: index++, yearKind: "value", year, sportClass });
    }
  }
  return units;
}

/** Total unit count for a given range, without materialising the array --
 *  the cursor math and the budget-margin reasoning both want this cheaply. */
function unitCount(opts = {}) {
  const minYear = Number.isFinite(opts.minYear) ? opts.minYear : MIN_CARD_YEAR;
  const maxYear = Number.isFinite(opts.maxYear) ? opts.maxYear : maxCardYear();
  const yearBuckets = Math.max(0, maxYear - minYear + 1);
  return 2 * SPORT_CLASSES_WITH_OTHER.length + yearBuckets * SPORT_CLASSES_WITH_OTHER.length;
}

/**
 * A Cosmos predicate + parameters for one unit, scoped with a positional
 * suffix `i` so several units' predicates can share one parameterised query
 * without their bind-variable names colliding -- same convention
 * rematch-sold-comps.cjs's unitPredicate() uses.
 */
function unitPredicate(unit, i = 0) {
  const params = [];
  const parts = [];
  if (unit.yearKind === "absent") parts.push("NOT IS_DEFINED(c.cardYear)");
  else if (unit.yearKind === "null") parts.push("IS_NULL(c.cardYear)");
  else {
    parts.push(`c.cardYear = @y${i}`);
    params.push({ name: `@y${i}`, value: Number(unit.year) });
  }
  if (unit.sportClass === "other") {
    const names = SPORT_CLASSES.map((s, j) => {
      params.push({ name: `@sc${i}_${j}`, value: s });
      return `@sc${i}_${j}`;
    });
    parts.push(`(NOT IS_DEFINED(c.sport) OR NOT (c.sport IN (${names.join(", ")})))`);
  } else {
    parts.push(`c.sport = @s${i}`);
    params.push({ name: `@s${i}`, value: unit.sportClass });
  }
  return { where: `(${parts.join(" AND ")})`, params };
}

/** The full WHERE + parameters for one unit's query against sold_comps,
 *  folded together with the report's own row filter (hiq: slugs with a
 *  defined price) so the scan never reads a row it will discard anyway. */
function unitQuery(unit, i = 0) {
  const { where, params } = unitPredicate(unit, i);
  return {
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price) AND ${where}`,
    parameters: params,
  };
}

/** True when `row` belongs to `unit` -- used only by tests to prove the
 *  predicate math partitions the pool rather than overlapping or leaving a
 *  gap; the lane itself trusts the Cosmos-side predicate on the real read. */
function rowInUnit(row, unit) {
  const yearOk =
    unit.yearKind === "absent" ? row.cardYear === undefined
    : unit.yearKind === "null" ? row.cardYear === null
    : row.cardYear !== null && row.cardYear !== undefined && Number(row.cardYear) === Number(unit.year);
  if (!yearOk) return false;
  const sport = String(row.sport ?? "").toLowerCase();
  if (unit.sportClass === "other") return !SPORT_CLASSES.includes(sport);
  return sport === unit.sportClass;
}

module.exports = {
  SPORT_CLASSES,
  SPORT_CLASSES_WITH_OTHER,
  MIN_CARD_YEAR,
  maxCardYear,
  enumerateUnits,
  unitCount,
  unitPredicate,
  unitQuery,
  rowInUnit,
};
