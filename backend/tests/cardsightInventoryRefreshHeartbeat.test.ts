// CF-OPS-HARDENING-1b (2026-06-04): heartbeat consistency pin.
//
// The per-job heartbeat-missing alert pattern-matches `[<jobName>] done`
// across all 8 schedulers. cardsightInventoryRefresh.job previously emitted
// "refresh complete" on success — out of pattern. This test guards the
// standardized `[cardsightInventoryRefresh.job] done` line so a future
// refactor can't silently break the alert query.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/cardsight/identifiableSetCache.service.js", () => ({
  refreshIdentifiableSetInventory: vi.fn(async () => ({
    totalCount: 1234,
    pagesFetched: 5,
    durationMs: 1500,
  })),
}));

describe("cardsightInventoryRefresh.job heartbeat", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("emits a `[cardsightInventoryRefresh.job] done` line on successful run", async () => {
    const { runInventoryRefreshJob } = await import(
      "../src/jobs/cardsightInventoryRefresh.job"
    );
    await runInventoryRefreshJob();

    const lines = logSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const heartbeat = lines.find((l) =>
      l.includes("[cardsightInventoryRefresh.job] done"),
    );
    expect(
      heartbeat,
      "expected a [cardsightInventoryRefresh.job] done line; got: " + JSON.stringify(lines),
    ).toBeDefined();
    // Diagnostic detail is preserved alongside the `done` keyword.
    expect(heartbeat).toMatch(/total=1234/);
    expect(heartbeat).toMatch(/pages=5/);
  });
});
