// CF-MARKET-TREND-INDEXES (2026-06-03): gate + payload coverage for the
// 3 new investor+ surfaces over marketDelta.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { MarketDelta } from "../src/services/dailyiq/marketDelta.service.js";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

const getMarketDeltaMock = vi.fn(async (_name: string): Promise<MarketDelta | null> => null);
const getMarketDeltasForPlayersMock = vi.fn(
  async (_names: string[]): Promise<Map<string, MarketDelta | null>> => new Map(),
);
vi.mock("../src/services/dailyiq/marketDelta.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getMarketDelta: (...args: unknown[]) => getMarketDeltaMock(...(args as [string])),
    getMarketDeltasForPlayers: (...args: unknown[]) =>
      getMarketDeltasForPlayersMock(...(args as [string[]])),
  };
});

const getLatestBriefMock = vi.fn(async () => null as any);
vi.mock("../src/repositories/dailyiq.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getLatestBrief: () => getLatestBriefMock(),
  };
});

function makeUser(plan: string) {
  return {
    userId: `u-${plan}`,
    email: `${plan}@t`,
    username: null,
    fullName: null,
    plan,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeDelta(over: Partial<MarketDelta> = {}): MarketDelta {
  return {
    pct1d: 2.5,
    pct7d: 5.0,
    pct30d: 8.2,
    avg30dPrice: 120.5,
    sampleCount: 12,
    ...over,
  };
}

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  getMarketDeltaMock.mockReset().mockResolvedValue(null);
  getMarketDeltasForPlayersMock.mockReset().mockResolvedValue(new Map());
  getLatestBriefMock.mockReset().mockResolvedValue(null);
});

// ─── Gate matrix per route ──────────────────────────────────────────────────

const ROUTES: Array<{ name: string; path: string }> = [
  { name: "per-player", path: "/api/compiq/market-trend?playerName=Skenes" },
  {
    name: "batch",
    path: "/api/compiq/market-trend/batch?playerNames=Skenes,Acuna",
  },
  {
    name: "top-movers",
    path: "/api/compiq/market-trend/top-movers?window=7d",
  },
];

