// CF-RELEASE-AUTO-DETECT (2026-07-05) — pins the spike-detection
// heuristic that finds a set's release date from CH additions-summary
// when the hard-coded RELEASE_DATES table doesn't cover the set.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getAdditionsSummary: vi.fn(),
}));

const FAKE_NOW = new Date("2026-07-05T00:00:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  // NOTE: releaseAutoDetect.service uses cacheWrap; the cache lives
  // across tests. In practice each test uses a different (year, set)
  // key so no collision. If we ever need to reset, we'd expose a hook.
});

function iso(daysBefore: number): string {
  return new Date(FAKE_NOW.getTime() - daysBefore * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

describe("CF-RELEASE-AUTO-DETECT — detectReleaseDateForSet", () => {
  it("returns the earliest spike day when additions ramp above threshold", async () => {
    const { getAdditionsSummary } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    // 60-day window with baseline of ~2 additions/day, then a huge
    // spike of 500 on day-21 (the release day).
    const rows = [] as any[];
    for (let d = 55; d >= 22; d--) {
      rows.push({ added_date: iso(d), card_count: 2, category: "Baseball", set_name: "Custom Set", subset: null, variants: null });
    }
    rows.push({ added_date: iso(21), card_count: 500, category: "Baseball", set_name: "Custom Set", subset: null, variants: null });
    for (let d = 20; d >= 0; d--) {
      rows.push({ added_date: iso(d), card_count: 8, category: "Baseball", set_name: "Custom Set", subset: null, variants: null });
    }
    vi.mocked(getAdditionsSummary).mockResolvedValue({
      data: rows,
      page: 1,
      page_size: 200,
    } as any);

    const { detectReleaseDateForSet } = await import(
      "../src/services/compiq/releaseAutoDetect.service.js"
    );
    const detected = await detectReleaseDateForSet(2026, "Custom Auto Set A", FAKE_NOW);
    expect(detected).toBe(iso(21));
  });

  it("returns null when no day meets the absolute floor (all-quiet catalog)", async () => {
    const { getAdditionsSummary } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    // Steady 5/day for 60 days — never crosses the absolute floor (50).
    const rows = [] as any[];
    for (let d = 59; d >= 0; d--) {
      rows.push({ added_date: iso(d), card_count: 5, category: "Baseball", set_name: "Custom Set", subset: null, variants: null });
    }
    vi.mocked(getAdditionsSummary).mockResolvedValue({
      data: rows,
      page: 1,
      page_size: 200,
    } as any);

    const { detectReleaseDateForSet } = await import(
      "../src/services/compiq/releaseAutoDetect.service.js"
    );
    const detected = await detectReleaseDateForSet(2026, "Custom Auto Set B", FAKE_NOW);
    expect(detected).toBeNull();
  });

  it("returns null when CH returns empty data (product not tracked)", async () => {
    const { getAdditionsSummary } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(getAdditionsSummary).mockResolvedValue({
      data: [],
      page: 1,
      page_size: 200,
    } as any);

    const { detectReleaseDateForSet } = await import(
      "../src/services/compiq/releaseAutoDetect.service.js"
    );
    const detected = await detectReleaseDateForSet(2026, "Custom Auto Set C", FAKE_NOW);
    expect(detected).toBeNull();
  });

  it("returns null when CH endpoint call itself fails (silent no-throw)", async () => {
    const { getAdditionsSummary } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(getAdditionsSummary).mockResolvedValue(null as any);

    const { detectReleaseDateForSet } = await import(
      "../src/services/compiq/releaseAutoDetect.service.js"
    );
    const detected = await detectReleaseDateForSet(2026, "Custom Auto Set D", FAKE_NOW);
    expect(detected).toBeNull();
  });
});
