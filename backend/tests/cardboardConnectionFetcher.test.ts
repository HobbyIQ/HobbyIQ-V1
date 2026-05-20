import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchCardboardConnectionChecklist,
  looksLikeXlsx,
} from "../src/agents/cardboardConnection/cardboardConnectionFetcher.js";

describe("Cardboard Connection fetcher", () => {
  const originalFetch = globalThis.fetch;
  const url =
    "https://www.cardboardconnection.com/wp-content/uploads/2022/02/2022-Topps-Series-1-Baseball-checklist-Excel-spreadsheet.xlsx";

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("validates xlsx magic bytes", () => {
    expect(looksLikeXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(looksLikeXlsx(new Uint8Array([0x3c, 0x68, 0x74, 0x6d]))).toBe(false);
  });

  it("downloads a valid workbook with resolved URL", async () => {
    const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 200 })) as any;

    const got = await fetchCardboardConnectionChecklist({
      year: 2022,
      brand: "Topps",
      sport: "Baseball",
      resolvedUrl: url,
      maxRetries: 0,
    });

    expect(got.url).toBe(url);
    expect(got.bytes.byteLength).toBe(body.byteLength);
    expect(got.fetchAttempts.length).toBe(1);
  });

  it("retries 404 responses then fails cleanly", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as any;

    await expect(
      fetchCardboardConnectionChecklist({
        year: 2022,
        brand: "Topps",
        sport: "Baseball",
        resolvedUrl: url,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/Failed to download valid \.xlsx/);

    expect((globalThis.fetch as any).mock.calls.length).toBe(3);
  });

  it("retries network errors with backoff then fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as any;

    await expect(
      fetchCardboardConnectionChecklist({
        year: 2022,
        brand: "Topps",
        sport: "Baseball",
        resolvedUrl: url,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/Failed to download valid \.xlsx/);

    expect((globalThis.fetch as any).mock.calls.length).toBe(3);
  });
});
