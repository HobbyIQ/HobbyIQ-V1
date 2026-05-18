/**
 * Unit tests for the Beckett URL discovery layer.
 *
 * Pure / offline tests only — the real S3 HEAD probes are exercised by the
 * orchestrator's integration phase. Here we cover:
 *   - Candidate enumeration shape
 *   - Brand-variant table coverage
 *   - 404-resilience via a mocked fetch
 *   - Non-primary variant flagging
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  BRAND_VARIANTS,
  enumerateCandidateUrls,
  discoverBeckettChecklistUrl,
} from "../src/agents/beckett/beckettUrlDiscovery.js";

describe("enumerateCandidateUrls", () => {
  it("emits months × suffixes × variants × sport-flag candidates", () => {
    const cands = enumerateCandidateUrls({
      year: 2022,
      brand: "Bowman",
      sport: "Baseball",
      months: ["04", "05"],
      suffixes: ["", "-2"],
    });
    // 1 variant × 2 months × 2 suffixes × 3 sport-placements = 12
    expect(cands.length).toBe(12);
    expect(cands.every((c) => c.url.startsWith("https://beckett-www.s3.amazonaws.com/"))).toBe(true);
    expect(cands.some((c) => c.url.includes("-Baseball-Checklist"))).toBe(true);
    expect(cands.some((c) => !c.url.includes("-Baseball-"))).toBe(true);
    // Per-placement assertions
    const prefix = cands.filter((c) => c.sportPlacement === "prefix");
    const suffix = cands.filter((c) => c.sportPlacement === "suffix");
    const omitted = cands.filter((c) => c.sportPlacement === "omitted");
    expect(prefix.length).toBe(4);
    expect(suffix.length).toBe(4);
    expect(omitted.length).toBe(4);
  });

  it("includes every brand variant in BRAND_VARIANTS table", () => {
    const cands = enumerateCandidateUrls({
      year: 2022,
      brand: "Bowman Chrome",
      sport: "Baseball",
      months: ["09"],
      suffixes: [""],
    });
    const variants = new Set(cands.map((c) => c.brandVariant));
    for (const v of BRAND_VARIANTS["Bowman Chrome"]!) {
      expect(variants.has(v)).toBe(true);
    }
  });

  it("falls back to the brand name as-is when not in BRAND_VARIANTS", () => {
    const cands = enumerateCandidateUrls({
      year: 2022,
      brand: "UnknownBrand",
      sport: "Baseball",
      months: ["04"],
      suffixes: [""]
    });
    expect(cands.every((c) => c.brandVariant === "UnknownBrand")).toBe(true);
    expect(cands.length).toBe(3); // 1 × 1 × 1 × 3 sport-placements
    // Per-placement assertions
    const prefix = cands.filter((c) => c.sportPlacement === "prefix");
    const suffix = cands.filter((c) => c.sportPlacement === "suffix");
    const omitted = cands.filter((c) => c.sportPlacement === "omitted");
    expect(prefix.length).toBe(1);
    expect(suffix.length).toBe(1);
    expect(omitted.length).toBe(1);
  });
});

describe("discoverBeckettChecklistUrl", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns success when a candidate returns 200 with octet-stream", async () => {
    const winningUrl =
      "https://beckett-www.s3.amazonaws.com/news/news-content/uploads/2022/04/2022-Bowman-Baseball-Checklist.xlsx";
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url) === winningUrl) {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "application/octet-stream", "content-length": "150000" },
        });
      }
      return new Response(null, { status: 404 });
    }) as any;

    const result = await discoverBeckettChecklistUrl({
      year: 2022,
      brand: "Bowman",
      sport: "Baseball",
      months: ["04"],
      suffixes: [""],
      timeoutMs: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.url).toBe(winningUrl);
    expect(result.statusCode).toBe(200);
    expect(result.matchedBrandVariant).toBe("Bowman");
    expect(result.matchedNonPrimaryVariant).toBe(false);
  });

  it("handles 404 on every candidate gracefully (no throw)", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as any;
    const result = await discoverBeckettChecklistUrl({
      year: 2099,
      brand: "Bowman",
      sport: "Baseball",
      months: ["04"],
      suffixes: [""],
      timeoutMs: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.url).toBeNull();
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.attempts.every((a) => a.status === 404)).toBe(true);
  });

  it("flags non-primary variant when the second variant wins", async () => {
    const winningUrl =
      "https://beckett-www.s3.amazonaws.com/news/news-content/uploads/2022/09/2022-BowmanChrome-Baseball-Checklist.xlsx";
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url) === winningUrl) {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "application/octet-stream", "content-length": "150000" },
        });
      }
      return new Response(null, { status: 404 });
    }) as any;

    const result = await discoverBeckettChecklistUrl({
      year: 2022,
      brand: "Bowman Chrome",
      sport: "Baseball",
      months: ["09"],
      suffixes: [""],
      timeoutMs: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.matchedBrandVariant).toBe("BowmanChrome");
    expect(result.matchedNonPrimaryVariant).toBe(true);
  });

  it("treats network error as miss, not crash", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("dns lookup failed");
    }) as any;
    const result = await discoverBeckettChecklistUrl({
      year: 2022,
      brand: "Bowman",
      sport: "Baseball",
      months: ["04"],
      suffixes: [""],
      timeoutMs: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.attempts.every((a) => a.status === "network-error")).toBe(true);
  });
});
