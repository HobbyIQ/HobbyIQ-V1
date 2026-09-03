// CF-FIRST-RUN (Drew, 2026-09-02). Funnel telemetry — so drop-off is a
// number, not a guess.
//
// NO NEW VENDOR. The events go to the backend, which emits them as
// structured JSON on stdout exactly the way marketRead.service.ts's
// logSubRawInversionObserved does; the App Service agent lifts those
// into App Insights, where they are queryable beside every other event
// the platform already writes. There is no third-party script on the
// page, no cookie, and nothing to consent to that the app has not
// already disclosed.
//
// THREE RULES:
//
// 1. TELEMETRY NEVER THROWS AND NEVER BLOCKS. Every call is
//    fire-and-forget with a swallowed rejection. A dead telemetry route
//    must not be able to stop a new user from reaching their first
//    price — that failure would cost us the exact thing we are measuring.
//
// 2. ONE EVENT NAME, STEP AS A DIMENSION. `onboarding_funnel_step` with
//    `{step, action}` rather than an event per step, so a funnel query is
//    one `summarize by step` instead of a union that silently misses any
//    step someone forgot to add. Adding a step needs no query change.
//
// 3. NO CARD, NO PRICE, NO PII IN THE PAYLOAD. The funnel measures
//    MOVEMENT — which step, which lane, did they advance or leave. What
//    the card was and what it was worth is portfolio data, and it is
//    already recorded where portfolio data belongs.

import { API_BASE, getStoredSessionId } from "./api";
import type { FirstRunStepId, LaneId } from "./firstRun";

/** What happened at a step. `view` on render, `advance` when the step is
 *  completed, `skip` when the user leaves the funnel from it, and
 *  `resume` when a returning user re-enters at it — the four transitions
 *  a drop-off chart needs. */
export type FunnelAction = "view" | "advance" | "skip" | "resume" | "complete";

export interface FunnelEvent {
  step: FirstRunStepId;
  action: FunnelAction;
  /** The lane in play, once chosen. Null before the choice. */
  lane?: LaneId | null;
  /** Small, non-identifying extras — a lane count, a gated-action id.
   *  Values are primitives so the App Insights column stays flat. */
  detail?: Record<string, string | number | boolean | null> | null;
}

/** Fire one funnel event. Returns immediately; the request is not awaited
 *  by callers and its failure is swallowed (rule 1). */
export function trackFunnelStep(event: FunnelEvent): void {
  try {
    const body = JSON.stringify({
      event: "onboarding_funnel_step",
      step: event.step,
      action: event.action,
      lane: event.lane ?? null,
      detail: event.detail ?? null,
      // Client clock, named as such. The server stamps its own arrival
      // time; keeping both makes a skewed device visible rather than
      // silently wrong.
      clientTimestamp: new Date().toISOString(),
    });

    // Same session model as every other call (lib/api.ts): the session id
    // rides in an `x-session-id` header, not a cookie. An anonymous or
    // expired session simply omits it — the route accepts that and logs
    // the event without a user, because a person who bounced before
    // signing in is still a data point.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const sessionId = getStoredSessionId();
    if (sessionId) headers["x-session-id"] = sessionId;

    // `keepalive` so the last event of a session — the one where the user
    // navigates away, which is precisely the drop-off we care about —
    // still leaves the browser.
    void fetch(`${API_BASE}/api/onboarding/telemetry`, {
      method: "POST",
      headers,
      keepalive: true,
      body,
    }).catch(() => {
      // Rule 1. A funnel we cannot measure is a reporting problem; a
      // funnel we cannot finish is a product outage. Never the second.
    });
  } catch {
    // Serialization or a missing fetch (SSR, a locked-down browser).
    // Same rule.
  }
}
