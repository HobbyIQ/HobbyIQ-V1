/**
 * CF-INVARIANT-BEFORE-CACHE (2026-08-22).
 *
 * canonicalize() answered the same question two different ways depending on
 * whether it had been asked before:
 *
 *   call 1  cache miss -> compute -> cache{found} -> invariant rejects -> not-found
 *   call 2  cache hit  -> return cache{found}, invariant never runs -> FOUND
 *
 * The cache was written BEFORE the parallel invariant ran, and a cache hit
 * returned early, above the invariant entirely. So the first caller got the
 * rejection and every caller for the next 10 minutes got the match that had
 * just been thrown away.
 *
 * This is the same shape as #1177-#1180: a guard that is correct in isolation
 * but runs on only one of the paths the value can travel. It hid well, because
 * a rejection is indistinguishable from "no such card" at the call site.
 *
 * Found on Andrew Fischer #CPA-AF ($140.82). Asked with NO parallel, the
 * matcher computes the slug `…:cpa-af:refractor:auto` — our own slug builder
 * supplies "refractor" — finds that row at exact/0.98, and the invariant then
 * rejects it because "refractor" is not the nothing that was asked for.
 * Called once: not-found. Called twice in one process: FOUND.
 *
 * The property under test is determinism: the same input must produce the same
 * answer, whatever the cache happens to hold. These tests fail against the
 * pre-fix ordering — the second call returns found:true.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { readMock, queryMock, ctorMock } = vi.hoisted(() => {
  const readMock = vi.fn();
  const queryMock = vi.fn(() => ({ fetchAll: async () => ({ resources: [] }) }));
  const containerMock = {
    item: vi.fn((id: string) => ({ read: () => readMock(id) })),
    items: { query: queryMock, upsert: vi.fn() },
  };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { readMock, queryMock, ctorMock };
});

vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

import {
  canonicalize,
  clearCatalogMatchCache,
} from "../src/services/catalog/catalogMatcher.service.js";

/** Andrew Fischer's real shape: a prospect auto asked for with no parallel. */
const FISCHER = {
  sport: "baseball",
  year: 2026,
  setName: "Bowman Chrome",
  cardNumber: "CPA-AF",
  parallel: null,
  isAuto: true,
  player: "Andrew Fischer",
  source: "unknown" as const,
};

beforeEach(() => {
  clearCatalogMatchCache();
  readMock.mockReset();
  // Step 1 is an exact read on the slug we ourselves computed, so "the row
  // exists" is the realistic case — that is how Fischer produced exact/0.98.
  readMock.mockImplementation(async (id: string) => ({ resource: { id } }));
});

describe("canonicalize — the invariant must not be cache-dependent", () => {
  it("returns the SAME answer on the second call as on the first", async () => {
    const first = await canonicalize({ ...FISCHER });
    const second = await canonicalize({ ...FISCHER });

    // The precise verdict is asserted below; this is the determinism property
    // on its own, and it is what the old ordering broke.
    expect(second.found).toBe(first.found);
    expect(second.matchedBy).toBe(first.matchedBy);
    expect(second.confidence).toBe(first.confidence);
  });

  it("rejects the mismatched parallel on BOTH calls, not just the first", async () => {
    const first = await canonicalize({ ...FISCHER });
    const second = await canonicalize({ ...FISCHER });

    // Direction matters: asked for no parallel, offered a Refractor. Absent
    // beats wrong, and it has to stay absent on the repeat call.
    expect(first.found).toBe(false);
    expect(first.matchedBy).toBe("not-found");
    expect(second.found).toBe(false);
    expect(second.matchedBy).toBe("not-found");
  });

  it("still caches — the second call does not re-read Cosmos", async () => {
    await canonicalize({ ...FISCHER });
    const readsAfterFirst = readMock.mock.calls.length;
    await canonicalize({ ...FISCHER });

    // Caching the REJECTION is the point. If this ever regresses to zero
    // caching the fix has been paid for with an extra round trip per call.
    expect(readMock.mock.calls.length).toBe(readsAfterFirst);
  });

  it("does not turn every match into a rejection — an agreeing parallel survives twice", async () => {
    const agreeing = { ...FISCHER, parallel: "Refractor" };
    const first = await canonicalize(agreeing);
    const second = await canonicalize(agreeing);

    // Guards against "fixed" by making the invariant reject everything: when
    // the asked parallel matches the slug's, the match must be adopted, and
    // must still be adopted on the cached path.
    expect(first.found).toBe(true);
    expect(first.matchedBy).toBe("exact");
    expect(second.found).toBe(true);
    expect(second.matchedBy).toBe("exact");
  });
});
