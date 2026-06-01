/**
 * CF-DAILYIQ-PLAYERSCORE-SLUG-FALLBACK-RETIRE Part 1 — reader-cutover tests.
 *
 * Asserts that the two slug-keyed read paths in playeriq.routes.ts are gone:
 *
 *   - GET /api/playeriq/:playerName/history (was L62-63):
 *       pre-retire: getPlayerTrendHistory(playerNameSlug(name)) on a name miss
 *       post-retire: empty payload { points: [], count: 0, playerId: null }
 *
 *   - GET /api/playeriq/:playerName (was L117):
 *       pre-retire: getPlayerScore(playerNameSlug(name)) fallback when
 *                   getPlayerScoreByName missed
 *       post-retire: name miss flows directly to updatePlayerScoreFromEstimate
 *                    then the existing 200-stub at L129 (slug stays in the
 *                    STUB's wire-shape playerId for iOS routing continuity —
 *                    it is NOT a Cosmos lookup key).
 *
 * Strategy: vi.mock the playerScore.service module so the route handler
 * binds against test fakes. Assert (a) response shape, (b) that the
 * retired-fn mocks (`getPlayerScore`, `getPlayerTrendHistory` for the slug-key
 * inputs) were NOT called on the miss path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock playerScore.service BEFORE importing the router so the route handler
// binds against these fakes. Each fn is a vi.fn() the tests can configure
// + spy on per scenario.
vi.mock("../src/services/playerScore/playerScore.service.js", () => ({
  getPlayerScoreByName: vi.fn(),
  getPlayerScore: vi.fn(),
  getTopPlayersByScore: vi.fn(),
  refreshPlayerScoreForJob: vi.fn(),
  getPlayerTrendHistory: vi.fn(),
  updatePlayerScoreFromEstimate: vi.fn(),
}));

// mlbStats.service is referenced by /:playerName/stats which we don't
// exercise here, but the module-side import resolution still needs a stub.
vi.mock("../src/services/playerScore/mlbStats.service.js", () => ({
  getPlayerSeasonAndCareerStats: vi.fn(),
}));

import playeriqRouter from "../src/routes/playeriq.routes";
import {
  getPlayerScoreByName,
  getPlayerScore,
  getPlayerTrendHistory,
  updatePlayerScoreFromEstimate,
} from "../src/services/playerScore/playerScore.service.js";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/playeriq", playeriqRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── /:playerName — score-by-name miss path ─────────────────────────────────

describe("GET /api/playeriq/:playerName — Part 1 slug-fallback retired", () => {
  it("name miss → updatePlayerScoreFromEstimate consulted → stub returned; getPlayerScore (slug-keyed) NEVER called", async () => {
    (getPlayerScoreByName as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (updatePlayerScoreFromEstimate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/playeriq/Unresolvable%20Prospect");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_score");
    expect(res.body.dataSource).toBe("stub");
    expect(res.body.playerName).toBe("Unresolvable Prospect");
    expect(res.body.playerId).toBe("unresolvable-prospect");
    expect(res.body.market).toBeNull();
    expect(res.body.performance).toBeNull();

    // Load-bearing assertion: the L117 `getPlayerScore(playerNameSlug(name))`
    // call is gone. Mock should have zero invocations.
    expect((getPlayerScore as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // Name lookup + live-build rescue were both attempted (the post-retirement
    // miss path).
    expect((getPlayerScoreByName as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((updatePlayerScoreFromEstimate as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("name hit → cached score returned without any rescue path attempted", async () => {
    const fakeScore = {
      id: "545361",
      playerId: "545361",
      playerName: "Mike Trout",
      playerIQScore: 72,
      playerIQDirection: "rising",
      playerIQLabel: "Heating Up",
      market: { marketScore: 70, marketDirection: "rising" },
      performance: { performanceScore: 75 },
    };
    (getPlayerScoreByName as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fakeScore);

    const res = await request(buildApp()).get("/api/playeriq/Mike%20Trout");

    expect(res.status).toBe(200);
    expect(res.body.playerId).toBe("545361");
    expect(res.body.playerIQScore).toBe(72);

    // Rescue paths must not fire when the name hit.
    expect((getPlayerScore as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((updatePlayerScoreFromEstimate as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// ─── /:playerName/history — history-by-name miss path ──────────────────────

describe("GET /api/playeriq/:playerName/history — Part 1 slug-fallback retired", () => {
  it("name miss → empty payload; getPlayerTrendHistory NEVER called with slug-form id", async () => {
    (getPlayerScoreByName as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/playeriq/Unresolvable%20Prospect/history");

    expect(res.status).toBe(200);
    expect(res.body.playerName).toBe("Unresolvable Prospect");
    expect(res.body.playerId).toBeNull();
    expect(res.body.points).toEqual([]);
    expect(res.body.count).toBe(0);

    // Load-bearing: the L62-63 `getPlayerTrendHistory(playerNameSlug(name))`
    // fallback is gone. The history container is not consulted at all when
    // the name doesn't resolve.
    expect((getPlayerTrendHistory as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("name hit → history queried with the cached row's numeric playerId, NOT a slug", async () => {
    (getPlayerScoreByName as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      playerId: "545361",
      playerName: "Mike Trout",
    });
    (getPlayerTrendHistory as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        playerIQScore: 70,
        playerIQDirection: "rising",
        playerIQLabel: "Heating Up",
        market: { marketScore: 68 },
        performance: { performanceScore: 73 },
        updatedAt: "2026-05-31T12:00:00Z",
        dataSource: "nightly_job",
      },
    ]);

    const res = await request(buildApp()).get("/api/playeriq/Mike%20Trout/history?limit=10");

    expect(res.status).toBe(200);
    expect(res.body.playerId).toBe("545361");
    expect(res.body.count).toBe(1);

    // Argument passed to getPlayerTrendHistory is the numeric playerId from
    // the cached row — never the slug form.
    const calls = (getPlayerTrendHistory as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe("545361");
    expect(calls[0][1]).toBe(10);
  });
});
