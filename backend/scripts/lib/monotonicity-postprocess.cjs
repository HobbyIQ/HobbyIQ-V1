// CF-MULTIPLIER-MONOTONICITY-ENFORCEMENT (2026-06-29) — shared post-
// process applied to the auto/vintage multiplier tables after the
// per-grade trimmed medians are computed. Enforces the domain truth
// that within a single (company, tier) row, ratios should generally
// increase with grade (PSA 7 ≤ PSA 8 ≤ PSA 9 ≤ PSA 10).
//
// Violations come from low-sample noise — when a tier has only 1-2
// observations for a higher grade, the trimmed median is unreliable
// and can be lower than the better-sampled lower grade. Without this
// post-process the engine reads the noisy value and underprices the
// holding (e.g., 1948-1969 PSA 100-500: PSA 9 = 64×, PSA 10 = 3× —
// PSA 10 vintage HOFs would price BELOW PSA 9 of the same card).
//
// Rules per (company, tier):
//   - Walk grades ascending: 1, 1.5, 2, ..., 9.5, 10
//   - For each grade G with a ratio R and sample size N:
//     - If R < prev_ratio AND N < MIN_N_FOR_KEEP → DROP (set to null;
//       engine falls through to per-grade fallback)
//     - Otherwise → KEEP (accept that data variance is real OR that
//       both adjacent grades have enough samples to trust)
//
// DESIGN CHOICE: drop-only, never promote. An earlier draft promoted
// the violator's ratio to match the prior grade, but that propagated
// LOW-grade outliers up the chain (e.g., PSA 5 / <25 = 5.354 from
// a single-comp anomaly pulled PSA 6-9 up to 5.354 by transitive
// match-prev). Drop-only avoids this — the noisy entry is removed,
// the engine falls back to the per-grade fallback (median across all
// tiers, more samples), and other grades keep their own values.
//
// AUTH and non-numeric grades are SKIPPED (different semantics — AUTH
// in vintage = damaged-card, can be legit sub-Raw).
//
// Mutates the table in-place. Returns a {adjustments[]} report for
// telemetry / diagnostic logging.

const GRADE_ORDER = ["1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10"];

const MIN_N_FOR_KEEP = 10;  // n < 10 → drop on monotonicity violation; n >= 10 → trust the variance

/**
 * Apply monotonicity post-process to one (company, tier) row.
 * @param {Record<string, Record<string, number>>} gradeRows  table[era][company] subtree (or table[company] for auto)
 * @param {Record<string, Record<string, {n:number}>>} diagnosticRows  same shape, diagnostics
 * @param {string[]} tiers  ordered tier labels for this table
 * @param {string} contextLabel  e.g. "1948-1969 PSA" or "auto PSA"
 * @param {{adjustments: Array<object>}} report  accumulator
 */
function enforceMonotonicityForCompany(gradeRows, diagnosticRows, tiers, contextLabel, report) {
  for (const tier of tiers) {
    let prevGrade = null;
    let prevRatio = null;
    for (const grade of GRADE_ORDER) {
      const row = gradeRows[grade];
      if (!row) continue;
      const r = row[tier];
      if (typeof r !== "number") continue;

      if (prevRatio !== null && r < prevRatio) {
        const diag = diagnosticRows?.[grade]?.[tier];
        const n = typeof diag?.n === "number" ? diag.n : 0;
        if (n < MIN_N_FOR_KEEP) {
          // DROP: not enough samples to trust against the prior grade's
          // value; let engine fall back to the per-grade fallback.
          delete row[tier];
          if (diagnosticRows?.[grade]?.[tier]) {
            diagnosticRows[grade][tier].monotonicityAction = `dropped (n=${n} < ${MIN_N_FOR_KEEP}, was ${r}, violated ${prevGrade}=${prevRatio})`;
          }
          report.adjustments.push({
            action: "drop",
            context: contextLabel,
            tier,
            grade,
            sampleSize: n,
            originalRatio: r,
            violatedGrade: prevGrade,
            violatedRatio: prevRatio,
          });
          // prev stays the same — this grade is now absent
          continue;
        }
        // n >= MIN_N_FOR_KEEP: trust the variance, keep the entry.
        // Log it as kept-despite-violation for analyst review without
        // mutating the table.
        report.adjustments.push({
          action: "keep-despite-violation",
          context: contextLabel,
          tier,
          grade,
          sampleSize: n,
          originalRatio: r,
          violatedGrade: prevGrade,
          violatedRatio: prevRatio,
        });
      }
      // Update prev (either non-violation OR kept-despite-violation)
      prevRatio = r;
      prevGrade = grade;
    }
  }
}

/**
 * Apply monotonicity post-process to an entire output table (mutates).
 * Handles both auto (table[company]) and vintage (table[era][company]).
 *
 * @param {object} output  the full calibration output object (has .table, .diagnostics)
 * @param {string[]} tiers  ordered tier labels for this table
 * @param {boolean} isVintage  true for vintage (two-level era→company), false for auto
 */
function applyMonotonicityPostprocess(output, tiers, isVintage) {
  const report = { adjustments: [] };
  if (isVintage) {
    for (const era of Object.keys(output.table)) {
      for (const company of Object.keys(output.table[era])) {
        enforceMonotonicityForCompany(
          output.table[era][company],
          output.diagnostics?.[era]?.[company],
          tiers,
          `${era} ${company}`,
          report,
        );
      }
    }
  } else {
    for (const company of Object.keys(output.table)) {
      enforceMonotonicityForCompany(
        output.table[company],
        output.diagnostics?.[company],
        tiers,
        company,
        report,
      );
    }
  }
  return report;
}

module.exports = { applyMonotonicityPostprocess, MIN_N_FOR_KEEP, GRADE_ORDER };
