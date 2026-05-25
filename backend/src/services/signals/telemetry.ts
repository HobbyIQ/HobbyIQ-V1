// Manual App Insights `dependencies`-table coverage for `fetch()` calls.
//
// PROVENANCE: ported 2026-05-25 from mcp-server/telemetry.ts (which
// landed via PR #125 and was column-mapping-fixed at fba6e89).
// Identical pattern — both services emit OTel CLIENT spans via
// `@opentelemetry/api` that the App Service Agent's globally-registered
// tracer-provider converts into `dependencies` table rows.
//
// Why both backend and mcp-server need this: Node 18+'s global fetch()
// is NOT auto-instrumented by `applicationinsights` v3 or by the App
// Service Agent. Direct fetch() calls therefore produce no entries in
// the App Insights `dependencies` table unless wrapped manually.
//
// FOLLOWUP: if a third consumer ever needs this, extract this file +
// signals.types.ts into a shared workspace package and remove the
// duplication. The duplication is intentional for now — see
// signals.types.ts FOLLOWUP comment for rationale.
//
// Telemetry must never throw — App Insights/OTel client failures must
// not break the prediction path. All errors swallowed.

import {
  trace,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type Attributes,
} from "@opentelemetry/api";
import {
  ATTR_URL_FULL,
  ATTR_SERVER_ADDRESS,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_REQUEST_METHOD,
} from "@opentelemetry/semantic-conventions";
import * as appInsights from "applicationinsights";

const TRACER_NAME = "compiq-backend";

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
  name: string;
  url: string;
  startMs: number;
  resultCode: number;
  success: boolean;
  error?: Error;
}

export function trackHttpDependency(args: TrackHttpDependencyArgs): void {
  try {
    let target = "unknown";
    let sanitizedFullUrl = args.url;
    try {
      const u = new URL(args.url);
      target = u.hostname;
      sanitizedFullUrl = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      // Malformed URL — fall back to raw string; server.address stays "unknown".
    }

    const duration = Math.max(0, Date.now() - args.startMs);
    const endTime = Date.now();
    const startTime = new Date(endTime - duration);

    const attributes: Attributes = {
      [ATTR_URL_FULL]: sanitizedFullUrl,
      [ATTR_SERVER_ADDRESS]: target,
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: args.resultCode,
      [ATTR_HTTP_REQUEST_METHOD]: "GET",
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
    // No-op — telemetry must never throw.
  }
}
