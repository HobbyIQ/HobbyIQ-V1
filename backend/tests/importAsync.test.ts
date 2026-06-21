// CF-IMPORT-ASYNC (2026-06-21) — async preview + status-poll + staleness tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as XLSX from "xlsx";
import app from "../src/app";
import {
  SYNC_PREVIEW_ROW_THRESHOLD,
} from "../src/services/portfolioiq/import/importService.js";
import {
  STALENESS_THRESHOLD_MS,
  PROGRESS_WRITE_THROTTLE_MS,
  IMPORT_JOB_TTL_SECONDS,
  readImportJob,
  writeImportJob,
  _testResetImportJobStore,
  type ImportJobDoc,
} from "../src/services/portfolioiq/import/importJobStore.service.js";

vi.mock("../src/services/compiq/cardsight.mapper.js", async (importActual) => {
  const actual = await importActual() as Record<string, unknown>;
  return {
    ...actual,
    resolveCardId: vi.fn().mockResolvedValue({ cardId: null }),
  };
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  _testResetImportJobStore();
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

// ─── Threshold boundary ─────────────────────────────────────────────────

describe("CF-IMPORT-ASYNC — sync/async threshold boundary (p95-sized)", () => {
  it("threshold constant is 40 (p95-margined, not 50)", () => {
    expect(SYNC_PREVIEW_ROW_THRESHOLD).toBe(40);
  });

  it("≤ threshold (40 rows) → sync result with envelopes inline", async () => {
    const { sessionId } = await signIn();
    const file = makeXlsxBase64(
      ["holdingId", "cardsightCardId", "playerName", "cardYear", "product"],
      Array.from({ length: SYNC_PREVIEW_ROW_THRESHOLD }, (_, i) => [
        `sync-h-${i}-${Date.now()}`,
        `sync-card-${i}-${Date.now()}`,
        `Sync Player ${i}`,
        2026,
        "Bowman",
      ]),
    );
    const res = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ file, format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.body.envelopes).toBeDefined();
    expect(res.body.envelopes).toHaveLength(SYNC_PREVIEW_ROW_THRESHOLD);
    // Async kickoff fields should NOT be present on the sync path
    expect(res.body.async).toBeUndefined();
    expect(res.body.jobId).toBeUndefined();
  });

  it("> threshold (41 rows) → async kickoff with jobId, no envelopes inline", async () => {
    const { sessionId } = await signIn();
    const file = makeXlsxBase64(
      ["holdingId", "cardsightCardId", "playerName", "cardYear", "product"],
      Array.from({ length: SYNC_PREVIEW_ROW_THRESHOLD + 1 }, (_, i) => [
        `async-h-${i}-${Date.now()}`,
        `async-card-${i}-${Date.now()}`,
        `Async Player ${i}`,
        2026,
        "Bowman",
      ]),
    );
    const res = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ file, format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.body.async).toBe(true);
    expect(typeof res.body.jobId).toBe("string");
    expect(res.body.jobId.length).toBeGreaterThan(0);
    expect(res.body.totalRows).toBe(SYNC_PREVIEW_ROW_THRESHOLD + 1);
    // Async response carries auto-map + headers info but NO envelopes
    expect(res.body.proposedMapping).toBeDefined();
    expect(res.body.envelopes).toBeUndefined();
  });
});

// ─── Job lifecycle: kick → poll → ready ────────────────────────────────

describe("CF-IMPORT-ASYNC — job lifecycle: kick → poll → ready", () => {
  it("kick async, poll until status === ready, envelopes available", async () => {
    const { sessionId } = await signIn();
    const file = makeXlsxBase64(
      ["holdingId", "cardsightCardId", "playerName", "cardYear", "product"],
      Array.from({ length: SYNC_PREVIEW_ROW_THRESHOLD + 5 }, (_, i) => [
        `lifecycle-h-${i}-${Date.now()}`,
        `lifecycle-card-${i}-${Date.now()}`,
        `Lifecycle Player ${i}`,
        2026,
        "Bowman",
      ]),
    );
    const kick = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ file, format: "xlsx" });
    expect(kick.status).toBe(200);
    expect(kick.body.async).toBe(true);
    const jobId = kick.body.jobId as string;

    // Poll for status — with mocked resolver returning null synchronously
    // (no Cardsight HTTP), the job completes very quickly.
    let attempts = 0;
    let final: { status: string; envelopes?: unknown[]; progress?: { rowsProcessed: number; rowsTotal: number } } | null = null;
    while (attempts < 30) {
      const poll = await request(app)
        .get(`/api/portfolio/import/jobs/${jobId}`)
        .set("x-session-id", sessionId);
      expect(poll.status).toBe(200);
      if (poll.body.status === "ready" || poll.body.status === "failed") {
        final = poll.body;
        break;
      }
      // Brief await for event-loop progress
      await new Promise((r) => setImmediate(r));
      attempts += 1;
    }
    expect(final).not.toBeNull();
    expect(final!.status).toBe("ready");
    expect(final!.envelopes).toBeDefined();
    expect(final!.envelopes).toHaveLength(SYNC_PREVIEW_ROW_THRESHOLD + 5);
    expect(final!.progress!.rowsProcessed).toBe(SYNC_PREVIEW_ROW_THRESHOLD + 5);
  });

  it("404 when polling unknown jobId", async () => {
    const { sessionId } = await signIn();
    const res = await request(app)
      .get("/api/portfolio/import/jobs/nonexistent-job-id")
      .set("x-session-id", sessionId);
    expect(res.status).toBe(404);
  });
});

// ─── Staleness ──────────────────────────────────────────────────────────

