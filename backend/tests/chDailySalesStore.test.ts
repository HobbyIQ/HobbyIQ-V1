// CF-CH-DAILY-EXPORT-INGEST (2026-07-16) — Cosmos store contract pins
// using an injected fake container. Same pattern as
// verdictHistoryStoreReadFlips.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertDailySalesBatch,
  getSalesByCardId,
  writeIngestCheckpoint,
  readIngestCheckpoint,
  _setContainerForTests,
} from "../src/services/portfolioiq/chDailySalesStore.service.js";
import type { CHDailySaleRow } from "../src/types/chDailySales.types.js";

interface FakeItem { id: string; card_id: string; [k: string]: any }

function makeFake() {
  const docs = new Map<string, FakeItem>();
  const container = {
    items: {
      upsert: async (doc: FakeItem) => {
        docs.set(`${doc.card_id}|${doc.id}`, { ...doc });
      },
      query: (spec: { query: string; parameters: Array<{ name: string; value: any }> }, opts: { partitionKey: string }) => ({
        fetchAll: async () => {
          const pkKey = opts.partitionKey;
          const since = spec.parameters.find((p) => p.name === "@since")?.value as string | undefined;
          const rows = [...docs.values()]
            .filter((d) => d.card_id === pkKey)
            .filter((d) => (since ? d.sale_date >= since : true))
            .sort((a, b) => (a.sale_date < b.sale_date ? 1 : -1));
          return { resources: rows };
        },
      }),
    },
    item: (id: string, partitionKey: string) => ({
      read: async () => {
        const doc = docs.get(`${partitionKey}|${id}`);
        if (!doc) {
          const err: any = new Error("not found");
          err.code = 404;
          throw err;
        }
        return { resource: doc };
      },
    }),
  };
  return { container, docs };
}

function mkRow(overrides: Partial<CHDailySaleRow> = {}): CHDailySaleRow {
  return {
    price_history_id: "phid-1",
    source: "ebay",
    description: "desc",
    price: 10,
    listing_url: "",
    image_url: "",
    pop: 0,
    sale_date: "2026-07-15T00:00:00+00:00",
    sale_type: "BIN",
    card_id: "card-A",
    card_description: "",
    number: "1",
    player: "Trout",
    grade: "10",
    grader: "PSA",
    group: "Baseball",
    card_set: "2011 Topps Update",
    card_set_type: "Topps Update",
    variant: "Base",
    year: 2011,
    created_at: "2026-07-15T00:00:00+00:00",
    updated_at: "2026-07-15T00:00:00+00:00",
    ...overrides,
  };
}

describe("upsertDailySalesBatch", () => {
  beforeEach(() => _setContainerForTests(null));

  it("returns 0 upserted / all failed when container unavailable", async () => {
    _setContainerForTests(null);
    const res = await upsertDailySalesBatch([mkRow()]);
    expect(res.upserted).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.firstError).toBe("container unavailable");
  });

  it("upserts rows with id = price_history_id", async () => {
    const fake = makeFake();
    _setContainerForTests(fake.container as never);
    const res = await upsertDailySalesBatch([
      mkRow({ price_history_id: "phid-a", card_id: "card-1" }),
      mkRow({ price_history_id: "phid-b", card_id: "card-1" }),
    ]);
    expect(res.upserted).toBe(2);
    expect(res.failed).toBe(0);
    expect(fake.docs.size).toBe(2);
    expect(fake.docs.get("card-1|phid-a")?.id).toBe("phid-a");
  });

  it("is idempotent — re-upserting the same rows leaves the doc count stable", async () => {
    const fake = makeFake();
    _setContainerForTests(fake.container as never);
    const rows = [mkRow({ price_history_id: "same", card_id: "card-x" })];
    await upsertDailySalesBatch(rows);
    await upsertDailySalesBatch(rows);
    await upsertDailySalesBatch(rows);
    expect(fake.docs.size).toBe(1);
  });

  it("bounds concurrency (no throw on large batches)", async () => {
    const fake = makeFake();
    _setContainerForTests(fake.container as never);
    const rows = Array.from({ length: 100 }, (_, i) =>
      mkRow({ price_history_id: `id-${i}`, card_id: `card-${i % 5}` }));
    const res = await upsertDailySalesBatch(rows, { concurrency: 8 });
    expect(res.upserted).toBe(100);
    expect(fake.docs.size).toBe(100);
  });
});

describe("getSalesByCardId", () => {
  beforeEach(() => _setContainerForTests(null));

  it("returns empty when container unavailable", async () => {
    _setContainerForTests(null);
    expect(await getSalesByCardId("anything")).toEqual([]);
  });

  it("filters by partition (card_id) and orders newest first", async () => {
    const fake = makeFake();
    _setContainerForTests(fake.container as never);
    await upsertDailySalesBatch([
      mkRow({ price_history_id: "1", card_id: "A", sale_date: "2026-07-10T00:00:00+00:00" }),
      mkRow({ price_history_id: "2", card_id: "A", sale_date: "2026-07-15T00:00:00+00:00" }),
      mkRow({ price_history_id: "3", card_id: "B", sale_date: "2026-07-14T00:00:00+00:00" }),
    ]);
    const rows = await getSalesByCardId("A");
    expect(rows.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("respects sinceIso filter", async () => {
    const fake = makeFake();
    _setContainerForTests(fake.container as never);
    await upsertDailySalesBatch([
      mkRow({ price_history_id: "old", card_id: "C", sale_date: "2026-01-01T00:00:00+00:00" }),
      mkRow({ price_history_id: "new", card_id: "C", sale_date: "2026-07-15T00:00:00+00:00" }),
    ]);
    const rows = await getSalesByCardId("C", { sinceIso: "2026-07-01T00:00:00+00:00" });
    expect(rows.map((r) => r.id)).toEqual(["new"]);
  });
});

describe("writeIngestCheckpoint + readIngestCheckpoint", () => {
  beforeEach(() => _setContainerForTests(null));

  it("round-trips a checkpoint doc", async () => {
    const fake = makeFake();
    _setContainerForTests(fake.container as never);
    await writeIngestCheckpoint({
      fileDate: "2026-07-15",
      rowsUpserted: 77_000,
      rowsFailed: 12,
      csvSizeBytes: 38_782_538,
      firstError: null,
    });
    const cp = await readIngestCheckpoint("2026-07-15");
    expect(cp).not.toBeNull();
    expect(cp!.fileDate).toBe("2026-07-15");
    expect(cp!.rowsUpserted).toBe(77_000);
    expect(cp!.rowsFailed).toBe(12);
    expect(cp!.csvSizeBytes).toBe(38_782_538);
  });

  it("returns null when no checkpoint exists for the date", async () => {
    const fake = makeFake();
    _setContainerForTests(fake.container as never);
    expect(await readIngestCheckpoint("2020-01-01")).toBeNull();
  });
});
