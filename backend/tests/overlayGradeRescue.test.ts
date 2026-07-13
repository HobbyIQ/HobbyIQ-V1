// CF-CARD-PANEL-GRADE-RESCUE (Drew, 2026-07-13, PR #406) — verifies the
// /card-panel route's graded rescue: when CH's grade curve is empty
// (Cardsight-only SKU), pool the resolver's per-record raw + graded comps
// through our own median/confidence math and emit grade-rail entries.
//
// Guards the "vendor-as-data-pipe, engine-as-brain" contract: vendors
// provide sale records, we compute the derived signals.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildRescuedGradeEntries,
  buildRescuedRawEntry,
  overlayGradeRescue,
} from "../src/services/compiq/resolverFallbackHelper.js";
import * as resolver from "../src/services/compiq/catalogResolver.service.js";

const baseQuery = {
  cardId: "cs-abc",
  playerName: "Eric Hartman",
  cardYear: 2026,
  setName: "2026 Bowman Baseball",
  cardNumber: "CPA-EHA",
} as const;

const gradedComps = [
  { saleDate: "2026-07-05", price: 500, gradeCompany: "PSA", gradeValue: 10 },
  { saleDate: "2026-07-06", price: 550, gradeCompany: "PSA", gradeValue: 10 },
  { saleDate: "2026-07-04", price: 300, gradeCompany: "PSA", gradeValue: 9 },
  { saleDate: "2026-07-02", price: 100, gradeCompany: "BGS", gradeValue: 10 },
];
const rawComps = [
  { saleDate: "2026-07-01", price: 90 },
  { saleDate: "2026-07-03", price: 110 },
  { saleDate: "2026-07-02", price: 100 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildRescuedGradeEntries", () => {
  it("groups records by (grader, grade) into per-bucket entries", () => {
    const entries = buildRescuedGradeEntries(gradedComps);
    expect(entries).toHaveLength(3);
    const psa10 = entries.find((e) => e.grader === "PSA" && e.grade === "10");
    expect(psa10?.sampleCount).toBe(2);
    expect(psa10?.value).toBe(525);   // median of 500 and 550
    expect(psa10?.valueSource).toBe("observed");
  });

  it("orders grader PSA → BGS → SGC → CGC and grade DESC within grader", () => {
    const entries = buildRescuedGradeEntries(gradedComps);
    expect(entries.map((e) => `${e.grader}-${e.grade}`)).toEqual([
      "PSA-10",
      "PSA-9",
      "BGS-10",
    ]);
  });

  it("formats half-grades as strings preserving the decimal", () => {
    const half = [
      { saleDate: "2026-07-01", price: 400, gradeCompany: "BGS", gradeValue: 9.5 },
      { saleDate: "2026-07-02", price: 410, gradeCompany: "BGS", gradeValue: 9.5 },
    ];
    const entries = buildRescuedGradeEntries(half);
    expect(entries[0].grade).toBe("9.5");
  });

  it("returns empty when no graded records", () => {
    expect(buildRescuedGradeEntries([])).toEqual([]);
  });

  it("sets confidence tiers from sample count", () => {
    const psa10 = buildRescuedGradeEntries(gradedComps).find(
      (e) => e.grade === "10" && e.grader === "PSA",
    );
    // 2 comps in the < 60d recency window → base 0.20, no age penalty
    expect(psa10?.confidenceScore).toBe(0.2);
  });
});

describe("buildRescuedRawEntry", () => {
  it("emits a Raw entry with median + range", () => {
    const raw = buildRescuedRawEntry(rawComps);
    expect(raw).not.toBeNull();
    expect(raw!.grade).toBe("Raw");
    expect(raw!.grader).toBe("RAW");
    expect(raw!.sampleCount).toBe(3);
    expect(raw!.value).toBe(100);   // median of 90, 100, 110
  });

  it("returns null when there are no raw records", () => {
    expect(buildRescuedRawEntry([])).toBeNull();
  });

  it("drops records with non-positive prices (defensive boundary)", () => {
    const raw = buildRescuedRawEntry([
      { saleDate: "2026-07-01", price: 100 },
      { saleDate: "2026-07-02", price: 0 },
      { saleDate: "2026-07-03", price: -50 },
    ]);
    expect(raw!.sampleCount).toBe(1);
    expect(raw!.value).toBe(100);
  });
});

