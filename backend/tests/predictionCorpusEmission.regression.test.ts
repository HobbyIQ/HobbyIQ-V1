// CF-PREDICTION-CORPUS STEP 2 — regression test.
//
// Purpose: confirm `[compiq.prediction_emitted]` stdout emission shape is
// IDENTICAL across the dual-emit transition (STEP 1 added cardsightCardId;
// STEP 2 adds the Cosmos writer alongside but the stdout shape MUST stay
// stable for the burn-in week per methodology §2.4).
//
// Also confirms the corpus writer receives the SAME in-memory emit object
// as the stdout serializes — verifies the "no shape drift between dual
// emitters" invariant.
//
// Mock strategy mirrors compiqEstimate.test.ts:1-100 — vi.mock the
// cardsight.router so computeEstimate runs end-to-end without external
// network. vi.mock the predictionCorpus.service so we can spy on the
// writer call without hitting Cosmos.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Cosmos writer — capture calls; never touch Cosmos in tests.
// Only the symbols actually exported from predictionCorpus.service.js are
// mocked here; DIRECTION_BAND_PCT + derivePredictionDirection live in the
// neutral predictionConstants module and don't need mocking for this test.
vi.mock("../src/services/compiq/predictionCorpus.service.js", async () => {
  const writePredictionLog = vi.fn();
  return {
    writePredictionLog,
    UNRESOLVED_CARDID_SENTINEL: "__unresolved__",
  };
});

