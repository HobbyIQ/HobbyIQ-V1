/**
 * CF-MCP-PLAYER-IN-SET-BRIDGE (2026-06-10) — backend bridge route tests.
 *
 * Asserts /api/compiq/player-in-set-momentum:
 *  - 400 on missing player / release / year
 *  - 400 on invalid year
 *  - Returns null payload when fetchPlayerInSetMomentum returns null
 *  - Surfaces multiplier + signal in compsMomentum-compatible shape
 *  - Includes per-card breakdown via componentSignals
 *
 * fetchPlayerInSetMomentum is mocked at module boundary so we test the
 * route's input parsing + response shape, not the underlying compute.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../src/services/compiq/playerInSetMomentum.service.js", () => ({
  fetchPlayerInSetMomentum: vi.fn(),
}));

import app from "../src/app";
import { fetchPlayerInSetMomentum } from "../src/services/compiq/playerInSetMomentum.service";

const mockFetch = fetchPlayerInSetMomentum as unknown as ReturnType<typeof vi.fn>;

describe("GET /api/compiq/player-in-set-momentum", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 when player query param is missing", async () => {
    const res = await request(app).get("/api/compiq/player-in-set-momentum?release=Bowman+Draft&year=2024");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/player/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("400 when release query param is missing", async () => {
    const res = await request(app).get("/api/compiq/player-in-set-momentum?player=Konnor+Griffin&year=2024");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/release/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("400 when year query param is missing or invalid", async () => {
    const noYear = await request(app).get("/api/compiq/player-in-set-momentum?player=X&release=Y");
    expect(noYear.status).toBe(400);

    const badYear = await request(app).get("/api/compiq/player-in-set-momentum?player=X&release=Y&year=abc");
    expect(badYear.status).toBe(400);
    expect(badYear.body.error).toMatch(/year/i);

    const oldYear = await request(app).get("/api/compiq/player-in-set-momentum?player=X&release=Y&year=1800");
    expect(oldYear.status).toBe(400);
  });

  it("returns null payload when fetchPlayerInSetMomentum returns null", async () => {
    mockFetch.mockResolvedValue(null);
    const res = await request(app).get("/api/compiq/player-in-set-momentum?player=Konnor+Griffin&release=Bowman+Draft&year=2024");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      player: "Konnor Griffin",
      release: "Bowman Draft",
      year: 2024,
      signal: null,
      multiplier: null,
      source: "playerInSet",
    });
    expect(mockFetch).toHaveBeenCalledWith({
      playerName: "Konnor Griffin",
      product: "Bowman Draft",
      cardYear: 2024,
    });
  });

  it("surfaces multiplier + signal in compsMomentum-compatible shape (falling)", async () => {
    mockFetch.mockResolvedValue({
      multiplier: 0.85,
      flags: ["player_in_set", "falling"],
      componentSignals: {
        pool_size: 1493,
        cards_in_pool: 5,
        qualifying_cards: 4,
        aggregated_ratio: 0.806,
        per_card_ratios: [
          { cardId: "df9ddcd2", ratio: 0.751, recentMedian: 7.51, priorMedian: 10.0, recentN: 7, priorN: 7 },
        ],
        sibling_card_ids_scanned: 5,
      },
      lastUpdated: "2026-06-10T00:13:45.567Z",
      sourceUrl: null,
    });
    const res = await request(app).get("/api/compiq/player-in-set-momentum?player=Konnor+Griffin&release=Bowman+Draft&year=2024");
    expect(res.status).toBe(200);
    expect(res.body.player).toBe("Konnor Griffin");
    expect(res.body.release).toBe("Bowman Draft");
    expect(res.body.year).toBe(2024);
    expect(res.body.multiplier).toBe(0.85);
    expect(res.body.signal).toBe("falling");
    expect(res.body.source).toBe("playerInSet");
    expect(res.body.flags).toEqual(["player_in_set", "falling"]);
    expect(res.body.componentSignals.qualifying_cards).toBe(4);
    expect(Array.isArray(res.body.componentSignals.per_card_ratios)).toBe(true);
    expect(res.body.lastUpdated).toBe("2026-06-10T00:13:45.567Z");
  });

  it("rising signal is surfaced (multiplier > 1.08)", async () => {
    mockFetch.mockResolvedValue({
      multiplier: 1.2,
      flags: ["player_in_set", "rising"],
      componentSignals: { qualifying_cards: 3, cards_in_pool: 4, aggregated_ratio: 1.5, per_card_ratios: [] },
      lastUpdated: "2026-06-10T00:00:00Z",
      sourceUrl: null,
    });
    const res = await request(app).get("/api/compiq/player-in-set-momentum?player=X&release=Y&year=2024");
    expect(res.body.signal).toBe("rising");
    expect(res.body.multiplier).toBe(1.2);
  });

  it("stable signal when neither rising nor falling fires", async () => {
    mockFetch.mockResolvedValue({
      multiplier: 1.0,
      flags: ["player_in_set", "stable"],
      componentSignals: { qualifying_cards: 3, cards_in_pool: 4, aggregated_ratio: 1.0, per_card_ratios: [] },
      lastUpdated: "2026-06-10T00:00:00Z",
      sourceUrl: null,
    });
    const res = await request(app).get("/api/compiq/player-in-set-momentum?player=X&release=Y&year=2024");
    expect(res.body.signal).toBe("stable");
  });

  it("URL-decodes player + release with spaces", async () => {
    mockFetch.mockResolvedValue(null);
    await request(app).get("/api/compiq/player-in-set-momentum?player=Mike%20Trout&release=Topps%20Update&year=2011");
    expect(mockFetch).toHaveBeenCalledWith({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });
  });
});
