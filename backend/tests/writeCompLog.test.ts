import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Cosmos mock — vi.mock is hoisted; vi.hoisted() runs before any
// top-level const/let so the factory can safely close over these
// mocks. Mirrors the writeCorpusEntry.test.ts hoist pattern.
const { createMock, ctorMock } = vi.hoisted(() => {
  const createMock = vi.fn();
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

import {
  writeCompLog,
  __writeCompLogInternals,
} from "../src/services/compLogs/writeCompLog";
import { __compLogsConfigInternals } from "../src/services/compLogs/compLogsConfig";
import type { CompLogEntry } from "../src/models/compLogEntry";

const flushMicrotasks = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeEntry(): CompLogEntry {
  return {
    compLogSchemaVersion: 1,
    player: "mike trout",
    timestamp: 1716336000000,
    latency_ms: 142,
    endpoint: "/api/compiq/search",
    cardId: "ch_abc123",
    query: "Mike Trout 2011 Topps Update US175",
    cardIdSource: "cardhedge",
    predictedPrice: 1250,
    comps: [
      { price: 1200, soldDate: "2026-05-15" },
      { price: 1310, soldDate: "2026-05-12" },
    ],
    confidence: 0.85,
    source: "fallback",
    sourceDetail: "live",
    outcome: "ok",
    engineVersion: "abc1234",
    parallel: null,
    grade: "PSA 9",
    isAuto: false,
    w7Count: 2,
    w14Count: 2,
    w30Count: 2,
    w7Avg: 1255,
    w14Avg: 1255,
    w30Avg: 1255,
  };
}

const ENV_DISABLED = "COMPIQ_COMP_LOGS_DISABLED";
const ENV_RATE = "COMPIQ_COMP_LOGS_SAMPLE_RATE";
const ENV_COSMOS = "COSMOS_CONNECTION_STRING";

function clearEnv() {
  delete process.env[ENV_DISABLED];
  delete process.env[ENV_RATE];
  delete process.env[ENV_COSMOS];
}

describe("writeCompLog — gating", () => {
  beforeEach(() => {
    clearEnv();
    createMock.mockReset();
    ctorMock.mockClear();
    __writeCompLogInternals.reset();
    __compLogsConfigInternals.resetWarningFlag();
  });
  afterEach(() => clearEnv());

  it("short-circuits when COMPIQ_COMP_LOGS_DISABLED=1 (no PRNG, no client init)", async () => {
    process.env[ENV_DISABLED] = "1";
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it("does not write when sample rate is unset (defaults to 0)", async () => {
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not write when sample rate is 0", async () => {
    process.env[ENV_RATE] = "0";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("always writes when sample rate is 1", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockResolvedValue({});
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("passes the full entry verbatim to Cosmos items.create", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockResolvedValue({});
    const entry = makeEntry();
    writeCompLog(entry);
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledWith(entry);
  });

  it("does not write when sample rate is 0 across many calls", async () => {
    process.env[ENV_RATE] = "0";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    for (let i = 0; i < 100; i++) writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("respects an intermediate sample rate via Math.random", async () => {
    process.env[ENV_RATE] = "0.5";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockResolvedValue({});
    // Force Math.random to alternate < 0.5 then >= 0.5.
    const values = [0.1, 0.9, 0.1, 0.9];
    let i = 0;
    const rng = vi.spyOn(Math, "random").mockImplementation(() => values[i++ % values.length]);
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(2);
    rng.mockRestore();
  });
});

describe("writeCompLog — error handling", () => {
  beforeEach(() => {
    clearEnv();
    createMock.mockReset();
    ctorMock.mockClear();
    __writeCompLogInternals.reset();
    __compLogsConfigInternals.resetWarningFlag();
  });
  afterEach(() => clearEnv());

  it("does not throw or produce an unhandled rejection when the client throws", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockRejectedValue(new Error("simulated Cosmos failure"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => writeCompLog(makeEntry())).not.toThrow();
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rate-limits error logs to one per minute", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockRejectedValue(new Error("err"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("logs once when COSMOS_CONNECTION_STRING is unset, then stays silent", async () => {
    process.env[ENV_RATE] = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    writeCompLog(makeEntry());
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
