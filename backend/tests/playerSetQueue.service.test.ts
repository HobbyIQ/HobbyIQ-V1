/**
 * CF-PLAYER-IN-SET-HISTORY PART 1 — enqueuePlayerSetTuple unit tests.
 *
 * The service is best-effort fire-and-forget; tests assert that:
 *   - invalid inputs (empty player/set) are no-ops
 *   - AZURE_BLOB_CONNECTION_STRING absent → no-op (returns cleanly)
 *   - in-process dedupe: same tuple twice in one process → only one
 *     blob write
 *   - blob 404 (first-time queue) → upload happens
 *   - blob read error doesn't propagate
 *
 * Uses vi.mock on @azure/storage-blob to avoid touching real blob.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { downloadMock, uploadMock, createIfNotExistsMock, fromConnectionStringMock } =
  vi.hoisted(() => {
    const downloadMock = vi.fn();
    const uploadMock = vi.fn();
    const createIfNotExistsMock = vi.fn();
    const getBlockBlobClientMock = vi.fn(() => ({
      download: downloadMock,
      upload: uploadMock,
    }));
    const getContainerClientMock = vi.fn(() => ({
      createIfNotExists: createIfNotExistsMock,
      getBlockBlobClient: getBlockBlobClientMock,
    }));
    const fromConnectionStringMock = vi.fn(() => ({
      getContainerClient: getContainerClientMock,
    }));
    return { downloadMock, uploadMock, createIfNotExistsMock, fromConnectionStringMock };
  });

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: fromConnectionStringMock,
  },
}));

import {
  enqueuePlayerSetTuple,
  __resetSeenForTest,
} from "../src/services/compiq/playerSetQueue.service";

function mockEmptyQueue() {
  // First-time blob — 404 on download
  const err: any = new Error("BlobNotFound");
  err.statusCode = 404;
  downloadMock.mockRejectedValue(err);
}

function mockQueueContent(entries: any[]) {
  const body = Buffer.from(JSON.stringify(entries), "utf8");
  downloadMock.mockResolvedValue({
    readableStreamBody: (function* gen() { yield body; })(),
  });
}

// We need a real Readable stream — return a minimal mock object the
// service's streamToBuffer can consume.
function readableStreamFromBuffer(buf: Buffer): NodeJS.ReadableStream {
  const { Readable } = require("stream");
  return Readable.from([buf]);
}

describe("enqueuePlayerSetTuple", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSeenForTest();
    createIfNotExistsMock.mockResolvedValue({});
    uploadMock.mockResolvedValue({});
    process.env.AZURE_BLOB_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=k;EndpointSuffix=core.windows.net";
  });

  it("returns silently when player or set is empty", async () => {
    await enqueuePlayerSetTuple({ player: "", set: "Bowman Draft" });
    await enqueuePlayerSetTuple({ player: "Trout", set: "" });
    expect(fromConnectionStringMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns silently when AZURE_BLOB_CONNECTION_STRING is unset", async () => {
    delete process.env.AZURE_BLOB_CONNECTION_STRING;
    // Reset blob client singleton by clearing module cache for this test
    vi.resetModules();
    const fresh = await import("../src/services/compiq/playerSetQueue.service");
    await fresh.enqueuePlayerSetTuple({ player: "Trout", set: "Topps Update" });
    expect(uploadMock).not.toHaveBeenCalled();
    // Reset for subsequent tests
    process.env.AZURE_BLOB_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=k;EndpointSuffix=core.windows.net";
  });

  it("first-time queue (404 on read): uploads the first entry", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Konnor Griffin", set: "Bowman Draft", year: 2024 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [body] = uploadMock.mock.calls[0];
    const parsed = JSON.parse(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].player).toBe("Konnor Griffin");
    expect(parsed[0].set).toBe("Bowman Draft");
    expect(parsed[0].year).toBe(2024);
    expect(parsed[0].seenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends a new tuple when blob has existing entries", async () => {
    const existing = [
      { player: "Mike Trout", set: "Topps Update", year: 2011, seenAt: "2026-06-09T01:00:00Z" },
    ];
    downloadMock.mockResolvedValue({
      readableStreamBody: readableStreamFromBuffer(Buffer.from(JSON.stringify(existing))),
    });
    await enqueuePlayerSetTuple({ player: "Konnor Griffin", set: "Bowman Draft", year: 2024 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [body] = uploadMock.mock.calls[0];
    const parsed = JSON.parse(body);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].player).toBe("Konnor Griffin");
  });

  it("does NOT append when tuple already exists in the blob (cross-instance dedupe)", async () => {
    __resetSeenForTest(); // make sure in-process Set doesn't short-circuit
    const existing = [
      { player: "Konnor Griffin", set: "Bowman Draft", year: 2024, seenAt: "2026-06-09T01:00:00Z" },
    ];
    downloadMock.mockResolvedValue({
      readableStreamBody: readableStreamFromBuffer(Buffer.from(JSON.stringify(existing))),
    });
    await enqueuePlayerSetTuple({ player: "Konnor Griffin", set: "Bowman Draft", year: 2024 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("in-process dedupe: same tuple twice in one process does NOT re-read blob", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Trout", set: "Topps", year: 2011 });
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    // Second call with same tuple — short-circuits BEFORE blob ops
    await enqueuePlayerSetTuple({ player: "Trout", set: "Topps", year: 2011 });
    expect(downloadMock).toHaveBeenCalledTimes(1); // unchanged
    expect(uploadMock).toHaveBeenCalledTimes(1);   // unchanged
  });

  it("case + whitespace normalization in the dedupe key (Trout = trout = ' Trout ')", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Mike Trout", set: "Topps Update", year: 2011 });
    // Re-attempt with weird casing/spacing — should be treated as same tuple
    await enqueuePlayerSetTuple({ player: " mike TROUT ", set: "TOPPS update", year: 2011 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("swallows upload errors without throwing (best-effort contract)", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    uploadMock.mockRejectedValue(new Error("Storage rate limit"));
    // Must not throw
    await expect(
      enqueuePlayerSetTuple({ player: "Trout", set: "Topps Chrome", year: 2024 }),
    ).resolves.toBeUndefined();
  });

  it("non-404 read errors fall back to empty list (still appends + uploads)", async () => {
    const err: any = new Error("Throttled");
    err.statusCode = 503;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Soto", set: "Bowman", year: 2024 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });
});
