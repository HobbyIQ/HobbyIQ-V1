// CF-TELEMETRY-VOLUME (2026-09-07). The SpanProcessor that acts on the
// isCosmosGatewayPing() rule in ./telemetryFilters.
//
// HOW SUPPRESSION ACTUALLY WORKS — this is the non-obvious part, and the
// reason this is a SpanProcessor rather than a Sampler or a telemetry
// processor.
//
//  * `client.addTelemetryProcessor()` — the classic v2 API — is a NO-OP in
//    applicationinsights v3. Its implementation is a single
//    `diag.warn("addTelemetryProcessor is not supported ... any longer")`.
//    Writing the filter that way compiles, tests green, and drops nothing in
//    production.
//
//  * A Sampler cannot express this rule. `shouldSample` runs when the span
//    STARTS, where neither the duration nor the response status exists yet,
//    and both are load-bearing safety clauses (we keep every slow or failing
//    call). So the decision has to happen at span end.
//
//  * A SpanProcessor's `onEnd` sees the finished span, but returning from it
//    does not stop anything: the distro registers processors as
//        [ AzureMonitorSpanProcessor, ...ours, BatchSpanProcessor ]
//    and each is called independently. What DOES stop the export is the
//    SAMPLED trace flag: `BatchSpanProcessorBase.onEnd` begins with
//        if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;
//    so clearing that bit before the batch processor runs suppresses the
//    exported row. Ordering is guaranteed — the distro appends its batch
//    processor AFTER the user-supplied ones.
//
// WHAT SURVIVES. AzureMonitorSpanProcessor runs BEFORE this one and only feeds
// standard pre-aggregated metrics (`recordSpan`); it does not export rows. So
// the pings keep being counted in aggregate metrics while ceasing to mint one
// AppDependencies row each — the call stays observable, the 215.7M rows stop.

import { isCosmosGatewayPing } from "./telemetryFilters.js";

/** TraceFlags.SAMPLED from @opentelemetry/api. Hard-coded so this module does
 *  not depend on a package that is only present transitively. */
const TRACE_FLAG_SAMPLED = 0x1;

/** Nanoseconds-per-second, for HrTime -> ms conversion. */
const NS_PER_MS = 1e6;
const S_PER_MS = 1e3;

/** OTel HrTime is [seconds, nanoseconds]. */
function hrTimeToMs(hr: unknown): number | undefined {
  if (!Array.isArray(hr) || hr.length !== 2) return undefined;
  const [s, ns] = hr as [unknown, unknown];
  if (typeof s !== "number" || typeof ns !== "number") return undefined;
  if (!Number.isFinite(s) || !Number.isFinite(ns)) return undefined;
  return s * S_PER_MS + ns / NS_PER_MS;
}

/**
 * Structural shape of what this processor touches on a span. Kept loose (rather
 * than importing ReadableSpan) so the module compiles without a direct
 * dependency on @opentelemetry/sdk-trace-base, and so tests can drive it with a
 * fake envelope.
 */
export interface FilterableSpan {
  kind?: number;
  attributes?: Record<string, unknown>;
  duration?: unknown;
  spanContext?: () => { traceFlags: number };
}

/**
 * Decides whether a finished span should be suppressed, and if so clears its
 * SAMPLED flag in place. Returns true when it suppressed the span.
 *
 * Exported separately from the processor class so the decision + mutation can
 * be pinned by tests without an SDK.
 */
export function suppressIfCosmosPing(span: FilterableSpan): boolean {
  const ctx = span.spanContext?.();
  // No span context means nothing to clear — never claim a suppression we did
  // not perform.
  if (!ctx || typeof ctx.traceFlags !== "number") return false;
  // Already unsampled: nothing to do, and not our suppression to claim.
  if ((ctx.traceFlags & TRACE_FLAG_SAMPLED) === 0) return false;

  const matched = isCosmosGatewayPing({
    kind: span.kind,
    attributes: span.attributes,
    durationMs: hrTimeToMs(span.duration),
  });
  if (!matched) return false;

  ctx.traceFlags = ctx.traceFlags & ~TRACE_FLAG_SAMPLED;
  return true;
}

/**
 * SpanProcessor that drops Cosmos gateway health pings from exported
 * dependency telemetry. Register it via
 * `useAzureMonitor({ spanProcessors: [new CosmosPingSpanFilter()] })`.
 */
export class CosmosPingSpanFilter {
  /** Count of spans suppressed, for the periodic summary log. */
  private _suppressed = 0;

  get suppressedCount(): number {
    return this._suppressed;
  }

  onStart(): void {
    /* nothing to do at start — the rule needs duration + status */
  }

  onEnd(span: FilterableSpan): void {
    // Telemetry must never throw into the SDK's span pipeline.
    try {
      if (suppressIfCosmosPing(span)) this._suppressed++;
    } catch {
      /* a filter defect must not break tracing */
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
