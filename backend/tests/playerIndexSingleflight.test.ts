/**
 * CF-ONE-COSMOS-CLIENT-ON-THE-PRICE-PATH (Fable, 2026-09-15) — the
 * singleflight half.
 *
 * playerIndex.service memoises readPlayerPoolRows for 5 minutes per
 * (player, sport, as-of). The memo is populated AFTER the read resolves, so it
 * de-duplicated nothing while the read was still in flight — and that window
 * is the one that matters. The read underneath is
 * playerIndexRead.readPlayerPoolRows: a cross-partition
 * "TOP 2000 ... ORDER BY c.soldAt DESC" over sold_comps filtered on
 * LOWER(c.playerName), which is not index-servable and is the most expensive
 * read on the price path.
 *
 * On a cold key, every concurrent request for the same star player therefore
 * issued its OWN copy: a stampede that makes the pool slower, which widens the
 * window, which admits more of the stampede. These pins hold the fix — one
 * read per key no matter how many callers arrive together — and its two edges:
 * a rejected read must not be cached as in-flight, and a distinct key must
 * still get its own read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readPlayerPoolRows = vi.fn();
vi.mock("../src/services/compiq/playerIndexRead.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, readPlayerPoolRows };
});

const { playerIndexRatio, _clearPlayerIndexMemo, _playerIndexInFlightCount } =
  await import("../src/services/compiq/playerIndex.service.js");

/** A resolver we control, so the in-flight window is as wide as the test needs. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const NOW = Date.parse("2026-09-15T00:00:00.000Z");
const ratio = (playerName: string) =>
  playerIndexRatio({
    playerName,
    sport: "baseball",
    nowMs: NOW,
    anchorMs: NOW - 30 * 86_400_000,
    targetValue: 100,
  });

beforeEach(() => {
  _clearPlayerIndexMemo();
  readPlayerPoolRows.mockReset();
});

describe("concurrent cold reads for one player share a single query", () => {
  it("issues ONE pool read for five simultaneous callers", async () => {
    const gate = deferred<unknown[]>();
    readPlayerPoolRows.mockReturnValue(gate.promise);

    const inflight = [ratio("Shohei Ohtani"), ratio("Shohei Ohtani"), ratio("Shohei Ohtani"),
                      ratio("Shohei Ohtani"), ratio("Shohei Ohtani")];

    // All five are parked on the same promise before any of them resolves.
    expect(_playerIndexInFlightCount()).toBe(1);

    gate.resolve([]);
    await Promise.all(inflight);

    // MUTATION CHECK: without the in-flight map this is 5 — five copies of a
    // cross-partition TOP 2000 scan for the identical question.
    expect(readPlayerPoolRows).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight entry once the read settles", async () => {
    readPlayerPoolRows.mockResolvedValue([]);

    await ratio("Shohei Ohtani");

    // A leaked entry would serve one request's rows forever, past the memo TTL
    // and past any correction to the pool.
    expect(_playerIndexInFlightCount()).toBe(0);
  });

  it("does not cache a REJECTED read — the next caller retries", async () => {
    readPlayerPoolRows.mockRejectedValueOnce(new Error("429 throttled"));
    readPlayerPoolRows.mockResolvedValueOnce([]);

    await ratio("Shohei Ohtani");
    expect(_playerIndexInFlightCount()).toBe(0);

    await ratio("Shohei Ohtani");

    // Two reads, because the first one FAILED. Caching a rejected promise
    // would pin the failure for the life of the process.
    expect(readPlayerPoolRows).toHaveBeenCalledTimes(2);
  });

  it("keys the flight per player — two players are two reads", async () => {
    const a = deferred<unknown[]>();
    const b = deferred<unknown[]>();
    readPlayerPoolRows.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const pending = [ratio("Shohei Ohtani"), ratio("Paul Skenes")];
    expect(_playerIndexInFlightCount()).toBe(2);

    a.resolve([]); b.resolve([]);
    await Promise.all(pending);

    // MUTATION CHECK: a singleflight keyed on anything coarser than the memo
    // key would serve one player's basket to another — silently wrong FMV,
    // which is far worse than the stampede it was fixing.
    expect(readPlayerPoolRows).toHaveBeenCalledTimes(2);
  });
});