describe("overlayGradeRescue", () => {
  it("populates gradeCurve when CH returned empty entries", async () => {
    vi.spyOn(resolver, "resolveCard").mockResolvedValue({
      winner: {
        vendor: "cardsight",
        cardId: "cs-abc",
        fairMarketValue: 100,
        compCount: 3,
        freshestSaleDate: "2026-07-03",
        confidence: "high",
        rawComps,
        gradedComps,
      },
      responses: [],
      fromCache: false,
    });
    const response: any = {
      gradeCurve: {
        totalSampleCount: 0,
        computedAt: "2026-07-13T00:00:00Z",
        entries: [],
      },
    };
    await overlayGradeRescue(response, baseQuery);
    // raw=3 + PSA10=2 + PSA9=1 + BGS10=1 = 7 pooled samples across 4 entries
    expect(response.gradeCurve.totalSampleCount).toBe(7);
    expect(response.gradeCurve.entries).toHaveLength(4);
    const grades = response.gradeCurve.entries.map(
      (e: any) => `${e.grader}-${e.grade}`,
    );
    expect(grades).toContain("RAW-Raw");
    expect(grades).toContain("PSA-10");
    expect(grades).toContain("PSA-9");
    expect(grades).toContain("BGS-10");
    // computedAt refreshed on rescue
    expect(response.gradeCurve.computedAt).not.toBe("2026-07-13T00:00:00Z");
  });

  it("passes through with no change when CH already has samples", async () => {
    const resolverSpy = vi.spyOn(resolver, "resolveCard");
    const response: any = {
      gradeCurve: {
        totalSampleCount: 10,
        entries: [{ grade: "10", grader: "PSA", sampleCount: 10 }],
      },
    };
    await overlayGradeRescue(response, baseQuery);
    expect(response.gradeCurve.totalSampleCount).toBe(10);
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it("skips when resolver returns cardhedge (primary path already saw it)", async () => {
    vi.spyOn(resolver, "resolveCard").mockResolvedValue({
      winner: {
        vendor: "cardhedge",
        cardId: "ch-abc",
        fairMarketValue: 100,
        compCount: 3,
        freshestSaleDate: "2026-07-01",
        confidence: "high",
        rawComps,
        gradedComps,
      },
      responses: [],
      fromCache: false,
    });
    const response: any = {
      gradeCurve: { totalSampleCount: 0, entries: [] },
    };
    await overlayGradeRescue(response, baseQuery);
    expect(response.gradeCurve.entries).toEqual([]);
  });

  it("skips when resolver had no comps to offer", async () => {
    vi.spyOn(resolver, "resolveCard").mockResolvedValue({
      winner: {
        vendor: "cardsight",
        cardId: "cs-abc",
        fairMarketValue: null,
        compCount: 0,
        freshestSaleDate: null,
        confidence: "low",
        rawComps: [],
        gradedComps: [],
      },
      responses: [],
      fromCache: false,
    });
    const response: any = {
      gradeCurve: { totalSampleCount: 0, entries: [] },
    };
    await overlayGradeRescue(response, baseQuery);
    expect(response.gradeCurve.entries).toEqual([]);
  });

  it("never throws when resolver errors — response passes through", async () => {
    vi.spyOn(resolver, "resolveCard").mockRejectedValue(new Error("network"));
    const response: any = {
      gradeCurve: { totalSampleCount: 0, entries: [] },
    };
    await expect(overlayGradeRescue(response, baseQuery)).resolves.not.toThrow();
    expect(response.gradeCurve.entries).toEqual([]);
  });

  it("survives when response is malformed (no gradeCurve)", async () => {
    const response: any = { success: true };
    await expect(overlayGradeRescue(response, baseQuery)).resolves.toBe(response);
  });
});
