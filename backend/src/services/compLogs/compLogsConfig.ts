/**
 * Runtime configuration for the CompIQ comp_logs writer.
 *
 * Environment variables consumed by this module:
 *
 *   COMPIQ_COMP_LOGS_DISABLED
 *     Hard kill-switch. When set to "1", "true", or "yes"
 *     (case-insensitive), comp_logs writes are skipped unconditionally —
 *     sample rate is not even evaluated. Operator break-glass during an
 *     incident.
 *
 *   COMPIQ_COMP_LOGS_SAMPLE_RATE
 *     Fraction of pricing responses to capture, in [0, 1]. Default is 0
 *     (capture nothing). Invalid values (non-numeric, out-of-range,
 *     NaN) are treated as 0 with a single warn() log per process; the
 *     writer stays safe-off.
 *
 * Both values are re-read on EVERY call. There is no caching, so an
 * operator can flip either knob without a process restart and the
 * change takes effect on the next sampled request.
 *
 * NOTE: This is intentionally separate from COMPIQ_CORPUS_SAMPLE_RATE.
 * The two telemetry streams (compiq_corpus for ML training, comp_logs
 * for operational/cohort analysis) are tuned independently. See PR-A1
 * description for design-decision D3 reasoning.
 */

let invalidValueWarned = false;

/**
 * @returns true iff COMPIQ_COMP_LOGS_DISABLED is set to a truthy
 *   string. Cheap; safe to call on the hot path before any further
 *   work.
 */
export function isCompLogsDisabled(): boolean {
  const raw = process.env.COMPIQ_COMP_LOGS_DISABLED;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * @returns sample rate as a float in [0, 1]. Returns 0 (with a
 *   one-shot warning) when COMPIQ_COMP_LOGS_SAMPLE_RATE is missing,
 *   non-numeric, NaN, negative, or greater than 1.
 */
export function getCompLogsSampleRate(): number {
  const raw = process.env.COMPIQ_COMP_LOGS_SAMPLE_RATE;
  if (raw === undefined || raw === null || raw.trim() === "") {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    if (!invalidValueWarned) {
      invalidValueWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[comp_logs] invalid COMPIQ_COMP_LOGS_SAMPLE_RATE="${raw}" — must be a number in [0,1]; treating as 0`,
      );
    }
    return 0;
  }
  return parsed;
}

/**
 * Test-only hook for resetting the once-per-process warning flag.
 * Production code MUST NOT call this.
 */
export const __compLogsConfigInternals = {
  resetWarningFlag: (): void => {
    invalidValueWarned = false;
  },
};
