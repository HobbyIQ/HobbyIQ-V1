// CF-TELEMETRY-VOLUME (2026-09-07). Pins the Cosmos gateway ping filter.
//
// The rule these tests defend is narrow on purpose: it drops only a fast,
// successful, root-path GET to a Cosmos account host. Every widening of that
// is a way to lose real evidence, so each clause has a test that proves the
// span SURVIVES when the clause does not hold.

import { describe, it, expect } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import {
  isCosmosGatewayPing,
  COSMOS_PING_MAX_DURATION_MS,
  SPAN_KIND_CLIENT,
} from "../src/services/ops/telemetryFilters.js";
import {
  suppressIfCosmosPing,
  CosmosPingSpanFilter,
} from "../src/services/ops/cosmosPingSpanFilter.js";

const COSMOS_HOST = "hobbyiq-comps.documents.azure.com";

/** The exact shape the 2026-09-07 report measured at ~356k rows/hour. */
function pingAttrs(over: Record<string, unknown> = {}) {
  return {
    "server.address": COSMOS_HOST,
    "url.path": "/",
    "http.request.method": "GET",
    "http.response.status_code": 200,
    ...over,
  };
}

function ping(over: Record<string, unknown> = {}, durationMs = 1) {
  return { kind: SPAN_KIND_CLIENT, attributes: pingAttrs(over), durationMs };
}

// The constant this whole filter pivots on. It is written by hand in
// telemetryFilters.ts (so that module needs no OTel dependency), which means a
// test that also hard-codes it proves nothing: both can be wrong together and
// stay green while the filter silently matches nothing in production. This is
// the one test that checks the value against the REAL enum.
//
// It caught exactly that during development: the constant was 3 (PRODUCER),
// taken from a misreading of the SpanProcessor docs. Every unit test passed and
// an end-to-end run against the real SDK suppressed zero spans.
describe("SPAN_KIND_CLIENT — checked against @opentelemetry/api, not itself", () => {
  it("is SpanKind.CLIENT", () => {
    expect(SPAN_KIND_CLIENT).toBe(SpanKind.CLIENT);
  });

  it("is not any other span kind", () => {
    expect(SPAN_KIND_CLIENT).not.toBe(SpanKind.INTERNAL);
    expect(SPAN_KIND_CLIENT).not.toBe(SpanKind.SERVER);
    expect(SPAN_KIND_CLIENT).not.toBe(SpanKind.PRODUCER);
    expect(SPAN_KIND_CLIENT).not.toBe(SpanKind.CONSUMER);
  });
});

describe("isCosmosGatewayPing — the row we are dropping", () => {
  it("matches the exact envelope from the incident report", () => {
    // DependencyType HTTP, Name "GET /", Target hobbyiq-comps.documents.azure.com,
    // DurationMs 1, ResultCode 200.
    expect(isCosmosGatewayPing(ping())).toBe(true);
  });

  it("matches on legacy semantic-convention attribute names", () => {
    // The Cosmos SDK and the undici instrumentation do not agree on which
    // attribute set they emit, so both must be understood.
    expect(
      isCosmosGatewayPing({
        kind: SPAN_KIND_CLIENT,
        attributes: {
          "net.peer.name": COSMOS_HOST,
          "http.target": "/",
          "http.method": "GET",
          "http.status_code": 200,
        },
        durationMs: 1,
      }),
    ).toBe(true);
  });

  it("matches when host and path are only derivable from a full URL", () => {
    expect(
      isCosmosGatewayPing({
        kind: SPAN_KIND_CLIENT,
        attributes: {
          "http.url": `https://${COSMOS_HOST}/`,
          "http.method": "GET",
          "http.status_code": 200,
        },
        durationMs: 1,
      }),
    ).toBe(true);
  });

  it("tolerates a query string on the root path", () => {
    expect(isCosmosGatewayPing(ping({ "url.path": "/?x=1" }))).toBe(true);
  });

  it("accepts a string status code", () => {
    expect(
      isCosmosGatewayPing(ping({ "http.response.status_code": "200" })),
    ).toBe(true);
  });

  it("drops at exactly the duration boundary but not past it", () => {
    expect(isCosmosGatewayPing(ping({}, COSMOS_PING_MAX_DURATION_MS))).toBe(
      true,
    );
    expect(
      isCosmosGatewayPing(ping({}, COSMOS_PING_MAX_DURATION_MS + 0.001)),
    ).toBe(false);
  });
});

