import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Cosmos mock — vi.mock is hoisted to the top of the file, so the
// factory's referenced variables must also be hoisted. vi.hoisted()
// runs before any top-level const/let, so the factory can safely close
// over these mocks.
const { createMock, ctorMock } = vi.hoisted(() => {
  const createMock = vi.fn();
  const containerMock = { items: { create: createMock } };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  // Must be a real constructor function — vitest 4 warns and breaks
  // `new CosmosClient(...)` if the mock is just an arrow returning an
  // object. Wrap as a function declaration.
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { createMock, ctorMock };
});

vi.mock("@azure/cosmos", () => ({
  CosmosClient: ctorMock,
}));

import {
  writeCorpusEntry,
  __writeCorpusEntryInternals,
} from "../src/services/corpus/writeCorpusEntry";
import { __corpusConfigInternals } from "../src/services/corpus/corpusConfig";
import type { CorpusEntry } from "../src/models/corpusEntry";

// Helper: wait one macrotask so the fire-and-forget IIFE can run to
// completion (including its inner await and try/catch).
const flushMicrotasks = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeEntry(): CorpusEntry {
  return {
    corpusEntrySchemaVersion: 2,
    capturedAt: "2026-05-14T17:40:00.000Z",
    query: "Mike Trout 2011 Topps Update US175",
    querySource: "free_text",
    endpoint: "/api/compiq/search",
    responseDurationMs: 100,
    response: {
      fairMarketValueLive: 1250,
      confidence: 0.9,
      pricingEngine: "monolith",
      engineVersion: "4f14338",
      marketState: null,
      marketStateSchemaVersion: 0,
      sampleSize: 25,
    },
  };
}

const ENV_DISABLED = "COMPIQ_CORPUS_DISABLED";
const ENV_RATE = "COMPIQ_CORPUS_SAMPLE_RATE";
const ENV_COSMOS = "COSMOS_CONNECTION_STRING";

function clearEnv() {
  delete process.env[ENV_DISABLED];
  delete process.env[ENV_RATE];
  delete process.env[ENV_COSMOS];
}

describe("writeCorpusEntry — gating", () => {
  beforeEach(() => {
    clearEnv();
    createMock.mockReset();
    ctorMock.mockClear();
    __writeCorpusEntryInternals.reset();
    __corpusConfigInternals.resetWarningFlag();
  });
  afterEach(() => clearEnv());

  it("short-circuits when COMPIQ_CORPUS_DISABLED=1 (no PRNG, no client init)", async () => {
    process.env[ENV_DISABLED] = "1";
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    writeCorpusEntry(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it("does not write when sample rate is unset (defaults to 0)", async () => {
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    writeCorpusEntry(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not write when sample rate is 0", async () => {
    process.env[ENV_RATE] = "0";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    writeCorpusEntry(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("always writes when sample rate is 1", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockResolvedValue({});
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("passes the full entry verbatim to Cosmos items.create", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockResolvedValue({});
    const entry = makeEntry();
    writeCorpusEntry(entry);
    await flushMicrotasks();
    expect(createMock).toHaveBeenCalledWith(entry);
  });

  it("respects sample rate probabilistically (0 of 100 writes when rate=0)", async () => {
    process.env[ENV_RATE] = "0";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    for (let i = 0; i < 100; i++) writeCorpusEntry(makeEntry());
    await flushMicrotasks();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("writeCorpusEntry — error handling", () => {
  beforeEach(() => {
    clearEnv();
    createMock.mockReset();
    ctorMock.mockClear();
    __writeCorpusEntryInternals.reset();
    __corpusConfigInternals.resetWarningFlag();
  });
  afterEach(() => clearEnv());

  it("does not throw or produce an unhandled rejection when the client throws", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockRejectedValue(new Error("simulated Cosmos failure"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Should return synchronously without throwing.
    expect(() => writeCorpusEntry(makeEntry())).not.toThrow();
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("rate-limits error logs to one per minute", async () => {
    process.env[ENV_RATE] = "1";
    process.env[ENV_COSMOS] = "AccountEndpoint=https://x;AccountKey=y;";
    createMock.mockRejectedValue(new Error("err"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("logs once when COSMOS_CONNECTION_STRING is unset, then stays silent", async () => {
    process.env[ENV_RATE] = "1";
    // No COSMOS_CONNECTION_STRING set.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    writeCorpusEntry(makeEntry());
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
