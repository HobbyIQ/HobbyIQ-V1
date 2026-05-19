import request from "supertest";
import { afterEach, beforeEach, vi } from "vitest";

// Mock the live ingestion service BEFORE importing the app so the routes
// don't try to hit statsapi.mlb.com under stubbed fetch.
vi.mock("../src/services/dailyiq/dynamicIngestion.service.js", () => {
  const mlb = [
    {
      mlbPersonId: 660271,
      playerId: "660271",
      slug: "shohei-ohtani",
      playerName: "Shohei Ohtani",
      team: "LAD",
      teamName: "Los Angeles Dodgers",
      teamAbbreviation: "LAD",
      position: "DH",
      league: "MLB",
      level: null,
      dailyStats: { gameDate: "2026-05-16", opponent: "SD", atBats: 4, runs: 2, hits: 3, homeRuns: 1, rbi: 3, rbis: 3, walks: 1, strikeouts: 0, stolenBases: 0, battingAverage: ".750", ops: "1.500", dailyStatsStatus: "real", statsType: "batting" },
      seasonStats: { gamesPlayed: 50, atBats: 200, runs: 50, hits: 70, homeRuns: 15, rbi: 45, rbis: 45, walks: 30, strikeouts: 40, stolenBases: 5, battingAverage: ".350", onBasePercentage: ".440", sluggingPercentage: ".700", ops: "1.140", obp: ".440", slg: ".700", statsType: "batting" },
      dailyScore: 92.5,
    },
    {
      mlbPersonId: 592450,
      playerId: "592450",
      slug: "aaron-judge",
      playerName: "Aaron Judge",
      team: "NYY",
      teamName: "New York Yankees",
      teamAbbreviation: "NYY",
      position: "OF",
      league: "MLB",
      level: null,
      dailyStats: { gameDate: "2026-05-16", opponent: "BOS", atBats: 4, runs: 1, hits: 2, homeRuns: 1, rbi: 2, rbis: 2, walks: 0, strikeouts: 1, stolenBases: 0, battingAverage: ".500", ops: "1.250", dailyStatsStatus: "real", statsType: "batting" },
      seasonStats: { gamesPlayed: 50, atBats: 195, runs: 45, hits: 60, homeRuns: 18, rbi: 50, rbis: 50, walks: 35, strikeouts: 50, stolenBases: 2, battingAverage: ".308", onBasePercentage: ".410", sluggingPercentage: ".680", ops: "1.090", obp: ".410", slg: ".680", statsType: "batting" },
      dailyScore: 78.0,
    },
    {
      mlbPersonId: 694973,
      playerId: "paul-skenes",
      slug: "paul-skenes",
      playerName: "Paul Skenes",
      team: "PIT",
      teamName: "Pittsburgh Pirates",
      teamAbbreviation: "PIT",
      position: "SP",
      league: "MLB",
      level: null,
      dailyStats: { gameDate: "2026-05-16", opponent: "CHC", atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0, walks: 0, strikeouts: 11, stolenBases: 0, battingAverage: ".000", ops: ".000", dailyStatsStatus: "real", statsType: "pitching", inningsPitched: "7.0", earnedRuns: 1, pitchCount: 95, hitsAllowed: 4, runsAllowed: 1, homeRunsAllowed: 0, decision: "W", qualityStart: true, pitched: true },
      seasonStats: { gamesPlayed: 10, atBats: 0, runs: 0, hits: 0, homeRuns: 0, rbi: 0, rbis: 0, walks: 10, strikeouts: 80, stolenBases: 0, battingAverage: ".000", onBasePercentage: ".000", sluggingPercentage: ".000", ops: ".000", obp: ".000", slg: ".000", statsType: "pitching", era: "2.10", wins: 6, losses: 1, saves: 0, gamesStarted: 10, whip: "0.95", inningsPitched: "65.0" },
      dailyScore: 85.0,
    },
  ];
  const milb = [
    {
      mlbPersonId: 700001,
      playerId: "700001",
      slug: "minor-leaguer",
      playerName: "Minor Leaguer",
      team: "ABQ",
      teamName: "Albuquerque Isotopes",
      teamAbbreviation: "ABQ",
      position: "OF",
      league: "MiLB",
      level: "Triple-A",
      dailyStats: { gameDate: "2026-05-16", opponent: "REN", atBats: 5, runs: 2, hits: 3, homeRuns: 1, rbi: 2, rbis: 2, walks: 0, strikeouts: 1, stolenBases: 0, battingAverage: ".600", ops: "1.300", dailyStatsStatus: "real", statsType: "batting" },
      seasonStats: { gamesPlayed: 30, atBats: 120, runs: 25, hits: 40, homeRuns: 8, rbi: 25, rbis: 25, walks: 15, strikeouts: 30, stolenBases: 3, battingAverage: ".333", onBasePercentage: ".410", sluggingPercentage: ".600", ops: "1.010", obp: ".410", slg: ".600", statsType: "batting" },
      dailyScore: 65.0,
    },
  ];
  return {
    ingestDailyPlayers: vi.fn().mockResolvedValue({ date: "2026-05-16", mlb, milb, errors: [] }),
  };
});