describe("isCosmosGatewayPing — evidence that must SURVIVE", () => {
  it("keeps a SLOW root call — that is a latency signal", () => {
    expect(isCosmosGatewayPing(ping({}, 250))).toBe(false);
  });

  it("keeps a FAILING root call — that is an outage signal", () => {
    for (const code of [401, 403, 429, 500, 503]) {
      expect(
        isCosmosGatewayPing(ping({ "http.response.status_code": code })),
      ).toBe(false);
    }
  });

  it("keeps every real Cosmos operation — never a db/collection path", () => {
    for (const path of [
      "/dbs/hobbyiq/colls/sold_comps/docs",
      "/dbs/hobbyiq/colls/portfolio",
      "/dbs",
    ]) {
      expect(isCosmosGatewayPing(ping({ "url.path": path }))).toBe(false);
    }
  });

  it("keeps calls to any non-Cosmos host", () => {
    for (const host of [
      "api.ebay.com",
      "cardhedge.com",
      "documents.azure.com.evil.example",
      "hobbyiq3.azurewebsites.net",
    ]) {
      expect(isCosmosGatewayPing(ping({ "server.address": host }))).toBe(false);
    }
  });

  it("keeps INBOUND requests to our own root — a server span is not a dependency", () => {
    // Without the span-kind clause, our own "GET /" health traffic would vanish.
    expect(
      isCosmosGatewayPing({
        kind: SpanKind.SERVER,
        attributes: pingAttrs(),
        durationMs: 1,
      }),
    ).toBe(false);
  });

  it("keeps a non-GET call to the account root", () => {
    for (const m of ["POST", "PUT", "DELETE"]) {
      expect(isCosmosGatewayPing(ping({ "http.request.method": m }))).toBe(
        false,
      );
    }
  });

  it("refuses to drop when duration, status, host or path is unknown", () => {
    expect(
      isCosmosGatewayPing({ kind: SPAN_KIND_CLIENT, attributes: pingAttrs() }),
    ).toBe(false); // no duration
    const noStatus = pingAttrs();
    delete (noStatus as any)["http.response.status_code"];
    expect(
      isCosmosGatewayPing({
        kind: SPAN_KIND_CLIENT,
        attributes: noStatus,
        durationMs: 1,
      }),
    ).toBe(false);
    const noHost = pingAttrs();
    delete (noHost as any)["server.address"];
    expect(
      isCosmosGatewayPing({
        kind: SPAN_KIND_CLIENT,
        attributes: noHost,
        durationMs: 1,
      }),
    ).toBe(false);
    const noPath = pingAttrs();
    delete (noPath as any)["url.path"];
    expect(
      isCosmosGatewayPing({
        kind: SPAN_KIND_CLIENT,
        attributes: noPath,
        durationMs: 1,
      }),
    ).toBe(false);
  });

  it("survives a garbage envelope without throwing", () => {
    expect(isCosmosGatewayPing({})).toBe(false);
    expect(isCosmosGatewayPing({ attributes: { "http.url": "not a url" } })).toBe(
      false,
    );
  });
});

// ── The suppression mechanism ────────────────────────────────────────────
//
// Deciding correctly is only half of it. The decision has to actually stop the
// export, and it does so by clearing the SAMPLED trace flag that
// BatchSpanProcessorBase.onEnd checks first. These pin that mutation.

const SAMPLED = 0x1;

function fakeSpan(over: Record<string, unknown> = {}, durationSec = 0, durationNano = 1e6) {
  const ctx = { traceFlags: SAMPLED };
  return {
    kind: SPAN_KIND_CLIENT,
    attributes: pingAttrs(over),
    duration: [durationSec, durationNano] as [number, number],
    spanContext: () => ctx,
    _ctx: ctx,
  };
}

describe("suppressIfCosmosPing — clearing the SAMPLED flag", () => {
  it("clears SAMPLED on a ping, which is what stops the export", () => {
    const span = fakeSpan();
    expect(suppressIfCosmosPing(span)).toBe(true);
    expect(span._ctx.traceFlags & SAMPLED).toBe(0);
  });

  it("leaves a real operation's SAMPLED flag intact", () => {
    const span = fakeSpan({ "url.path": "/dbs/hobbyiq/colls/sold_comps/docs" });
    expect(suppressIfCosmosPing(span)).toBe(false);
    expect(span._ctx.traceFlags & SAMPLED).toBe(SAMPLED);
  });

  it("converts HrTime correctly — 6ms is past the 5ms ceiling and survives", () => {
    // [seconds, nanoseconds]; 6e6 ns = 6 ms.
    const span = fakeSpan({}, 0, 6e6);
    expect(suppressIfCosmosPing(span)).toBe(false);
    expect(span._ctx.traceFlags & SAMPLED).toBe(SAMPLED);
  });

  it("treats a whole-second duration as far past the ceiling", () => {
    const span = fakeSpan({}, 1, 0);
    expect(suppressIfCosmosPing(span)).toBe(false);
  });

  it("does not claim a suppression on an already-unsampled span", () => {
    const ctx = { traceFlags: 0 };
    expect(
      suppressIfCosmosPing({
        kind: SPAN_KIND_CLIENT,
        attributes: pingAttrs(),
        duration: [0, 1e6],
        spanContext: () => ctx,
      }),
    ).toBe(false);
  });

  it("does not claim a suppression when there is no span context to clear", () => {
    expect(
      suppressIfCosmosPing({
        kind: SPAN_KIND_CLIENT,
        attributes: pingAttrs(),
        duration: [0, 1e6],
      }),
    ).toBe(false);
  });
});

describe("CosmosPingSpanFilter — the processor", () => {
  it("counts only what it actually suppressed", () => {
    const p = new CosmosPingSpanFilter();
    p.onEnd(fakeSpan());
    p.onEnd(fakeSpan());
    p.onEnd(fakeSpan({ "url.path": "/dbs/hobbyiq/colls/sold_comps/docs" }));
    p.onEnd(fakeSpan({}, 0, 9e6)); // 9ms, too slow
    expect(p.suppressedCount).toBe(2);
  });

  it("never throws into the SDK span pipeline", () => {
    const p = new CosmosPingSpanFilter();
    expect(() =>
      p.onEnd({
        spanContext: () => {
          throw new Error("boom");
        },
      } as any),
    ).not.toThrow();
    expect(p.suppressedCount).toBe(0);
  });

  it("implements the SpanProcessor contract the distro calls", async () => {
    const p = new CosmosPingSpanFilter();
    expect(typeof p.onStart).toBe("function");
    expect(typeof p.onEnd).toBe("function");
    await expect(p.forceFlush()).resolves.toBeUndefined();
    await expect(p.shutdown()).resolves.toBeUndefined();
  });
});
