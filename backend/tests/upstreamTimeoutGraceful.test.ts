// PREDICTION-ROBUSTNESS-RECON #1 (2026-06-02) — graceful CardsightTimeoutError
// handling across the 5 prediction-path routes.
//
// Lock: a Cardsight timeout deep in computeEstimate/dispatchSearch must
// produce HTTP 200 with `source: "upstream-timeout"` and null pricing
// fields — NEVER HTTP 500 with a leaked error message. Mirrors the
// unsupported_sport short-circuit shape per route.
//
// 5 routes × happy-vs-timeout assertions + the helper module's pure
// shape locks.

import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CardsightTimeoutError } from "../src/services/compiq/cardsight.client.js";

process.env.COMPIQ_CORPUS_DISABLED = "1";

// Mock computeEstimate + dispatchSearch so we can force throws from the
// inner Cardsight call without hitting the network. Each test sets the
// implementation via vi.mocked(...).mockImplementationOnce.
vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/compiq/compiqEstimate.service.js",
  );
  return {
    ...actual,
    computeEstimate: vi.fn(),
  };
});
vi.mock("../src/services/unifiedSearch/dispatcher.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/unifiedSearch/dispatcher.js",
  );
  return {
    ...actual,
    dispatchSearch: vi.fn(),
  };
});

const compiqEstimateMod = await import(
  "../src/services/compiq/compiqEstimate.service.js"
);
const dispatcherMod = await import("../src/services/unifiedSearch/dispatcher.js");

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network disabled in tests")),
  );
  (compiqEstimateMod.computeEstimate as any).mockReset();
  (dispatcherMod.dispatchSearch as any).mockReset();
});

// Reused happy-path stub for routes that need a non-timeout estimate to
// run smoke / parity checks against.
const HAPPY_ESTIMATE = {
  fairMarketValue: 100,
  premiumValue: 115,
  quickSaleValue: 88,
  marketDNA: { trend: "flat", speed: "Normal" },
  confidence: { pricingConfidence: 70 },
  source: "live",
  verdict: "ok",
  compsUsed: 5,
  compsAvailable: 7,
  recentComps: [],
  cardIdentity: null,
  gradeUsed: "Raw",
  daysSinceNewestComp: 2,
  variantWarning: [],
  neighborSynthesis: null,
  crossParallelAnchor: null,
  effectiveFmv: 100,
};

