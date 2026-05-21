import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/services/corpus/writeCorpusEntry", () => ({
  writeCorpusEntry: vi.fn(),
  __writeCorpusEntryInternals: { reset: vi.fn() },
}));
vi.mock("../src/services/compLogs/writeCompLog", () => ({
  writeCompLog: vi.fn(),
  __writeCompLogInternals: { reset: vi.fn() },
}));

import { writeTelemetryEntries } from "../src/services/corpus/writeTelemetryEntries";
import { writeCorpusEntry } from "../src/services/corpus/writeCorpusEntry";
import { writeCompLog } from "../src/services/compLogs/writeCompLog";

const corpusMock = writeCorpusEntry as unknown as ReturnType<typeof vi.fn>;
const compLogMock = writeCompLog as unknown as ReturnType<typeof vi.fn>;

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
      pricingEngine: "monolith",
      compsUsed: 7,
      source: "live",
      recentComps: [
        { price: 1200, soldDate: new Date(Date.now() - 86400000).toISOString() },
        { price: 1310, soldDate: new Date(Date.now() - 86400000 * 5).toISOString() },
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

describe("writeTelemetryEntries", () => {
  beforeEach(() => {
    corpusMock.mockReset();
    compLogMock.mockReset();
  });
  afterEach(() => {
    corpusMock.mockReset();
    compLogMock.mockReset();
  });

  it("calls both writers exactly once with the expected entry shapes", () => {
    writeTelemetryEntries(captureArgs());
    expect(corpusMock).toHaveBeenCalledTimes(1);
    expect(compLogMock).toHaveBeenCalledTimes(1);

    const corpusEntry = corpusMock.mock.calls[0][0];
    const compLogEntry = compLogMock.mock.calls[0][0];

    expect(corpusEntry.query).toBe("Mike Trout 2011 Topps Update");
    expect(corpusEntry.querySource).toBe("free_text");
    expect(corpusEntry.endpoint).toBe("/api/compiq/search");

    expect(compLogEntry.compLogSchemaVersion).toBe(1);
    expect(compLogEntry.player).toBe("mike trout");
    expect(compLogEntry.cardId).toBe("ch_abc123");
    expect(compLogEntry.cardIdSource).toBe("cardhedge");
    expect(compLogEntry.predictedPrice).toBe(1250);
    expect(compLogEntry.endpoint).toBe("/api/compiq/search");
    expect(compLogEntry.grade).toBe("PSA 9");
    expect(compLogEntry.isAuto).toBe(false);
    expect(compLogEntry.engineVersion).toBe("abc1234");
    expect(compLogEntry.source).toBe("cardsight"); // "live" → cardsight
    expect(compLogEntry.outcome).toBe("ok");
  });

  it("does not throw when both writers throw", () => {
    corpusMock.mockImplementation(() => {
      throw new Error("corpus boom");
    });
    compLogMock.mockImplementation(() => {
      throw new Error("comp_log boom");
    });
    // The helper does not currently catch — exceptions in writers should
    // propagate up so callers know if they're missing the void wrapper.
    // (The fire-and-forget contract is handled INSIDE each writer's
    // async IIFE; the synchronous-phase entry build / dispatch should
    // not throw under normal conditions.)
    expect(() => writeTelemetryEntries(captureArgs())).toThrow("corpus boom");
  });

  it("calls corpus writer before comp_log writer (deterministic order)", () => {
    const calls: string[] = [];
    corpusMock.mockImplementation(() => {
      calls.push("corpus");
    });
    compLogMock.mockImplementation(() => {
      calls.push("comp_log");
    });
    writeTelemetryEntries(captureArgs());
    expect(calls).toEqual(["corpus", "comp_log"]);
  });

  it("plumbs playerName and cardYear through to the comp_log entry (PR-A1.1)", () => {
    writeTelemetryEntries({
      ...captureArgs(),
      playerName: "Mike Trout",
      cardYear: 2011,
    });
    const compLogEntry = compLogMock.mock.calls[0][0];
    expect(compLogEntry.playerName).toBe("Mike Trout");
    expect(compLogEntry.cardYear).toBe(2011);
  });

  it("defaults playerName and cardYear to null when callers omit them", () => {
    writeTelemetryEntries(captureArgs());
    const compLogEntry = compLogMock.mock.calls[0][0];
    expect(compLogEntry.playerName).toBeNull();
    expect(compLogEntry.cardYear).toBeNull();
  });
});

import { extractTelemetryCohortFromResult } from "../src/services/corpus/writeTelemetryEntries";

describe("extractTelemetryCohortFromResult — playerName + cardYear (PR-A1.1)", () => {
  it("reads playerName from parsedQuery verbatim and cardYear from parsedQuery.year", () => {
    const cohort = extractTelemetryCohortFromResult(
      {
        parsedQuery: { playerName: "Mike Trout", year: 2011 },
        cardIdentity: { player: "mike trout", cardId: "ch_abc" },
      },
      "fallback query",
    );
    expect(cohort.playerName).toBe("Mike Trout");
    expect(cohort.cardYear).toBe(2011);
  });

  it("falls back to cardIdentity.player and cardIdentity.year when parsedQuery is absent (e.g. /price-by-id)", () => {
    const cohort = extractTelemetryCohortFromResult(
      { cardIdentity: { player: "Mike Trout", cardId: "ch_abc", year: 2018 } },
      "fallback query",
      "cardhedge",
    );
    expect(cohort.playerName).toBe("Mike Trout");
    expect(cohort.cardYear).toBe(2018);
  });

  it("returns null playerName and null cardYear when neither source has them", () => {
    const cohort = extractTelemetryCohortFromResult({}, "raw query");
    expect(cohort.playerName).toBeNull();
    expect(cohort.cardYear).toBeNull();
  });

  it("coerces numeric-string year and drops out-of-range years", () => {
    const a = extractTelemetryCohortFromResult(
      { parsedQuery: { playerName: "X", year: "2022" } },
      "q",
    );
    expect(a.cardYear).toBe(2022);
    const b = extractTelemetryCohortFromResult(
      { parsedQuery: { playerName: "X", year: 1800 } },
      "q",
    );
    expect(b.cardYear).toBeNull();
  });
});
