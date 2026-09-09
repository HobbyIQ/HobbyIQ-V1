/**
 * CF-LONG-CRONS-DIE-AT-THE-IDLE-CUT (2026-09-09): a generic in-process
 * tracker for admin-triggered runs that outlive an HTTP response.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three nightly crons called an endpoint that does minutes of server-side
 * work and waited for the answer. App Insights (14d, app-id 468bd437-…):
 *
 *   /api/dailyiq/brief?fresh=true      17 requests ended ResultCode 0 at
 *                                      exactly 240.0s; the 200s that did
 *                                      land measured p95 182.9s.
 *   .../personal-prospect-breakout/run 38 requests, all 200, max 211.6s,
 *                                      p95 142.5s — under the cut, but only
 *                                      just, and climbing with the pool.
 *   /api/cleanliness/anomalies         11 requests, all ResultCode 0, every
 *                                      one at 89.9s (curl's own --max-time
 *                                      90 at the time), never a completion.
 *
 * 240.0s is not our number: it is the App Service front end's idle cut. It
 * fires when the connection produces no bytes for that long, and no widening
 * on the CLIENT can move it — #1985 raised the anomalies curl budget to 900s
 * and the platform still cuts at 240. The server, meanwhile, keeps working:
 * the run finishes into a socket nobody is holding, which is why the
 * anomalies lane could never report a drift comparison it had in fact
 * computed.
 *
 * So the fix is not a bigger timeout anywhere. It is to stop asking an HTTP
 * response to survive a job: the route dispatches, answers 202 with a job id
 * immediately, and the caller polls a cheap status route until the run
 * settles. Bytes flow on every poll, so nothing is ever idle.
 *
 * DELIBERATELY IN-PROCESS
 * -----------------------
 * This mirrors repriceJobTracker.ts exactly, and for the same reason: the
 * map is a progress surface, never a source of truth. The truth is what the
 * run writes (the anomaly report cache, the pushes sent, the persisted
 * brief). Losing the map to a recycle loses a progress read, not work.
 *
 * MULTI-INSTANCE: "I DON'T KNOW" IS AN ANSWER
 * -------------------------------------------
 * HobbyIQ3 serves on 2 instances, so a dispatch lands on one worker and its
 * next poll lands, about half the time, on the OTHER — which has never heard
 * of the job. repriceJobTracker learned this the expensive way (a poll that
 * answered `idle` was read as "finished", and the web page said "Refresh
 * complete." mid-run). The rule it arrived at is carried here verbatim:
 *
 *   a progress surface may say "I don't know";
 *   it may NEVER say "done" about a run it cannot see.
 *
 * An unrecognised job id answers `unknown-here`, and every caller — the
 * pollUntilSettled helper in scripts/lib/poll-admin-job.cjs included —
 * treats that as keep-polling. A cron therefore cannot mistake a
 * load-balanced poll for a finished run, and cannot mistake a finished run
 * for a failure: it polls until a worker that owns the id reports terminal
 * state, or until its own budget expires (and says so).
 */

import { randomUUID } from "node:crypto";

export type LongJobStatus = "running" | "done" | "error";

export interface LongJobState<TResult = unknown> {
  /** Job family — "anomalies", "personal-prospect-breakout", "dailyiq-brief". */
  kind: string;
  /**
   * Collapses concurrent dispatches of the same work. Two crons asking for
   * the same nightly scan must not start two rival scans.
   */
  key: string;
  /** Opaque id minted at dispatch, echoed to the caller so polls can name it. */
  jobId: string;
  status: LongJobStatus;
  /** ms epoch at dispatch. */
  startedAt: number;
  /** ms epoch when the run settled; undefined while running. */
  finishedAt?: number;
  /** Populated on status === "done". */
  result?: TResult;
  /** Populated on status === "error". */
  error?: string;
}

/** One entry per `kind:key`. */
const _jobs = new Map<string, LongJobState<any>>();

/** How long a settled entry stays readable before it is swept. */
const RETAIN_SETTLED_MS = 30 * 60 * 1000;

/**
 * A run older than this is treated as dead rather than in-flight, so a
 * process killed mid-run cannot wedge a lane out of ever dispatching again.
 * Generous against the worst case measured above (211.6s prospect, 220s
 * brief) and against an anomalies rescan that has never been allowed to
 * finish in the wild.
 */
const ASSUME_DEAD_MS = 30 * 60 * 1000;

function slot(kind: string, key: string): string {
  return `${kind}:${key}`;
}

export function isRunning(kind: string, key: string, now = Date.now()): boolean {
  const job = _jobs.get(slot(kind, key));
  if (!job || job.status !== "running") return false;
  return now - job.startedAt < ASSUME_DEAD_MS;
}

export function getJob<TResult = unknown>(
  kind: string,
  key: string,
): LongJobState<TResult> | null {
  return (_jobs.get(slot(kind, key)) as LongJobState<TResult> | undefined) ?? null;
}

