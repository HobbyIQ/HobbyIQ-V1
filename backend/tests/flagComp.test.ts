// CF-USER-COMP-FLAG (Drew, 2026-07-26). Pins the write path semantics
// for the /flag-comp endpoint: idempotency, threshold-driven auto-flag,
// audit-trail persistence, note truncation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fake sold_comps container — reads + patches an in-memory doc so we
// can assert every state transition without hitting real Cosmos.
function fakeContainer(docState: any) {
  return {
    item(id: string, pk: string) {
      return {
        async read<T>() {
          if (docState.id !== id || docState.cardId !== pk) return { resource: undefined };
          return { resource: { ...docState } as T };
        },
        async patch(ops: Array<{ op: string; path: string; value: unknown }>) {
          for (const op of ops) {
            const field = op.path.replace(/^\//, "");
            (docState as any)[field] = op.value;
          }
          return { resource: docState };
        },
      };
    },
    // unused
    items: {},
  };
}

async function loadService() {
  vi.resetModules();
  return await import("../src/services/portfolioiq/flagComp.service.js");
}

describe("flagComp — write path", () => {
  const ORIGINAL_THRESHOLD = process.env.USER_FLAG_AUTO_FILTER_THRESHOLD;
  let docState: any;

  beforeEach(() => {
    docState = {
      id: "comp-1",
      cardId: "cs-abc",
      price: 42,
      soldAt: "2026-07-01T00:00:00Z",
    };
  });
  afterEach(() => {
    if (ORIGINAL_THRESHOLD === undefined) delete process.env.USER_FLAG_AUTO_FILTER_THRESHOLD;
    else process.env.USER_FLAG_AUTO_FILTER_THRESHOLD = ORIGINAL_THRESHOLD;
    vi.restoreAllMocks();
  });

  it("first flag from a user appends to flaggedBy + flagHistory + applies user-flagged (threshold=1)", async () => {
    // CF-COMP-FLAG-THRESHOLD-P0.2 (Drew, 2026-07-26): default is now 3 (was 1);
    // pin explicit threshold=1 to keep single-user-flag intent test.
    process.env.USER_FLAG_AUTO_FILTER_THRESHOLD = "1";
    const svc = await loadService();
    vi.spyOn(svc as any, "flagComp");
    // Wire the internal container getter via env — but simpler: mock via a spy at call
    // Because getSoldContainer is module-private, we patch the underlying pattern by
    // exposing a container we swap in via the module's own getter override. For this
    // unit-test we use a lightweight trick: replace CosmosClient.
    // Simpler approach: assert against the OUTCOME by controlling the fake container
    // through a wrapper. We inject via jest.mock-equivalent above.

    // Direct call: since flagComp reads getSoldContainer(), we mock @azure/cosmos.
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() { return { container: () => fakeContainer(docState) }; }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=stub;AccountKey=stub;";
    const fresh = await loadService();

    const r = await fresh.flagComp({
      compId: "comp-1", cardId: "cs-abc", userId: "user-A",
      reason: "wrong-price", note: "listing shows same day at 10x price",
    });

    expect(r.success).toBe(true);
    expect(r.alreadyFlaggedByYou).toBe(false);
    expect(r.totalUserFlags).toBe(1);
    expect(r.qualityFlagsApplied).toBe(true);          // threshold 1 → flagged immediately
    expect(docState.flaggedBy).toEqual(["user-A"]);
    expect(docState.flagHistory).toHaveLength(1);
    expect(docState.flagHistory[0]).toMatchObject({
      userId: "user-A",
      reason: "wrong-price",
      note: "listing shows same day at 10x price",
    });
    expect(docState.qualityFlags).toContain("user-flagged");
  });

  it("second flag from same user is idempotent — no-op, returns alreadyFlaggedByYou=true", async () => {
    process.env.USER_FLAG_AUTO_FILTER_THRESHOLD = "1";   // CF-COMP-FLAG-THRESHOLD-P0.2: default is now 3
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() { return { container: () => fakeContainer(docState) }; }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=stub;AccountKey=stub;";
    const svc = await loadService();

    await svc.flagComp({ compId: "comp-1", cardId: "cs-abc", userId: "user-A", reason: "wrong-price" });
    const r2 = await svc.flagComp({ compId: "comp-1", cardId: "cs-abc", userId: "user-A", reason: "wrong-card" });

    expect(r2.alreadyFlaggedByYou).toBe(true);
    expect(r2.totalUserFlags).toBe(1);      // count didn't go up
    expect(docState.flaggedBy).toEqual(["user-A"]);      // no duplicate
    expect(docState.flagHistory).toHaveLength(1);
  });

  it("threshold=2 → first flag stores but does NOT apply qualityFlags; second (different user) does", async () => {
    process.env.USER_FLAG_AUTO_FILTER_THRESHOLD = "2";
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() { return { container: () => fakeContainer(docState) }; }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=stub;AccountKey=stub;";
    const svc = await loadService();

    const r1 = await svc.flagComp({ compId: "comp-1", cardId: "cs-abc", userId: "user-A", reason: "wrong-price" });
    expect(r1.qualityFlagsApplied).toBe(false);
    expect(docState.qualityFlags).toBeUndefined();

    const r2 = await svc.flagComp({ compId: "comp-1", cardId: "cs-abc", userId: "user-B", reason: "wrong-card" });
    expect(r2.qualityFlagsApplied).toBe(true);
    expect(docState.qualityFlags).toContain("user-flagged");
    expect(docState.flaggedBy).toEqual(["user-A", "user-B"]);
    expect(docState.flagHistory).toHaveLength(2);
  });

  it("truncates notes to 500 chars", async () => {
    process.env.USER_FLAG_AUTO_FILTER_THRESHOLD = "1";   // CF-COMP-FLAG-THRESHOLD-P0.2: default is now 3
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() { return { container: () => fakeContainer(docState) }; }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=stub;AccountKey=stub;";
    const svc = await loadService();

    const longNote = "x".repeat(1000);
    await svc.flagComp({ compId: "comp-1", cardId: "cs-abc", userId: "user-A", reason: "other", note: longNote });
    expect(docState.flagHistory[0].note).toHaveLength(500);
  });

  it("throws when compId not found in container", async () => {
    process.env.USER_FLAG_AUTO_FILTER_THRESHOLD = "1";   // CF-COMP-FLAG-THRESHOLD-P0.2: default is now 3
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() { return { container: () => fakeContainer(docState) }; }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=stub;AccountKey=stub;";
    const svc = await loadService();

    await expect(svc.flagComp({
      compId: "does-not-exist", cardId: "cs-abc", userId: "user-A", reason: "wrong-price",
    })).rejects.toThrow(/comp not found/);
  });

  it("throws when required fields missing", async () => {
    const svc = await loadService();
    await expect(svc.flagComp({
      compId: "", cardId: "cs-abc", userId: "user-A", reason: "wrong-price",
    })).rejects.toThrow(/compId, cardId, userId all required/);
  });

  it("preserves EXISTING qualityFlags when adding user-flagged (doesn't clobber algorithmic flags)", async () => {
    process.env.USER_FLAG_AUTO_FILTER_THRESHOLD = "1";   // CF-COMP-FLAG-THRESHOLD-P0.2: default is now 3
    docState.qualityFlags = ["price-outlier"];    // pre-existing algo flag
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() { return { container: () => fakeContainer(docState) }; }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=stub;AccountKey=stub;";
    const svc = await loadService();

    await svc.flagComp({ compId: "comp-1", cardId: "cs-abc", userId: "user-A", reason: "wrong-price" });
    expect(docState.qualityFlags).toEqual(expect.arrayContaining(["price-outlier", "user-flagged"]));
    expect(docState.qualityFlags).toHaveLength(2);
  });
});
