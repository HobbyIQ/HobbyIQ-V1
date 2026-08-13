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
  yearTokensFor,
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

// CF-BECKETT-SEASON-YEAR (Drew, 2026-08-13: "check for basketball football and
// hocket, we need it").
//
// Basketball and hockey are season-dated products and Beckett names the file to
// match. Rendering only a single year meant those URLs were never enumerated,
// so every basketball/hockey seed reported "no checklist published" — ~15,300
// of the seed queue's demand, written off while the files existed.
describe("season-year tokens", () => {
  it("emits only the plain year for single-year sports", () => {
    // Baseball and football really are single-year: the live
    // 2024-Panini-Prizm-Football checklist resolves. Adding season tokens here
    // would triple every probe for nothing and eat the probe cap.
    expect(yearTokensFor(2024, "baseball")).toEqual(["2024"]);
    expect(yearTokensFor(2025, "football")).toEqual(["2025"]);
  });

  it("adds both adjacent seasons for basketball and hockey", () => {
    // A seed's `year` can be either half of the season it came from, so both
    // are tried. Plain year stays FIRST so a single-year product still
    // resolves in one probe.
    expect(yearTokensFor(2025, "basketball")).toEqual(["2025", "2024-25", "2025-26"]);
    expect(yearTokensFor(2024, "hockey")).toEqual(["2024", "2023-24", "2024-25"]);
  });

  it("pads the two-digit half across a century boundary", () => {
    expect(yearTokensFor(2000, "basketball")).toEqual(["2000", "1999-00", "2000-01"]);
  });

  it("is case-insensitive on sport", () => {
    expect(yearTokensFor(2025, "Basketball")).toEqual(["2025", "2024-25", "2025-26"]);
  });

  it("enumerates the season filename that actually exists", () => {
    // Verified live 2026-08-13:
    //   2024-Panini-Prizm-Basketball-Checklist.xlsx     not found
    //   2024-25-Panini-Prizm-Basketball-Checklist.xlsx  FOUND
    const urls = enumerateCandidateUrls({ year: 2025, brand: "Panini Prizm", sport: "basketball" })
      .map((a) => a.url);
    expect(urls.some((u) => u.includes("2024-25-Panini-Prizm-Basketball-Checklist.xlsx"))).toBe(true);
  });

  it("still enumerates the single-year baseball filename", () => {
    const urls = enumerateCandidateUrls({ year: 2024, brand: "Bowman Chrome", sport: "baseball" })
      .map((a) => a.url);
    expect(urls.some((u) => u.includes("2024-Bowman-Chrome-Baseball-Checklist.xlsx"))).toBe(true);
  });
});