// Mock cardsight.router so computeEstimate runs end-to-end without network.
// Minimal happy-path mocks; payload values chosen so the prediction path
// reaches the emission site at compiqEstimate.service.ts:~2715.
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const now = Date.now();
  const sales = Array.from({ length: 8 }, (_, i) => ({
    price: 100 + i * 5,
    date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
    grade: "PSA 10",
    source: "cardsight",
    sale_type: "auction",
    title: "2018 Topps Chrome Shohei Ohtani #150 PSA 10",
    url: null,
  }));
  return {
    ...actual,
    findCompsRouted: vi.fn(async () => ({
      card: {
        card_id: "ohtani-base-uuid",
        title: "2018 Topps Chrome Shohei Ohtani #150 PSA 10",
        player: "Shohei Ohtani",
        set: "Topps Chrome",
        year: 2018,
        number: "150",
        variant: "Base",
      },
      sales,
      variantWarning: [],
      aiCategory: "Baseball",
    })),
    getCardSalesRouted: vi.fn(async () => sales),
    searchCardsRouted: vi.fn(async () => [
      {
        card_id: "ohtani-base-uuid",
        title: "2018 Topps Chrome Shohei Ohtani #150 PSA 10",
        player: "Shohei Ohtani",
      },
    ]),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import { writePredictionLog } from "../src/services/compiq/predictionCorpus.service.js";

// ─── Expected stable key set ───────────────────────────────────────────────
//
// Locked at STEP 2 ship. Any future change to this key set is a wire-shape
// change that downstream consumers (App Insights KQL queries, the corpus
// writer schema) depend on. Adding/removing keys requires a coordinated
// schema update across the emission site, the corpus writer's
// PredictionEmitInput type, and any KQL parsing references.

const EXPECTED_TOP_LEVEL_KEYS = [
  "eventType",
  "timestamp",
  "cardsightCardId",   // added STEP 1
  "playerName",
  "cardYear",
  "product",
  "parallel",
  "gradeCompany",
  "gradeValue",
  "fairMarketValue",
  "predictedPrice",
  "predictedPriceRange",
  "predictedPriceMechanism",
  "forwardProjectionFactor",
  "trendIQ",
  "compsUsed",
  // CF-PREDICTION-CORPUS-EMISSION-COVERAGE (2026-05-31): three new fields
  // landed on the canonical payload — fmvMechanism (FMV-mechanism axis),
  // surfacedPrice (the headline value the user saw on the wire), and
  // surfacedPriceSource (predictedPrice vs fairMarketValue vs none).
  // Documented in prediction_credibility_methodology_2026-05-30.md §2.2.
  "fmvMechanism",
  "surfacedPrice",
  "surfacedPriceSource",
  // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): four attribution
  // fields landed flat on the payload. Methodology §2.2 amended for the
  // join-key role: routedFromHolding=true → PortfolioLedgerEntry-join
  // via holdingId+userId; routedFromHolding=false → eBay-sold
  // cardsightCardId-join. source is the closed PredictionCorpusSource
  // literal union — tsc enforces every caller supplies a documented value.
  "source",
  "userId",
  "holdingId",
  "routedFromHolding",
] as const;

const EXPECTED_TRENDIQ_KEYS = [
  "composite",
  "direction",
  "coverage",
  "components",
  // PHASE-4B-SLICE-1 (2026-06-01): TrendIQResult.weights now passes
  // through the emit shape so the buildDocument layer can hoist
  // trendIQ_weights to a flat corpus field for query-axis clarity.
  // The nested struct still carries the full weight matrix.
  "weights",
  "lastUpdated",
] as const;

const EXPECTED_TRENDIQ_COMPONENT_KEYS = [
  "playerMomentum",
  "cardTrajectory",
  "segmentTrajectory",
] as const;

beforeAll(() => {
  process.env.CARD_HEDGE_API_KEY = "test-key";
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CF-PREDICTION-CORPUS STEP 2 — prediction_emitted stdout shape regression", () => {
  it("emits exactly one [compiq.prediction_emitted] line with the locked key set", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await computeEstimate({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      parallel: "Base",
      gradeCompany: "PSA",
      gradeValue: 10,
    } as any, testCallContext);

    // Find the prediction_emitted log line (other logs may also fire).
    const predictionLogCalls = consoleLogSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === "string" && first.startsWith("[compiq.prediction_emitted] ");
    });
    expect(
      predictionLogCalls.length,
      "expected exactly one [compiq.prediction_emitted] log line",
    ).toBe(1);

    // Parse the JSON payload after the "[compiq.prediction_emitted] " prefix.
    const logLine = predictionLogCalls[0][0] as string;
    const jsonStart = logLine.indexOf("{");
    expect(jsonStart, "log line must contain JSON payload").toBeGreaterThan(-1);
    const payload = JSON.parse(logLine.slice(jsonStart));

    // Top-level shape lock.
    const topLevelKeys = Object.keys(payload).sort();
    expect(topLevelKeys).toEqual([...EXPECTED_TOP_LEVEL_KEYS].sort());

    // eventType discriminator.
    expect(payload.eventType).toBe("prediction_emitted");

    // cardsightCardId resolved from mock (verifies STEP 1 cardId emission).
    expect(payload.cardsightCardId).toBe("ohtani-base-uuid");

    // trendIQ sub-shape lock.
    expect(payload.trendIQ).toBeTypeOf("object");
    expect(payload.trendIQ).not.toBeNull();
    expect(Object.keys(payload.trendIQ).sort()).toEqual(
      [...EXPECTED_TRENDIQ_KEYS].sort(),
    );

    // trendIQ.components sub-sub-shape lock.
    expect(payload.trendIQ.components).toBeTypeOf("object");
    expect(payload.trendIQ.components).not.toBeNull();
    expect(Object.keys(payload.trendIQ.components).sort()).toEqual(
      [...EXPECTED_TRENDIQ_COMPONENT_KEYS].sort(),
    );

    consoleLogSpy.mockRestore();
  });

  it("calls writePredictionLog with the SAME object the stdout serializes (no shape drift between dual emitters)", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await computeEstimate({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      parallel: "Base",
      gradeCompany: "PSA",
      gradeValue: 10,
    } as any, testCallContext);

    // The corpus writer was called exactly once.
    expect((writePredictionLog as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    const corpusArg = (writePredictionLog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;

    // Extract the stdout payload (same find pattern as above).
    const predictionLogCalls = consoleLogSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === "string" && first.startsWith("[compiq.prediction_emitted] ");
    });
    expect(predictionLogCalls.length).toBe(1);
    const logLine = predictionLogCalls[0][0] as string;
    const stdoutPayload = JSON.parse(logLine.slice(logLine.indexOf("{")));

    // The two emissions share the EXACT same object — every key on the
    // stdout payload must also be on the corpus arg, identical value
    // (mod the eventType field which is a stdout-only discriminator).
    for (const k of EXPECTED_TOP_LEVEL_KEYS) {
      expect(corpusArg[k]).toEqual(stdoutPayload[k]);
    }

    consoleLogSpy.mockRestore();
  });
});