for (const route of ROUTES) {
  describe(`GET ${route.path} — gates`, () => {
    it("401 without x-session-id", async () => {
      const r = await request(app).get(route.path);
      expect(r.status).toBe(401);
    });
    it("402 for free (lacks marketTrendIndexes)", async () => {
      setUser(makeUser("free"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).toBe(402);
      expect(r.body.feature).toBe("marketTrendIndexes");
      expect(r.body.requiredTier).toBe("investor");
    });
    it("402 for collector (lacks marketTrendIndexes)", async () => {
      setUser(makeUser("collector"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).toBe(402);
      expect(r.body.requiredTier).toBe("investor");
    });
    it("investor passes", async () => {
      setUser(makeUser("investor"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(402);
    });
    it("pro_seller passes", async () => {
      setUser(makeUser("pro_seller"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(402);
    });
  });
}

// ─── Per-player payload ─────────────────────────────────────────────────────

describe("GET /api/compiq/market-trend — payload + edge cases", () => {
  beforeEach(() => setUser(makeUser("investor")));

  it("400 when playerName missing", async () => {
    const r = await request(app)
      .get("/api/compiq/market-trend")
      .set("x-session-id", "s");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/playerName/);
  });

  it("returns delta + high-confidence + window label when sampleCount >= 5", async () => {
    getMarketDeltaMock.mockResolvedValueOnce(makeDelta({ sampleCount: 12 }));
    const r = await request(app)
      .get("/api/compiq/market-trend?playerName=Skenes")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.playerName).toBe("Skenes");
    expect(r.body.delta.sampleCount).toBe(12);
    expect(r.body.confidence).toBe("high");
    expect(r.body.window.pct30dLabel).toMatch(/7d-vs-30d momentum/);
    expect(r.body.window.pct30dLabel).toMatch(/Phase 2/);
    // Per-player has no `selected` — all three windows are returned at once.
    expect(r.body.window.selected).toBeUndefined();
  });

  it("low confidence when sampleCount < 5", async () => {
    getMarketDeltaMock.mockResolvedValueOnce(makeDelta({ sampleCount: 3 }));
    const r = await request(app)
      .get("/api/compiq/market-trend?playerName=Skenes")
      .set("x-session-id", "s");
    expect(r.body.confidence).toBe("low");
  });

  it("none confidence when delta is null", async () => {
    getMarketDeltaMock.mockResolvedValueOnce(null);
    const r = await request(app)
      .get("/api/compiq/market-trend?playerName=Skenes")
      .set("x-session-id", "s");
    expect(r.body.delta).toBeNull();
    expect(r.body.confidence).toBe("none");
  });
});

// ─── Batch payload ──────────────────────────────────────────────────────────

describe("GET /api/compiq/market-trend/batch", () => {
  beforeEach(() => setUser(makeUser("investor")));

  it("400 when playerNames missing", async () => {
    const r = await request(app)
      .get("/api/compiq/market-trend/batch")
      .set("x-session-id", "s");
    expect(r.status).toBe(400);
  });

  it("returns per-player map keyed by requested name", async () => {
    getMarketDeltasForPlayersMock.mockResolvedValueOnce(
      new Map<string, MarketDelta | null>([
        ["Skenes", makeDelta({ sampleCount: 10 })],
        ["Acuna", null],
      ]),
    );
    const r = await request(app)
      .get("/api/compiq/market-trend/batch?playerNames=Skenes,Acuna")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.deltas).sort()).toEqual(["Acuna", "Skenes"]);
    expect(r.body.deltas["Skenes"].confidence).toBe("high");
    expect(r.body.deltas["Acuna"].confidence).toBe("none");
    expect(r.body.window.pct30dLabel).toMatch(/Phase 2/);
    expect(r.body.window.selected).toBeUndefined();
    expect(r.body.truncated).toBeNull();
  });

  it("truncates at 20 and surfaces the truncated count", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `p${i}`);
    getMarketDeltasForPlayersMock.mockResolvedValueOnce(new Map());
    const r = await request(app)
      .get(`/api/compiq/market-trend/batch?playerNames=${names.join(",")}`)
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.truncated.requested).toBe(25);
    expect(r.body.truncated.served).toBe(20);
    // Confirm we DIDN'T fetch the trailing 5 names.
    const calledWith = getMarketDeltasForPlayersMock.mock.calls[0][0] as string[];
    expect(calledWith.length).toBe(20);
  });
});

// ─── Top-movers ────────────────────────────────────────────────────────────

