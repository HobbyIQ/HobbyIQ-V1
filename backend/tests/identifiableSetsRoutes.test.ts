// CF-SCANNING-B5 — route-layer integration tests:
//   GET /api/portfolio/identifiable-sets
//   GET /api/portfolio/identify/set-supported
//
// Both routes are session-gated (requireSession) but otherwise ungated
// (no entitlement, no rate-limit cap). Mocks getUserBySession at the
// authService boundary so we can exercise auth + the cache service
// without touching real Cosmos or Cardsight.

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user",
      email: "t@t",
      username: null,
      fullName: null,
      plan: "free",        // ungated routes must serve free users
      createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

// Mock the underlying cardsight client used by the cache service so the
// pre-flight live fallback is deterministic.
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

let app: any;

beforeEach(async () => {
  // resetAllMocks clears IMPLEMENTATIONS too — clearAllMocks would only
  // clear .calls, leaving leftover mockImplementationOnce queue entries
  // to leak across tests (which produced an "empty first page" surprise
  // on the second seed).
  vi.resetAllMocks();
  cacheMod._resetForTests();
  if (!app) {
    app = (await import("../src/app")).default;
  }
});

function seedSnapshot() {
  (clientMod.listIdentifiableSets as any).mockImplementation(async ({ skip }: { skip: number }) => {
    // Single fixture; second-page request returns empty so the refresh loop terminates.
    if (skip >= 3) return { sets: [], total_count: 3, skip, take: 50 };
    return {
      sets: [
        { year: "2024", release_name: "Topps",  segment_name: "Baseball", set_name: "Base",   set_id: "bb1" },
        { year: "2024", release_name: "Topps",  segment_name: "Baseball", set_name: "Chrome", set_id: "bb2" },
        { year: "2024", release_name: "Panini", segment_name: "Football", set_name: "Prizm",  set_id: "ff1" },
      ],
      total_count: 3,
      skip,
      take: 50,
    };
  });
  return cacheMod.refreshIdentifiableSetInventory({ delayMsBetweenPages: 0, refreshedAt: "2026-06-03T04:30:00.000Z" });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/portfolio/identifiable-sets
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/portfolio/identifiable-sets", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app).get("/api/portfolio/identifiable-sets");
    expect(r.status).toBe(401);
  });

  it("returns the full snapshot when no segment filter (free user — ungated)", async () => {
    await seedSnapshot();
    const r = await request(app)
      .get("/api/portfolio/identifiable-sets")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.totalCount).toBe(3);
    expect(r.body.segmentCount).toBe(3);
    expect(r.body.sets).toHaveLength(3);
    expect(r.body.refreshedAt).toBe("2026-06-03T04:30:00.000Z");
  });

  it("filters by segment (case-insensitive)", async () => {
    await seedSnapshot();
    const r = await request(app)
      .get("/api/portfolio/identifiable-sets?segment=baseball")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.segmentCount).toBe(2);
    expect(r.body.sets.every((s: any) => s.segment_name === "Baseball")).toBe(true);
  });

  it("supports skip + take pagination", async () => {
    await seedSnapshot();
    const r = await request(app)
      .get("/api/portfolio/identifiable-sets?skip=1&take=1")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.sets).toHaveLength(1);
    expect(r.body.sets[0].set_id).toBe("bb2");
  });

  it("returns empty shape with refreshedAt=null when no snapshot exists yet", async () => {
    // cache + memStore reset in beforeEach; no refresh performed.
    const r = await request(app)
      .get("/api/portfolio/identifiable-sets")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.refreshedAt).toBeNull();
    expect(r.body.totalCount).toBe(0);
    expect(r.body.sets).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/portfolio/identify/set-supported
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/portfolio/identify/set-supported", () => {
  it("401 without x-session-id", async () => {
    const r = await request(app).get("/api/portfolio/identify/set-supported?setId=bb1");
    expect(r.status).toBe(401);
  });

  it("400 when setId is missing", async () => {
    const r = await request(app)
      .get("/api/portfolio/identify/set-supported")
      .set("x-session-id", "s");
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
  });

  it("cache hit (positive) — supported=true, source='cache', no live call", async () => {
    await seedSnapshot();
    const r = await request(app)
      .get("/api/portfolio/identify/set-supported?setId=bb1")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, setId: "bb1", supported: true, source: "cache" });
    expect(clientMod.checkSetIdentifiable).not.toHaveBeenCalled();
  });

  it("cache hit (negative) — supported=false, source='cache'", async () => {
    await seedSnapshot();
    const r = await request(app)
      .get("/api/portfolio/identify/set-supported?setId=not-in-snapshot")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ supported: false, source: "cache" });
    expect(clientMod.checkSetIdentifiable).not.toHaveBeenCalled();
  });

  it("cache absent (pre-first-refresh) — falls back to live Cardsight check", async () => {
    // cache reset in beforeEach; no refresh
    (clientMod.checkSetIdentifiable as any).mockResolvedValueOnce({
      set_id: "live-uuid",
      is_identifiable: true,
    });
    const r = await request(app)
      .get("/api/portfolio/identify/set-supported?setId=live-uuid")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ supported: true, source: "live" });
    expect(clientMod.checkSetIdentifiable).toHaveBeenCalledWith("live-uuid");
  });
});
