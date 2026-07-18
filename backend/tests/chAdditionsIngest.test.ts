// CF-CH-ADDITIONS-INGEST (Drew, 2026-07-17). Pinning tests for the
// dedup / checkpoint / pagination behavior of the ingest
// orchestrator. Mocks the CH client + the store so we exercise
// the pure control flow.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CardHedgeAdditionRow } from "../src/services/compiq/cardhedge.client.js";

const mockGetAdditionsSummary = vi.fn();
const mockUpsertAdditions = vi.fn();
const mockReadCheckpoint = vi.fn();
const mockUpsertCheckpoint = vi.fn();

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getAdditionsSummary: (opts: unknown) => mockGetAdditionsSummary(opts),
}));

vi.mock("../src/services/catalog/chAdditionsStore.service.js", () => ({
  upsertAdditions: (rows: CardHedgeAdditionRow[]) => mockUpsertAdditions(rows),
  readCheckpoint: () => mockReadCheckpoint(),
  upsertCheckpoint: (input: unknown) => mockUpsertCheckpoint(input),
}));

// Import AFTER mocks
const { ingestCatalogAdditions } = await import("../src/services/catalog/chAdditionsIngest.service.js");

function row(overrides: Partial<CardHedgeAdditionRow> = {}): CardHedgeAdditionRow {
  return {
    category: "Baseball",
    set_name: "2026 Bowman Chrome",
    subset: "Prospect Autographs",
    variants: null,
    added_date: "2026-07-15",
    card_count: 5,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetAdditionsSummary.mockReset();
  mockUpsertAdditions.mockReset();
  mockReadCheckpoint.mockReset();
  mockUpsertCheckpoint.mockReset();
  mockUpsertAdditions.mockImplementation(async (rows: CardHedgeAdditionRow[]) => rows.length);
  mockUpsertCheckpoint.mockImplementation(async () => undefined);
});

describe("ingestCatalogAdditions — cold start", () => {
  it("Uses 14-day lookback when no checkpoint exists", async () => {
    mockReadCheckpoint.mockResolvedValue(null);
    mockGetAdditionsSummary.mockResolvedValue({ data: [], page: 1, page_size: 200 });

    const result = await ingestCatalogAdditions({ endDate: "2026-07-15" });
    // Expected startDate = 2026-07-15 minus 14 days = 2026-07-01
    expect(result.startDate).toBe("2026-07-01");
    expect(result.endDate).toBe("2026-07-15");
    expect(result.rowsUpserted).toBe(0);
  });

  it("Uses (checkpoint + 1 day) when checkpoint exists", async () => {
    mockReadCheckpoint.mockResolvedValue({
      id: "checkpoint::additions",
      addedDate: "_meta",
      lastRunStart: "2026-07-15T00:00:00Z",
      lastRunEnd: "2026-07-15T00:05:00Z",
      lastEndDate: "2026-07-14",
      rowsUpserted: 3,
      updatedAt: "2026-07-15T00:05:00Z",
    });
    mockGetAdditionsSummary.mockResolvedValue({ data: [], page: 1, page_size: 200 });

    const result = await ingestCatalogAdditions({ endDate: "2026-07-15" });
    expect(result.startDate).toBe("2026-07-15");   // checkpoint end + 1 day
  });
});

describe("ingestCatalogAdditions — dedup + checkpoint advance", () => {
  it("Skips work when startDate > endDate (already up-to-date)", async () => {
    mockReadCheckpoint.mockResolvedValue({
      id: "checkpoint::additions",
      addedDate: "_meta",
      lastRunStart: "", lastRunEnd: "",
      lastEndDate: "2026-07-15", rowsUpserted: 0, updatedAt: "",
    });
    const result = await ingestCatalogAdditions({ endDate: "2026-07-15" });
    expect(result.pagesFetched).toBe(0);
    expect(result.rowsUpserted).toBe(0);
    expect(mockGetAdditionsSummary).not.toHaveBeenCalled();
  });

  it("Upserts rows and stamps checkpoint to highest seen date", async () => {
    mockReadCheckpoint.mockResolvedValue(null);
    mockGetAdditionsSummary.mockResolvedValue({
      data: [
        row({ added_date: "2026-07-10", card_count: 3 }),
        row({ added_date: "2026-07-12", card_count: 7 }),
        row({ added_date: "2026-07-11", card_count: 4 }),
      ],
      page: 1, page_size: 200,
    });

    const result = await ingestCatalogAdditions({
      startDate: "2026-07-10", endDate: "2026-07-15",
    });
    expect(result.rowsSeen).toBe(3);
    expect(result.rowsUpserted).toBe(3);
    // Checkpoint should be stamped with the highest added_date seen (2026-07-12)
    expect(mockUpsertCheckpoint).toHaveBeenCalled();
    const cp = mockUpsertCheckpoint.mock.calls[0][0];
    expect(cp.lastEndDate).toBe("2026-07-12");
  });
});

describe("ingestCatalogAdditions — pagination", () => {
  it("Walks pages until a partial page is returned", async () => {
    mockReadCheckpoint.mockResolvedValue(null);
    // Two full pages + one partial page
    const fullPage = Array.from({ length: 200 }, (_, i) => row({ added_date: "2026-07-10", card_count: i }));
    const partialPage = Array.from({ length: 42 }, (_, i) => row({ added_date: "2026-07-11", card_count: i }));
    mockGetAdditionsSummary
      .mockResolvedValueOnce({ data: fullPage, page: 1, page_size: 200 })
      .mockResolvedValueOnce({ data: fullPage, page: 2, page_size: 200 })
      .mockResolvedValueOnce({ data: partialPage, page: 3, page_size: 200 });

    const result = await ingestCatalogAdditions({
      startDate: "2026-07-10", endDate: "2026-07-15",
    });
    expect(result.pagesFetched).toBe(3);
    expect(result.rowsSeen).toBe(200 + 200 + 42);
    expect(result.rowsUpserted).toBe(200 + 200 + 42);
  });
});

describe("ingestCatalogAdditions — failure paths", () => {
  it("CH returns null → cleanly returns summary with 0 rows", async () => {
    mockReadCheckpoint.mockResolvedValue(null);
    mockGetAdditionsSummary.mockResolvedValue(null);

    const result = await ingestCatalogAdditions({
      startDate: "2026-07-10", endDate: "2026-07-15",
    });
    expect(result.pagesFetched).toBe(0);
    expect(result.rowsUpserted).toBe(0);
    // Checkpoint still stamped so we don't reprocess the empty window
    expect(mockUpsertCheckpoint).toHaveBeenCalled();
  });

  it("CH throws → firstError recorded, no crash", async () => {
    mockReadCheckpoint.mockResolvedValue(null);
    mockGetAdditionsSummary.mockRejectedValue(new Error("HTTP 429"));

    const result = await ingestCatalogAdditions({
      startDate: "2026-07-10", endDate: "2026-07-15",
    });
    expect(result.firstError).toBe("HTTP 429");
    expect(result.rowsUpserted).toBe(0);
  });
});
