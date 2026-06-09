/**
 * CF-PLAYER-IN-SET-HISTORY PART 1 — enqueuePlayerSetTuple unit tests.
 *
 * CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): the tuple identity is
 * (player, release, year) — NOT (player, set, year). Tests use the
 * release field (e.g. "Bowman Draft", "Topps Update") which is the
 * unique-per-edition scope; the literal Cardsight "Base Set" subset
 * name collides across products and is no longer accepted.
 *
 * The service is best-effort fire-and-forget; tests assert that:
 *   - invalid inputs (empty player/release, missing/zero year) are no-ops
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

  it("returns silently when player or release is empty", async () => {
    await enqueuePlayerSetTuple({ player: "", release: "Bowman Draft", year: 2024 });
    await enqueuePlayerSetTuple({ player: "Trout", release: "", year: 2024 });
    expect(fromConnectionStringMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns silently when year is missing or non-positive", async () => {
    await enqueuePlayerSetTuple({ player: "Trout", release: "Topps Update", year: 0 });
    await enqueuePlayerSetTuple({ player: "Trout", release: "Topps Update", year: NaN });
    await enqueuePlayerSetTuple({ player: "Trout", release: "Topps Update", year: -1 });
    // @ts-expect-error — runtime guard catches undefined too
    await enqueuePlayerSetTuple({ player: "Trout", release: "Topps Update" });
    expect(fromConnectionStringMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns silently when AZURE_BLOB_CONNECTION_STRING is unset", async () => {
    delete process.env.AZURE_BLOB_CONNECTION_STRING;
    // Reset blob client singleton by clearing module cache for this test
    vi.resetModules();
    const fresh = await import("../src/services/compiq/playerSetQueue.service");
    await fresh.enqueuePlayerSetTuple({ player: "Trout", release: "Topps Update", year: 2011 });
    expect(uploadMock).not.toHaveBeenCalled();
    // Reset for subsequent tests
    process.env.AZURE_BLOB_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=k;EndpointSuffix=core.windows.net";
  });

  it("first-time queue (404 on read): uploads the first entry with release+year", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Konnor Griffin", release: "Bowman Draft", year: 2024 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [body] = uploadMock.mock.calls[0];
    const parsed = JSON.parse(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].player).toBe("Konnor Griffin");
    expect(parsed[0].release).toBe("Bowman Draft");
    expect(parsed[0].year).toBe(2024);
    expect(parsed[0].seenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // CF-PLAYER-IN-SET-RELEASE-KEY: legacy `set` field must NOT leak in
    expect(parsed[0]).not.toHaveProperty("set");
  });

  it("appends a new tuple when blob has existing entries", async () => {
    const existing = [
      { player: "Mike Trout", release: "Topps Update", year: 2011, seenAt: "2026-06-09T01:00:00Z" },
    ];
    downloadMock.mockResolvedValue({
      readableStreamBody: readableStreamFromBuffer(Buffer.from(JSON.stringify(existing))),
    });
    await enqueuePlayerSetTuple({ player: "Konnor Griffin", release: "Bowman Draft", year: 2024 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [body] = uploadMock.mock.calls[0];
    const parsed = JSON.parse(body);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].player).toBe("Konnor Griffin");
    expect(parsed[1].release).toBe("Bowman Draft");
  });

  it("does NOT append when tuple already exists in the blob (cross-instance dedupe)", async () => {
    __resetSeenForTest();
    const existing = [
      { player: "Konnor Griffin", release: "Bowman Draft", year: 2024, seenAt: "2026-06-09T01:00:00Z" },
    ];
    downloadMock.mockResolvedValue({
      readableStreamBody: readableStreamFromBuffer(Buffer.from(JSON.stringify(existing))),
    });
    await enqueuePlayerSetTuple({ player: "Konnor Griffin", release: "Bowman Draft", year: 2024 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("DIFFERENT release → DOES append (no collision across products for same player)", async () => {
    // The point of the release-key change: 2024 Bowman Draft Griffin and
    // 2024 Bowman Chrome Griffin are DIFFERENT scopes, so the queue must
    // accept both.
    __resetSeenForTest();
    const existing = [
      { player: "Konnor Griffin", release: "Bowman Draft", year: 2024, seenAt: "2026-06-09T01:00:00Z" },
    ];
    downloadMock.mockResolvedValue({
      readableStreamBody: readableStreamFromBuffer(Buffer.from(JSON.stringify(existing))),
    });
    await enqueuePlayerSetTuple({ player: "Konnor Griffin", release: "Bowman Chrome", year: 2024 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(uploadMock.mock.calls[0][0]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].release).toBe("Bowman Chrome");
  });

  it("DIFFERENT year → DOES append (same release, different edition is a new scope)", async () => {
    __resetSeenForTest();
    const existing = [
      { player: "Mike Trout", release: "Topps Update", year: 2011, seenAt: "2026-06-09T01:00:00Z" },
    ];
    downloadMock.mockResolvedValue({
      readableStreamBody: readableStreamFromBuffer(Buffer.from(JSON.stringify(existing))),
    });
    await enqueuePlayerSetTuple({ player: "Mike Trout", release: "Topps Update", year: 2012 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(uploadMock.mock.calls[0][0]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].year).toBe(2012);
  });

  it("in-process dedupe: same tuple twice in one process does NOT re-read blob", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Trout", release: "Topps Update", year: 2011 });
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    // Second call with same tuple — short-circuits BEFORE blob ops
    await enqueuePlayerSetTuple({ player: "Trout", release: "Topps Update", year: 2011 });
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("case + whitespace normalization in the dedupe key", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Mike Trout", release: "Topps Update", year: 2011 });
    await enqueuePlayerSetTuple({ player: " mike TROUT ", release: "TOPPS update", year: 2011 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("swallows upload errors without throwing (best-effort contract)", async () => {
    const err: any = new Error("BlobNotFound");
    err.statusCode = 404;
    downloadMock.mockRejectedValue(err);
    uploadMock.mockRejectedValue(new Error("Storage rate limit"));
    await expect(
      enqueuePlayerSetTuple({ player: "Trout", release: "Topps Chrome", year: 2024 }),
    ).resolves.toBeUndefined();
  });

  it("non-404 read errors fall back to empty list (still appends + uploads)", async () => {
    const err: any = new Error("Throttled");
    err.statusCode = 503;
    downloadMock.mockRejectedValue(err);
    await enqueuePlayerSetTuple({ player: "Soto", release: "Bowman Chrome", year: 2024 });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });
});
