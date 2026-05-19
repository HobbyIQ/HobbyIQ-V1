import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

import {
  __resetPlayerSeasonCacheForTests,
  appendPlayerSeasonGame,
  getPlayerSeason,
  playerSeasonDocId,
  upsertPlayerSeason,
} from "../src/services/dailyiq/playerSeasonStore.service.js";

describe("dailyiq playerSeasonStore (disk fallback)", () => {
  let tmpDir: string;
  let storePath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dailyiq-player-season-"));
    storePath = path.join(tmpDir, "store.json");
    savedEnv = {
      DAILYIQ_PLAYER_SEASON_STORE_PATH: process.env.DAILYIQ_PLAYER_SEASON_STORE_PATH,
      COSMOS_ENDPOINT: process.env.COSMOS_ENDPOINT,
      COSMOS_CONNECTION_STRING: process.env.COSMOS_CONNECTION_STRING,
      COSMOS_KEY: process.env.COSMOS_KEY,
    };
    process.env.DAILYIQ_PLAYER_SEASON_STORE_PATH = storePath;
    delete process.env.COSMOS_ENDPOINT;
    delete process.env.COSMOS_CONNECTION_STRING;
    delete process.env.COSMOS_KEY;
    __resetPlayerSeasonCacheForTests();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetPlayerSeasonCacheForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for an unknown player", async () => {
    const result = await getPlayerSeason("12345", 2026, "regular");
    expect(result).toBeNull();
  });

  it("upserts and reads back a full season payload with recomputed aggregates", async () => {
    const written = await upsertPlayerSeason({
      playerId: "660271",
      playerName: "Ohtani",
      seasonYear: 2026,
      phase: "regular",
      sportId: 1,
      gameLog: [
        { date: "2026-04-01", fantasyPoints: 10, dailyScore: 40, isHot: true },
        { date: "2026-04-02", fantasyPoints: 20, dailyScore: 60, isHot: true },
        { date: "2026-04-03", fantasyPoints: 5, dailyScore: 15, isHot: false },
      ],
      fantasyPointsTotal: 0,
      gamesPlayed: 0,
      hotDays: 0,
      seasonHigh: 0,
      seasonLow: 0,
      last7Avg: 0,
      last30Avg: 0,
      updatedAt: "",
    });

    expect(written.fantasyPointsTotal).toBe(35);
    expect(written.gamesPlayed).toBe(3);
    expect(written.hotDays).toBe(2);
    expect(written.seasonHigh).toBe(20);
    expect(written.seasonLow).toBe(5);
    expect(written.last7Avg).toBeCloseTo(35 / 3, 6);
    expect(written.last30Avg).toBeCloseTo(35 / 3, 6);
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const readBack = await getPlayerSeason("660271", 2026, "regular");
    expect(readBack).not.toBeNull();
    expect(readBack!.fantasyPointsTotal).toBe(35);
    expect(readBack!.gameLog).toHaveLength(3);
  });

  it("appendPlayerSeasonGame merges by date and recomputes aggregates", async () => {
    await appendPlayerSeasonGame(
      { playerId: "660271", playerName: "Ohtani", seasonYear: 2026, phase: "regular", sportId: 1 },
      { date: "2026-04-01", fantasyPoints: 10, dailyScore: 40, isHot: true },
    );
    await appendPlayerSeasonGame(
      { playerId: "660271", seasonYear: 2026, phase: "regular" },
      { date: "2026-04-02", fantasyPoints: 20, dailyScore: 60, isHot: true },
    );
    // Correction: re-append same date with new value — should overwrite, not duplicate.
    const final = await appendPlayerSeasonGame(
      { playerId: "660271", seasonYear: 2026, phase: "regular" },
      { date: "2026-04-02", fantasyPoints: 25, dailyScore: 70, isHot: true },
    );

    expect(final.gamesPlayed).toBe(2);
    expect(final.fantasyPointsTotal).toBe(35);
    expect(final.seasonHigh).toBe(25);
    expect(final.gameLog.find((g) => g.date === "2026-04-02")!.fantasyPoints).toBe(25);
  });

  it("partitions by phase: regular and postseason are independent docs", async () => {
    await upsertPlayerSeason({
      playerId: "660271",
      seasonYear: 2026,
      phase: "regular",
      gameLog: [{ date: "2026-09-30", fantasyPoints: 15 }],
      fantasyPointsTotal: 0, gamesPlayed: 0, hotDays: 0, seasonHigh: 0, seasonLow: 0,
      last7Avg: 0, last30Avg: 0, updatedAt: "",
    });
    await upsertPlayerSeason({
      playerId: "660271",
      seasonYear: 2026,
      phase: "postseason",
      gameLog: [{ date: "2026-10-04", fantasyPoints: 40 }],
      fantasyPointsTotal: 0, gamesPlayed: 0, hotDays: 0, seasonHigh: 0, seasonLow: 0,
      last7Avg: 0, last30Avg: 0, updatedAt: "",
    });

    const reg = await getPlayerSeason("660271", 2026, "regular");
    const post = await getPlayerSeason("660271", 2026, "postseason");
    expect(reg!.fantasyPointsTotal).toBe(15);
    expect(post!.fantasyPointsTotal).toBe(40);
  });

  it("caps gameLog at 182 entries, dropping oldest first", async () => {
    const log = Array.from({ length: 200 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = String(Math.floor(i / 28) + 4).padStart(2, "0");
      return {
        date: `2026-${month}-${day}-seq${i}`, // unique to avoid dedupe
        fantasyPoints: i,
      };
    });
    const written = await upsertPlayerSeason({
      playerId: "999",
      seasonYear: 2026,
      phase: "regular",
      gameLog: log,
      fantasyPointsTotal: 0, gamesPlayed: 0, hotDays: 0, seasonHigh: 0, seasonLow: 0,
      last7Avg: 0, last30Avg: 0, updatedAt: "",
    });
    expect(written.gameLog.length).toBeLessThanOrEqual(182);
  });

  it("playerSeasonDocId is deterministic", () => {
    expect(playerSeasonDocId("660271", 2026, "regular")).toBe("660271-2026-regular");
    expect(playerSeasonDocId("660271", 2026, "postseason")).toBe("660271-2026-postseason");
  });

  it("never blanks the store file on parse failure", async () => {
    // Seed garbage into the store file
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, "{not valid json", "utf8");
    __resetPlayerSeasonCacheForTests();

    const result = await getPlayerSeason("anyone", 2026, "regular");
    expect(result).toBeNull();

    // File should still contain the garbage (preserved for forensics)
    const after = await fs.readFile(storePath, "utf8");
    expect(after).toBe("{not valid json");
  });
});
