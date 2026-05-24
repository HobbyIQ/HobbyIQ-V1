// Manual App Insights `dependencies`-table coverage for `fetch()` calls.
//
// CF-FETCH-SIGNAL-FLOOR-TELEMETRY (2026-05-24, partial-shipped PR #124) +
// CF-FETCH-TELEMETRY-V3-FIX (2026-05-24, full-shipped this commit).
//
// Why this module exists: Node 18+'s global `fetch()` is NOT auto-
// instrumented by `applicationinsights` or by the Azure App Service Agent.
// Direct `fetch()` calls therefore produce no entries in App Insights
// `dependencies` table. This module's `trackHttpDependency()` emits the
// equivalent dependency record manually.
//
// PR #124 v1 used `appInsights.defaultClient.trackDependency()` — the v3
// SDK's legacy compatibility shim. Post-deploy verification showed those
// records did NOT reach the `dependencies` table. Root cause (per diagnosis
// reading v3 SDK source): the shim creates an OpenTelemetry CLIENT span via
// `api.trace.getTracer("ApplicationInsightsTracer")`. When the App Service
// Agent (`ApplicationInsightsAgent_EXTENSION_VERSION=~3`) is running, both
// the agent and the npm SDK register global OTel providers; the conflict
// caused manual spans to never reach the exporter. Auto-instrumented http/
// Cosmos calls still surfaced because they hook into the http module at
// load time, independent of which tracer-provider is currently global.
//
// This commit migrates to OpenTelemetry API primitives directly — same
// pattern v3 SDK uses internally, but without the legacy shim. The agent
// supplies the globally-registered tracer-provider; this code retrieves a
// tracer from it and creates CLIENT spans with the Azure Monitor expected
// semantic attributes (http.url, http.status_code, peer.service). Azure
// Monitor then converts those spans into `dependencies` table entries.
//
// Telemetry must never throw — App Insights/OTel client failures must not
// break the prediction path. All errors swallowed.

import {
  trace,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type Attributes,
} from "@opentelemetry/api";
import {
  SEMATTRS_HTTP_URL,
  SEMATTRS_HTTP_STATUS_CODE,
  SEMATTRS_PEER_SERVICE,
} from "@opentelemetry/semantic-conventions";
import * as appInsights from "applicationinsights";

const TRACER_NAME = "compiq-mcp";

// Test seams — production reads via _tracerResolver / _exceptionTracker.
// Module-level mutable references because the npm `applicationinsights`
// namespace exports are non-configurable in ESM and can't be monkey-patched
// directly. Used only by scripts/telemetry.test.ts.
let _tracerResolver: () => Tracer = () => trace.getTracer(TRACER_NAME);
let _exceptionTracker: (err: Error) => void = (err) => {
  const client = (appInsights as any).defaultClient;
  if (client) client.trackException({ exception: err });
};

export function _setTracerResolverForTests(fn: () => Tracer): void {
  _tracerResolver = fn;
}
export function _resetTracerResolverForTests(): void {
  _tracerResolver = () => trace.getTracer(TRACER_NAME);
}
export function _setExceptionTrackerForTests(fn: (err: Error) => void): void {
  _exceptionTracker = fn;
}
export function _resetExceptionTrackerForTests(): void {
  _exceptionTracker = (err) => {
    const client = (appInsights as any).defaultClient;
    if (client) client.trackException({ exception: err });
  };
}

export interface TrackHttpDependencyArgs {
  /** Logical dependency name surfaced in App Insights queries (e.g. "signal_service"). */
  name: string;
  /** Full URL of the fetch — hostname extracted for `peer.service`, pathname for `http.url`. */
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
  try {
    let target = "unknown";
    let data = args.url;
    try {
      const u = new URL(args.url);
      target = u.hostname;
      // Pathname only — exclude query string so function-key (`?code=`) params
      // don't leak into App Insights records.
      data = u.pathname;
    } catch {
      // Malformed URL — fall back to raw string
    }

    const duration = Math.max(0, Date.now() - args.startMs);
    const endTime = Date.now();
    const startTime = new Date(endTime - duration);

    const attributes: Attributes = {
      [SEMATTRS_HTTP_URL]: data,
      [SEMATTRS_HTTP_STATUS_CODE]: String(args.resultCode),
      [SEMATTRS_PEER_SERVICE]: target,
    };

    const tracer = _tracerResolver();
    const span = tracer.startSpan(args.name, {
      kind: SpanKind.CLIENT,
      startTime,
      attributes,
    });
    span.setStatus({
      code: args.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    });
    span.end(endTime);

    if (args.error) {
      _exceptionTracker(args.error);
    }
  } catch {
    // Telemetry MUST NOT throw — prediction path callers depend on this
    // being a no-op when something goes wrong inside the SDK/OTel pipeline.
  }
}
