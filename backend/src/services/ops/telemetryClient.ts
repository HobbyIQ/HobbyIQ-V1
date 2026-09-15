/**
 * CF-DEFAULTCLIENT-WAS-A-GETTER-ONLY-RE-EXPORT (Fable, 2026-09-15).
 *
 * THE DEFECT. Every manual telemetry call in this repo went through
 * `appInsights.defaultClient`, and server.ts published that client with:
 *
 *     (appInsights as any).defaultClient = new TelemetryClient(...);
 *
 * That assignment has never taken effect. In `applicationinsights@3.14.0`,
 * `defaultClient` is a re-export built by TypeScript's `__createBinding`
 * helper, which defines it as a GETTER WITH NO SETTER. Read directly from the
 * live module:
 *
 *     Object.getOwnPropertyDescriptor(appInsights, "defaultClient")
 *       -> { get: true, set: false, configurable: false }
 *
 * Assigning to a getter-only property in non-strict code is a SILENT no-op —
 * no throw, no warning, and the `try/catch` around it therefore never fired.
 * `appInsights.defaultClient` stayed `undefined` for the life of the process,
 * and every consumer guards with `if (client)`, so every one of them silently
 * emitted nothing.
 *
 * MEASURED, which is how this was found: App Insights holds **zero**
 * `customEvents` rows over a 30-day window — not merely zero of one event
 * name, zero of every name. That means `worker_shutdown` (#1977) has never
 * reported once, and `trackException` from services/signals/telemetry has
 * never reported once. #1977 was written specifically to end a blind spot; it
 * was writing into one. The gap surfaced while trying to read the ladder's own
 * timing events during a latency investigation and finding nothing there.
 *
 * THE FIX, and it is deliberately the boring one. The client lives HERE, in a
 * module-local variable this repo owns, and every consumer reads it through
 * `getTelemetryClient()`. Nothing depends on being able to write a property on
 * a third-party module's namespace object — which is the thing that turned out
 * not to work, and which no amount of care at the call sites could have fixed.
 *
 * `appInsights.defaultClient` is ALSO still consulted as a fallback, so a
 * process that somehow does have one (an older SDK, a future one that restores
 * the setter, a host that sets it before we load) is not left worse off. But
 * nothing relies on it.
 */

/** The minimal surface every consumer in this repo actually uses. */
export interface TelemetryClientLike {
  trackEvent(telemetry: { name: string; properties?: Record<string, unknown>; measurements?: Record<string, number> }): void;
  trackException(telemetry: { exception: Error }): void;
  flush?(): void;
}

let _client: TelemetryClientLike | null = null;

/**
 * Publish the process's telemetry client. Called once from server.ts after
 * `useAzureMonitor`, and never elsewhere.
 */
export function setTelemetryClient(client: TelemetryClientLike | null): void {
  _client = client;
}

/**
 * The process's telemetry client, or null when there is none.
 *
 * Null is the NORMAL case for a large share of this repo: every script, every
 * cron, the backfill and rematch lanes, and every test. Callers must treat it
 * as optional and must never let its absence fail real work — telemetry is
 * never load-bearing.
 */
export function getTelemetryClient(): TelemetryClientLike | null {
  if (_client) return _client;
  // Fallback only. See the note above: this is expected to be undefined on
  // @azure SDK 3.14.0, and is consulted so that a host or SDK version which
  // does populate it still works.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require.cache?.[require.resolve("applicationinsights")]?.exports as
      { defaultClient?: TelemetryClientLike } | undefined;
    const fallback = mod?.defaultClient;
    if (fallback && typeof fallback.trackEvent === "function") return fallback;
  } catch { /* no applicationinsights in this process; null is correct */ }
  return null;
}

/** Test seam: forget the published client. */
export function _resetTelemetryClientForTests(): void {
  _client = null;
}