describe("CF-IMPORT-ASYNC — staleness detection (the instance-recycled-mid-job recovery path)", () => {
  it("staleness threshold is 10 minutes", () => {
    expect(STALENESS_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });

  it("a 'processing' job with no progress > 10min → next poll marks 'stale'", async () => {
    const { sessionId, userId } = await signIn();
    const jobId = `stale-test-${Date.now()}`;
    // Hand-write a job in the "processing" state with a deliberately
    // old lastProgressAt — simulates the importer Promise dying without
    // updating progress.
    const tenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const stuckJob: ImportJobDoc = {
      id: `import-job-${jobId}`,
      userId,
      jobId,
      status: "processing",
      progress: { rowsProcessed: 100, rowsTotal: 500, lastProgressAt: tenMinutesAgo },
      ttl: IMPORT_JOB_TTL_SECONDS,
      createdAt: tenMinutesAgo,
      updatedAt: tenMinutesAgo,
    };
    await writeImportJob(stuckJob);

    const poll = await request(app)
      .get(`/api/portfolio/import/jobs/${jobId}`)
      .set("x-session-id", sessionId);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe("stale");
    expect(poll.body.errorMessage).toContain("recycled");

    // Persisted: re-read returns "stale" too (markStaleIfNeeded wrote it back).
    const persisted = await readImportJob(userId, jobId);
    expect(persisted!.status).toBe("stale");
  });

  it("a 'processing' job with RECENT progress is NOT marked stale", async () => {
    const { sessionId, userId } = await signIn();
    const jobId = `not-stale-${Date.now()}`;
    const oneSecondAgo = new Date(Date.now() - 1_000).toISOString();
    await writeImportJob({
      id: `import-job-${jobId}`,
      userId,
      jobId,
      status: "processing",
      progress: { rowsProcessed: 50, rowsTotal: 500, lastProgressAt: oneSecondAgo },
      ttl: IMPORT_JOB_TTL_SECONDS,
      createdAt: oneSecondAgo,
      updatedAt: oneSecondAgo,
    });

    const poll = await request(app)
      .get(`/api/portfolio/import/jobs/${jobId}`)
      .set("x-session-id", sessionId);
    expect(poll.body.status).toBe("processing");
  });

  it("a 'ready' job is NEVER marked stale, regardless of lastProgressAt age", async () => {
    const { sessionId, userId } = await signIn();
    const jobId = `ready-stale-immune-${Date.now()}`;
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await writeImportJob({
      id: `import-job-${jobId}`,
      userId,
      jobId,
      status: "ready",
      progress: { rowsProcessed: 500, rowsTotal: 500, lastProgressAt: longAgo },
      envelopes: [],
      ttl: IMPORT_JOB_TTL_SECONDS,
      createdAt: longAgo,
      updatedAt: longAgo,
    });

    const poll = await request(app)
      .get(`/api/portfolio/import/jobs/${jobId}`)
      .set("x-session-id", sessionId);
    expect(poll.body.status).toBe("ready");
  });
});

// ─── Progress-write throttle ────────────────────────────────────────────

describe("CF-IMPORT-ASYNC — progress-write throttle (~5s)", () => {
  it("PROGRESS_WRITE_THROTTLE_MS is 5000", () => {
    expect(PROGRESS_WRITE_THROTTLE_MS).toBe(5000);
  });
});

// ─── TTL: per-doc 24h ─────────────────────────────────────────────────

describe("CF-IMPORT-ASYNC — per-doc TTL (24h, with container defaultTtl: -1 safety)", () => {
  it("IMPORT_JOB_TTL_SECONDS is 24h (86400)", () => {
    expect(IMPORT_JOB_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it("writeImportJob persists the ttl field as 86400 by default", async () => {
    const { userId } = await signIn();
    const jobId = `ttl-test-${Date.now()}`;
    await writeImportJob({
      id: `import-job-${jobId}`,
      userId,
      jobId,
      status: "pending",
      progress: { rowsProcessed: 0, rowsTotal: 0, lastProgressAt: new Date().toISOString() },
      ttl: IMPORT_JOB_TTL_SECONDS,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const got = await readImportJob(userId, jobId);
    expect(got).not.toBeNull();
    expect(got!.ttl).toBe(86400);
  });

  it("defensive default: writeImportJob fills ttl when caller drops it", async () => {
    const { userId } = await signIn();
    const jobId = `ttl-default-${Date.now()}`;
    // Deliberately omit ttl (cast through unknown to bypass the type) —
    // this models a future code path that forgets to set it.
    await writeImportJob({
      id: `import-job-${jobId}`,
      userId,
      jobId,
      status: "pending",
      progress: { rowsProcessed: 0, rowsTotal: 0, lastProgressAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as ImportJobDoc);
    const got = await readImportJob(userId, jobId);
    expect(got!.ttl).toBe(86400);
  });

  it("preview-kickoff path: the doc the async preview writes has ttl set", async () => {
    const { sessionId, userId } = await signIn();
    const file = makeXlsxBase64(
      ["holdingId", "cardsightCardId", "playerName", "cardYear", "product"],
      Array.from({ length: SYNC_PREVIEW_ROW_THRESHOLD + 1 }, (_, i) => [
        `ttl-kick-${i}`, `ttl-card-${i}`, `Player ${i}`, 2026, "Bowman",
      ]),
    );
    const kick = await request(app)
      .post("/api/portfolio/import/preview")
      .set("x-session-id", sessionId)
      .send({ file, format: "xlsx" });
    expect(kick.body.async).toBe(true);
    const jobId = kick.body.jobId as string;
    const persisted = await readImportJob(userId, jobId);
    expect(persisted!.ttl).toBe(86400);
  });
});
