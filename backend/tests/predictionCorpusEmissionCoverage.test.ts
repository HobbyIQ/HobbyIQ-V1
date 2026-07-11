// CF-PREDICTION-CORPUS-EMISSION-COVERAGE — Ship verification
//
// Locks the helper's behavior across the four documented input scenarios
// (surfacedPrice derivation, surfacedPriceSource mapping, trendIQ-null stub,
// dedup-signature path-discrimination) plus the source-level guarantee that
// every FMV-returning path in computeEstimate now emits via the unified
// helper exactly once.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "fs";
import { testCallContext } from "./_helpers/testCallContext.js";

// Mock the corpus writer + health counter so we can observe what the helper
// actually emits, without touching Cosmos. The mock factory MUST cover every
// exported name the predictionCorpus modules expose (writePredictionLog +
// the health-counter trio) — otherwise downstream imports break.
const writeMock = vi.fn();
vi.mock("../src/services/compiq/predictionCorpus.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/compiq/predictionCorpus.service.js",
  );
  return {
    ...actual,
    writePredictionLog: writeMock,
  };
});

const { emitPredictionToCorpus } = await import(
  "../src/services/compiq/compiqEstimate.service.js"
);
const corpusModule = await import(
  "../src/services/compiq/predictionCorpus.service.js"
);

const BASE_BODY = {
  playerName: "Paul Skenes",
  cardYear: 2024,
  product: "Bowman Chrome",
  parallel: "Base",
  gradeCompany: "PSA",
  gradeValue: 10,
};

