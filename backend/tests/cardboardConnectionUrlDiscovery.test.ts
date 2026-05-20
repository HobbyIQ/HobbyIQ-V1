import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CC_MAX_PROBES,
  discoverCardboardConnectionChecklistUrl,
  enumerateCardboardConnectionCandidateUrls,
} from "../src/agents/cardboardConnection/cardboardConnectionUrlDiscovery.js";

describe("Cardboard Connection URL discovery", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("builds a probe ladder with month + suffix variants", () => {
    const candidates = enumerateCardboardConnectionCandidateUrls({
      year: 2022,
      brand: "Topps",
      sport: "Baseball",
      months: ["02"],
    });
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates.some((c) => c.url.includes("checklist-Excel-spreadsheet.xlsx"))).toBe(true);
    expect(candidates.some((c) => c.url.includes("checklist.xlsx"))).toBe(true);
  });

  it("returns first successful URL and attemptedUrls audit trail", async () => {
    const hit =
      "https://www.cardboardconnection.com/wp-content/uploads/2022/02/2022-Topps-Series-1-Baseball-checklist-Excel-spreadsheet.xlsx";

    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url) === hit) {
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-length": "4096",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as any;

    const result = await discoverCardboardConnectionChecklistUrl({
      year: 2022,
      brand: "Topps",
      sport: "Baseball",
      months: ["02"],
      maxProbes: 36,
      minSpacingMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.url).toBe(hit);
    expect(result.attemptedUrls.length).toBeGreaterThan(0);
    expect(result.statusCode).toBe(200);
  });

  it("honors probe cap and all-miss path is clean", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as any;

    const result = await discoverCardboardConnectionChecklistUrl({
      year: 2022,
      brand: "Topps",
      sport: "Baseball",
      maxProbes: 7,
      minSpacingMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.url).toBeNull();
    expect(result.attemptedUrls.length).toBe(7);
    expect(result.attempts.every((a) => a.status === 404)).toBe(true);
  });

  it("defaults to 36 probes", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as any;

    const result = await discoverCardboardConnectionChecklistUrl({
      year: 2022,
      brand: "Topps",
      sport: "Baseball",
      minSpacingMs: 0,
    });
    expect(result.attemptedUrls.length).toBe(DEFAULT_CC_MAX_PROBES);
  });
});
