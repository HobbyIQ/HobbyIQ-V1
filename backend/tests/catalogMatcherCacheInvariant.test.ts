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

  // UPDATED 2026-08-23 by CF-BASE-IS-NOT-A-REFRACTOR.
  //
  // This case used to assert not-found on both calls. Read the file header: the
  // reason Fischer was rejected at all is that "our own slug builder supplies
  // 'refractor'" — CF-CHROME-AUTO-BASE-IS-REFRACTOR rewrote a Base ask into a
  // refractor slug, and the invariant then correctly refused a Refractor for a
  // caller who asked for no parallel.
  //
  // That rule is removed (Drew: "base is a refractor is wrong"), so the slug
  // builder no longer contradicts the caller: a no-parallel CPA auto computes a
  // BASE slug and matching it is right. Fischer's $140.82 card stops returning
  // not-found.
  //
  // The determinism property this file exists for is unchanged and still
  // asserted — on both calls, and by the deliberate-mismatch case below.
  it("matches a no-parallel auto to its BASE slug, identically on both calls", async () => {
    const first = await canonicalize({ ...FISCHER });
    const second = await canonicalize({ ...FISCHER });

    expect(first.found).toBe(true);
    expect(first.slug).toContain(":cpa-af:base:auto");
    expect(first.slug).not.toContain(":refractor:");
    expect(second.found).toBe(first.found);
    expect(second.slug).toBe(first.slug);
    expect(second.matchedBy).toBe(first.matchedBy);
  });

  // NOTE ON COVERAGE (2026-08-23). This file no longer exercises the parallel
  // invariant's REJECTION branch, and that is a consequence of the fix rather
  // than a gap opened by it: step 1 reads the slug canonicalize computed from
  // the caller's own input, so once the slug builder stopped rewriting Base to
  // Refractor, the asked and matched parallels agree by construction here. A
  // rejection can now only come from the query-driven fuzzy/family steps, which
  // this file deliberately mocks as empty to isolate the cache ordering.
  //
  // The rejection branch is covered by parallelIsIdentity.test.ts, which drives
  // those steps directly. Rather than mock a mismatch into this file — which
  // would pass for a reason unrelated to what the file is about — the coverage
  // is left where it belongs.

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