import app from "../src/app";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(username: string, password: string): Promise<string> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });

  expect(response.status).toBe(200);
  expect(response.body.sessionId).toBeTruthy();
  return response.body.sessionId as string;
}

describe("DailyIQ routes", () => {
  it("returns only MLB players for the MLB top endpoint", async () => {
    const response = await request(app).get("/api/dailyiq/players/top/mlb");

    expect(response.status).toBe(200);
    expect(response.body.limit).toBe(50);
    expect(response.body.players.length).toBeGreaterThan(0);
    expect(response.body.players.every((player: any) => player.league === "MLB")).toBe(true);
    expect(response.body.players.every((player: any) => player.rank >= 1)).toBe(true);
    expect(response.body.players.every((player: any) => typeof player.rankingScore === "number")).toBe(true);
    expect(response.body.players.every((player: any) => player.dailyStats && player.seasonStats)).toBe(true);
  });

  it("returns only MiLB players for the MiLB top endpoint", async () => {
    const response = await request(app).get("/api/dailyiq/players/top/milb");

    expect(response.status).toBe(200);
    expect(response.body.players.length).toBeGreaterThan(0);
    expect(response.body.players.every((player: any) => player.league === "MiLB")).toBe(true);
    expect(response.body.players.every((player: any) => player.level !== null)).toBe(true);
  });

  it("returns non-empty watchlist top players for a large limit", async () => {
    const response = await request(app).get("/api/dailyiq/watchlist/top?limit=50");

    expect(response.status).toBe(200);
    expect(response.body.count).toBeGreaterThan(0);
    expect(response.body.count).toBeLessThanOrEqual(50);
    expect(Array.isArray(response.body.players)).toBe(true);
    expect(response.body.players.length).toBe(response.body.count);
  });

  it("scopes watchlists by authenticated user", async () => {
    const firstSession = await signIn("HobbyIQ", "Baseball25");
    const secondSession = await signIn("JusttheBoysandCards", "Carolina23");

    const addResponse = await request(app)
      .post("/api/dailyiq/watchlist")
      .set("x-session-id", firstSession)
      .send({ playerId: "shohei-ohtani" });

    expect([200, 201]).toContain(addResponse.status);

    const firstWatchlist = await request(app)
      .get("/api/dailyiq/watchlist")
      .set("x-session-id", firstSession);

    const secondWatchlist = await request(app)
      .get("/api/dailyiq/watchlist")
      .set("x-session-id", secondSession);

    expect(firstWatchlist.status).toBe(200);
    expect(secondWatchlist.status).toBe(200);
    expect(firstWatchlist.body.count).toBeGreaterThanOrEqual(1);
    expect(firstWatchlist.body.watchlist.some((player: any) => player.playerId === "shohei-ohtani")).toBe(true);
    expect(secondWatchlist.body.watchlist.some((player: any) => player.playerId === "shohei-ohtani")).toBe(false);
  });

  it("prevents duplicate watchlist entries for the same user", async () => {
    const sessionId = await signIn("HobbyIQ", "Baseball25");

    await request(app)
      .post("/api/dailyiq/watchlist")
      .set("x-session-id", sessionId)
      .send({ playerId: "jackson-chourio" });

    await request(app)
      .post("/api/dailyiq/watchlist")
      .set("x-session-id", sessionId)
      .send({ playerId: "jackson-chourio" });

    const watchlist = await request(app)
      .get("/api/dailyiq/watchlist")
      .set("x-session-id", sessionId);

    const matches = watchlist.body.watchlist.filter((player: any) => player.playerId === "jackson-chourio");
    expect(matches).toHaveLength(1);
  });

  it("returns dashboard sections and watchlist status consistently", async () => {
    const sessionId = await signIn("HobbyIQ", "Baseball25");

    await request(app)
      .post("/api/dailyiq/watchlist")
      .set("x-session-id", sessionId)
      .send({ playerId: "paul-skenes" });

    const dashboard = await request(app)
      .get("/api/dailyiq/dashboard/player-stats")
      .set("x-session-id", sessionId);

    expect(dashboard.status).toBe(200);
    expect(Array.isArray(dashboard.body.mlbTopPlayers)).toBe(true);
    expect(Array.isArray(dashboard.body.milbTopPlayers)).toBe(true);
    expect(Array.isArray(dashboard.body.watchlistPlayers)).toBe(true);
    expect(dashboard.body.mlbTopPlayers.some((player: any) => player.playerId === "paul-skenes" && player.isOnWatchlist === true)).toBe(true);
    expect(dashboard.body.watchlistPlayers.some((player: any) => player.playerId === "paul-skenes" && player.isOnWatchlist === true)).toBe(true);
  });
});