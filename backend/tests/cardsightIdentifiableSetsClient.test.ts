// CF-SCANNING-B5 — unit tests for the two new cardsight.client exports:
//   listIdentifiableSets({skip, take})
//   checkSetIdentifiable(setId)
//
// fetch is mocked at the global level so we can assert the exact URL +
// the response-shape parsing without hitting the real Cardsight API.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let app: any;

beforeEach(() => {
  vi.resetModules();
  process.env.CARDSIGHT_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CARDSIGHT_API_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────
// listIdentifiableSets
// ─────────────────────────────────────────────────────────────────────────────

describe("listIdentifiableSets", () => {
  it("issues GET to /v1/identify/list/sets with skip + take query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        sets: [
          { year: "2024", release_name: "Topps", segment_name: "Baseball", set_name: "Base", set_id: "uuid-1" },
        ],
        total_count: 1,
        skip: 0,
        take: 50,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listIdentifiableSets } = await import("../src/services/compiq/cardsight.client.js");
    const page = await listIdentifiableSets({ skip: 0, take: 50 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/identify/list/sets");
    expect(url).toContain("skip=0");
    expect(url).toContain("take=50");
    expect(page.sets).toHaveLength(1);
    expect(page.sets[0].set_id).toBe("uuid-1");
    expect(page.total_count).toBe(1);
  });

  it("returns empty page shape when CARDSIGHT_API_KEY is missing (no fetch)", async () => {
    delete process.env.CARDSIGHT_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { listIdentifiableSets } = await import("../src/services/compiq/cardsight.client.js");
    const page = await listIdentifiableSets({ skip: 100, take: 50 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(page).toEqual({ sets: [], total_count: 0, skip: 100, take: 50 });
  });

  it("defaults skip=0 take=50 when not supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ sets: [], total_count: 0, skip: 0, take: 50 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listIdentifiableSets } = await import("../src/services/compiq/cardsight.client.js");
    await listIdentifiableSets();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("skip=0");
    expect(url).toContain("take=50");
  });

  it("normalizes malformed responses (missing fields) into a safe shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ /* no sets, no total_count */ }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listIdentifiableSets } = await import("../src/services/compiq/cardsight.client.js");
    const page = await listIdentifiableSets({ skip: 7, take: 13 });
    expect(page.sets).toEqual([]);
    expect(page.total_count).toBe(0);
    expect(page.skip).toBe(7);
    expect(page.take).toBe(13);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkSetIdentifiable
// ─────────────────────────────────────────────────────────────────────────────

describe("checkSetIdentifiable", () => {
  it("issues GET to /v1/identify/check/set/{setId}", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ set_id: "uuid-abc", is_identifiable: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { checkSetIdentifiable } = await import("../src/services/compiq/cardsight.client.js");
    const result = await checkSetIdentifiable("uuid-abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/identify/check/set/uuid-abc");
    expect(result).toEqual({ set_id: "uuid-abc", is_identifiable: true });
  });

  it("returns null when CARDSIGHT_API_KEY is missing", async () => {
    delete process.env.CARDSIGHT_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { checkSetIdentifiable } = await import("../src/services/compiq/cardsight.client.js");
    const result = await checkSetIdentifiable("uuid-abc");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("URL-encodes the setId path segment (defense against control chars)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ set_id: "weird id", is_identifiable: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { checkSetIdentifiable } = await import("../src/services/compiq/cardsight.client.js");
    await checkSetIdentifiable("weird id");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/identify/check/set/weird%20id");
  });

  it("treats is_identifiable=false as a clean negative", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ set_id: "uuid-xyz", is_identifiable: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { checkSetIdentifiable } = await import("../src/services/compiq/cardsight.client.js");
    const result = await checkSetIdentifiable("uuid-xyz");
    expect(result?.is_identifiable).toBe(false);
  });
});
