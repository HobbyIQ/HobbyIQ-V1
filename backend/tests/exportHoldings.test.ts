// CF-EXPORT-BE (2026-06-21) — holdings export unit + integration tests.
//
// Locks the canonical schema (the column order = the import contract) +
// CSV escaping + xlsx round-trip + route-level Content-Type / Content-
// Disposition.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as XLSX from "xlsx";

import app from "../src/app";
import {
  EXPORT_COLUMNS,
  buildExportRows,
  buildHoldingsExport,
  exportColumnHeaders,
  readonlyImportHeaders,
} from "../src/services/portfolioiq/exportHoldings.service.js";
import type { PortfolioHoldingWire } from "../src/services/portfolioiq/responseAssembly.js";

// ─── Synthetic holdings ──────────────────────────────────────────────────

function makeHolding(overrides: Partial<PortfolioHoldingWire> = {}): PortfolioHoldingWire {
  // Minimum shape — all fields PortfolioHoldingWire requires.
  return {
    id: "holding-test-1",
    playerName: "Eric Hartman",
    cardYear: 2026,
    product: "Bowman",
    cardTitle: "2026 Bowman Eric Hartman",
    cardNumber: "CPA-EHA",
    parallel: "Blue X-Fractor /150",
    isAuto: true,
    cardId: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    purchaseDate: "2026-04-15",
    fairMarketValue: null,
    predictedPrice: null,
    predictedPriceLow: null,
    predictedPriceHigh: null,
    predictedPriceUpdatedAt: null,
    movementDirection: null,
    movementUpdatedAt: null,
    verdict: null,
    recommendation: null,
    predictedPriceMechanism: null,
    estimatedValue: null,
    estimateLow: null,
    estimateHigh: null,
    estimateConfidence: null,
    estimateBasis: null,
    isEstimate: false,
    valuationStatus: null,
    currentValue: 100,
    totalProfitLoss: 0,
    totalProfitLossPct: 0,
    quickSaleValue: null,
    premiumValue: null,
    suggestedListPrice: null,
    freshnessStatus: "Needs refresh",
    displayableValue: null,
    displayableValueSource: null,
    ...overrides,
  };
}

// ─── Schema lock — column order IS the import contract ──────────────────

describe("CF-EXPORT-BE — canonical schema (column order = import contract)", () => {
  it("exports columns in the locked order (identity-first → computed-last)", () => {
    expect(EXPORT_COLUMNS.length).toBeGreaterThan(20);
    const headers = exportColumnHeaders();
    // First three are the round-trip anchor identity columns
    expect(headers.slice(0, 3)).toEqual(["holdingId", "cardId", "gradeId"]);
    // Last seven are computed (read-only on import)
    expect(headers.slice(-7)).toEqual([
      "fairMarketValue", "estimatedValue", "valuationStatus",
      "totalProfitLoss", "totalProfitLossPct", "currentValue", "lastUpdated",
    ]);
  });

  it("readonlyImportHeaders returns exactly the 7 computed columns", () => {
    const readonly = readonlyImportHeaders();
    expect(readonly).toHaveLength(7);
    expect(readonly).toEqual([
      "fairMarketValue", "estimatedValue", "valuationStatus",
      "totalProfitLoss", "totalProfitLossPct", "currentValue", "lastUpdated",
    ]);
  });

  it("every column has a group, and groups are in canonical order (identity → identity-edit → grade → acquisition → listing → computed)", () => {
    const groups = EXPORT_COLUMNS.map((c) => c.group);
    const order = ["identity", "identity-edit", "grade", "acquisition", "listing", "computed"];
    const lastIdx: Record<string, number> = {};
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      lastIdx[g] = i;
    }
    // Each group's last occurrence index should be ≤ the next group's first
    for (let i = 0; i < order.length - 1; i++) {
      const here = order[i]!;
      const next = order[i + 1]!;
      const firstNext = groups.indexOf(next);
      const lastHere = lastIdx[here] ?? -1;
      if (firstNext >= 0 && lastHere >= 0) {
        expect(lastHere).toBeLessThan(firstNext);
      }
    }
  });
});

// ─── Row building ────────────────────────────────────────────────────────

describe("CF-EXPORT-BE — buildExportRows", () => {
  it("flattens holding into a row keyed by header", () => {
    const rows = buildExportRows([makeHolding()]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r["holdingId"]).toBe("holding-test-1");
    expect(r["cardId"]).toBe("befe9bcc-e7e8-458c-9cd8-ce831848b9a1");
    expect(r["playerName"]).toBe("Eric Hartman");
    expect(r["isAuto"]).toBe("TRUE");
    expect(r["parallel"]).toBe("Blue X-Fractor /150");
  });

  it("renders null/undefined as empty string", () => {
    const rows = buildExportRows([makeHolding({ gradeId: null, notes: undefined })]);
    expect(rows[0]!["gradeId"]).toBe("");
    expect(rows[0]!["notes"]).toBe("");
  });

  it("renders boolean as 'TRUE'/'FALSE' (round-trip-friendly: csv parses both)", () => {
    const rows = buildExportRows([
      makeHolding({ isAuto: true }),
      makeHolding({ isAuto: false }),
    ]);
    expect(rows[0]!["isAuto"]).toBe("TRUE");
    expect(rows[1]!["isAuto"]).toBe("FALSE");
  });
});

// ─── CSV format ──────────────────────────────────────────────────────────

