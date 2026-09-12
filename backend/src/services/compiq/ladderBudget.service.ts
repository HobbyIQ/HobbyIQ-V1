/**
 * CF-LADDER-TIME-BUDGET (Fable, 2026-09-12).
 *
 * A post-deploy Tier 1 harness run found POST /api/compiq/canonical-fmv
 * for hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto
 * (zero direct comps) timing out at the harness's OWN 25,000ms client
 * ceiling — the server never answered in time to be measured, let alone
 * within the 5s read budget. App Insights traced the concurrency fix
 * (CF-LADDER-BOUNDED-CONCURRENCY) actually working under load a few hours
 * later on a direct re-check (~1-1.4s per call), so the specific incident
 * looks like a transient fleet-load spike rather than a deterministic
 * defect — but a ladder with no WORST-CASE bound will always be able to
 * hang again the next time sold_comps is under RU pressure, a rung's
 * query plan changes, or a partition gets hot. That is the actual defect:
 * not "this rung is slow" (unproven — the fast re-check argues against a
 * single culprit) but "nothing stops it from being slow."
 *
 * This module is the fix for THAT: a wall-clock budget over the whole
 * ladder walk, and a per-rung ceiling within it, so a zero-comp request
 * degrades HONESTLY — a withheld verdict with a visible reason
 * (`ladder-timeout`, see oneValuationPath.service.ts's ValuationReason) —
 * instead of hanging until the client gives up. Doctrine: a withheld
 * price is null + a reason, never a slow number and never an invented one.
 *
 * Usage: one `LadderBudget` per ladder walk (one `computeHobbyIqFmv` call).
 * Each batch of rung queries is wrapped in `budget.timeBox(work, label)`,
 * which:
 *   - races `work` against `min(PER_RUNG_TIMEOUT_MS, budget.remainingMs())`
 *   - logs the rung's actual elapsed ms via console.warn REGARDLESS of
 *     outcome (harness-visible: stdout at INFO is dropped by the WARN
 *     floor in prod logging config, so ordinary per-rung timing needs
 *     WARN to be seen at all — this is not an error signal, just the
 *     level that survives)
 *   - returns `{ ok: true, value }` on completion within budget, or
 *     `{ ok: false, reason: "rung-timeout" | "budget-exhausted" }` when
 *     the ceiling is hit — the CALLER decides what an exhausted rung
 *     means (usually: treat it as if it had returned no rows, and move on
 *     — a slow rung is not evidence of anything, so it must never be
 *     read as a confident miss OR a confident hit).
 *
 * A rung that times out keeps running in the background (Node cannot
 * cancel an in-flight Cosmos SDK call) — the budget only stops WAITING
 * for it. This mirrors how the SDK's own request timeout works and is
 * strictly safer than the alternative (aborting the HTTP connection
 * out from under the SDK, which the driver does not support cleanly).
 */

export interface LadderBudgetOptions {
  /** Total wall-clock ceiling for the whole ladder walk. */
  totalMs: number;
  /** Ceiling for any ONE timeBox call. */
  perRungMs: number;
}

export const DEFAULT_LADDER_BUDGET: LadderBudgetOptions = {
  totalMs: 8_000,
  perRungMs: 3_000,
};

export type TimeBoxOutcome<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; reason: "rung-timeout" | "budget-exhausted"; ms: number };

/**
 * Bound a best-effort ENRICHMENT promise (not a pricing rung — something
 * that decorates whichever rung answers, like the population lookup or the
 * broader-identity trend note) to `maxMs`, resolving to `fallback` if it
 * has not settled by then. Unlike `LadderBudget.timeBox`, this does not
 * consume any rung's budget and does not log per-rung timing — it exists
 * so a slow enrichment can never turn into an unbounded hang on every
 * return path of the ladder (9 call sites in hobbyIqFmv.service.ts await
 * these two promises unconditionally), while staying invisible to the
 * happy path: a fast enrichment (the overwhelming majority of the time)
 * resolves long before `maxMs` and this wrapper adds nothing but one
 * microtask tick.
 */
export async function withEnrichmentTimeout<T>(promise: Promise<T>, maxMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), maxMs);
  });
  try {
    const result = await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeoutPromise,
    ]);
    return result.timedOut ? fallback : result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class LadderBudget {
  private readonly startedAtMs: number;
  private readonly opts: LadderBudgetOptions;
  /** Per-rung timings collected for the harness-visible summary log. */
  readonly rungTimings: Array<{ label: string; ms: number; outcome: "ok" | "rung-timeout" | "budget-exhausted" }> = [];

  constructor(opts: LadderBudgetOptions = DEFAULT_LADDER_BUDGET) {
    this.startedAtMs = Date.now();
    this.opts = opts;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAtMs;
  }

  /** The configured per-rung ceiling, for callers (like the population /
   *  broader-trend enrichment lookups) that want to bound their OWN work
   *  to the same ceiling without consuming a rung slot via timeBox. */
  perRungCeilingMs(): number {
    return this.opts.perRungMs;
  }

  remainingMs(): number {
    return Math.max(0, this.opts.totalMs - this.elapsedMs());
  }

  /** True once the total budget is exhausted — the caller should stop
   *  issuing new rungs and return the withheld verdict immediately,
   *  without even attempting a timeBox (which would return
   *  budget-exhausted instantly anyway, but skipping it avoids a wasted
   *  Cosmos call the SDK would still have to tear down later). */
  isExhausted(): boolean {
    return this.remainingMs() <= 0;
  }

  /**
   * Race `work` against the smaller of the per-rung ceiling and whatever
   * budget remains. Always logs the rung's timing via console.warn —
   * this IS the harness-visible per-rung logging the fix asked for; stdout
   * at a lower level is dropped by the prod logging WARN floor.
   */
  async timeBox<T>(work: () => Promise<T>, label: string): Promise<TimeBoxOutcome<T>> {
    const ceilingMs = Math.min(this.opts.perRungMs, this.remainingMs());
    const t0 = Date.now();
    if (ceilingMs <= 0) {
      const ms = 0;
      this.rungTimings.push({ label, ms, outcome: "budget-exhausted" });
      console.warn(JSON.stringify({
        event: "ladder_rung_timing",
        source: "ladderBudget",
        label,
        ms,
        outcome: "budget-exhausted",
        totalElapsedMs: this.elapsedMs(),
      }));
      return { ok: false, reason: "budget-exhausted", ms };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ceilingMs);
    });
    try {
      const result = await Promise.race([
        work().then((value) => ({ timedOut: false as const, value })),
        timeoutPromise,
      ]);
      const ms = Date.now() - t0;
      if (result.timedOut) {
        this.rungTimings.push({ label, ms, outcome: "rung-timeout" });
        console.warn(JSON.stringify({
          event: "ladder_rung_timing",
          source: "ladderBudget",
          label,
          ms,
          outcome: "rung-timeout",
          ceilingMs,
          totalElapsedMs: this.elapsedMs(),
        }));
        return { ok: false, reason: "rung-timeout", ms };
      }
      this.rungTimings.push({ label, ms, outcome: "ok" });
      console.warn(JSON.stringify({
        event: "ladder_rung_timing",
        source: "ladderBudget",
        label,
        ms,
        outcome: "ok",
        totalElapsedMs: this.elapsedMs(),
      }));
      return { ok: true, value: result.value, ms };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