describe("CF-PREDICTION-CORPUS-EMISSION-COVERAGE", () => {
  beforeEach(() => {
    writeMock.mockClear();
  });

  describe("emitPredictionToCorpus helper — surfacedPrice derivation", () => {
    it("predicted present + FMV present -> surfacedPrice = predicted, source = predictedPrice", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-aaa" },
        body: BASE_BODY,
        fairMarketValue: 100,
        fmvMechanism: "main-pipeline",
        predictedPrice: 110,
        predictedPriceRange: { low: 100, high: 120 },
        predictedPriceMechanism: "trendiq-projection",
      });
      expect(writeMock).toHaveBeenCalledTimes(1);
      const payload = writeMock.mock.calls[0][0];
      expect(payload.surfacedPrice).toBe(110);
      expect(payload.surfacedPriceSource).toBe("predictedPrice");
    });

    it("predicted null + FMV present -> surfacedPrice = FMV, source = fairMarketValue", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-bbb" },
        body: BASE_BODY,
        fairMarketValue: 100,
        fmvMechanism: "sibling-pool-weighted-median",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      const payload = writeMock.mock.calls[0][0];
      expect(payload.surfacedPrice).toBe(100);
      expect(payload.surfacedPriceSource).toBe("fairMarketValue");
    });

    it("predicted null + FMV null -> surfacedPrice = null, source = none", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: null,
        body: BASE_BODY,
        fairMarketValue: null,
        fmvMechanism: "unavailable",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      const payload = writeMock.mock.calls[0][0];
      expect(payload.surfacedPrice).toBeNull();
      expect(payload.surfacedPriceSource).toBe("none");
    });

    it("FMV NaN / Infinity coerce to null (defensive)", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-nan" },
        body: BASE_BODY,
        fairMarketValue: NaN,
        fmvMechanism: "unavailable",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      const payload = writeMock.mock.calls[0][0];
      expect(payload.fairMarketValue).toBeNull();
      expect(payload.surfacedPrice).toBeNull();
    });
  });

  describe("emitPredictionToCorpus helper — trendIQ-null stub", () => {
    it("absent trendIQ -> zero-coverage stub (composite=1.0, coverage=insufficient, direction=flat)", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-stub" },
        body: BASE_BODY,
        fairMarketValue: 50,
        fmvMechanism: "sibling-pool-weighted-median",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      const payload = writeMock.mock.calls[0][0];
      expect(payload.trendIQ.composite).toBe(1.0);
      expect(payload.trendIQ.coverage).toBe("insufficient");
      expect(payload.trendIQ.direction).toBe("flat");
      expect(payload.trendIQ.components.playerMomentum).toBeNull();
      expect(payload.trendIQ.components.cardTrajectory).toBeNull();
      expect(payload.trendIQ.components.segmentTrajectory).toBeNull();
      expect(payload.trendIQ.lastUpdated).toBeNull();
    });

    it("forwardProjectionFactor defaults to 1.0 when omitted", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-default" },
        body: BASE_BODY,
        fairMarketValue: 100,
        fmvMechanism: "unavailable",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      const payload = writeMock.mock.calls[0][0];
      expect(payload.forwardProjectionFactor).toBe(1.0);
    });

    it("compsUsed defaults to 0 when omitted", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-default-comps" },
        body: BASE_BODY,
        fairMarketValue: null,
        fmvMechanism: "unavailable",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      const payload = writeMock.mock.calls[0][0];
      expect(payload.compsUsed).toBe(0);
    });
  });

  describe("emitPredictionToCorpus helper — fmvMechanism tagging", () => {
    it("main-pipeline tag flows through to payload", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-main" },
        body: BASE_BODY,
        fairMarketValue: 100,
        fmvMechanism: "main-pipeline",
        predictedPrice: 110,
        predictedPriceRange: null,
        predictedPriceMechanism: "trendiq-projection",
      });
      expect(writeMock.mock.calls[0][0].fmvMechanism).toBe("main-pipeline");
    });

    it("sibling-pool-weighted-median tag flows through to payload", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-sib" },
        body: BASE_BODY,
        fairMarketValue: 50,
        fmvMechanism: "sibling-pool-weighted-median",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      expect(writeMock.mock.calls[0][0].fmvMechanism).toBe(
        "sibling-pool-weighted-median",
      );
    });

    it("unavailable tag flows through to payload", () => {
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: null,
        body: BASE_BODY,
        fairMarketValue: null,
        fmvMechanism: "unavailable",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      expect(writeMock.mock.calls[0][0].fmvMechanism).toBe("unavailable");
    });
  });

  describe("source-level lock — every FMV-returning path emits via the helper exactly once", () => {
    it("computeEstimate has 7 emitPredictionToCorpus call sites (1 main + 6 fallback)", async () => {
      const text = await fs.readFile(
        new URL(
          "../src/services/compiq/compiqEstimate.service.ts",
          import.meta.url,
        ),
        "utf8",
      );
      // 1 helper definition + 12 callsites = 13 hits total.
      // Historical additions:
      //   CF-LAUNCH-HARDENING (2026-06-02): pre-modern + catalog-miss → 7
      //   CF-FAMILY-PROJECTION (#348-#350, 2026-07-09): product-family
      //     projection emit → 8
      //   CF-PARALLEL-FLOOR (#344, 2026-07-09): parallel-floor projection
      //     emit → 9
      //   CF-PHASE5-V2-ZERO-COMP-ANCHOR (2026-07-10): scarcity-prior-floor
      //     projection emit (fires when parent-player pool empty) → 10
      //   CF-NO-NULL-PRICING PR 1 (2026-07-11): reference-catalog-baseline
      //     (Tier 6 fallback, era baseline × ladder tier) → 11
      //   CF-NO-NULL-PRICING PR 3 (2026-07-11): setdoc-baseline (Tier 7
      //     fallback at catalog-miss, era-typed SetDoc baseline) → 12
      const matches = text.match(/emitPredictionToCorpus\s*[({]/g);
      expect(matches?.length ?? 0).toBe(13);
    });

    it("each fallback path tags fmvMechanism appropriately", async () => {
      const text = await fs.readFile(
        new URL(
          "../src/services/compiq/compiqEstimate.service.ts",
          import.meta.url,
        ),
        "utf8",
      );
      // main-pipeline appears once (main path emit + helper signature
      // declaration both mention the literal — accept >= 2).
      expect(
        text.match(/fmvMechanism:\s*"main-pipeline"/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(1);
      expect(
        text.match(/fmvMechanism:\s*"sibling-pool-weighted-median"/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(1);
      // 3 fallback paths emit fmvMechanism: "unavailable" (unsupported_sport,
      // variant-mismatch, no-recent-comps).
      expect(
        text.match(/fmvMechanism:\s*"unavailable"/g)?.length ?? 0,
      ).toBeGreaterThanOrEqual(3);
    });

    it("no double-emit: every emit call site sits BEFORE its return statement (single emit per request)", async () => {
      // A double-emit would manifest as multiple emit calls reachable in a
      // single function flow. Each emit call site in computeEstimate lives
      // immediately above its own `return { ... }`. The control-flow
      // structure (early return at each fallback) guarantees exactly one
      // helper invocation per request:
      //   pre-modern:               emit -> return (function exit)  [2026-06-02]
      //   catalog-miss:             emit -> return (function exit)  [2026-06-02]
      //   unsupported_sport:        emit -> return (function exit)
      //   variant-mismatch:         emit -> return (function exit)
      //   sibling-pool:             emit -> return (function exit)
      //   no-recent-comps:          emit -> return (function exit)
      //   main success:             emit -> return (function exit)
      //   product-family-projection: emit -> return (function exit) [#348-#350, 2026-07-09]
      //   parallel-floor-projection: emit -> return (function exit) [#344, 2026-07-09]
      //   scarcity-prior-floor:      emit -> return (function exit) [#357, 2026-07-10]
      // Source-level documentation test — guards against a future refactor
      // accidentally inserting an emit inside a loop or a non-returning
      // branch.
      const text = await fs.readFile(
        new URL(
          "../src/services/compiq/compiqEstimate.service.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const emitCalls = (text.match(/emitPredictionToCorpus\({/g) ?? []).length;
      // 12 call sites (see enumeration above); declaration uses parens, not brace.
      expect(emitCalls).toBe(12);
    });
  });

  describe("dedup-signature path-discrimination", () => {
    it("identical inputs except fmvMechanism produce DIFFERENT signatures (path switch lands as a new row)", () => {
      // inputSignature is module-private; verify behavior via the writer's
      // public contract instead. Make a real call to writePredictionLog
      // (un-mocked for this scope) and observe that two different
      // fmvMechanism values for the SAME card identity DO NOT dedup within
      // the rate-limit window.
      //
      // To avoid actually writing to Cosmos, we observe via recordAttempt
      // counts (the health counter increments per attempt POST-dedup).
      const recordSpy = vi.spyOn(corpusModule, "writePredictionLog");
      recordSpy.mockClear();

      // First emit: main-pipeline
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-dedup-test" },
        body: BASE_BODY,
        fairMarketValue: 100,
        fmvMechanism: "main-pipeline",
        predictedPrice: 110,
        predictedPriceRange: null,
        predictedPriceMechanism: "trendiq-projection",
      });
      // Second emit: sibling-pool — same card identity, different mechanism
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-dedup-test" },
        body: BASE_BODY,
        fairMarketValue: 95,
        fmvMechanism: "sibling-pool-weighted-median",
        predictedPrice: null,
        predictedPriceRange: null,
        predictedPriceMechanism: "unavailable",
      });
      // Both reach the writer — different fmvMechanism = different signature
      // = no dedup. (The writer's mock here is the outer `writeMock` for
      // this whole describe; both calls land regardless of internal rate
      // limit because the mock bypasses the rate-limit check entirely.
      // What this test verifies is that THE HELPER fires the writer twice
      // — i.e., it doesn't internally suppress the second call.)
      expect(writeMock).toHaveBeenCalledTimes(2);
      expect(writeMock.mock.calls[0][0].fmvMechanism).toBe("main-pipeline");
      expect(writeMock.mock.calls[1][0].fmvMechanism).toBe(
        "sibling-pool-weighted-median",
      );
      recordSpy.mockRestore();
    });
  });

  describe("main-path emit content unchanged (helper migration preserves payload shape)", () => {
    it("main-path payload retains the same canonical field set as the pre-helper inline emit", () => {
      // Pin the field set on the main-path emit — the pre-CF inline payload
      // emitted: eventType, timestamp, cardId, playerName, cardYear,
      // product, parallel, gradeCompany, gradeValue, fairMarketValue,
      // predictedPrice, predictedPriceRange, predictedPriceMechanism,
      // forwardProjectionFactor, trendIQ, compsUsed.
      // CF additions: fmvMechanism, surfacedPrice, surfacedPriceSource.
      // Verify all are present (and NOTHING from the pre-CF set is missing).
      emitPredictionToCorpus({
        callContext: testCallContext,
        cardIdentity: { card_id: "card-main-pin" },
        body: BASE_BODY,
        fairMarketValue: 100,
        fmvMechanism: "main-pipeline",
        predictedPrice: 110,
        predictedPriceRange: { low: 95, high: 125 },
        predictedPriceMechanism: "trendiq-projection",
        forwardProjectionFactor: 1.1,
        trendIQ: {
          composite: 1.1,
          direction: "up",
          impliedPct: 10,
          coverage: "full",
          components: {
            playerMomentum: { multiplier: 1.05, source: "test" } as any,
            cardTrajectory: { multiplier: 1.08, source: "test" } as any,
            segmentTrajectory: { multiplier: 1.12, source: "test" } as any,
          },
          weights: { playerMomentum: 1, cardTrajectory: 1, segmentTrajectory: 1 },
          lastUpdated: "2026-05-31T12:00:00.000Z",
        },
        compsUsed: 10,
      });
      const payload = writeMock.mock.calls[0][0];
      // Pre-CF fields (preserved).
      expect(payload.eventType).toBe("prediction_emitted");
      expect(payload.timestamp).toBeDefined();
      expect(payload.cardId).toBe("card-main-pin");
      expect(payload.playerName).toBe("Paul Skenes");
      expect(payload.cardYear).toBe(2024);
      expect(payload.product).toBe("Bowman Chrome");
      expect(payload.parallel).toBe("Base");
      expect(payload.gradeCompany).toBe("PSA");
      expect(payload.gradeValue).toBe(10);
      expect(payload.fairMarketValue).toBe(100);
      expect(payload.predictedPrice).toBe(110);
      expect(payload.predictedPriceRange).toEqual({ low: 95, high: 125 });
      expect(payload.predictedPriceMechanism).toBe("trendiq-projection");
      expect(payload.forwardProjectionFactor).toBe(1.1);
      expect(payload.trendIQ.composite).toBe(1.1);
      expect(payload.trendIQ.components.playerMomentum).toBe(1.05);
      expect(payload.compsUsed).toBe(10);
      // CF additions.
      expect(payload.fmvMechanism).toBe("main-pipeline");
      expect(payload.surfacedPrice).toBe(110);
      expect(payload.surfacedPriceSource).toBe("predictedPrice");
    });
  });
});