describe("CF-EXPORT-BE — buildHoldingsExport csv", () => {
  it("emits header row + data row joined by CRLF", () => {
    const out = buildHoldingsExport([makeHolding()], "csv", new Date("2026-06-21T00:00:00Z"));
    const csv = out.buffer as string;
    const lines = csv.split("\r\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("holdingId,cardId");
    expect(lines[1]).toContain("holding-test-1");
  });

  it("escapes commas, quotes, and newlines inside cells per RFC-4180", () => {
    const out = buildHoldingsExport(
      [makeHolding({
        notes: 'has, comma',
        cardTitle: 'has "quotes"',
        playerName: "newline\ninside",
      })],
      "csv",
    );
    const csv = out.buffer as string;
    expect(csv).toContain('"has, comma"');
    expect(csv).toContain('"has ""quotes"""');
    expect(csv).toContain('"newline\ninside"');
  });

  it("Content-Type and filename for CSV", () => {
    const out = buildHoldingsExport([], "csv", new Date("2026-06-21T00:00:00Z"));
    expect(out.contentType).toContain("text/csv");
    expect(out.filename).toBe("hobbyiq-holdings-2026-06-21.csv");
  });
});

// ─── XLSX format ─────────────────────────────────────────────────────────

describe("CF-EXPORT-BE — buildHoldingsExport xlsx", () => {
  it("emits a parseable xlsx workbook with a Holdings sheet", () => {
    const out = buildHoldingsExport([makeHolding(), makeHolding({ id: "h2", playerName: "Test Player" })], "xlsx");
    const buf = out.buffer as Buffer;
    expect(buf.length).toBeGreaterThan(0);
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toContain("Holdings");
    const sheet = wb.Sheets["Holdings"]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    expect(rows).toHaveLength(2);
    expect(rows[0]!["holdingId"]).toBe("holding-test-1");
    expect(rows[1]!["playerName"]).toBe("Test Player");
  });

  it("xlsx round-trip preserves column order (the import contract)", () => {
    const out = buildHoldingsExport([makeHolding()], "xlsx");
    const wb = XLSX.read(out.buffer as Buffer, { type: "buffer" });
    const sheet = wb.Sheets["Holdings"]!;
    // sheet_to_json returns rows in column order; check first row's keys
    // come back in canonical header order.
    const rowsAsArrays = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    expect(rowsAsArrays[0]).toEqual(exportColumnHeaders());
  });

  it("Content-Type and filename for XLSX", () => {
    const out = buildHoldingsExport([], "xlsx", new Date("2026-06-21T00:00:00Z"));
    expect(out.contentType).toContain("openxmlformats-officedocument.spreadsheetml.sheet");
    expect(out.filename).toBe("hobbyiq-holdings-2026-06-21.xlsx");
  });
});

// ─── Route integration ──────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const res = await request(app).post("/api/auth/signin").send({ username: "HobbyIQ", password: "Baseball25" });
  expect(res.status).toBe(200);
  return { sessionId: res.body.sessionId as string, userId: res.body.user?.userId as string };
}

async function addTestHolding(sessionId: string, id: string, overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const res = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send({
      id,
      playerName: "Paul Skenes",
      cardYear: 2024,
      product: "Bowman Chrome",
      cardTitle: "2024 Bowman Chrome Auto",
      cardId: "test-cardsight-id-" + id,
      quantity: 1,
      purchasePrice: 100,
      totalCostBasis: 100,
      ...overrides,
    });
  expect(res.status).toBe(201);
}

describe("CF-EXPORT-BE — GET /api/portfolio/export route", () => {
  it("defaults to xlsx when no format query param given", async () => {
    const { sessionId } = await signIn();
    await addTestHolding(sessionId, "export-test-1");

    const res = await request(app)
      .get("/api/portfolio/export")
      .set("x-session-id", sessionId);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="hobbyiq-holdings-\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect(res.headers["x-holdings-count"]).toBe("1");
  });

  it("emits CSV when format=csv", async () => {
    const { sessionId } = await signIn();
    await addTestHolding(sessionId, "export-test-2");

    const res = await request(app)
      .get("/api/portfolio/export?format=csv")
      .set("x-session-id", sessionId);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/\.csv"/);
    // Body should be a CSV string with the canonical header row
    expect(res.text).toContain("holdingId,cardId");
  });

  it("round-trips through xlsx parser: every column header lands in the sheet header row", async () => {
    const { sessionId } = await signIn();
    await addTestHolding(sessionId, "export-test-3");

    const res = await request(app)
      .get("/api/portfolio/export?format=xlsx")
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .set("x-session-id", sessionId);

    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body as Buffer, { type: "buffer" });
    const sheet = wb.Sheets["Holdings"]!;
    const arr = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    expect(arr[0]).toEqual(exportColumnHeaders());
  });

  it("route succeeds whether portfolio is empty or populated; X-Holdings-Count matches", async () => {
    // The in-memory test store accumulates holdings across tests in the
    // same describe — don't assume an empty state. What we lock instead:
    // (1) the route returns 200 regardless, (2) the header count is a
    // valid non-negative integer, (3) the workbook has the Holdings
    // sheet with the canonical header row even for an empty portfolio.
    const { sessionId } = await signIn();

    const res = await request(app)
      .get("/api/portfolio/export")
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .set("x-session-id", sessionId);

    expect(res.status).toBe(200);
    const count = Number(res.headers["x-holdings-count"]);
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);

    const wb = XLSX.read(res.body as Buffer, { type: "buffer" });
    const sheet = wb.Sheets["Holdings"]!;
    const arr = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    // Header row is always present, regardless of holdings count.
    expect(arr[0]).toEqual(exportColumnHeaders());
    // Row count = header (1) + holdings count
    expect(arr.length).toBe(1 + count);
  });
});
