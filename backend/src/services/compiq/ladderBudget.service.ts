import { getTelemetryClient } from "../ops/telemetryClient.js";
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

/**
 * CF-A-LOG-NOBODY-CAN-READ-IS-NOT-TELEMETRY (Fable, 2026-09-15).
 *
 * The per-rung timings below have been written via `console.warn` since
 * CF-LADDER-TIME-BUDGET, on the reasoning that stdout at INFO is dropped by the
 * prod WARN floor so WARN is the level that survives. That reasoning was right
 * about the floor and wrong about the destination: it was checked, on
 * 2026-09-15, while investigating why the star query takes 9.2 s. Querying App
 * Insights for the deploy's own smoke window returned ZERO
 * `ladder_rung_timing` and ZERO `ladder_walk_summary` rows — console output
 * reaches the traces table as sampled log lines, and at the 10% ingestion
 * sampling applied on 09-07 the one request you actually want is the one most
 * likely to be missing. The timing logs that exist to be read during an
 * incident were unreadable during an incident.
 *
 * So the timings are emitted as a CUSTOM EVENT as well. Custom events go
 * through `defaultClient.trackEvent` — the isolated `TelemetryClient` published
 * in server.ts, which exports on its own provider rather than the sampled log
 * pipeline — so they survive at full fidelity and are queryable as
 * `customEvents | where name == "ladder_rung_timing"` with the per-rung ms as
 * typed fields rather than text to be parsed out of a message.
 *
 * The console line STAYS, unchanged. It is what a local run and a container log
 * show, it costs nothing, and removing it would trade one blind spot for
 * another.
 *
 * Emission is a SEAM for the same reason workerLifecycle's is: tests assert on
 * the payload, not on App Insights, and nothing here may throw into a pricing
 * request. A missing `defaultClient` (every script, every test, any process
 * that never initialised telemetry) is the normal case and is silently fine.
 */
export type LadderTelemetryEvent = {
  name: "ladder_rung_timing" | "ladder_walk_summary";
  properties: Record<string, string>;
  measurements: Record<string, number>;
};

/**
 * The App Insights client, resolved ONCE and cached — including the "there
 * isn't one" answer.
 *
 * This matters more than it looks. `require("applicationinsights")` costs
 * ~1,225 ms on first call in this repo (measured) and ~0 ms thereafter, because
 * the module cache absorbs every later call. Resolving it per rung therefore
 * looks free in any process that has already loaded it — the API, where
 * server.ts imports it at boot — and costs over a second in any process that
 * has NOT: every script, every cron, and every test. A ladderTimeBudget test
 * went from 0.6 s to 16.6 s on exactly that, which is how the cost was found.
 *
 * `undefined` means "not resolved yet", `null` means "resolved, and there is no
 * client". Caching the null is the half that matters: a process with no
 * telemetry is the common case for scripts and lanes, and it must cost one
 * failed lookup for the life of the process rather than one per rung.
 */
/**
 * CF-DEFAULTCLIENT-WAS-A-GETTER-ONLY-RE-EXPORT (Fable, 2026-09-15). This used
 * to read `appInsights.defaultClient` out of `require.cache` itself. The cache
 * lookup was right — the module IS there and identity matches — but the
 * property it read was always `undefined`, because on applicationinsights@3.14.0
 * `defaultClient` is a getter with no setter and server.ts's assignment to it
 * was a silent no-op. So these events were emitted into nothing, which is how
 * a 30-day window came to hold zero customEvents of any name.
 *
 * The client now comes from `services/ops/telemetryClient`, a module this repo
 * owns and can actually write to. The resolution cost that mattered here is
 * gone with it: that accessor reads a module-local variable, so there is no
 * `require` on the ladder's timing path — which was the bug that turned a
 * 0.6 s test into a 16.6 s one when this was first written.
 */

let _emitLadderTelemetry: (event: LadderTelemetryEvent) => void = (event) => {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    client.trackEvent({
      name: event.name,
      properties: event.properties,
      measurements: event.measurements,
    });
  } catch { /* telemetry is never load-bearing */ }
};

/** Test seam: capture emitted ladder telemetry instead of sending it. */
export function _setLadderTelemetryEmitter(fn: (event: LadderTelemetryEvent) => void): void {
  _emitLadderTelemetry = fn;
}

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
   * One rung's timing, to BOTH destinations: the console line that has always
   * been here (a local run and the container log show it) and a custom event
   * that survives log sampling (see the note at the top of this file).
   *
   * The ms is a MEASUREMENT, not a property, so it is queryable as a number —
   * `customEvents | where name == "ladder_rung_timing" | summarize
   *  avg(todouble(customMeasurements.ms)) by tostring(customDimensions.label)`
   * — instead of being parsed back out of a message string.
   */
  private reportRung(
    label: string,
    ms: number,
    outcome: "ok" | "rung-timeout" | "budget-exhausted",
    ceilingMs?: number,
  ): void {
    const totalElapsedMs = this.elapsedMs();
    console.warn(JSON.stringify({
      event: "ladder_rung_timing",
      source: "ladderBudget",
      label,
      ms,
      outcome,
      ...(ceilingMs !== undefined ? { ceilingMs } : {}),
      totalElapsedMs,
    }));
    _emitLadderTelemetry({
      name: "ladder_rung_timing",
      properties: { label, outcome, source: "ladderBudget" },
      measurements: {
        ms,
        totalElapsedMs,
        ...(ceilingMs !== undefined ? { ceilingMs } : {}),
      },
    });
  }

  /**
   * The whole walk, once, when it ends. A rung-by-rung view answers "which rung
   * was slow"; this answers the question an incident actually starts from —
   * "how long did this take, how much of the budget was left, and how many
   * rungs did it need" — without having to reassemble N rows to get it.
   *
   * Call it at the end of a walk. It is safe to call more than once (a walk
   * that ends twice reports twice, which is visible rather than hidden) and
   * safe never to call at all — the per-rung events stand on their own.
   */
  reportWalkSummary(extra: Record<string, string> = {}): void {
    const totalElapsedMs = this.elapsedMs();
    const timedOut = this.rungTimings.filter((r) => r.outcome !== "ok").length;
    const slowest = this.rungTimings.reduce(
      (a, b) => (b.ms > (a?.ms ?? -1) ? b : a),
      null as { label: string; ms: number } | null,
    );
    console.warn(JSON.stringify({
      event: "ladder_walk_summary",
      source: "ladderBudget",
      totalElapsedMs,
      remainingMs: this.remainingMs(),
      rungs: this.rungTimings.length,
      timedOutRungs: timedOut,
      slowestRung: slowest?.label ?? null,
      slowestRungMs: slowest?.ms ?? 0,
      ...extra,
    }));
    _emitLadderTelemetry({
      name: "ladder_walk_summary",
      properties: { source: "ladderBudget", slowestRung: slowest?.label ?? "none", ...extra },
      measurements: {
        totalElapsedMs,
        remainingMs: this.remainingMs(),
        rungs: this.rungTimings.length,
        timedOutRungs: timedOut,
        slowestRungMs: slowest?.ms ?? 0,
      },
    });
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
      this.reportRung(label, ms, "budget-exhausted");
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
        this.reportRung(label, ms, "rung-timeout", ceilingMs);
        return { ok: false, reason: "rung-timeout", ms };
      }
      this.rungTimings.push({ label, ms, outcome: "ok" });
      this.reportRung(label, ms, "ok");
      return { ok: true, value: result.value, ms };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
