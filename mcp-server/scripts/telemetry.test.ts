// Unit tests for trackHttpDependency (CF-FETCH-SIGNAL-FLOOR-TELEMETRY).
//
// Verifies:
// - Calls into App Insights' trackDependency with the right shape
// - Extracts target/data from URL (hostname/pathname only — no query string,
//   so function keys don't leak into telemetry)
// - On error: calls trackException too
// - Never throws even when the underlying client throws (telemetry must not
//   break the prediction path)
// - No-op when App Insights isn't initialized (defaultClient is null)
//
// Run: cd mcp-server && npx tsx --test scripts/telemetry.test.ts

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";

let trackHttpDependency: typeof import("../telemetry.js").trackHttpDependency;
let _setClientResolverForTests: typeof import("../telemetry.js")._setClientResolverForTests;
let _resetClientResolverForTests: typeof import("../telemetry.js")._resetClientResolverForTests;

// In-memory capture for App Insights calls
let capturedDependencies: Array<{
  name: string;
  target: string;
  data: string;
  duration: number;
  resultCode: string;
  success: boolean;
  dependencyTypeName: string;
}> = [];
let capturedExceptions: Array<{ exception: Error }> = [];

interface FakeClient {
  trackDependency: (args: {
    name: string;
    target: string;
    data: string;
    duration: number;
    resultCode: string;
    success: boolean;
    dependencyTypeName: string;
  }) => void;
  trackException: (args: { exception: Error }) => void;
}

function installFakeClient(opts: { throws?: boolean } = {}): void {
  const fake: FakeClient = {
    trackDependency: (a) => {
      if (opts.throws) throw new Error("simulated AI failure");
      capturedDependencies.push(a);
    },
    trackException: (a) => {
      if (opts.throws) throw new Error("simulated AI failure");
      capturedExceptions.push(a);
    },
  };
  _setClientResolverForTests(() => fake);
}

function clearClient(): void {
  _setClientResolverForTests(() => null);
}

before(async () => {
  const mod = await import("../telemetry.js");
  trackHttpDependency = mod.trackHttpDependency;
  _setClientResolverForTests = mod._setClientResolverForTests;
  _resetClientResolverForTests = mod._resetClientResolverForTests;
});

beforeEach(() => {
  capturedDependencies = [];
  capturedExceptions = [];
});

after(() => {
  _resetClientResolverForTests();
});

describe("trackHttpDependency — happy paths", () => {
  it("records a successful dependency with target=hostname and data=pathname", () => {
    installFakeClient();
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals?player=Mike%20Trout&code=secret",
      startMs: Date.now() - 250,
      resultCode: 200,
      success: true,
    });
    assert.equal(capturedDependencies.length, 1);
    const d = capturedDependencies[0];
    assert.equal(d.name, "signal_service");
    assert.equal(d.target, "fn-compiq.azurewebsites.net");
    // CRITICAL: data is pathname ONLY — must not include ?code=secret query string
    assert.equal(d.data, "/api/signals");
    assert.equal(d.resultCode, "200");
    assert.equal(d.success, true);
    assert.equal(d.dependencyTypeName, "HTTP");
    assert.ok(d.duration >= 240 && d.duration < 5000, `duration=${d.duration}`);
    assert.equal(capturedExceptions.length, 0);
  });

  it("records HTTP 4xx as success=false (e.g., 404 URL_NOT_FOUND)", () => {
    installFakeClient();
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/serve-signals",
      startMs: Date.now() - 100,
      resultCode: 404,
      success: false,
    });
    assert.equal(capturedDependencies.length, 1);
    assert.equal(capturedDependencies[0].resultCode, "404");
    assert.equal(capturedDependencies[0].success, false);
    assert.equal(capturedExceptions.length, 0);
  });

  it("records HTTP 5xx as success=false", () => {
    installFakeClient();
    trackHttpDependency({
      name: "price_floor_service",
      url: "https://fn-compiq.azurewebsites.net/api/price-floor",
      startMs: Date.now() - 1500,
      resultCode: 503,
      success: false,
    });
    assert.equal(capturedDependencies[0].resultCode, "503");
    assert.equal(capturedDependencies[0].success, false);
  });
});

describe("trackHttpDependency — error paths", () => {
  it("records network failure with resultCode=0 + trackException", () => {
    installFakeClient();
    const networkErr = new Error("ECONNREFUSED");
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now() - 200,
      resultCode: 0,
      success: false,
      error: networkErr,
    });
    assert.equal(capturedDependencies.length, 1);
    assert.equal(capturedDependencies[0].resultCode, "0");
    assert.equal(capturedDependencies[0].success, false);
    assert.equal(capturedExceptions.length, 1);
    assert.equal(capturedExceptions[0].exception, networkErr);
  });

  it("records timeout error (AbortError) with trackException", () => {
    installFakeClient();
    const abortErr = new Error("The operation was aborted due to timeout");
    abortErr.name = "TimeoutError";
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now() - 5100,
      resultCode: 0,
      success: false,
      error: abortErr,
    });
    assert.equal(capturedExceptions[0].exception, abortErr);
  });
});

describe("trackHttpDependency — robustness", () => {
  it("no-ops silently when appInsights.defaultClient is null (not initialized)", () => {
    clearClient();
    // Should not throw
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now(),
      resultCode: 200,
      success: true,
    });
    // No captures because the fake client isn't installed
    assert.equal(capturedDependencies.length, 0);
    assert.equal(capturedExceptions.length, 0);
  });

  it("does not throw when the App Insights client itself throws", () => {
    installFakeClient({ throws: true });
    // Should swallow the simulated AI failure — telemetry must never break callers
    assert.doesNotThrow(() => {
      trackHttpDependency({
        name: "signal_service",
        url: "https://fn-compiq.azurewebsites.net/api/signals",
        startMs: Date.now(),
        resultCode: 200,
        success: true,
      });
    });
  });

  it("does not throw on malformed URL — falls back to raw string as data", () => {
    installFakeClient();
    trackHttpDependency({
      name: "signal_service",
      url: "not a valid url",
      startMs: Date.now(),
      resultCode: 200,
      success: true,
    });
    // Still records something
    assert.equal(capturedDependencies.length, 1);
    assert.equal(capturedDependencies[0].target, "unknown");
    assert.equal(capturedDependencies[0].data, "not a valid url");
  });

  it("clamps negative duration to 0 (defensive — startMs in future)", () => {
    installFakeClient();
    trackHttpDependency({
      name: "signal_service",
      url: "https://fn-compiq.azurewebsites.net/api/signals",
      startMs: Date.now() + 10000,  // 10s in the future
      resultCode: 200,
      success: true,
    });
    assert.equal(capturedDependencies[0].duration, 0);
  });
});
