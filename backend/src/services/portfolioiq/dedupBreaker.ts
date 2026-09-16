/**
 * CF-A-PAUSED-DRAINER-IS-RECOVERABLE-A-DUPLICATE-FLOOD-IS-NOT
 * (Fable, 2026-09-16).
 *
 * The circuit breaker for `sold_comps` dedup, shared across the staging
 * drainer's 16 concurrent loops.
 *
 * WHY. Of the ~289,365 Cosmos calls per 7 days that fail at the SDK's 60 s
 * default with no request context, 73% are `hobbyiq3-worker` querying
 * `card_catalog`, and the issuer is the staging drainer
 * (`STAGING_DRAINER_ENABLED=true`, `STAGING_DRAINER_WORKERS=16` — the only
 * always-on in-process loop, matching a failure floor present in every one of
 * the 24 UTC hours). It reaches Cosmos through
 * `soldCompsStore.recordSoldComp`, whose ten `items.query` call sites carried
 * ZERO `abortSignal` between them, so each rode the 60 s default plus the
 * SDK's internal retries — sixteen loops at a time, into a container they were
 * themselves saturating.
 *
 * WHY IT PAUSES RATHER THAN PROCEEDING, which is the whole design. A dedup
 * query answers "have we already stored this sale?". A TIMEOUT is not a "no" —
 * it is "I do not know". The tempting cheap behaviour is to treat the unknown
 * as a miss and write the row as new, because that is what a genuine miss
 * does; but doing that under a sustained outage writes a duplicate for every
 * row the drainer touches, across sixteen loops, for as long as the container
 * stays slow. `sold_comps` duplicates are not a cosmetic problem: a split pool
 * is a wrong FMV (feedback_one_card_one_row_one_pool), and they are laborious
 * to unpick afterwards.
 *
 * A paused drainer, by contrast, resumes on its own and loses nothing —
 * comps_staging still holds every unpromoted row. So: one timeout writes the
 * row as new (indistinguishable from a miss, and the existing behaviour), but
 * N CONSECUTIVE timeouts mean the container is not answering and the drainer
 * STOPS rather than guessing at scale.
 *
 * Consecutive is the right signal for the same reason it was in
 * `withNarrowBreaker`: one timeout is noise, N in a row is a statement about
 * the container.
 *
 * MODULE-LEVEL, not per-cycle: the sixteen loops share one breaker, so the
 * first loop to discover the container is unavailable stops the other fifteen
 * rather than each independently rediscovering it.
 */

/** Consecutive dedup timeouts before the breaker opens. */
export const DEDUP_BREAKER_THRESHOLD = 10;
/** How long the breaker stays open before admitting a probe. */
export const DEDUP_BREAKER_HOLD_MS = 60_000;

type BreakerState = {
  consecutiveTimeouts: number;
  /** When the breaker opened, or null when closed. */
  openedAtMs: number | null;
  /** True while a half-open probe is in flight, so only ONE loop probes. */
  probeInFlight: boolean;
  opens: number;
  timeouts: number;
};

const state: BreakerState = {
  consecutiveTimeouts: 0,
  openedAtMs: null,
  probeInFlight: false,
  opens: 0,
  timeouts: 0,
};

/** Is the breaker currently holding the drainer back? */
export function dedupBreakerIsOpen(nowMs: number = Date.now()): boolean {
  if (state.openedAtMs === null) return false;
  if (nowMs - state.openedAtMs >= DEDUP_BREAKER_HOLD_MS) return false;  // half-open window
  return true;
}

/**
 * May THIS caller issue a dedup query?
 *
 * Closed: yes. Open and still holding: no. Open but past the hold: exactly ONE
 * caller is admitted as a probe — the rest keep waiting, so a half-open
 * breaker cannot become sixteen simultaneous retries into a container that may
 * still be down.
 */
export function dedupBreakerAdmits(nowMs: number = Date.now()): boolean {
  if (state.openedAtMs === null) return true;
  if (nowMs - state.openedAtMs < DEDUP_BREAKER_HOLD_MS) return false;
  if (state.probeInFlight) return false;
  state.probeInFlight = true;
  return true;
}

/** A dedup query answered. Closes the breaker and resets the run. */
export function recordDedupSuccess(): void {
  state.consecutiveTimeouts = 0;
  state.probeInFlight = false;
  if (state.openedAtMs !== null) {
    state.openedAtMs = null;
    console.warn(JSON.stringify({
      event: "staging_drainer.breaker_closed",
      source: "dedupBreaker",
      detail: "a probe succeeded; dedup resumes",
    }));
  }
}

/** A dedup query timed out. Trips the breaker on the Nth consecutive one. */
export function recordDedupTimeout(nowMs: number = Date.now()): void {
  state.timeouts++;
  state.consecutiveTimeouts++;
  state.probeInFlight = false;
  // A failed probe re-opens the window rather than leaving it half-open, so the
  // next hold period starts now instead of admitting a probe on every call.
  if (state.openedAtMs !== null) { state.openedAtMs = nowMs; return; }
  if (state.consecutiveTimeouts >= DEDUP_BREAKER_THRESHOLD) {
    state.openedAtMs = nowMs;
    state.opens++;
    console.warn(JSON.stringify({
      event: "staging_drainer.breaker_open",
      source: "dedupBreaker",
      threshold: DEDUP_BREAKER_THRESHOLD,
      holdMs: DEDUP_BREAKER_HOLD_MS,
      consecutiveTimeouts: state.consecutiveTimeouts,
      totalTimeouts: state.timeouts,
      detail: "sold_comps dedup is not answering; the drainer PAUSES rather than writing unverified rows as new — a paused drainer is recoverable, a duplicate flood is not",
    }));
  }
}

/** Test seam. */
export function _dedupBreakerStateForTest(): Readonly<BreakerState> { return { ...state }; }
/** Test seam: back to closed. */
export function _resetDedupBreakerForTest(): void {
  state.consecutiveTimeouts = 0;
  state.openedAtMs = null;
  state.probeInFlight = false;
  state.opens = 0;
  state.timeouts = 0;
}
