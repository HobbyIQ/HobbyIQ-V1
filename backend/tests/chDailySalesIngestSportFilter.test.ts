// CF-CH-INGEST-BASEBALL-ONLY (Drew, 2026-07-17) — pin the sport filter
// resolution behavior. The runtime cost of getting this wrong is
// high (we could purge everything or purge nothing), so behavior is
// tested at multiple boundaries.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "stream";
import type { CHDailySaleRow } from "../src/types/chDailySales.types.js";

// Import the orchestrator via the actual module and stub its
// downstream dependencies with vi.mock so we only exercise the filter
// logic, not the network or Cosmos writes.
vi.mock("../src/services/compiq/cardhedgeDailyExport.client.js", () => ({
  downloadDailyPriceExport: vi.fn(),
  parseDailyExportStream: vi.fn(),
}));
vi.mock("../src/services/portfolioiq/chDailySalesStore.service.js", () => ({
  upsertDailySalesBatch: vi.fn().mockResolvedValue({ upserted: 0, failed: 0, firstError: null }),
  writeIngestCheckpoint: vi.fn().mockResolvedValue(undefined),
  readIngestCheckpoint: vi.fn().mockResolvedValue(null),
}));

async function loadUnderTest() {
  const mod = await import("../src/services/portfolioiq/chDailySalesIngest.service.js");
  const dlMod = await import("../src/services/compiq/cardhedgeDailyExport.client.js");
  const storeMod = await import("../src/services/portfolioiq/chDailySalesStore.service.js");
  return { mod, dlMod, storeMod };
}

function makeRow(overrides: Partial<CHDailySaleRow> = {}): CHDailySaleRow {
  return {
    price_history_id: `phid-${Math.random().toString(36).slice(2, 10)}`,
    source: "ebay",
    description: "",
    price: 1,
    listing_url: "",
    image_url: "",
    pop: 0,
    sale_date: "2026-07-15",
    sale_type: "BIN",
    card_id: "card-1",
    card_description: "",
    number: "1",
    player: "Player",
    grade: "Raw",
    grader: "Raw",
    group: "Baseball",
    card_set: "Set",
    card_set_type: "Type",
    variant: "Base",
    year: 2020,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

const ORIGINAL_ENV = process.env.CH_INGEST_SPORT_FILTER;
beforeEach(() => { vi.resetAllMocks(); delete process.env.CH_INGEST_SPORT_FILTER; });
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.CH_INGEST_SPORT_FILTER;
  else process.env.CH_INGEST_SPORT_FILTER = ORIGINAL_ENV;
});

async function runWithRows(rows: CHDailySaleRow[], opts: any = {}) {
  const { mod, dlMod, storeMod } = await loadUnderTest();
  (dlMod.downloadDailyPriceExport as any).mockResolvedValue({
    status: 200,
    bodyStream: Readable.from([]),
    contentType: "text/csv",
    contentLength: 100,
    contentEncoding: null,
  });
  (dlMod.parseDailyExportStream as any).mockImplementation(async (_stream: any, onRow: (r: CHDailySaleRow) => Promise<void>) => {
    for (const r of rows) await onRow(r);
    return { rows: rows.length, errors: 0, firstError: null };
  });
  const upsertSpy = (storeMod.upsertDailySalesBatch as any).mockResolvedValue({ upserted: 0, failed: 0, firstError: null });
  const result = await mod.runDailySalesIngest({ fileDate: "2026-07-15", skipIfCompleted: false, ...opts });
  return { result, upsertSpy };
}

describe("runDailySalesIngest — sport filter", () => {
  it("no filter (env unset, opts.sportFilter unset) → all rows pass", async () => {
    const rows = [makeRow({ group: "Baseball" }), makeRow({ group: "Pokemon" }), makeRow({ group: "Basketball" })];
    const { result, upsertSpy } = await runWithRows(rows);
    expect(result.sportFilter).toBeNull();
    expect(result.rowsSeen).toBe(3);
    expect(result.rowsFiltered).toBe(0);
    // Every row passed through to the buffer, so upsert was called with all 3.
    const upsertedRows = upsertSpy.mock.calls.reduce((acc: number, call: any[]) => acc + call[0].length, 0);
    expect(upsertedRows).toBe(3);
  });

  it("env CH_INGEST_SPORT_FILTER=Baseball → only Baseball rows pass", async () => {
    process.env.CH_INGEST_SPORT_FILTER = "Baseball";
    const rows = [
      makeRow({ group: "Baseball", price_history_id: "b1" }),
      makeRow({ group: "Pokemon", price_history_id: "p1" }),
      makeRow({ group: "Baseball", price_history_id: "b2" }),
      makeRow({ group: "Basketball", price_history_id: "bk1" }),
    ];
    const { result, upsertSpy } = await runWithRows(rows);
    expect(result.sportFilter).toEqual(["Baseball"]);
    expect(result.rowsSeen).toBe(2);
    expect(result.rowsFiltered).toBe(2);
    const upsertedRows = upsertSpy.mock.calls.reduce((acc: number, call: any[]) => acc + call[0].length, 0);
    expect(upsertedRows).toBe(2);
  });

  it("multi-sport env (Baseball,Football) → both pass, others filtered", async () => {
    process.env.CH_INGEST_SPORT_FILTER = "Baseball,Football";
    const rows = [
      makeRow({ group: "Baseball" }),
      makeRow({ group: "Football" }),
      makeRow({ group: "Basketball" }),
    ];
    const { result } = await runWithRows(rows);
    expect(result.sportFilter).toEqual(["Baseball", "Football"]);
    expect(result.rowsSeen).toBe(2);
    expect(result.rowsFiltered).toBe(1);
  });

  it("opts.sportFilter overrides env", async () => {
    process.env.CH_INGEST_SPORT_FILTER = "Baseball";
    const rows = [
      makeRow({ group: "Baseball" }),
      makeRow({ group: "Pokemon" }),
    ];
    const { result } = await runWithRows(rows, { sportFilter: ["Pokemon"] });
    expect(result.sportFilter).toEqual(["Pokemon"]);
    expect(result.rowsSeen).toBe(1);
    expect(result.rowsFiltered).toBe(1);
  });

  it("opts.sportFilter=null explicitly disables the filter", async () => {
    process.env.CH_INGEST_SPORT_FILTER = "Baseball";
    const rows = [
      makeRow({ group: "Baseball" }),
      makeRow({ group: "Pokemon" }),
    ];
    const { result } = await runWithRows(rows, { sportFilter: null });
    expect(result.sportFilter).toBeNull();
    expect(result.rowsSeen).toBe(2);
    expect(result.rowsFiltered).toBe(0);
  });

  it("empty env value → treated as no filter (no accidental purge)", async () => {
    process.env.CH_INGEST_SPORT_FILTER = "";
    const rows = [
      makeRow({ group: "Baseball" }),
      makeRow({ group: "Pokemon" }),
    ];
    const { result } = await runWithRows(rows);
    expect(result.sportFilter).toBeNull();
    expect(result.rowsSeen).toBe(2);
  });

  it("normalizes list — dedupes + trims whitespace", async () => {
    const { result } = await runWithRows(
      [makeRow({ group: "Baseball" })],
      { sportFilter: ["Baseball", "  Baseball  ", "Football"] },
    );
    expect(result.sportFilter).toEqual(["Baseball", "Football"]);
  });
});
