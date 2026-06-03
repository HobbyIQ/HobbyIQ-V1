// CF-SCANNING-B5 — identifiableSetCache.service.ts unit tests.
//
// Covers:
//   - refreshIdentifiableSetInventory() paginates correctly, computes
//     segment counts, and logs the coverage snapshot.
//   - getIdentifiableSets() honors segment filter + skip/take pagination.
//   - isSetIdentifiable() — cache hit (positive + negative) + live
//     fallback when no snapshot exists yet.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listIdentifiableSets: vi.fn(),
    checkSetIdentifiable: vi.fn(),
  };
});

const clientMod = await import("../src/services/compiq/cardsight.client.js");
const cacheMod = await import("../src/services/cardsight/identifiableSetCache.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  cacheMod._resetForTests();
});

// Convenience: stub a paginated response set across N pages.
function stubPages(pages: Array<Array<{ year: string; release_name: string; segment_name: string; set_name: string; set_id: string }>>) {
  const total = pages.reduce((acc, p) => acc + p.length, 0);
  let call = 0;
  (clientMod.listIdentifiableSets as any).mockImplementation(async ({ skip }: { skip: number }) => {
    const which = pages[call++] ?? [];
    return { sets: which, total_count: total, skip, take: 50 };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// refreshIdentifiableSetInventory
// ─────────────────────────────────────────────────────────────────────────────

describe("refreshIdentifiableSetInventory", () => {
  it("paginates pages and persists the merged snapshot (stops when count reached)", async () => {
    stubPages([
      [
        { year: "2024", release_name: "Topps", segment_name: "Baseball", set_name: "Base", set_id: "b1" },
        { year: "2024", release_name: "Topps", segment_name: "Baseball", set_name: "Chrome", set_id: "b2" },
      ],
      [
        { year: "2024", release_name: "Panini", segment_name: "Football", set_name: "Prizm", set_id: "f1" },
      ],
    ]);

    const result = await cacheMod.refreshIdentifiableSetInventory({
      refreshedAt: "2026-06-03T04:30:00.000Z",
      delayMsBetweenPages: 0,
    });

    expect(result.totalCount).toBe(3);
    // Refresh stops when all.length >= totalCount — 2 pages is enough to
    // collect all 3 reported sets, so the loop exits after page 2.
    expect(result.pagesFetched).toBe(2);
    expect(result.refreshedAt).toBe("2026-06-03T04:30:00.000Z");
    expect(result.segmentCounts).toEqual({ Baseball: 2, Football: 1 });
  });

  it("computes segmentCounts correctly across mixed segments", async () => {
    stubPages([
      [
        { year: "2024", release_name: "A", segment_name: "Baseball", set_name: "1", set_id: "a1" },
        { year: "2024", release_name: "B", segment_name: "Pokemon", set_name: "2", set_id: "a2" },
        { year: "2024", release_name: "C", segment_name: "Baseball", set_name: "3", set_id: "a3" },
        { year: "2024", release_name: "D", segment_name: "Football", set_name: "4", set_id: "a4" },
      ],
      [],
    ]);
    const result = await cacheMod.refreshIdentifiableSetInventory({ delayMsBetweenPages: 0 });
    expect(result.segmentCounts).toEqual({ Baseball: 2, Pokemon: 1, Football: 1 });
  });

  it("logs the segment-count snapshot (visible to operators for drift detection)", async () => {
    stubPages([
      [{ year: "2024", release_name: "A", segment_name: "Baseball", set_name: "1", set_id: "a1" }],
      [],
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await cacheMod.refreshIdentifiableSetInventory({ delayMsBetweenPages: 0 });
    const logCall = logSpy.mock.calls.find((c) => String(c[0] ?? "").includes("[identifiableSetCache] refresh complete"));
    expect(logCall).toBeDefined();
    expect(String(logCall![0])).toContain('"Baseball":1');
    logSpy.mockRestore();
  });

  it("after a refresh, the in-process cache hits without re-reading storage", async () => {
    stubPages([
      [{ year: "2024", release_name: "A", segment_name: "Baseball", set_name: "1", set_id: "a1" }],
      [],
    ]);
    await cacheMod.refreshIdentifiableSetInventory({ delayMsBetweenPages: 0 });
    const r1 = await cacheMod.isSetIdentifiable("a1");
    expect(r1).toEqual({ setId: "a1", supported: true, source: "cache" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getIdentifiableSets (segment filter + pagination)
// ─────────────────────────────────────────────────────────────────────────────

describe("getIdentifiableSets", () => {
  beforeEach(async () => {
    stubPages([
      [
        { year: "2024", release_name: "Topps",  segment_name: "Baseball", set_name: "Base",  set_id: "bb1" },
        { year: "2024", release_name: "Topps",  segment_name: "Baseball", set_name: "Chrome", set_id: "bb2" },
        { year: "2024", release_name: "Topps",  segment_name: "Baseball", set_name: "Heritage", set_id: "bb3" },
        { year: "2024", release_name: "Panini", segment_name: "Football", set_name: "Prizm", set_id: "ff1" },
        { year: "2024", release_name: "Panini", segment_name: "Football", set_name: "Select", set_id: "ff2" },
        { year: "2024", release_name: "Pokemon Co", segment_name: "Pokemon", set_name: "151", set_id: "pk1" },
      ],
      [],
    ]);
    await cacheMod.refreshIdentifiableSetInventory({ delayMsBetweenPages: 0 });
  });

  it("returns all segments when no segment filter is applied", async () => {
    const r = await cacheMod.getIdentifiableSets({});
    expect(r.totalCount).toBe(6);
    expect(r.segmentCount).toBe(6);
    expect(r.sets).toHaveLength(6);
  });

  it("filters by segment (case-insensitive)", async () => {
    const r = await cacheMod.getIdentifiableSets({ segment: "baseball" });
    expect(r.totalCount).toBe(6);
    expect(r.segmentCount).toBe(3);
    expect(r.sets.every((s) => s.segment_name === "Baseball")).toBe(true);
  });

  it("paginates (skip + take)", async () => {
    const r = await cacheMod.getIdentifiableSets({ skip: 1, take: 2 });
    expect(r.sets).toHaveLength(2);
    expect(r.sets[0].set_id).toBe("bb2");
    expect(r.sets[1].set_id).toBe("bb3");
  });

  it("paginates WITHIN a segment", async () => {
    const r = await cacheMod.getIdentifiableSets({ segment: "Football", skip: 1, take: 1 });
    expect(r.segmentCount).toBe(2);
    expect(r.sets).toHaveLength(1);
    expect(r.sets[0].set_id).toBe("ff2");
  });

  it("returns empty result shape when no snapshot exists yet (pre-first-refresh)", async () => {
    cacheMod._resetForTests();
    const r = await cacheMod.getIdentifiableSets({ segment: "Baseball" });
    expect(r.refreshedAt).toBeNull();
    expect(r.totalCount).toBe(0);
    expect(r.sets).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSetIdentifiable (pre-flight cache + live fallback)
// ─────────────────────────────────────────────────────────────────────────────

describe("isSetIdentifiable", () => {
  it("cache hit (positive) — returns supported=true, source='cache' WITHOUT calling Cardsight", async () => {
    stubPages([
      [{ year: "2024", release_name: "Topps", segment_name: "Baseball", set_name: "Base", set_id: "bb1" }],
      [],
    ]);
    await cacheMod.refreshIdentifiableSetInventory({ delayMsBetweenPages: 0 });
    (clientMod.checkSetIdentifiable as any).mockClear();

    const r = await cacheMod.isSetIdentifiable("bb1");
    expect(r).toEqual({ setId: "bb1", supported: true, source: "cache" });
    expect(clientMod.checkSetIdentifiable).not.toHaveBeenCalled();
  });

  it("cache hit (negative) — returns supported=false, source='cache' WITHOUT live call", async () => {
    stubPages([
      [{ year: "2024", release_name: "Topps", segment_name: "Baseball", set_name: "Base", set_id: "bb1" }],
      [],
    ]);
    await cacheMod.refreshIdentifiableSetInventory({ delayMsBetweenPages: 0 });
    (clientMod.checkSetIdentifiable as any).mockClear();

    const r = await cacheMod.isSetIdentifiable("not-in-snapshot");
    expect(r).toEqual({ setId: "not-in-snapshot", supported: false, source: "cache" });
    expect(clientMod.checkSetIdentifiable).not.toHaveBeenCalled();
  });

  it("cache absent (no snapshot) — falls back to live checkSetIdentifiable", async () => {
    cacheMod._resetForTests();
    (clientMod.checkSetIdentifiable as any).mockResolvedValueOnce({
      set_id: "live-uuid",
      is_identifiable: true,
    });
    const r = await cacheMod.isSetIdentifiable("live-uuid");
    expect(r).toEqual({ setId: "live-uuid", supported: true, source: "live" });
    expect(clientMod.checkSetIdentifiable).toHaveBeenCalledWith("live-uuid");
  });

  it("cache absent + live returns null (api key missing) — FAILS OPEN: supported=true, source='unknown'", async () => {
    cacheMod._resetForTests();
    (clientMod.checkSetIdentifiable as any).mockResolvedValueOnce(null);
    const r = await cacheMod.isSetIdentifiable("set-x");
    // CF-SCANNING-B5-FIXES (2026-06-03): supported=true on indeterminate
    // — naive iOS (`if (!supported) warn`) must NOT block scans during a
    // Cardsight outage. Only an explicit cache/live negative blocks.
    expect(r).toEqual({ setId: "set-x", supported: true, source: "unknown" });
  });

  it("cache absent + live throws — FAILS OPEN: supported=true, source='unknown' (no rethrow)", async () => {
    cacheMod._resetForTests();
    (clientMod.checkSetIdentifiable as any).mockRejectedValueOnce(new Error("Cardsight down"));
    const errSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await cacheMod.isSetIdentifiable("set-y");
    // CF-SCANNING-B5-FIXES (2026-06-03): same fail-open semantic as the
    // null-return branch above.
    expect(r).toEqual({ setId: "set-y", supported: true, source: "unknown" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
