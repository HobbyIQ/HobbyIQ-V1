/**
 * Runtime configuration for the CompIQ corpus collector.
 *
 * Environment variables consumed by this module:
 *
 *   COMPIQ_CORPUS_DISABLED
 *     Hard kill-switch. When set to "1", "true", or "yes" (case-insensitive),
 *     corpus writes are skipped unconditionally — sample rate is not even
 *     evaluated. Use this as the operator break-glass during an incident.
 *     Any other value (including unset) leaves the corpus enabled.
 *
 *   COMPIQ_CORPUS_SAMPLE_RATE
 *     Fraction of pricing responses to capture, in [0, 1]. Default is 0
 *     (capture nothing). The operator rollout sequence ramps this from
 *     0.01 → 0.10 → ... after the hard-gate inspection of initial entries.
 *     Invalid values (non-numeric, out-of-range, NaN) are treated as 0
 *     with a single warn() log per process; the corpus stays safe-off.
 *
 * Both values are re-read on EVERY call. There is no caching, so an
 * operator can flip either knob without a process restart and the change
 * takes effect on the next sampled request.
 */

// One-shot guard for the "invalid sample-rate value" warning. We don't
// want to spam logs on every request if an operator types `"0,5"` (comma
// instead of dot) — log it once and move on.
let invalidValueWarned = false;

/**
 * @returns true iff COMPIQ_CORPUS_DISABLED is set to a truthy string
 *   ("1" / "true" / "yes", case-insensitive). Cheap; safe to call on
 *   the hot path before any further work.
 */
export function isCorpusDisabled(): boolean {
  const raw = process.env.COMPIQ_CORPUS_DISABLED;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * @returns sample rate as a float in [0, 1]. Returns 0 (with a one-shot
 *   warning) when COMPIQ_CORPUS_SAMPLE_RATE is missing, non-numeric,
 *   NaN, negative, or greater than 1.
 */
export function getCorpusSampleRate(): number {
  const raw = process.env.COMPIQ_CORPUS_SAMPLE_RATE;
  if (raw === undefined || raw === null || raw.trim() === "") {
    // Unset is the default-safe case; not an "invalid" warning condition.
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    if (!invalidValueWarned) {
      invalidValueWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[corpus] invalid COMPIQ_CORPUS_SAMPLE_RATE="${raw}" — must be a number in [0,1]; treating as 0`,
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
export const __corpusConfigInternals = {
  resetWarningFlag: (): void => {
    invalidValueWarned = false;
  },
};
