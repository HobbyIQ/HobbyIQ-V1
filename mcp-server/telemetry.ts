// Manual App Insights `dependencies`-table coverage for `fetch()` calls.
//
// CF-FETCH-SIGNAL-FLOOR-TELEMETRY (2026-05-24): Node 18+'s global `fetch()`
// is NOT auto-instrumented by the applicationinsights SDK (only the legacy
// http/https modules are). Direct `fetch()` calls therefore produce no
// dependency telemetry — misconfigured URLs, transient failures, and slow
// responses are invisible to App Insights observability. See the silent-
// failure audit at docs/phase0/signal_silent_failure_audit.md for the full
// inventory.
//
// This module's `trackHttpDependency()` lets callers emit the equivalent
// dependency record manually after each fetch. Used by mcp-server/pricing.ts
// to close the 2 HIGH-severity audit findings (fetchSignals + fetchPriceFloor).
//
// Telemetry must never throw — App Insights client failures must not break
// the prediction path. All errors swallowed.

import * as appInsights from "applicationinsights";

// Test seam — production reads from appInsights.defaultClient; tests can
// override via _setClientResolverForTests below. The seam exists because
// appInsights's ESM namespace exports are non-configurable, so direct
// `(appInsights as any).defaultClient = mock` doesn't work in test runners.
type AnyClient = {
  trackDependency: (a: any) => void;
  trackException: (a: any) => void;
} | null;
let _clientResolver: () => AnyClient = () =>
  (appInsights as any).defaultClient ?? null;

/** Test-only — replace the client lookup. Reset to default after tests. */
export function _setClientResolverForTests(fn: () => AnyClient): void {
  _clientResolver = fn;
}

/** Test-only — restore production behavior. */
export function _resetClientResolverForTests(): void {
  _clientResolver = () => (appInsights as any).defaultClient ?? null;
}

export interface TrackHttpDependencyArgs {
  /** Logical dependency name surfaced in App Insights queries (e.g. "signal_service"). */
  name: string;
  /** Full URL of the fetch — hostname extracted for `target`, pathname for `data`. */
  url: string;
  /** Date.now() captured immediately before the fetch — used to derive duration. */
  startMs: number;
  /** HTTP status code; 0 if the request never produced a response (network/timeout). */
  resultCode: number;
  /** True only when the fetch produced an OK response. */
  success: boolean;
  /** Optional — non-HTTP failure (network, timeout, aborted). Tracked as an exception. */
  error?: Error;
}

export function trackHttpDependency(args: TrackHttpDependencyArgs): void {
  // App Insights may not be initialized (local dev, missing connection string,
  // SDK init failure). Bail silently.
  const client = _clientResolver();
  if (!client) return;
  try {
    let target = "unknown";
    let data = args.url;
    try {
      const u = new URL(args.url);
      target = u.hostname;
      // Pathname only — exclude query string to avoid leaking ?code=<KEY>
      // function-key params into App Insights records.
      data = u.pathname;
    } catch {
      // Malformed URL — fall back to raw string; better than nothing
    }
    const duration = Math.max(0, Date.now() - args.startMs);
    client.trackDependency({
      name: args.name,
      target,
      data,
      duration,
      resultCode: String(args.resultCode),
      success: args.success,
      dependencyTypeName: "HTTP",
    });
    if (args.error) {
      client.trackException({ exception: args.error });
    }
  } catch {
    // Telemetry MUST NOT throw — prediction path callers depend on this
    // being a no-op when something goes wrong inside the SDK.
  }
}
