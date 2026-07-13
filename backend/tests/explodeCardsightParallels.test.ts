// CF-EXPLODE-CARDSIGHT-PARALLELS (Drew, 2026-07-13, PR #413) — every
// Cardsight UUID parent explodes into N candidates so reconciliation +
// picker + Find-Cards surfaces all see each parallel as its own row.

import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchCardsightUuidNativeCandidates } from "../src/services/compiq/cardsightUuidSource.js";
import * as slim from "../src/services/compiq/cardsightSlim.client.js";

const HARTMAN_HIT = {
  id: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
  name: "Eric Hartman",
  number: "CPA-EHA",
  releaseName: "Bowman",
  setName: "Chrome Prospects Autographs",
  year: 2026,
};

const HARTMAN_DETAIL_FULL = {
  id: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
  name: "Eric Hartman",
  number: "CPA-EHA",
  releaseName: "Bowman",
  setName: "Chrome Prospects Autographs",
  year: 2026,
  parallels: [
    { id: "334908f4-bf5f-4ed5-98c7-75113561ab55", name: "Blue Refractor", numberedTo: 150 },
    { id: "b83de312-609d-4d58-af41-c8766a81835f", name: "Blue X-Fractor", numberedTo: 150 },
    { id: "8d2a3915-56b7-49a1-9851-86d9b1342152", name: "Speckle Refractor", numberedTo: 299 },
    { id: "fa14bc6c-8cfb-484b-8353-164e946e24c8", name: "Breaker Delight Exclusive Parallels:" },
    { id: "7f2779f2-e5ab-4437-97c5-d88464ddcfba", name: "Retail Exclusive Parallels:" },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("explode UUID parent into per-parallel candidates", () => {
  it("emits ONE candidate per parallel (not one per parent)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL_FULL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    // 3 real parallels + 2 subgroup headers filtered = 3 candidates
    expect(candidates).toHaveLength(3);
    const parallels = candidates.map((c) => c.parallel);
    expect(parallels).toContain("Blue Refractor");
    expect(parallels).toContain("Blue X-Fractor");
    expect(parallels).toContain("Speckle Refractor");
  });

  it("candidateId is compound: cardsight:{parentId}::{parallelId}", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL_FULL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    const blueRef = candidates.find((c) => c.parallel === "Blue Refractor")!;
    expect(blueRef.candidateId).toBe(
      "cardsight:befe9bcc-e7e8-458c-9cd8-ce831848b9a1::334908f4-bf5f-4ed5-98c7-75113561ab55",
    );
  });

  it("filters subgroup headers (names ending in colon)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL_FULL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    for (const c of candidates) {
      expect(c.parallel).not.toContain("Exclusive Parallels:");
    }
  });

  it("every exploded row carries the shared parent identity", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL_FULL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    for (const c of candidates) {
      expect(c.player).toBe("Eric Hartman");
      expect(c.cardNumber).toBe("CPA-EHA");
      expect(c.year).toBe(2026);
      expect(c.setName).toBe("Chrome Prospects Autographs");
      expect(c.isAuto).toBe(true);
    }
  });

  it("exploded rows have EMPTY parallels[] (row IS the parallel)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL_FULL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    for (const c of candidates) {
      expect(c.parallels).toEqual([]);
    }
  });

  it("title composes with the parallel name for visual distinctness in the picker", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL_FULL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    const blueRef = candidates.find((c) => c.parallel === "Blue Refractor")!;
    expect(blueRef.title).toContain("Blue Refractor");
    expect(blueRef.title).toContain("Eric Hartman");
    expect(blueRef.title).toContain("CPA-EHA");
  });

  it("confidence decays per-parallel within a parent (preserves picker order)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL_FULL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    // Confidence is monotonically non-increasing across the exploded rows
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].confidence).toBeLessThanOrEqual(candidates[i - 1].confidence!);
    }
  });

  it("emits no candidates when the parent has zero real parallels", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue({
      ...HARTMAN_DETAIL_FULL,
      parallels: [
        { id: "aaa", name: "Some Group:" },
        { id: "bbb", name: "Another Group:" },
      ],
    } as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    expect(candidates).toEqual([]);
  });
});
