// PHASE-4B-SLICE-1 (2026-06-01) — fetchPlayerSignals observability.
//
// Locks every code path's structured `[compiq.signal_fetch_observed]` log
// emission. The PROOF question this resolves: is the backend actually
// calling fn-serve-signals, and when it does, what does it observe?
//
// hobbyiq-insights traces query (post-deploy verification):
//   traces
//   | where timestamp > ago(1h)
//   | where message startswith "[compiq.signal_fetch_observed]"
//   | parse message with * "outcome=" outcome:string " multiplier=" *
//   | summarize count() by outcome
//
// Outcome union (must stay in sync with SignalFetchOutcome in fetchSignals.ts):
//   not_configured | no_player | ok_neutral | ok_non_neutral
//   | aggregator_unavailable | non_ok_status | timeout | fetch_error

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Track all stdout lines for log-shape assertions.
let logs: string[] = [];
const origLog = console.log;

beforeEach(() => {
  // CF-CARDSIGHT-REMOVAL (Wave 3): cross-file isolation guard. Other suites
  // (cacheStaleServe / mlbStatsResolverGap / playerScoreLeagueLevel) enable
  // vi.useFakeTimers(); if any leaves the fake clock active in this worker,
  // both vi.resetModules()+dynamic import() below AND the SUT's
  // AbortSignal.timeout(3000) stall on the frozen clock, so the
  // not_configured short-circuit test never resolves and hits the 5000ms
  // vitest timeout. Force real timers FIRST so this file is hermetic
  // regardless of worker file ordering (exposed when sibling files were
  // deleted and the worker file distribution reshuffled).
  vi.useRealTimers();
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  // Clear env between tests; specific tests set what they need.
  delete process.env.AZURE_SIGNAL_FUNCTION_URL;
  delete process.env.AZURE_SIGNAL_FUNCTION_KEY;
  vi.resetModules();
});

afterEach(() => {
  console.log = origLog;
  vi.restoreAllMocks();
});

function observedLines(): string[] {
  return logs.filter((l) => l.startsWith("[compiq.signal_fetch_observed]"));
}

function parseOutcome(line: string): string {
  const m = line.match(/outcome=(\S+)/);
  return m?.[1] ?? "";
}
function parseMultiplier(line: string): string {
  const m = line.match(/multiplier=(\S+)/);
  return m?.[1] ?? "";
}
function parseStatus(line: string): string {
  const m = line.match(/status=(\S+)/);
  return m?.[1] ?? "";
}

