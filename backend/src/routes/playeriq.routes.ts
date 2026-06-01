// PlayerIQ public routes.
//
//   GET  /api/playeriq/health                       — service health
//   GET  /api/playeriq/top?limit=25&direction=...   — leaderboard
//   GET  /api/playeriq/:playerName                  — score by name
//   GET  /api/playeriq/:playerName/history?limit=30 — score chart points
//   POST /api/playeriq/refresh                      — internal, admin-key
//
// All reads are cheap Cosmos lookups in `player_trends`. The refresh
// endpoint is what fn-player-score-refresh hits nightly with the full
// player pool — gated by BACKEND_ADMIN_KEY.

import { Router, type Request, type Response } from "express";
import {
  getPlayerScoreByName,
  getTopPlayersByScore,
  refreshPlayerScoreForJob,
  getPlayerTrendHistory,
  updatePlayerScoreFromEstimate,
} from "../services/playerScore/playerScore.service.js";
import { getPlayerSeasonAndCareerStats } from "../services/playerScore/mlbStats.service.js";
import { playerNameSlug, type PlayerIQDirection } from "../types/playerScore.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "PlayerIQ",
    timestamp: new Date().toISOString(),
  });
});

// Leaderboard — keep before /:playerName so "top" doesn't get matched as a name.
router.get("/top", async (req: Request, res: Response) => {
  const limitNum = Number.parseInt(String(req.query.limit ?? "25"), 10);
  const limit = Number.isFinite(limitNum) ? limitNum : 25;
  const dirRaw = String(req.query.direction ?? "").trim().toLowerCase();
  const dir: PlayerIQDirection | undefined =
    dirRaw === "rising" || dirRaw === "falling" || dirRaw === "stable" ? dirRaw : undefined;
  try {
    const players = await getTopPlayersByScore(limit, dir);
    res.json({ players, count: players.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Score history for a player. Looks up by name → playerId → history container.
//
// DAILYIQ-PLAYERSCORE-SLUG-FALLBACK-RETIRE Part 1 (2026-06-01): when the
// name lookup misses there is no longer a slug-form playerId to query
// against — pre-retirement we tried `getPlayerTrendHistory(playerNameSlug(name))`
// which returned snapshots written by the prior slug-keyed writer fallback.
// Post-retirement the writer skips unresolvable names entirely, so the slug
// read could only surface stale orphan rows. Empty payload is the canonical
// response for a name-miss.
router.get("/:playerName/history", async (req: Request, res: Response) => {
  const raw = req.params.playerName;
  const name = decodeURIComponent(typeof raw === "string" ? raw : "").trim();
  if (!name) {
    res.status(400).json({ error: "playerName is required" });
    return;
  }
  const limitNum = Number.parseInt(String(req.query.limit ?? "30"), 10);
  const limit = Number.isFinite(limitNum) ? limitNum : 30;
  try {
    const current = await getPlayerScoreByName(name);
    if (!current) {
      res.json({ playerName: name, playerId: null, points: [], count: 0 });
      return;
    }
    const history = await getPlayerTrendHistory(current.playerId, limit);
    res.json({
      playerName: name,
      playerId: current.playerId,
      points: history.map((h) => ({
        playerIQScore: h.playerIQScore,
        playerIQDirection: h.playerIQDirection,
        playerIQLabel: h.playerIQLabel,
        marketScore: h.market.marketScore,
        performanceScore: h.performance.performanceScore,
        updatedAt: h.updatedAt,
        dataSource: h.dataSource,
      })),
      count: history.length,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Season + career stats (MLB.com-style). Lives before /:playerName so the
// "/stats" suffix doesn't get swallowed by the name matcher.
router.get("/:playerName/stats", async (req: Request, res: Response) => {
  const raw = req.params.playerName;
  const name = decodeURIComponent(typeof raw === "string" ? raw : "").trim();
  if (!name) {
    res.status(400).json({ error: "playerName is required" });
    return;
  }
  try {
    const payload = await getPlayerSeasonAndCareerStats(name);
    if (payload.status === "player_not_found") {
      res.status(404).json(payload);
      return;
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Score by name (case-insensitive). When no doc exists yet (common for MiLB
// or freshly-watchlisted players), attempt an on-the-fly build so the
// PlayerIQ detail screen still renders something instead of 404'ing.
router.get("/:playerName", async (req: Request, res: Response) => {
  const raw = req.params.playerName;
  const name = decodeURIComponent(typeof raw === "string" ? raw : "").trim();
  if (!name) {
    res.status(400).json({ error: "playerName is required" });
    return;
  }
  try {
    // DAILYIQ-PLAYERSCORE-SLUG-FALLBACK-RETIRE Part 1 (2026-06-01): the
    // prior `getPlayerScore(playerNameSlug(name))` fallback between the
    // name lookup and the live-build path read slug-keyed rows written by
    // the retired writer fallback. With the writer no longer producing
    // slug-keyed rows, the slug read could only surface stale orphans.
    // Name miss flows directly to the live-build / stub path.
    let score = await getPlayerScoreByName(name);
    if (!score) {
      // No cached score — try to build one live from CompIQ snapshots + MLB
      // momentum. Rate-limited internally; returns null when there's no data
      // to compute from (e.g. a prospect with no comps yet) AND now when the
      // name doesn't resolve to an MLB person id at all (Part-1 writer skip).
      score = await updatePlayerScoreFromEstimate(name);
    }
    if (!score) {
      // Still nothing. Return a 200 stub so the iOS detail screen can render
      // the rest of the page (stats card, etc.) instead of bailing on 404.
      // The stub's `playerId` keeps the slug form for iOS routing continuity
      // — it's a wire-shape value, not a Cosmos lookup key.
      res.json({
        playerId: playerNameSlug(name),
        playerName: name,
        playerIQScore: null,
        playerIQDirection: null,
        playerIQLabel: null,
        market: null,
        performance: null,
        status: "no_score",
        dataSource: "stub",
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Internal refresh — used by fn-player-score-refresh.
router.post("/refresh", async (req: Request, res: Response) => {
  const adminKey = process.env.BACKEND_ADMIN_KEY;
  const provided = req.header("x-admin-key");
  if (!adminKey || provided !== adminKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const players = Array.isArray(req.body?.players) ? req.body.players : [];
  if (players.length === 0) {
    res.status(400).json({ error: "body.players must be a non-empty array" });
    return;
  }
  const results: Array<{ player: string; ok: boolean; playerIQScore?: number; error?: string }> = [];
  for (const raw of players) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) continue;
    try {
      const score = await refreshPlayerScoreForJob(name);
      if (score) results.push({ player: name, ok: true, playerIQScore: score.playerIQScore });
      else results.push({ player: name, ok: false, error: "no_score" });
    } catch (err) {
      results.push({ player: name, ok: false, error: (err as Error).message });
    }
  }
  res.json({
    refreshed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    completedAt: new Date().toISOString(),
  });
});

export default router;