describe("upstream-timeout graceful handling", () => {
  describe("/api/compiq/price", () => {
    it("returns HTTP 200 with source=upstream-timeout instead of 500 on CardsightTimeoutError", async () => {
      (compiqEstimateMod.computeEstimate as any).mockImplementationOnce(
        async () => {
          throw new CardsightTimeoutError();
        },
      );
      const r = await request(app)
        .post("/api/compiq/price")
        .send({ query: "Elly De La Cruz 2024 Topps Chrome" });
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("upstream-timeout");
      expect(r.body.fairMarketValueLive).toBeNull();
      expect(r.body.marketValue).toBeNull();
      expect(r.body.predictedPrice).toBeNull();
      expect(r.body.trendIQ).toBeNull();
      expect(r.body.summary).toContain("Couldn't reach the catalog");
      expect(r.body.predictedPriceAttribution).toEqual({
        mechanism: "unavailable",
        failureReason: "upstream-timeout",
      });
      // Shape-stable defaults — iOS depends on every field being present.
      expect(r.body.marketTier).toEqual({ value: null, high: null });
      expect(r.body.buyZone).toEqual([null, null]);
      expect(r.body.recentComps).toEqual([]);
      expect(r.body.compsUsed).toBe(0);
    });

    it("happy path still emits live estimate (no regression on the non-timeout path)", async () => {
      (compiqEstimateMod.computeEstimate as any).mockImplementationOnce(
        async () => HAPPY_ESTIMATE,
      );
      const r = await request(app)
        .post("/api/compiq/price")
        .send({ query: "Mike Trout 2023 Topps" });
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("live");
      expect(r.body.fairMarketValueLive).toBe(100);
    });
  });

  describe("/api/compiq/search", () => {
    it("returns 200 + upstream-timeout shape on CardsightTimeoutError", async () => {
      (compiqEstimateMod.computeEstimate as any).mockImplementationOnce(
        async () => {
          throw new CardsightTimeoutError();
        },
      );
      const r = await request(app)
        .post("/api/compiq/search")
        .send({ query: "Elly De La Cruz 2024 Topps Chrome" });
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("upstream-timeout");
      expect(r.body.predictedPrice).toBeNull();
      expect(r.body.trendIQ).toBeNull();
    });
  });

  describe("/api/compiq/price-by-id", () => {
    it("returns 200 + upstream-timeout shape with the pinned cardsightCardId exposed", async () => {
      (compiqEstimateMod.computeEstimate as any).mockImplementationOnce(
        async () => {
          throw new CardsightTimeoutError();
        },
      );
      const r = await request(app)
        .post("/api/compiq/price-by-id")
        .send({ cardsightCardId: "test-card-uuid-abc", query: "Test card" });
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("upstream-timeout");
      expect(r.body.cardsightCardId).toBe("test-card-uuid-abc");
      expect(r.body.predictedPrice).toBeNull();
    });
  });

  describe("/api/compiq/cardsearch", () => {
    it("returns 200 + UnifiedSearchResponse with empty candidates + structured timeout warning", async () => {
      (dispatcherMod.dispatchSearch as any).mockImplementationOnce(
        async () => {
          throw new CardsightTimeoutError();
        },
      );
      const r = await request(app)
        .post("/api/compiq/cardsearch")
        .send({ query: "Elly De La Cruz 2024 Topps Chrome" });
      expect(r.status).toBe(200);
      expect(r.body.candidates).toEqual([]);
      expect(r.body.warnings).toContain("upstream_timeout:cardsight_search");
      expect(r.body.input.raw).toBe("Elly De La Cruz 2024 Topps Chrome");
      expect(r.body.input.detectedMode).toBe("freetext");
    });

    it("preserves detectedMode=cert when hint=cert was provided", async () => {
      (dispatcherMod.dispatchSearch as any).mockImplementationOnce(
        async () => {
          throw new CardsightTimeoutError();
        },
      );
      const r = await request(app)
        .post("/api/compiq/cardsearch")
        .send({ query: "12345678", hint: "cert" });
      expect(r.status).toBe(200);
      expect(r.body.input.detectedMode).toBe("cert");
    });
  });

  describe("/api/compiq/bulk", () => {
    it("one item timing out does NOT take down the whole bulk; timed-out item gets the graceful shape with status=ok", async () => {
      // 2 queries: first succeeds, second times out
      (compiqEstimateMod.computeEstimate as any)
        .mockImplementationOnce(async () => HAPPY_ESTIMATE)
        .mockImplementationOnce(async () => {
          throw new CardsightTimeoutError();
        });
      const r = await request(app)
        .post("/api/compiq/bulk")
        .send({
          queries: [
            "Mike Trout 2023 Topps",
            "Elly De La Cruz 2024 Topps Chrome",
          ],
        });
      expect(r.status).toBe(200);
      expect(r.body.requested).toBe(2);
      // Both items return status=ok (the timeout doesn't escalate to error)
      expect(r.body.succeeded).toBe(2);
      expect(r.body.failed).toBe(0);
      expect(r.body.results).toHaveLength(2);
      expect(r.body.results[0].status).toBe("ok");
      expect(r.body.results[0].data.source).toBe("live");
      expect(r.body.results[1].status).toBe("ok");
      expect(r.body.results[1].data.source).toBe("upstream-timeout");
      expect(r.body.results[1].data.predictedPrice).toBeNull();
      expect(r.body.results[1].data.summary).toContain(
        "Couldn't reach the catalog",
      );
    });

    it("non-timeout errors still propagate to status=error (no broad-catch regression)", async () => {
      (compiqEstimateMod.computeEstimate as any).mockImplementationOnce(
        async () => {
          throw new Error("some other failure");
        },
      );
      const r = await request(app)
        .post("/api/compiq/bulk")
        .send({ queries: ["Mike Trout 2023 Topps"] });
      expect(r.status).toBe(200);
      expect(r.body.results[0].status).toBe("error");
      expect(r.body.results[0].error).toBe("some other failure");
    });
  });

  describe("non-timeout errors still propagate to 500 (no broad-catch regression)", () => {
    it("/price — generic error continues to next(err)", async () => {
      (compiqEstimateMod.computeEstimate as any).mockImplementationOnce(
        async () => {
          throw new Error("some other failure");
        },
      );
      const r = await request(app)
        .post("/api/compiq/price")
        .send({ query: "x" });
      // The default Express handler emits 500 for an unhandled throw —
      // CardsightTimeoutError is the ONLY error we soft-handle.
      expect(r.status).toBe(500);
    });
  });
});