describe("PHASE-4B-SLICE-1 fetchPlayerSignals observability", () => {
  describe("zero-cost outcomes (no fetch attempted)", () => {
    it("emits outcome=not_configured when AZURE_SIGNAL_FUNCTION_URL unset", async () => {
      // No URL → caller skips fetch entirely. The PROOF angle here:
      // distinguishes "env-gap" from "no playerName" — both produce
      // null but only one indicates a deployment misconfiguration.
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("Paul Skenes");
      expect(result.payload).toBeNull();
      expect(result.sourceUrl).toBeNull();
      const lines = observedLines();
      expect(lines.length).toBe(1);
      expect(parseOutcome(lines[0])).toBe("not_configured");
      expect(parseMultiplier(lines[0])).toBe("null");
      expect(parseStatus(lines[0])).toBe("null");
    });

    it("emits outcome=no_player when playerName empty (URL configured)", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("");
      expect(result.payload).toBeNull();
      expect(result.sourceUrl).toBeNull();
      const lines = observedLines();
      expect(lines.length).toBe(1);
      expect(parseOutcome(lines[0])).toBe("no_player");
    });
  });

  describe("successful fetch outcomes", () => {
    it("emits outcome=ok_neutral when aggregator returns final_multiplier === 1.0", async () => {
      // The decider: predictions where Layer 1 is present but neutral.
      // Counted distinctly from ok_non_neutral so we can answer "what
      // fraction of player-signal-having predictions are actually
      // moving away from 1.0?" — the PROOF the directive asks for.
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ final_multiplier: 1.0, signal_flags: [] }),
          { status: 200 },
        ),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("Paul Skenes");
      expect(result.payload).not.toBeNull();
      expect(result.payload?.final_multiplier).toBe(1.0);
      const lines = observedLines();
      expect(lines.length).toBe(1);
      expect(parseOutcome(lines[0])).toBe("ok_neutral");
      expect(parseMultiplier(lines[0])).toBe("1.000");
      expect(parseStatus(lines[0])).toBe("200");
      fetchSpy.mockRestore();
    });

    it("emits outcome=ok_non_neutral when aggregator returns multiplier > 1.0", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ final_multiplier: 1.27, signal_flags: ["trends_spike"] }),
          { status: 200 },
        ),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("Paul Skenes");
      expect(result.payload?.final_multiplier).toBe(1.27);
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("ok_non_neutral");
      expect(parseMultiplier(lines[0])).toBe("1.270");
      fetchSpy.mockRestore();
    });

    it("emits outcome=ok_non_neutral when aggregator returns multiplier < 1.0 (down direction)", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ final_multiplier: 0.85, signal_flags: ["news_negative"] }),
          { status: 200 },
        ),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      await fetchPlayerSignals("Paul Skenes");
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("ok_non_neutral");
      expect(parseMultiplier(lines[0])).toBe("0.850");
      fetchSpy.mockRestore();
    });

    it("re-clamps multiplier outside 0.7..1.5 and still buckets ok_non_neutral by post-clamp value", async () => {
      // Aggregator is the canonical clamp authority; we re-clamp defensively.
      // The outcome bucket reads post-clamp so a value of 0.5 → clamped 0.7 →
      // logged 0.700 → bucket ok_non_neutral. Locks behavior so a future
      // pre-clamp emit doesn't silently mis-bucket.
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ final_multiplier: 0.5, signal_flags: [] }), {
          status: 200,
        }),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("Paul Skenes");
      expect(result.payload?.final_multiplier).toBe(0.7);
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("ok_non_neutral");
      expect(parseMultiplier(lines[0])).toBe("0.700");
      fetchSpy.mockRestore();
    });
  });

  describe("failure outcomes", () => {
    it("emits outcome=aggregator_unavailable on signal_unavailable flag", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            final_multiplier: 1.0,
            signal_flags: ["signal_unavailable"],
          }),
          { status: 200 },
        ),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("Paul Skenes");
      expect(result.payload).toBeNull();
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("aggregator_unavailable");
      expect(parseStatus(lines[0])).toBe("200");
      expect(parseMultiplier(lines[0])).toBe("null");
      fetchSpy.mockRestore();
    });

    it("emits outcome=non_ok_status on HTTP 5xx", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("internal error", { status: 503 }),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("Paul Skenes");
      expect(result.payload).toBeNull();
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("non_ok_status");
      expect(parseStatus(lines[0])).toBe("503");
      fetchSpy.mockRestore();
    });

    it("emits outcome=fetch_error on generic fetch failure", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("ECONNREFUSED"),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const result = await fetchPlayerSignals("Paul Skenes");
      expect(result.payload).toBeNull();
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("fetch_error");
      expect(parseMultiplier(lines[0])).toBe("null");
      fetchSpy.mockRestore();
    });

    it("emits outcome=timeout when AbortSignal.timeout fires (TimeoutError)", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      // Synthesize a DOMException-shaped TimeoutError (Node 18+ shape).
      const timeoutErr = new Error("timed out");
      timeoutErr.name = "TimeoutError";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutErr);
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      await fetchPlayerSignals("Paul Skenes");
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("timeout");
      fetchSpy.mockRestore();
    });

    it("emits outcome=timeout for AbortError name (alias the runtime sometimes emits)", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      await fetchPlayerSignals("Paul Skenes");
      const lines = observedLines();
      expect(parseOutcome(lines[0])).toBe("timeout");
      fetchSpy.mockRestore();
    });
  });

  describe("log-shape invariants", () => {
    it("every call emits EXACTLY one observed line (no doubles, no misses)", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ final_multiplier: 1.2, signal_flags: [] }), {
          status: 200,
        }),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      await fetchPlayerSignals("Paul Skenes");
      await fetchPlayerSignals("Wyatt Langford");
      await fetchPlayerSignals("Jackson Holliday");
      expect(observedLines().length).toBe(3);
      fetchSpy.mockRestore();
    });

    it("log line format is grep-stable: known prefix + outcome + multiplier + duration_ms + status + player", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ final_multiplier: 1.1, signal_flags: [] }), {
          status: 200,
        }),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      await fetchPlayerSignals("Paul Skenes");
      const line = observedLines()[0];
      // Strict format lock — order matters because App Insights `parse`
      // operators consume tokens left-to-right.
      expect(line).toMatch(
        /^\[compiq\.signal_fetch_observed\] outcome=\S+ multiplier=\S+ duration_ms=\d+ status=\S+ player="[^"]*"$/,
      );
      fetchSpy.mockRestore();
    });

    it("player name truncates at 32 chars (bounded log line)", async () => {
      process.env.AZURE_SIGNAL_FUNCTION_URL = "https://fn-compiq.example/api/serve-signals";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ final_multiplier: 1.0, signal_flags: [] }), {
          status: 200,
        }),
      );
      const { fetchPlayerSignals } = await import(
        "../src/services/signals/fetchSignals.js"
      );
      const longName = "A".repeat(80);
      await fetchPlayerSignals(longName);
      const line = observedLines()[0];
      const playerMatch = line.match(/player="([^"]*)"/);
      expect(playerMatch?.[1].length).toBe(32);
      fetchSpy.mockRestore();
    });
  });
});
