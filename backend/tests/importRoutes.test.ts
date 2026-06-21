// CF-IMPORT-BE (2026-06-21) — preview + commit route integration tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as XLSX from "xlsx";
import app from "../src/app";

// Mock the Cardsight resolver — import routes go through it for arbitrary
// rows; we don't want live HTTP in tests.
vi.mock("../src/services/compiq/cardsight.mapper.js", async (importActual) => {
  const actual = await importActual() as Record<string, unknown>;
  return {
    ...actual,
    resolveCardId: vi.fn().mockResolvedValue({ cardId: null }),
  };
});

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

function makeXlsxBase64(headers: string[], rows: unknown[][]): string {
  const data = [headers, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Holdings");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buf.toString("base64");
}

describe("CF-IMPORT-BE — POST /api/portfolio/import/preview", () => {
  it("400 when 'file' missing", async () => {
    const { sessionId } = await signIn();
    const res = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ format: "xlsx" });
    expect(res.status).toBe(400);
  });

  it("round-trip sheet → isRoundTrip true + envelopes returned", async () => {
    const { sessionId } = await signIn();
    const file = makeXlsxBase64(
      ["holdingId", "cardsightCardId", "playerName", "cardYear", "product", "purchasePrice"],
      [
        ["new-import-h1", "abc12345", "Test Player A", 2026, "Bowman", 100],
        ["new-import-h2", "def67890", "Test Player B", 2024, "Bowman Chrome", 200],
      ],
    );
    const res = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ file, format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary.isRoundTrip).toBe(true);
    expect(res.body.summary.totalRows).toBe(2);
    expect(res.body.envelopes).toHaveLength(2);
    // No live writes occurred — the same preview can be called repeatedly
    expect(res.body.summary.bucketCounts["resolved-clean"]).toBeGreaterThan(0);
  });

  it("arbitrary sheet → auto-map proposal + lenient parse", async () => {
    const { sessionId } = await signIn();
    const file = makeXlsxBase64(
      ["Player", "Year", "Brand", "Paid"],
      [["Test Player C", 2026, "Bowman", "$150.50"]],
    );
    const res = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ file, format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.body.summary.isRoundTrip).toBe(false);
    expect(res.body.proposedMapping["Player"]).toBe("playerName");
    expect(res.body.proposedMapping["Paid"]).toBe("purchasePrice");
    // Lenient parse: "$150.50" → 150.5
    const env = res.body.envelopes[0];
    expect(env.payload.purchasePrice).toBe(150.5);
  });

  it("capacity projection surfaces wouldExceed flag", async () => {
    const { sessionId } = await signIn();
    // Free tier = 25 cap. Make a sheet with 100 rows.
    const rows: unknown[][] = Array.from({ length: 100 }, (_, i) => [
      `import-bulk-${i}`,
      `cardId-${i}`,
      `Player ${i}`,
      2026,
      "Bowman",
      100,
    ]);
    const file = makeXlsxBase64(
      ["holdingId", "cardsightCardId", "playerName", "cardYear", "product", "purchasePrice"],
      rows,
    );
    const res = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ file, format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.body.summary.capacityProjection.cap).toBeGreaterThan(0);
    // 100 rows > 25 cap → wouldExceed true (current may be > 0 from earlier tests but never enough to flip wouldExceed false here)
    expect(res.body.summary.capacityProjection.wouldExceed).toBe(true);
  });
});

describe("CF-IMPORT-BE — POST /api/portfolio/import/commit", () => {
  it("400 when idempotencyToken missing", async () => {
    const { sessionId } = await signIn();
    const res = await request(app)
      .post("/api/portfolio/import/commit")
      .set("x-session-id", sessionId)
      .send({ envelopes: [] });
    expect(res.status).toBe(400);
  });

  it("400 when envelopes missing", async () => {
    const { sessionId } = await signIn();
    const res = await request(app)
      .post("/api/portfolio/import/commit")
      .set("x-session-id", sessionId)
      .send({ idempotencyToken: "test-token-1" });
    expect(res.status).toBe(400);
  });

  it("commits resolved-clean envelopes; idempotency token prevents double-ingest", async () => {
    const { sessionId } = await signIn();
    const token = `commit-test-token-${Date.now()}`;
    const envelopes = [
      {
        rowNumber: 2,
        lane: "new",
        bucket: "resolved-clean",
        cardsightCardId: "card-import-1",
        payload: {
          id: "import-commit-h1",
          cardsightCardId: "card-import-1",
          playerName: "Import Test Player",
          cardYear: 2026,
          product: "Bowman",
          purchasePrice: 100,
        },
        parseFlags: [],
        message: "test",
      },
    ];

    // First commit
    const res1 = await request(app)
      .post("/api/portfolio/import/commit")
      .set("x-session-id", sessionId)
      .send({ idempotencyToken: token, envelopes });
    expect(res1.status).toBe(200);
    expect(res1.body.cached).toBe(false);
    expect(res1.body.totals.added).toBe(1);
    expect(res1.body.outcomes[0].holdingId).toBeDefined();

    // Second commit with same token — should return cached
    const res2 = await request(app)
      .post("/api/portfolio/import/commit")
      .set("x-session-id", sessionId)
      .send({ idempotencyToken: token, envelopes });
    expect(res2.status).toBe(200);
    expect(res2.body.cached).toBe(true);
    // Cached result has the same totals
    expect(res2.body.totals.added).toBe(1);
  });

  it("skips unresolved envelopes by default", async () => {
    const { sessionId } = await signIn();
    const token = `commit-test-skip-${Date.now()}`;
    const envelopes = [
      {
        rowNumber: 2,
        lane: "new",
        bucket: "unresolved",
        cardsightCardId: null,
        payload: { playerName: "Unresolved Player" },
        parseFlags: [],
        message: "no match",
      },
    ];
    const res = await request(app)
      .post("/api/portfolio/import/commit")
      .set("x-session-id", sessionId)
      .send({ idempotencyToken: token, envelopes });
    expect(res.status).toBe(200);
    expect(res.body.totals.skipped).toBe(1);
    expect(res.body.totals.added).toBe(0);
  });
});
