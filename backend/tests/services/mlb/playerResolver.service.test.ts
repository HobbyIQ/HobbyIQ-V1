import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  resolvePlayer,
  normalizePlayerName,
  _clearPlayerResolverCache,
} from "../../../src/services/mlb/playerResolver.service.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    async json() {
      return body;
    },
  } as unknown as Response;
}

function mockFetchSequence(responses: unknown[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return jsonResponse(r);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("playerResolver.service", () => {
  beforeEach(() => {
    _clearPlayerResolverCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns high confidence when MLB returns exactly one match", async () => {
    mockFetchSequence([
      { people: [{ id: 545361, fullName: "Mike Trout", mlbDebutDate: "2011-07-08" }] },
    ]);
    const r = await resolvePlayer("Mike Trout", { year: 2022 });
    expect(r).not.toBeNull();
    expect(r!.playerId).toBe("545361");
    expect(r!.confidence).toBe("high");
    expect(r!.matchCount).toBe(1);
    expect(r!.displayName).toBe("Mike Trout");
  });

  it("returns medium confidence when multiple matches but year narrows to one", async () => {
    mockFetchSequence([
      {
        people: [
          { id: 1, fullName: "John Smith", mlbDebutDate: "1955-04-15" },
          { id: 2, fullName: "John Smith", mlbDebutDate: "2020-06-01" },
          { id: 3, fullName: "John Smith", mlbDebutDate: "1899-05-10" },
        ],
      },
    ]);
    const r = await resolvePlayer("John Smith", { year: 2022 });
    expect(r).not.toBeNull();
    expect(r!.playerId).toBe("2");
    expect(r!.confidence).toBe("medium");
    expect(r!.matchCount).toBe(3);
  });

  it("returns low confidence when multiple matches and no year given", async () => {
    mockFetchSequence([
      {
        people: [
          { id: 10, fullName: "Bob Jones", mlbDebutDate: "1980-04-10" },
          { id: 11, fullName: "Bob Jones", mlbDebutDate: "2015-06-12" },
        ],
      },
    ]);
    const r = await resolvePlayer("Bob Jones");
    expect(r).not.toBeNull();
    expect(r!.playerId).toBe("10");
    expect(r!.confidence).toBe("low");
    expect(r!.matchCount).toBe(2);
  });

  it("returns ambiguous when multiple matches and year cannot narrow", async () => {
    mockFetchSequence([
      {
        people: [
          { id: 20, fullName: "Chris Lee", mlbDebutDate: "2020-04-01" },
          { id: 21, fullName: "Chris Lee", mlbDebutDate: "2018-06-12" },
        ],
      },
    ]);
    const r = await resolvePlayer("Chris Lee", { year: 2022 });
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe("ambiguous");
    expect(r!.matchCount).toBe(2);
  });

  it("returns null when MLB returns zero matches", async () => {
    mockFetchSequence([{ people: [] }]);
    const r = await resolvePlayer("Zzz Nonexistent", { year: 2024 });
    expect(r).toBeNull();
  });

  it("caches resolved players and does not refetch on the second call", async () => {
    const fetchMock = mockFetchSequence([
      { people: [{ id: 545361, fullName: "Mike Trout", mlbDebutDate: "2011-07-08" }] },
    ]);
    const a = await resolvePlayer("Mike Trout", { year: 2022 });
    const b = await resolvePlayer("Mike Trout", { year: 2022 });
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes punctuation and suffixes so equivalent names share a cache key", async () => {
    expect(normalizePlayerName("J.T. Ginn")).toBe(normalizePlayerName("JT Ginn"));
    expect(normalizePlayerName("Cal Ripken Jr.")).toBe(normalizePlayerName("Cal Ripken"));
    expect(normalizePlayerName("Ken Griffey Jr")).toBe("ken griffey");

    const fetchMock = mockFetchSequence([
      { people: [{ id: 999, fullName: "JT Ginn", mlbDebutDate: "2024-07-01" }] },
    ]);
    const a = await resolvePlayer("J.T. Ginn", { year: 2024 });
    const b = await resolvePlayer("JT Ginn", { year: 2024 });
    expect(a?.playerId).toBe("999");
    expect(b?.playerId).toBe("999");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on fetch failure without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const r = await resolvePlayer("Mike Trout", { year: 2022 });
    expect(r).toBeNull();
  });

  it("returns null on non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false)));
    const r = await resolvePlayer("Mike Trout", { year: 2022 });
    expect(r).toBeNull();
  });

  it("returns null for empty input without calling fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ people: [] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolvePlayer("")).toBeNull();
    expect(await resolvePlayer("   ")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
