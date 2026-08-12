// CF-CATALOG-SEED-QUEUE. A verify miss becomes exactly one work order per
// release, carrying a demand count — so the sets users actually hold get
// their checklists built first, and a thousand misses don't become a
// thousand jobs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { upsertMock, readMock, ctorMock } = vi.hoisted(() => {
  const upsertMock = vi.fn();
  const readMock = vi.fn();
  const containerMock = {
    items: { upsert: upsertMock, query: vi.fn() },
    item: vi.fn(() => ({ read: readMock })),
  };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { upsertMock, readMock, ctorMock };
});

vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

import {
  requestChecklistSeed,
  __resetSeedQueueForTests,
  type SeedQueueDoc,
} from "../src/services/catalog/checklistSeedQueue.service";

const REQ = {
  sport: "baseball",
  year: 2026,
  setName: "2026 Bowman Chrome",
  setKey: "bowman-chrome",
  reason: "set-not-in-catalog",
  missingPlayer: "Roman Anthony",
  missingCardNumber: "BCP-100",
};

const EXPECTED_ID = "seed:baseball:2026:bowman-chrome";

describe("requestChecklistSeed", () => {
  beforeEach(() => {
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=y;";
    delete process.env.CATALOG_SEED_QUEUE_ENABLED;
    upsertMock.mockReset();
    readMock.mockReset();
    upsertMock.mockResolvedValue({});
    readMock.mockResolvedValue({ resource: undefined });
    __resetSeedQueueForTests();
  });

  afterEach(() => {
    delete process.env.COSMOS_CONNECTION_STRING;
  });

  it("writes a pending work order keyed deterministically by release", async () => {
    const ok = await requestChecklistSeed(REQ);

    expect(ok).toBe(true);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const doc = upsertMock.mock.calls[0][0] as SeedQueueDoc;
    expect(doc.id).toBe(EXPECTED_ID);
    expect(doc.status).toBe("pending");
    expect(doc.requestCount).toBe(1);
    expect(doc.sport).toBe("baseball");
    expect(doc.samples[0]).toMatchObject({
      player: "Roman Anthony",
      cardNumber: "BCP-100",
    });
  });

  it("collapses repeat misses of the same release in-process", async () => {
    await requestChecklistSeed(REQ);
    const second = await requestChecklistSeed(REQ);

    // A 40-card import of one release must not write 40 times.
    expect(second).toBe(false);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("still separates distinct releases", async () => {
    await requestChecklistSeed(REQ);
    await requestChecklistSeed({ ...REQ, year: 2025 });

    expect(upsertMock).toHaveBeenCalledTimes(2);
    const ids = upsertMock.mock.calls.map((c) => (c[0] as SeedQueueDoc).id);
    expect(ids).toEqual([EXPECTED_ID, "seed:baseball:2025:bowman-chrome"]);
  });

  it("bumps demand on an existing open work order", async () => {
    readMock.mockResolvedValue({
      resource: {
        id: EXPECTED_ID,
        sport: "baseball",
        year: 2026,
        setKey: "bowman-chrome",
        setName: "2026 Bowman Chrome",
        status: "pending",
        requestCount: 7,
        reasons: ["set-not-in-catalog"],
        samples: [],
        firstRequestedAt: "2026-08-01T00:00:00.000Z",
        lastRequestedAt: "2026-08-01T00:00:00.000Z",
      } satisfies SeedQueueDoc,
    });

    await requestChecklistSeed(REQ);

    const doc = upsertMock.mock.calls[0][0] as SeedQueueDoc;
    expect(doc.requestCount).toBe(8);
    expect(doc.status).toBe("pending");
    expect(doc.firstRequestedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("reopens a completed release when it gets missed again", async () => {
    readMock.mockResolvedValue({
      resource: {
        id: EXPECTED_ID,
        sport: "baseball",
        year: 2026,
        setKey: "bowman-chrome",
        setName: "2026 Bowman Chrome",
        status: "done",
        requestCount: 3,
        reasons: [],
        samples: [],
        firstRequestedAt: "2026-08-01T00:00:00.000Z",
        lastRequestedAt: "2026-08-02T00:00:00.000Z",
        completedAt: "2026-08-03T00:00:00.000Z",
      } satisfies SeedQueueDoc,
    });

    await requestChecklistSeed(REQ);

    // A miss against a "done" set proves the checklist we built was partial.
    const doc = upsertMock.mock.calls[0][0] as SeedQueueDoc;
    expect(doc.status).toBe("pending");
    expect(doc.reopenedAt).toBeTruthy();
    expect(doc.requestCount).toBe(4);
  });

  it("caps stored samples so a hot gap can't grow the doc unbounded", async () => {
    readMock.mockResolvedValue({
      resource: {
        id: EXPECTED_ID,
        sport: "baseball",
        year: 2026,
        setKey: "bowman-chrome",
        setName: "2026 Bowman Chrome",
        status: "pending",
        requestCount: 100,
        reasons: [],
        samples: Array.from({ length: 20 }, (_, i) => ({
          player: `p${i}`,
          at: "2026-08-01T00:00:00.000Z",
        })),
        firstRequestedAt: "2026-08-01T00:00:00.000Z",
        lastRequestedAt: "2026-08-01T00:00:00.000Z",
      } satisfies SeedQueueDoc,
    });

    await requestChecklistSeed(REQ);

    const doc = upsertMock.mock.calls[0][0] as SeedQueueDoc;
    expect(doc.samples).toHaveLength(20);
    expect(doc.samples.at(-1)).toMatchObject({ player: "Roman Anthony" });
  });

  it("is a no-op when explicitly disabled", async () => {
    process.env.CATALOG_SEED_QUEUE_ENABLED = "false";

    expect(await requestChecklistSeed(REQ)).toBe(false);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("swallows a write failure — a lost seed never breaks the caller", async () => {
    upsertMock.mockRejectedValue(new Error("container not found"));

    await expect(requestChecklistSeed(REQ)).resolves.toBe(false);
  });

  it("rejects incomplete requests without a write", async () => {
    expect(await requestChecklistSeed({ ...REQ, setKey: "" })).toBe(false);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