describe("upstreamTimeout.helpers — pure-shape locks", () => {
  it("isCardsightTimeoutError narrows the type", async () => {
    const { isCardsightTimeoutError } = await import(
      "../src/services/compiq/upstreamTimeout.helpers.js"
    );
    expect(isCardsightTimeoutError(new CardsightTimeoutError())).toBe(true);
    expect(isCardsightTimeoutError(new Error("nope"))).toBe(false);
    expect(isCardsightTimeoutError(null)).toBe(false);
    expect(isCardsightTimeoutError("string")).toBe(false);
  });

  it("buildUpstreamTimeoutPriceResponse carries the canonical source + null pricing", async () => {
    const { buildUpstreamTimeoutPriceResponse } = await import(
      "../src/services/compiq/upstreamTimeout.helpers.js"
    );
    const out = buildUpstreamTimeoutPriceResponse("foo");
    expect(out.source).toBe("upstream-timeout");
    expect(out.fairMarketValueLive).toBeNull();
    expect(out.predictedPrice).toBeNull();
    expect(out.trendIQ).toBeNull();
    expect(out.compsUsed).toBe(0);
    expect((out.predictedPriceAttribution as any).failureReason).toBe(
      "upstream-timeout",
    );
  });

  it("buildUpstreamTimeoutCardSearchResponse emits a structured timeout warning string", async () => {
    const { buildUpstreamTimeoutCardSearchResponse } = await import(
      "../src/services/compiq/upstreamTimeout.helpers.js"
    );
    const out = buildUpstreamTimeoutCardSearchResponse("q", "freetext");
    expect(out.candidates).toEqual([]);
    expect(out.warnings).toEqual(["upstream_timeout:cardsight_search"]);
    expect(out.input.raw).toBe("q");
    expect(out.input.detectedMode).toBe("freetext");
  });

  it("buildUpstreamTimeoutPriceByIdResponse preserves the pinned cardId", async () => {
    const { buildUpstreamTimeoutPriceByIdResponse } = await import(
      "../src/services/compiq/upstreamTimeout.helpers.js"
    );
    const out = buildUpstreamTimeoutPriceByIdResponse("uuid-xyz");
    expect(out.cardsightCardId).toBe("uuid-xyz");
    expect(out.source).toBe("upstream-timeout");
    expect(out.predictedPrice).toBeNull();
  });

  it("buildUpstreamTimeoutBulkItemData carries query + null pricing", async () => {
    const { buildUpstreamTimeoutBulkItemData } = await import(
      "../src/services/compiq/upstreamTimeout.helpers.js"
    );
    const out = buildUpstreamTimeoutBulkItemData("Mike Trout");
    expect(out.query).toBe("Mike Trout");
    expect(out.source).toBe("upstream-timeout");
    expect(out.predictedPrice).toBeNull();
  });
});
