// CF-NO-NULL-PRICING PR 2 (2026-07-11, Drew — era-baselines repo tests).
// Locks the id derivation + cache-hit / miss / error paths without
// hitting real Cosmos.

import { describe, it, expect, vi, beforeEach } from "vitest";

const readMock = vi.fn();
const bulkMock = vi.fn();

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    databases = {
      createIfNotExists: async () => ({
        database: {
          containers: {
            createIfNotExists: async () => ({
              container: {
                item: (id: string, pk: string) => ({
                  read: () => readMock(id, pk),
                }),
                items: { bulk: (ops: unknown[]) => bulkMock(ops) },
              },
            }),
          },
        },
      }),
    };
  },
  JSONObject: undefined,
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {},
}));

async function load() {
  const mod = await import("../src/repositories/eraBaselines.repository");
  mod._resetEraBaselineCacheForTest();
  return mod;
}

describe("eraBaselineDocId", () => {
  it("deterministic — same tuple → same id", async () => {
    const { eraBaselineDocId } = await load();
    expect(eraBaselineDocId("bowman-chrome", 2020, "base")).toBe(
      eraBaselineDocId("bowman-chrome", 2020, "base"),
    );
  });

  it("different tuple → different id", async () => {
    const { eraBaselineDocId } = await load();
    const a = eraBaselineDocId("bowman-chrome", 2020, "base");
    const b = eraBaselineDocId("bowman-chrome", 2020, "auto");
    const c = eraBaselineDocId("bowman-chrome", 2021, "base");
    const d = eraBaselineDocId("topps-chrome", 2020, "base");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("getEraBaseline", () => {
  beforeEach(() => {
    readMock.mockReset();
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x;AccountKey=y==";
    process.env.COSMOS_DATABASE = "hobbyiq";
  });

  it("returns null when inputs are incomplete", async () => {
    const { getEraBaseline } = await load();
    expect(await getEraBaseline("", 2020, "base")).toBeNull();
    expect(await getEraBaseline("bowman-chrome", NaN, "base")).toBeNull();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("returns the doc on a successful read", async () => {
    readMock.mockResolvedValue({
      resource: {
        id: "abc",
        productKey: "bowman-chrome",
        year: 2020,
        cardClass: "base",
        medianSale: 15,
        p25Sale: 8,
        p75Sale: 25,
        sampleSize: 42,
        computedAt: "2026-07-11T00:00:00Z",
        schemaVersion: 1,
      },
    });
    const { getEraBaseline } = await load();
    const doc = await getEraBaseline("bowman-chrome", 2020, "base");
    expect(doc).not.toBeNull();
    expect(doc!.medianSale).toBe(15);
    expect(doc!.sampleSize).toBe(42);
  });

  it("returns null on 404 (bucket has no data yet)", async () => {
    const err = new Error("not found");
    (err as unknown as { code: number }).code = 404;
    readMock.mockRejectedValue(err);
    const { getEraBaseline } = await load();
    const doc = await getEraBaseline("bowman-chrome", 2020, "base");
    expect(doc).toBeNull();
  });

  it("caches a hit — a second call is free", async () => {
    readMock.mockResolvedValue({
      resource: {
        id: "abc",
        productKey: "bowman-chrome",
        year: 2020,
        cardClass: "base",
        medianSale: 15,
        p25Sale: 8,
        p75Sale: 25,
        sampleSize: 42,
        computedAt: "2026-07-11T00:00:00Z",
        schemaVersion: 1,
      },
    });
    const { getEraBaseline } = await load();
    await getEraBaseline("bowman-chrome", 2020, "base");
    await getEraBaseline("bowman-chrome", 2020, "base");
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it("caches a miss — a second call is free (avoids retrying on empty buckets)", async () => {
    const err = new Error("not found");
    (err as unknown as { code: number }).code = 404;
    readMock.mockRejectedValue(err);
    const { getEraBaseline } = await load();
    await getEraBaseline("bowman-chrome", 2020, "base");
    await getEraBaseline("bowman-chrome", 2020, "base");
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on non-404 error (never blocks caller)", async () => {
    readMock.mockRejectedValue(new Error("cosmos boom"));
    const { getEraBaseline } = await load();
    const doc = await getEraBaseline("bowman-chrome", 2020, "base");
    expect(doc).toBeNull();
  });
});
