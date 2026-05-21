import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Cross-product e2e test for telemetry sample-rate gating.
//
// Matrix (4 cells):
//   COMPIQ_CORPUS_SAMPLE_RATE × COMPIQ_COMP_LOGS_SAMPLE_RATE
//     0,0 → no writes
//     0,1 → comp_logs only
//     1,0 → corpus only
//     1,1 → both
//
// Verifies the D5 contract: each writer self-gates, and writeTelemetryEntries
// is a thin orchestrator that always invokes both writers — the actual
// gate is enforced INSIDE each writer based on its own env var.

// Hoisted Cosmos mock — single createMock spy is shared by BOTH writers
// because both go through `new CosmosClient(...).database(...).container(...)`.
const { createMock, ctorMock } = vi.hoisted(() => {
  const createMock = vi.fn().mockResolvedValue({ resource: {} });
  const containerMock = { items: { create: createMock } };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { createMock, ctorMock };
});

vi.mock("@azure/cosmos", () => ({
  CosmosClient: ctorMock,
}));

import { writeTelemetryEntries } from "../src/services/corpus/writeTelemetryEntries";
import { __writeCorpusEntryInternals } from "../src/services/corpus/writeCorpusEntry";
import { __writeCompLogInternals } from "../src/services/compLogs/writeCompLog";
import { __compLogsConfigInternals } from "../src/services/compLogs/compLogsConfig";

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function captureArgs() {
  return {
    query: "Mike Trout 2011 Topps Update",
    querySource: "free_text" as const,
    endpoint: "/api/compiq/search",
    durationMs: 142,
    result: {
      fairMarketValueLive: 1250,
      confidence: 0.85,
      engineVersion: "abc1234",
      pricingEngine: "monolith" as const,
      compsUsed: 7,
      source: "live" as const,
      recentComps: [
        { price: 1200, soldDate: new Date(Date.now() - 86400000).toISOString() },
      ],
    },
    player: "mike trout",
    cardId: "ch_abc123",
    cardIdSource: "cardhedge" as const,
    parallel: null,
    grade: "PSA 9",
    isAuto: false,
  };
}

describe("writeTelemetryEntries — cross-product sample-rate gating (PR-A1 commit 5)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    createMock.mockClear();
    ctorMock.mockClear();
    __writeCorpusEntryInternals.reset();
    __writeCompLogInternals.reset();
    __compLogsConfigInternals.resetWarningFlag();
    process.env.COSMOS_CONNECTION_STRING =
      "AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=AAAA==;";
    delete process.env.COMPIQ_CORPUS_DISABLED;
    delete process.env.COMPIQ_COMP_LOGS_DISABLED;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("00: corpus=0, comp_logs=0 → zero Cosmos writes", async () => {
    process.env.COMPIQ_CORPUS_SAMPLE_RATE = "0";
    process.env.COMPIQ_COMP_LOGS_SAMPLE_RATE = "0";
    writeTelemetryEntries(captureArgs());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(0);
  });

  it("01: corpus=0, comp_logs=1 → only comp_logs writes", async () => {
    process.env.COMPIQ_CORPUS_SAMPLE_RATE = "0";
    process.env.COMPIQ_COMP_LOGS_SAMPLE_RATE = "1";
    writeTelemetryEntries(captureArgs());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(1);
    const written = createMock.mock.calls[0][0];
    expect(written.compLogSchemaVersion).toBe(1);
    expect(written.player).toBe("mike trout");
  });

  it("10: corpus=1, comp_logs=0 → only corpus writes", async () => {
    process.env.COMPIQ_CORPUS_SAMPLE_RATE = "1";
    process.env.COMPIQ_COMP_LOGS_SAMPLE_RATE = "0";
    writeTelemetryEntries(captureArgs());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(1);
    const written = createMock.mock.calls[0][0];
    // Corpus entries do NOT have compLogSchemaVersion
    expect(written.compLogSchemaVersion).toBeUndefined();
    expect(written.query).toBe("Mike Trout 2011 Topps Update");
  });

  it("11: corpus=1, comp_logs=1 → both writers fire", async () => {
    process.env.COMPIQ_CORPUS_SAMPLE_RATE = "1";
    process.env.COMPIQ_COMP_LOGS_SAMPLE_RATE = "1";
    writeTelemetryEntries(captureArgs());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(2);
    // One call should be a corpus entry (no compLogSchemaVersion);
    // the other should be a comp_log entry (has compLogSchemaVersion=1).
    const writtenShapes = createMock.mock.calls.map((c) => c[0]);
    const hasCompLog = writtenShapes.some((e: any) => e.compLogSchemaVersion === 1);
    const hasCorpus = writtenShapes.some((e: any) => e.compLogSchemaVersion === undefined);
    expect(hasCompLog).toBe(true);
    expect(hasCorpus).toBe(true);
  });

  it("disabled flag overrides sample rate (corpus=1 but disabled=true → no write)", async () => {
    process.env.COMPIQ_CORPUS_SAMPLE_RATE = "1";
    process.env.COMPIQ_COMP_LOGS_SAMPLE_RATE = "0";
    process.env.COMPIQ_CORPUS_DISABLED = "true";
    writeTelemetryEntries(captureArgs());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(0);
  });

  it("disabled flag overrides sample rate (comp_logs=1 but disabled=true → no write)", async () => {
    process.env.COMPIQ_CORPUS_SAMPLE_RATE = "0";
    process.env.COMPIQ_COMP_LOGS_SAMPLE_RATE = "1";
    process.env.COMPIQ_COMP_LOGS_DISABLED = "true";
    writeTelemetryEntries(captureArgs());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(0);
  });
});
