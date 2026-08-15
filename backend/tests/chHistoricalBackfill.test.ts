// CF-CH-HISTORICAL-BACKFILL (Drew, 2026-08-14).
//
// The load-bearing behaviors under test:
//   1. sourceExternalId matches bulk-import-ch-daily-to-sold-comps.cjs,
//      so the CSV path and the ch_daily_sales path dedupe against each
//      other rather than double-writing the pool.
//   2. The cursor advances ONLY past days that completed end-to-end.
//      A day that 500s or throws mid-parse must leave the cursor where
//      it was, or the walk leaves a permanent hole nothing returns for.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

import {
  mapChRowToSoldComp,
  normSport,
  normGrader,
  parseGrade,
  inferIsAutoFromCH,
} from "../src/services/portfolioiq/chRowToSoldComp.js";
import type { CHDailySaleRow } from "../src/types/chDailySales.types.js";

const baseRow = (over: Partial<CHDailySaleRow> = {}): CHDailySaleRow => ({
  price_history_id: "ph-1",
  source: "ebay",
  description: "2024 Topps Chrome Shohei Ohtani #1 PSA 10",
  price: 125.5,
  listing_url: "https://example.test/item/1",
  image_url: "https://img.test/1.jpg",
  pop: 0,
  sale_date: "2025-03-04",
  sale_type: "auction",
  card_id: "1778540952494x233768468903861100",
  card_description: "Topps Chrome Ohtani",
  number: "1",
  player: "Shohei Ohtani",
  grade: "10",
  grader: "PSA",
  group: "Baseball",
  card_set: "Topps Chrome",
  card_set_type: "Base",
  variant: "Base",
  year: 2024,
  created_at: "2025-03-04T00:00:00Z",
  updated_at: "2025-03-04T00:00:00Z",
  ...over,
});

describe("chRowToSoldComp — field derivation", () => {
  it("normalizes CH group to a canonical sport tag", () => {
    expect(normSport("Baseball")).toBe("baseball");
    expect(normSport("  FOOTBALL ")).toBe("football");
    expect(normSport("Pokemon")).toBeNull();
    expect(normSport(undefined)).toBeNull();
  });

  it("treats raw/ungraded/unknown graders as null", () => {
    expect(normGrader("PSA")).toBe("PSA");
    expect(normGrader("raw")).toBeNull();
    expect(normGrader("Ungraded")).toBeNull();
    expect(normGrader("WHOKNOWS")).toBeNull();
  });

  it("parses grades only inside (0, 10]", () => {
    expect(parseGrade("9.5")).toBe(9.5);
    expect(parseGrade("10")).toBe(10);
    expect(parseGrade("Raw")).toBeNull();
    expect(parseGrade("0")).toBeNull();
    expect(parseGrade("11")).toBeNull();
    expect(parseGrade("")).toBeNull();
  });

  it("flags autos from the cardNumber prefix boundary", () => {
    expect(inferIsAutoFromCH({ variant: "Base", description: "no tokens", number: "CPA-SO" })).toBe(true);
    expect(inferIsAutoFromCH({ variant: "Base", description: "plain card", number: "1" })).toBe(false);
  });
});