describe("GET /api/compiq/market-trend/top-movers", () => {
  beforeEach(() => setUser(makeUser("investor")));

  it("400 when window is missing or invalid", async () => {
    const r1 = await request(app)
      .get("/api/compiq/market-trend/top-movers")
      .set("x-session-id", "s");
    expect(r1.status).toBe(400);
    const r2 = await request(app)
      .get("/api/compiq/market-trend/top-movers?window=14d")
      .set("x-session-id", "s");
    expect(r2.status).toBe(400);
  });

  it("returns empty movers when DailyIQ brief has no players", async () => {
    getLatestBriefMock.mockResolvedValueOnce(null);
    const r = await request(app)
      .get("/api/compiq/market-trend/top-movers?window=7d")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.movers).toEqual([]);
    expect(r.body.poolSize).toBe(0);
    // Normalized shape: `window` is the descriptor object, `selected`
    // carries the user's window choice. No top-level `window_label`.
    expect(r.body.window.selected).toBe("7d");
    expect(r.body.window.pct30dLabel).toMatch(/Phase 2/);
    expect(r.body.window_label).toBeUndefined();
  });

  it("top-movers `window` shape matches per-player + batch (same Codable on iOS)", async () => {
    getLatestBriefMock.mockResolvedValueOnce({
      date: "2026-06-03",
      generatedAt: "2026-06-03T08:00:00Z",
      mlb: [{ playerId: "1", playerName: "Skenes" }],
      milb: [],
      notifiedAt: null,
    });
    getMarketDeltasForPlayersMock.mockResolvedValueOnce(
      new Map<string, MarketDelta | null>([["Skenes", makeDelta({ sampleCount: 10 })]]),
    );
    const r = await request(app)
      .get("/api/compiq/market-trend/top-movers?window=1d&limit=5")
      .set("x-session-id", "s");
    expect(r.body.window).toEqual({
      selected: "1d",
      pct30dLabel: expect.stringMatching(/Phase 2/),
    });
    expect(r.body.window_label).toBeUndefined();
  });

  it("ranks by |delta[window]| descending, excludes null deltas", async () => {
    getLatestBriefMock.mockResolvedValueOnce({
      date: "2026-06-03",
      generatedAt: "2026-06-03T08:00:00Z",
      mlb: [
        { playerId: "1", playerName: "Skenes" },
        { playerId: "2", playerName: "Acuna" },
        { playerId: "3", playerName: "Trout" },
      ],
      milb: [{ playerId: "4", playerName: "RookieX" }],
      notifiedAt: null,
    });
    getMarketDeltasForPlayersMock.mockResolvedValueOnce(
      new Map<string, MarketDelta | null>([
        ["Skenes", makeDelta({ pct7d: 12.5, sampleCount: 10 })],
        ["Acuna", makeDelta({ pct7d: -18.0, sampleCount: 8 })],   // |−18| > 12.5
        ["Trout", null],
        ["RookieX", makeDelta({ pct7d: 5.1, sampleCount: 5 })],
      ]),
    );
    const r = await request(app)
      .get("/api/compiq/market-trend/top-movers?window=7d&limit=5")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.movers.length).toBe(3); // Trout (null) excluded
    expect(r.body.movers[0].playerName).toBe("Acuna");  // |−18| wins
    expect(r.body.movers[1].playerName).toBe("Skenes"); // 12.5
    expect(r.body.movers[2].playerName).toBe("RookieX"); // 5.1
    expect(r.body.poolSize).toBe(4);
  });

  it("respects limit param (1..50)", async () => {
    getLatestBriefMock.mockResolvedValueOnce({
      date: "2026-06-03",
      generatedAt: "2026-06-03T08:00:00Z",
      mlb: Array.from({ length: 30 }, (_, i) => ({ playerId: `${i}`, playerName: `P${i}` })),
      milb: [],
      notifiedAt: null,
    });
    getMarketDeltasForPlayersMock.mockResolvedValueOnce(
      new Map<string, MarketDelta | null>(
        Array.from({ length: 30 }, (_, i) => [
          `P${i}`,
          makeDelta({ pct1d: i, sampleCount: 10 }),
        ]),
      ),
    );
    const r = await request(app)
      .get("/api/compiq/market-trend/top-movers?window=1d&limit=3")
      .set("x-session-id", "s");
    expect(r.body.movers.length).toBe(3);
    expect(r.body.movers[0].playerName).toBe("P29");
    expect(r.body.movers[1].playerName).toBe("P28");
    expect(r.body.movers[2].playerName).toBe("P27");
  });

  it("invalid limit (101) clamps to default 20, not 101", async () => {
    getLatestBriefMock.mockResolvedValueOnce({
      date: "2026-06-03",
      generatedAt: "2026-06-03T08:00:00Z",
      mlb: Array.from({ length: 25 }, (_, i) => ({ playerId: `${i}`, playerName: `P${i}` })),
      milb: [],
      notifiedAt: null,
    });
    getMarketDeltasForPlayersMock.mockResolvedValueOnce(
      new Map(
        Array.from({ length: 25 }, (_, i) => [`P${i}`, makeDelta({ sampleCount: 10 })]),
      ),
    );
    const r = await request(app)
      .get("/api/compiq/market-trend/top-movers?window=1d&limit=101")
      .set("x-session-id", "s");
    expect(r.body.limit).toBe(20);
    expect(r.body.movers.length).toBe(20);
  });
});
