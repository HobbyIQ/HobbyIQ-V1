// Unit tests for trackHttpDependency (CF-FETCH-SIGNAL-FLOOR-TELEMETRY +
// CF-FETCH-TELEMETRY-V3-FIX).
//
// Verifies the post-V3-migration helper (with CF-FETCH-TELEMETRY-COLUMN-MAPPING
// upgrade to newer ATTR_* string conventions):
// - Uses @opentelemetry/api directly (not the legacy SDK shim that the
//   App Service Agent conflict broke)
// - Creates CLIENT-kind spans with newer OTel semantic-conventions attributes
//   (url.full, server.address, http.response.status_code, http.request.method)
//   so Azure Monitor's OTel exporter populates target/data/resultCode columns
// - Sanitizes URL — full URL with scheme+host+path but no query string
//   (so ?code= function keys don't leak into the dependencies table)
// - On error: calls the exception tracker (legacy SDK trackException shim
//   still used here since OTel logs migration is separate scope)
// - Never throws even when the underlying tracer throws
// - No-op when tracer is no-op (test simulates production-without-agent)
//
// Run: cd mcp-server && npx tsx --test scripts/telemetry.test.ts

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";

import {
  type Tracer,
  type Span,
  type SpanOptions,
  SpanKind,
  SpanStatusCode,
  type Context,
} from "@opentelemetry/api";

let trackHttpDependency: typeof import("../telemetry.js").trackHttpDependency;
let _setTracerResolverForTests: typeof import("../telemetry.js")._setTracerResolverForTests;
let _resetTracerResolverForTests: typeof import("../telemetry.js")._resetTracerResolverForTests;
let _setExceptionTrackerForTests: typeof import("../telemetry.js")._setExceptionTrackerForTests;
let _resetExceptionTrackerForTests: typeof import("../telemetry.js")._resetExceptionTrackerForTests;

interface CapturedSpan {
  name: string;
  kind?: SpanKind;
  attributes: Record<string, unknown>;
  startTime?: Date;
  status?: { code: SpanStatusCode; message?: string };
  endTime?: number;
}

let capturedSpans: CapturedSpan[] = [];
let capturedExceptions: Error[] = [];

function makeFakeSpan(captured: CapturedSpan): Span {
  // OTel Span has many methods; we only need setStatus + end. The rest are
  // no-ops returning `this` for chainable interface compliance.
  const span = {
    setStatus(s: { code: SpanStatusCode; message?: string }): Span {
      captured.status = s;
      return span;
    },
    end(time?: number): void {
      captured.endTime = time ?? Date.now();
    },
    spanContext() {
      return { traceId: "00000000000000000000000000000000", spanId: "0000000000000000", traceFlags: 0 };
    },
    setAttribute(): Span { return span; },
    setAttributes(): Span { return span; },
    addEvent(): Span { return span; },
    addLink(): Span { return span; },
    addLinks(): Span { return span; },
    updateName(): Span { return span; },
    recordException(): void {},
    isRecording(): boolean { return true; },
  } as unknown as Span;
  return span;
}

function makeFakeTracer(opts: { throwOnStartSpan?: boolean } = {}): Tracer {
  return {
    startSpan(name: string, options?: SpanOptions, _ctx?: Context): Span {
      if (opts.throwOnStartSpan) throw new Error("simulated tracer failure");
      const cap: CapturedSpan = {
        name,
        kind: options?.kind,
        attributes: (options?.attributes ?? {}) as Record<string, unknown>,
        startTime: options?.startTime as Date | undefined,
      };
      capturedSpans.push(cap);
      return makeFakeSpan(cap);
    },
    startActiveSpan() { throw new Error("not used"); },
  } as unknown as Tracer;
}

function makeNoopTracer(): Tracer {
  // Mirror OTel's no-op tracer behavior — startSpan returns a non-recording
  // span that swallows all calls. Simulates the case where the agent didn't
  // register a global provider (e.g., local dev without app insights).
  return {
    startSpan(): Span {
      return {
        setStatus() { return this; },
        end() {},
        spanContext() { return { traceId: "0", spanId: "0", traceFlags: 0 }; },
        setAttribute() { return this; },
        setAttributes() { return this; },
        addEvent() { return this; },
        addLink() { return this; },
        addLinks() { return this; },
        updateName() { return this; },
        recordException() {},
        isRecording() { return false; },
      } as unknown as Span;
    },
    startActiveSpan() { throw new Error("not used"); },
  } as unknown as Tracer;
}

before(async () => {
  const mod = await import("../telemetry.js");
  trackHttpDependency = mod.trackHttpDependency;
  _setTracerResolverForTests = mod._setTracerResolverForTests;
  _resetTracerResolverForTests = mod._resetTracerResolverForTests;
  _setExceptionTrackerForTests = mod._setExceptionTrackerForTests;
  _resetExceptionTrackerForTests = mod._resetExceptionTrackerForTests;
  // Replace the real exception tracker with a capturing stub for the duration
  // of the test suite.
  _setExceptionTrackerForTests((err) => capturedExceptions.push(err));
});

beforeEach(() => {
  capturedSpans = [];
  capturedExceptions = [];
});

after(() => {
  _resetTracerResolverForTests();
  _resetExceptionTrackerForTests();
});

