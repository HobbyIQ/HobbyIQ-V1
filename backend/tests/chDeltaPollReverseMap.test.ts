// CF-CH-DELTA-POLL-REVERSE-MAP (2026-06-30) — pins the reverse-map +
// reprice trigger added in PR #213:
//
//   1. runDeltaPollCycle dedupes (card_id, grade) pairs from a batch
//      so the same card isn't repriced twice in one cycle
//   2. For each unique pair, findHoldingsByCardAndGrade returns
//      matching {userId, holdingId} tuples — those holdings get
//      repriceHoldingByDelta called
//   3. The telemetry event carries holdingsAffected + holdingsRepriced
//   4. Reverse-map failure is NON-FATAL — the checkpoint still advances
//      and the cycle reports success

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

const fetchMock = vi.fn();

vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheWrap: (_key: string, fn: () => Promise<unknown>) => fn(),
  cacheKey: (...parts: string[]) => parts.join(":"),
}));

const findMock = vi.fn();
const repriceMock = vi.fn();
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  findHoldingsByCardAndGrade: (...args: unknown[]) => findMock(...args),
  repriceHoldingByDelta: (...args: unknown[]) => repriceMock(...args),
}));

const CHECKPOINT_FILE = path.join(process.cwd(), ".data", "ch-delta-poll-checkpoint.json");

function clearCheckpoint() {
  try { fs.unlinkSync(CHECKPOINT_FILE); } catch { /* ignore */ }
}

beforeEach(() => {
  // @ts-expect-error – global fetch override
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  findMock.mockReset();
  repriceMock.mockReset();
  findMock.mockResolvedValue([]);
  repriceMock.mockResolvedValue({ repriced: true });
  process.env.CARD_HEDGE_API_KEY = "test-key";
  clearCheckpoint();
});
afterEach(() => {
  delete process.env.CARD_HEDGE_API_KEY;
  clearCheckpoint();
});

describe("CF-CH-DELTA-POLL-REVERSE-MAP — cycle wires updates → reprice", () => {
  it("dedupes (card_id, grade) pairs before the reverse-map lookup", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        updates: [
          { card_id: "c1", grade: "PSA 10", price: "100", sale_date: "2026-06-29", update_timestamp: "2026-06-30T10:00:00Z", card_desc: "x", card_set: "s", card_number: "1", player: "p", variant: "v" },
          { card_id: "c1", grade: "PSA 10", price: "105", sale_date: "2026-06-29", update_timestamp: "2026-06-30T10:30:00Z", card_desc: "x", card_set: "s", card_number: "1", player: "p", variant: "v" },
          { card_id: "c2", grade: "PSA 9",  price: "50",  sale_date: "2026-06-29", update_timestamp: "2026-06-30T11:00:00Z", card_desc: "x", card_set: "s", card_number: "2", player: "p", variant: "v" },
        ],
        count: 3,
      }),
    });
    const { runDeltaPollCycle } = await import("../src/jobs/chDeltaPoll.job.js");
    await runDeltaPollCycle(new Date("2026-06-30T12:00:00Z"));
    // 3 updates → 2 unique pairs → 2 findHoldingsByCardAndGrade calls
    expect(findMock).toHaveBeenCalledTimes(2);
    expect(findMock).toHaveBeenCalledWith("c1", "PSA 10");
    expect(findMock).toHaveBeenCalledWith("c2", "PSA 9");
  });

  it("triggers repriceHoldingByDelta for each matched holding", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        updates: [
          { card_id: "c1", grade: "PSA 10", price: "100", sale_date: "2026-06-29", update_timestamp: "2026-06-30T10:00:00Z", card_desc: "x", card_set: "s", card_number: "1", player: "p", variant: "v" },
        ],
        count: 1,
      }),
    });
    // Two users hold the same card+grade
    findMock.mockResolvedValueOnce([
      { userId: "user-A", holdingId: "h-1" },
      { userId: "user-B", holdingId: "h-2" },
    ]);
    const { runDeltaPollCycle } = await import("../src/jobs/chDeltaPoll.job.js");
    await runDeltaPollCycle(new Date("2026-06-30T12:00:00Z"));
    expect(repriceMock).toHaveBeenCalledTimes(2);
    expect(repriceMock).toHaveBeenCalledWith("user-A", "h-1");
    expect(repriceMock).toHaveBeenCalledWith("user-B", "h-2");
  });

  it("reports holdingsAffected + holdingsRepriced in the telemetry event", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        updates: [
          { card_id: "c1", grade: "PSA 10", price: "100", sale_date: "2026-06-29", update_timestamp: "2026-06-30T10:00:00Z", card_desc: "x", card_set: "s", card_number: "1", player: "p", variant: "v" },
        ],
        count: 1,
      }),
    });
    findMock.mockResolvedValueOnce([
      { userId: "user-A", holdingId: "h-1" },
      { userId: "user-B", holdingId: "h-2" },
    ]);
    // Simulate one reprice failing
    repriceMock
      .mockResolvedValueOnce({ repriced: true })
      .mockResolvedValueOnce({ repriced: false, reason: "holding_not_found" });
    const { runDeltaPollCycle } = await import("../src/jobs/chDeltaPoll.job.js");
    await runDeltaPollCycle(new Date("2026-06-30T12:00:00Z"));
    const events = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((p): p is Record<string, unknown> => p != null);
    const cycleEvent = events.find((e) => e.event === "ch_delta_poll_cycle");
    expect(cycleEvent).toBeDefined();
    expect(cycleEvent!.updatesReceived).toBe(1);
    expect(cycleEvent!.uniquePairs).toBe(1);
    expect(cycleEvent!.holdingsAffected).toBe(2);
    expect(cycleEvent!.holdingsRepriced).toBe(1);
    logSpy.mockRestore();
  });

  it("reverse-map throw is non-fatal: checkpoint still advances", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        updates: [
          { card_id: "c1", grade: "PSA 10", price: "100", sale_date: "2026-06-29", update_timestamp: "2026-06-30T11:00:00Z", card_desc: "x", card_set: "s", card_number: "1", player: "p", variant: "v" },
        ],
        count: 1,
      }),
    });
    findMock.mockRejectedValueOnce(new Error("cosmos down"));
    const { runDeltaPollCycle } = await import("../src/jobs/chDeltaPoll.job.js");
    const summary = await runDeltaPollCycle(new Date("2026-06-30T12:00:00Z"));
    expect(summary.pollSucceeded).toBe(true);
    expect(summary.newCheckpoint).toBe("2026-06-30T11:00:00Z");
    const persisted = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    expect(persisted.lastSeenUpdateTimestamp).toBe("2026-06-30T11:00:00Z");
  });

  it("zero updates → no reverse-map calls, telemetry still fires", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ updates: [], count: 0 }),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runDeltaPollCycle } = await import("../src/jobs/chDeltaPoll.job.js");
    await runDeltaPollCycle(new Date("2026-06-30T12:00:00Z"));
    expect(findMock).not.toHaveBeenCalled();
    expect(repriceMock).not.toHaveBeenCalled();
    const events = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((p): p is Record<string, unknown> => p != null);
    const ev = events.find((e) => e.event === "ch_delta_poll_cycle");
    expect(ev).toBeDefined();
    expect(ev!.updatesReceived).toBe(0);
    expect(ev!.holdingsAffected).toBe(0);
    expect(ev!.holdingsRepriced).toBe(0);
    logSpy.mockRestore();
  });
});
