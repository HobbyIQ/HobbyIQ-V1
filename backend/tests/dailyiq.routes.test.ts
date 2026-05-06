import request from "supertest";
import { afterEach, beforeEach, vi } from "vitest";
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