export function markStarted<TResult = unknown>(
  kind: string,
  key: string,
  now = Date.now(),
): LongJobState<TResult> {
  const job: LongJobState<TResult> = {
    kind,
    key,
    jobId: randomUUID(),
    status: "running",
    startedAt: now,
  };
  _jobs.set(slot(kind, key), job);
  return job;
}

/**
 * What THIS worker can say about the run being asked about.
 *
 *   - `job`          → this worker owns it; report its real state.
 *   - `unknown-here` → a jobId was named that this worker never issued (or
 *                      has already swept). The run may be alive on the other
 *                      instance. Keep polling; never "done".
 *   - `idle`         → no jobId named and nothing held for this kind+key.
 *
 * Never collapse `unknown-here` into `idle`: the first is honest ignorance
 * about a specific run, the second is a claim that no run exists.
 */
export type LongJobLookup<TResult = unknown> =
  | { kind: "job"; job: LongJobState<TResult> }
  | { kind: "unknown-here" }
  | { kind: "idle" };

export function lookupJob<TResult = unknown>(
  kind: string,
  key: string,
  jobId?: string | null,
): LongJobLookup<TResult> {
  const job = _jobs.get(slot(kind, key)) as LongJobState<TResult> | undefined;
  if (!jobId) return job ? { kind: "job", job } : { kind: "idle" };
  if (job && job.jobId === jobId) return { kind: "job", job };
  return { kind: "unknown-here" };
}

export function markDone<TResult>(
  kind: string,
  key: string,
  result: TResult,
  now = Date.now(),
): void {
  const job = _jobs.get(slot(kind, key));
  if (!job) return;
  job.status = "done";
  job.result = result;
  job.finishedAt = now;
  sweep(now);
}

export function markError(kind: string, key: string, error: string, now = Date.now()): void {
  const job = _jobs.get(slot(kind, key));
  if (!job) return;
  job.status = "error";
  job.error = error;
  job.finishedAt = now;
  sweep(now);
}

/** Drop settled entries past their retention window. */
export function sweep(now = Date.now()): void {
  for (const [id, job] of _jobs) {
    if (job.status === "running") continue;
    if (job.finishedAt != null && now - job.finishedAt > RETAIN_SETTLED_MS) {
      _jobs.delete(id);
    }
  }
}

/**
 * Dispatch `work` in the background under this kind+key, or adopt the run
 * already in flight. Returns the job entry the caller should answer 202 with.
 *
 * The work is deliberately fire-and-forget: there is no response left to
 * fail once the 202 is out, so a rejection is captured onto the entry and
 * structured-logged rather than escaping as an unhandled rejection.
 */
export function dispatch<TResult>(
  kind: string,
  key: string,
  work: () => Promise<TResult>,
): { job: LongJobState<TResult>; alreadyRunning: boolean } {
  if (isRunning(kind, key)) {
    return { job: getJob<TResult>(kind, key)!, alreadyRunning: true };
  }
  const job = markStarted<TResult>(kind, key);
  void (async () => {
    try {
      const result = await work();
      markDone(kind, key, result);
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      console.error(`[longJobTracker] ${kind}:${key} failed: ${reason}`);
      markError(kind, key, reason);
    }
  })();
  return { job, alreadyRunning: false };
}

/**
 * The wire shape of a status poll. Shared so every lane's poller reads the
 * same fields, and so `unknown-here` is never accidentally rendered as a
 * settled verdict.
 */
export function buildStatusPayload<TResult>(
  lookup: LongJobLookup<TResult>,
  now = Date.now(),
): Record<string, unknown> {
  if (lookup.kind === "idle") {
    return { status: "idle", running: false, settled: false };
  }
  if (lookup.kind === "unknown-here") {
    // Honest ignorance. `settled:false` is the load-bearing field: a poller
    // must keep asking, because the run may be alive on the other instance.
    return {
      status: "unknown-here",
      running: false,
      settled: false,
      note: "this worker has no record of that job id; it may be running on another instance",
    };
  }
  const { job } = lookup;
  return {
    status: job.status,
    running: job.status === "running",
    settled: job.status !== "running",
    jobId: job.jobId,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    elapsedMs: (job.finishedAt ?? now) - job.startedAt,
    ...(job.status === "done" ? { result: job.result } : {}),
    ...(job.status === "error" ? { error: job.error } : {}),
  };
}

/** Test-only: clear all tracked state. */
export function __resetForTests(): void {
  _jobs.clear();
}

/**
 * Test-only: resolve once the dispatched run has settled. Production never
 * awaits these runs — that is the whole point — so a test that asserts on
 * what a run DID has to poll for it.
 */
export async function __awaitSettledForTests(
  kind: string,
  key: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = _jobs.get(slot(kind, key));
    if (job && job.status !== "running") return;
    if (Date.now() > deadline) {
      throw new Error(
        `${kind}:${key} did not settle within ${timeoutMs}ms (status=${job?.status ?? "none"})`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