describe("chRowToSoldComp — mapping contract", () => {
  it("uses the ch-daily:: sourceExternalId shared with the bulk-import script", () => {
    // This exact format is what makes the CSV path idempotent against
    // the ~4.2M rows the bulk-import script already wrote. Changing it
    // would double-write the pool rather than dedupe.
    const r = mapChRowToSoldComp(baseRow({ price_history_id: "abc123" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.sourceExternalId).toBe("ch-daily::abc123");
    expect(r.input.source).toBe("cardhedge");
    expect(r.input.confidence).toBe(0.9);
  });

  it("maps a well-formed row end to end", () => {
    const r = mapChRowToSoldComp(baseRow());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      cardId: "1778540952494x233768468903861100",
      playerName: "Shohei Ohtani",
      cardYear: 2024,
      setName: "Topps Chrome",
      sport: "baseball",
      gradeCompany: "PSA",
      gradeValue: 10,
      price: 125.5,
      soldAt: "2025-03-04",
    });
  });

  it("defaults an empty variant to Base rather than null", () => {
    const r = mapChRowToSoldComp(baseRow({ variant: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.parallel).toBe("Base");
  });

  it("skips rows the pool cannot use, with a typed reason", () => {
    expect(mapChRowToSoldComp(baseRow({ player: "  " }))).toEqual({ ok: false, skip: "no-player" });
    expect(mapChRowToSoldComp(baseRow({ price: 0 }))).toEqual({ ok: false, skip: "no-price" });
    expect(mapChRowToSoldComp(baseRow({ card_id: "" }))).toEqual({ ok: false, skip: "no-card-id" });
    expect(mapChRowToSoldComp(baseRow({ sale_date: "" }))).toEqual({ ok: false, skip: "no-sale-date" });
  });

  it("applies the sport filter and distinguishes filtered from untagged", () => {
    expect(mapChRowToSoldComp(baseRow({ group: "Football" }), { sportFilter: ["baseball"] }))
      .toEqual({ ok: false, skip: "sport-filtered" });
    expect(mapChRowToSoldComp(baseRow({ group: "Pokemon" }), { sportFilter: ["baseball"] }))
      .toEqual({ ok: false, skip: "no-sport" });
    // No filter => untagged sport is still accepted, sport just stays null.
    const r = mapChRowToSoldComp(baseRow({ group: "Pokemon" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.sport).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Day-walk resumability.
// ---------------------------------------------------------------------

const CSV_HEADER = [
  "price_history_id", "source", "description", "price", "listing_url",
  "image_url", "pop", "sale_date", "sale_type", "card_id",
  "card_description", "number", "player", "grade", "grader",
  "group", "card_set", "card_set_type", "variant", "year",
  "created_at", "updated_at",
].join(",");

function csvFor(ids: string[], saleDate: string): string {
  const lines = [CSV_HEADER];
  for (const id of ids) {
    lines.push([
      id, "ebay", "Topps Chrome Ohtani", "100", "https://e.test/1",
      "https://i.test/1.jpg", "0", saleDate, "auction", "card-1",
      "Topps Chrome Ohtani", "1", "Shohei Ohtani", "10", "PSA",
      "Baseball", "Topps Chrome", "Base", "Base", "2024",
      `${saleDate}T00:00:00Z`, `${saleDate}T00:00:00Z`,
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

const downloadMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const readCursorMock = vi.hoisted(() => vi.fn());
const writeCursorMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/compiq/cardhedgeDailyExport.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardhedgeDailyExport.client.js")>(
    "../src/services/compiq/cardhedgeDailyExport.client.js",
  );
  return { ...actual, downloadDailyPriceExport: downloadMock };
});

vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", () => ({
  recordSoldComp: recordMock,
}));

vi.mock("../src/services/portfolioiq/chHistoricalBackfillStore.service.js", () => ({
  readBackfillCursor: readCursorMock,
  writeBackfillCursor: writeCursorMock,
}));

const okDownload = (csv: string) => ({
  status: 200,
  bodyStream: Readable.from([csv]),
  contentType: "text/csv",
  contentLength: csv.length,
  contentEncoding: null,
});

describe("chHistoricalBackfill — day walk + cursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readCursorMock.mockResolvedValue(null);
    writeCursorMock.mockResolvedValue(undefined);
    recordMock.mockResolvedValue({ written: true });
  });

  it("resumes at the day AFTER the persisted cursor", async () => {
    readCursorMock.mockResolvedValue({ lastCompletedDate: "2025-02-10" });
    downloadMock.mockImplementation((d: string) => Promise.resolve(okDownload(csvFor(["a"], d))));
    const { runHistoricalBackfill } = await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      endDate: "2025-02-13", maxDays: 2, apply: true, apiKey: "k",
    });

    expect(res.startDate).toBe("2025-02-11");
    expect(downloadMock.mock.calls.map((c) => c[0])).toEqual(["2025-02-11", "2025-02-12"]);
    expect(res.stoppedReason).toBe("max-days");
  });

  it("never starts earlier than the measured retention cutoff", async () => {
    downloadMock.mockImplementation((d: string) => Promise.resolve(okDownload(csvFor(["a"], d))));
    const { runHistoricalBackfill, CH_RETENTION_CUTOFF } =
      await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      startDate: "2019-05-05", endDate: "2025-01-02", maxDays: 1, apply: true, apiKey: "k",
    });
    expect(res.startDate).toBe(CH_RETENTION_CUTOFF);
  });

  it("holds the cursor when a day fails to download", async () => {
    downloadMock.mockImplementation((d: string) => {
      if (d === "2025-01-02") {
        return Promise.resolve({
          status: 500, bodyStream: null, contentType: null,
          contentLength: null, contentEncoding: null,
        });
      }
      return Promise.resolve(okDownload(csvFor(["a"], d)));
    });
    const { runHistoricalBackfill } = await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      startDate: "2025-01-01", endDate: "2025-01-05", maxDays: 5, apply: true, apiKey: "k",
    });

    // Day 1 succeeded, day 2 failed → we stop, and the cursor sits on
    // the last GOOD day. Walking past 01-02 would orphan it forever.
    expect(res.stoppedReason).toBe("hard-error");
    expect(res.cursorAfter).toBe("2025-01-01");
    const written = writeCursorMock.mock.calls.map((c) => c[0].lastCompletedDate);
    expect(written).toEqual(["2025-01-01"]);
    expect(written).not.toContain("2025-01-02");
  });

  it("does not advance the cursor at all in dry-run", async () => {
    downloadMock.mockImplementation((d: string) => Promise.resolve(okDownload(csvFor(["a", "b"], d))));
    const { runHistoricalBackfill } = await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      startDate: "2025-01-01", endDate: "2025-01-02", maxDays: 2, apply: false, apiKey: "k",
    });

    expect(writeCursorMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(res.totalRowsWritten).toBe(4); // counted, not written
  });

  it("counts catalog-unmatched separately from hard failures", async () => {
    downloadMock.mockImplementation((d: string) => Promise.resolve(okDownload(csvFor(["a", "b", "c"], d))));
    recordMock
      .mockResolvedValueOnce({ written: true })
      .mockResolvedValueOnce({ written: false, reason: "catalog-unmatched" })
      .mockResolvedValueOnce({ written: false, reason: "error" });
    const { runHistoricalBackfill } = await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      startDate: "2025-01-01", endDate: "2025-01-01", maxDays: 1, apply: true, apiKey: "k",
    });

    expect(res.totalRowsWritten).toBe(1);
    expect(res.totalRowsUnmatched).toBe(1);
    expect(res.totalRowsFailed).toBe(1);
    expect(res.cursorAfter).toBe("2025-01-01");
  });

  it("survives a mid-download socket drop and holds the cursor", async () => {
    // Live failure 2026-08-14: CH closed the connection ~2.7 MB into the
    // file while writes backpressured the read. `pipe()` does not forward
    // a source-stream error to its destination, so the 'error' event was
    // unhandled and killed the process — losing the run with no cursor
    // and no diagnosis. It must surface as an incomplete day instead.
    downloadMock.mockImplementation((d: string) => {
      if (d === "2025-01-02") {
        const s = new Readable({ read() {} });
        s.push(CSV_HEADER + "\n");
        process.nextTick(() => s.emit("error", new Error("other side closed")));
        return Promise.resolve({
          status: 200, bodyStream: s, contentType: "text/csv",
          contentLength: null, contentEncoding: null,
        });
      }
      return Promise.resolve(okDownload(csvFor(["a"], d)));
    });
    const { runHistoricalBackfill } = await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      startDate: "2025-01-01", endDate: "2025-01-05", maxDays: 5, apply: true, apiKey: "k",
    });

    expect(res.stoppedReason).toBe("hard-error");
    expect(res.cursorAfter).toBe("2025-01-01");
    expect(res.perDay[1].complete).toBe(false);
    expect(res.perDay[1].error).toMatch(/other side closed/);
  });

  it("does not write during the parse phase", async () => {
    // Phase separation is what keeps the origin socket alive: the row
    // callback must stay cheap, with every write deferred until the
    // stream is fully drained.
    let parseFinished = false;
    let wroteBeforeParseFinished = false;
    recordMock.mockImplementation(async () => {
      if (!parseFinished) wroteBeforeParseFinished = true;
      return { written: true };
    });
    downloadMock.mockImplementation((d: string) => {
      const csv = csvFor(["a", "b", "c", "d"], d);
      const s = Readable.from([csv]);
      s.on("end", () => { parseFinished = true; });
      return Promise.resolve({
        status: 200, bodyStream: s, contentType: "text/csv",
        contentLength: csv.length, contentEncoding: null,
      });
    });
    const { runHistoricalBackfill } = await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      startDate: "2025-01-01", endDate: "2025-01-01", maxDays: 1, apply: true, apiKey: "k",
    });

    expect(res.totalRowsWritten).toBe(4);
    expect(wroteBeforeParseFinished).toBe(false);
  });

  it("stops on maxDays without losing the next start position", async () => {
    downloadMock.mockImplementation((d: string) => Promise.resolve(okDownload(csvFor(["a"], d))));
    const { runHistoricalBackfill } = await import("../src/services/portfolioiq/chHistoricalBackfill.service.js");

    const res = await runHistoricalBackfill({
      startDate: "2025-01-01", endDate: "2025-12-31", maxDays: 3, apply: true, apiKey: "k",
    });

    expect(res.daysCompleted).toBe(3);
    expect(res.cursorAfter).toBe("2025-01-03");
    expect(res.stoppedReason).toBe("max-days");
  });
});