describe("trackHttpDependency — happy paths", () => {
  it("creates CLIENT-kind span with url.full/server.address/http.response.status_code attributes", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals?player=Mike%20Trout&code=secret",
      startMs: Date.now() - 250,
      resultCode: 200,
      success: true,
    });
    assert.equal(capturedSpans.length, 1);
    const s = capturedSpans[0];
    assert.equal(s.name, "signal_service");
    assert.equal(s.kind, SpanKind.CLIENT);
    // CRITICAL: url.full is scheme+host+pathname ONLY — must not contain ?code=secret
    assert.equal(s.attributes["url.full"], "https://fn-compiq.azurewebsites.net/api/signals");
    assert.equal(s.attributes["http.response.status_code"], 200);
    assert.equal(s.attributes["server.address"], "fn-compiq.azurewebsites.net");
    assert.equal(s.attributes["http.request.method"], "GET");
    assert.deepEqual(s.status, { code: SpanStatusCode.OK });
    assert.ok(s.endTime !== undefined && s.endTime > 0);
    assert.equal(capturedExceptions.length, 0);
  });

  it("records HTTP 4xx as ERROR status (e.g. 404 URL_NOT_FOUND)", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/serve-signals",
      startMs: Date.now() - 100,
      resultCode: 404,
      success: false,
    });
    assert.equal(capturedSpans[0].attributes["http.response.status_code"], 404);
    assert.deepEqual(capturedSpans[0].status, { code: SpanStatusCode.ERROR });
  });

  it("records HTTP 5xx as ERROR status", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    trackHttpDependency({
      name: "price_floor_service",
      url: "https://fn-compiq.azurewebsites.net/api/price-floor",
      startMs: Date.now() - 1500,
      resultCode: 503,
      success: false,
    });
    assert.equal(capturedSpans[0].attributes["http.response.status_code"], 503);
    assert.deepEqual(capturedSpans[0].status, { code: SpanStatusCode.ERROR });
  });

  it("computes startTime from startMs + duration", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    const startMs = Date.now() - 500;
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs,
      resultCode: 200,
      success: true,
    });
    const s = capturedSpans[0];
    assert.ok(s.startTime instanceof Date);
    // startTime should be approximately startMs (within ms of jitter)
    const startDiff = Math.abs((s.startTime!).getTime() - startMs);
    assert.ok(startDiff < 50, `startTime diff=${startDiff}ms`);
  });
});

describe("trackHttpDependency — error paths", () => {
  it("records network failure as ERROR + calls exception tracker", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    const networkErr = new Error("ECONNREFUSED");
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now() - 200,
      resultCode: 0,
      success: false,
      error: networkErr,
    });
    assert.equal(capturedSpans[0].attributes["http.response.status_code"], 0);
    assert.deepEqual(capturedSpans[0].status, { code: SpanStatusCode.ERROR });
    assert.equal(capturedExceptions.length, 1);
    assert.equal(capturedExceptions[0], networkErr);
  });

  it("records timeout (AbortError) with exception tracker", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    const abortErr = new Error("operation aborted due to timeout");
    abortErr.name = "TimeoutError";
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now() - 5100,
      resultCode: 0,
      success: false,
      error: abortErr,
    });
    assert.equal(capturedExceptions[0], abortErr);
  });
});

describe("trackHttpDependency — robustness", () => {
  it("does not throw when the tracer itself throws on startSpan", () => {
    _setTracerResolverForTests(() => makeFakeTracer({ throwOnStartSpan: true }));
    assert.doesNotThrow(() => {
      trackHttpDependency({
        name: "signal_service",
        url: "https://fn-compiq.azurewebsites.net/api/signals",
        startMs: Date.now(),
        resultCode: 200,
        success: true,
      });
    });
    // No span captured; no exception captured (the span-creation throw is
    // swallowed before reaching the exception-tracker call)
    assert.equal(capturedSpans.length, 0);
  });

  it("no-ops gracefully when tracer is no-op (e.g., no global provider)", () => {
    _setTracerResolverForTests(() => makeNoopTracer());
    assert.doesNotThrow(() => {
      trackHttpDependency({
        name: "signal_service",
        url: "https://fn-compiq.azurewebsites.net/api/signals",
        startMs: Date.now(),
        resultCode: 200,
        success: true,
      });
    });
    // No-op tracer doesn't capture anything in our test list
    assert.equal(capturedSpans.length, 0);
  });

  it("does not throw on malformed URL — falls back to raw string for url.full", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    trackHttpDependency({
      name: "signal_service",
      url: "not a valid url",
      startMs: Date.now(),
      resultCode: 200,
      success: true,
    });
    assert.equal(capturedSpans.length, 1);
    assert.equal(capturedSpans[0].attributes["server.address"], "unknown");
    assert.equal(capturedSpans[0].attributes["url.full"], "not a valid url");
  });

  it("clamps negative duration to 0 (defensive — startMs in future)", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    const startMs = Date.now() + 10000; // 10s in the future
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs,
      resultCode: 200,
      success: true,
    });
    const s = capturedSpans[0];
    // duration clamped to 0 → startTime should equal endTime
    assert.ok(s.startTime instanceof Date);
    assert.ok(s.endTime !== undefined);
    const startToEnd = s.endTime! - s.startTime!.getTime();
    // Allow small jitter from time.now() calls between startTime computation
    // and endTime read
    assert.ok(Math.abs(startToEnd) < 50, `startToEnd=${startToEnd}ms`);
  });

  it("does not call exception tracker when error not provided (success path)", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now(),
      resultCode: 200,
      success: true,
    });
    assert.equal(capturedExceptions.length, 0);
  });

  it("does not call exception tracker when error not provided (HTTP-error path)", () => {
    _setTracerResolverForTests(() => makeFakeTracer());
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now(),
      resultCode: 500,
      success: false,
      // no error — HTTP-error path without exception
    });
    assert.equal(capturedExceptions.length, 0);
  });
});
