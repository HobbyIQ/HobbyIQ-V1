/**
 * CF-PORTFOLIO-REFRESH-ASYNC (Drew, 2026-08-31): in-process tracker for
 * per-user background reprice runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /api/portfolio/reprice/batch` used to `await repriceHoldingsForUser`
 * inline. Measured in App Insights (60d window, app-id 468bd437-…): a single
 * such request issued **5,657 Cosmos dependency calls totalling 68.3s** —
 * 2,992 against sold_comps, 1,895 against card_catalog, 280 against
 * daily_price_series. That is the full CompIQ valuation chain running once
 * per holding, serially, for up to 50 holdings. The request row never
 * completed (only the OPTIONS preflight is recorded), i.e. the client
 * aborted — the known "missing request row = response never finished"
 * signature. The web client had already been widened to a 180s timeout to
 * paper over it.
 *
 * The read path was never the problem: `GET /api/portfolio/` measures
 * 77ms with ~10 dependency calls, because it serves stored values off one
 * user doc.
 *
 * So the refresh is now a dispatch, not a computation: the route starts
 * the run in the background and returns immediately with a job handle.
 * The client re-reads the (already fast) GET to see results land.
 *
 * DELIBERATELY IN-PROCESS
 * -----------------------
 * This mirrors `_lastRepriceAt` in portfolioStore.service.ts — state that
 * survives only within a single Node process, and that's fine. It is a
 * progress/дedupe surface, never a source of truth: the truth is the user
 * doc in Cosmos, and the 6h scheduled job (portfolioReprice.job.ts) is the
 * guaranteed catch-all if an instance recycles mid-run. Nothing here is a
 * cache of a *price* — no FMV is ever read from or served out of this map.
 */

import type { BatchRepriceResult } from "./portfolioStore.service.js";

export type RepriceJobStatus = "running" | "done" | "error";

export interface RepriceJobState {
  userId: string;
  status: RepriceJobStatus;
  /** ms epoch when the run was dispatched. */
  startedAt: number;
  /** ms epoch when the run settled; undefined while running. */
  finishedAt?: number;
  /** Populated on status==="done". */
  result?: BatchRepriceResult;
  /** Populated on status==="error". */
  error?: string;
}

/**
 * One entry per user. A second dispatch while a run is in flight returns
 * the in-flight entry rather than starting a rival run — two concurrent
 * repriceHoldingsForUser calls for the same user would read the same doc,
 * price against it independently, and the slower writer would clobber the
 * faster one's holdings (last-write-wins on the whole doc).
 */
const _jobs = new Map<string, RepriceJobState>();

/** How long a settled entry stays readable before it is swept. */
const RETAIN_SETTLED_MS = 10 * 60 * 1000;

/**
 * A run older than this is treated as dead rather than in-flight, so a
 * process that was killed mid-run (or an exception path that somehow
 * escaped the settle handlers) can't wedge a user out of refreshing
 * forever. Generous relative to the 68s worst case measured above.
 */
const ASSUME_DEAD_MS = 10 * 60 * 1000;

export function isRunning(userId: string, now = Date.now()): boolean {
  const job = _jobs.get(userId);
  if (!job || job.status !== "running") return false;
  return now - job.startedAt < ASSUME_DEAD_MS;
}

export function getJob(userId: string): RepriceJobState | null {
  return _jobs.get(userId) ?? null;
}

export function markStarted(userId: string, now = Date.now()): RepriceJobState {
  const job: RepriceJobState = { userId, status: "running", startedAt: now };
  _jobs.set(userId, job);
  return job;
}

export function markDone(userId: string, result: BatchRepriceResult, now = Date.now()): void {
  const job = _jobs.get(userId);
  if (!job) return;
  job.status = "done";
  job.result = result;
  job.finishedAt = now;
  sweep(now);
}

export function markError(userId: string, error: string, now = Date.now()): void {
  const job = _jobs.get(userId);
  if (!job) return;
  job.status = "error";
  job.error = error;
  job.finishedAt = now;
  sweep(now);
}

/** Drop settled entries past their retention window. */
export function sweep(now = Date.now()): void {
  for (const [userId, job] of _jobs) {
    if (job.status === "running") continue;
    if (job.finishedAt != null && now - job.finishedAt > RETAIN_SETTLED_MS) {
      _jobs.delete(userId);
    }
  }
}

/** Test-only: clear all tracked state. */
export function __resetForTests(): void {
  _jobs.clear();
}

/**
 * Test-only: resolve once the user's dispatched run has settled.
 *
 * The route answers 202 before the pricing work finishes, so a test that
 * asserts on what the run DID has to wait for it. Polls rather than exposing
 * a promise handle, because the run is deliberately fire-and-forget in
 * production — nothing there ever awaits it.
 */
export async function __awaitSettledForTests(userId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = _jobs.get(userId);
    if (job && job.status !== "running") return;
    if (Date.now() > deadline) {
      throw new Error(
        `reprice run for ${userId} did not settle within ${timeoutMs}ms (status=${job?.status ?? "none"})`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
