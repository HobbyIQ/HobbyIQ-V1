import { Router, Request, Response } from "express";
import { getUserBySession } from "../../services/authService";
import { watchPlayersRepository } from "../../repositories/watchPlayersRepository";
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  refreshDailyRealData,
  getDailyMLB,
  getDailyMiLB,
  getDailyDataStatus,
  getWatchPlayerFeed,
} = require("../../services/dailyiqService");

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function deriveBuyScore(stat: any): number {
  let score = 0;
  if (stat.trend === "hot")      score += 35;
  if (stat.trend === "up")       score += 20;
  if (stat.buySignal)            score += 20;
  if ((stat.hr ?? 0) >= 2)      score += 15;
  if ((stat.hr ?? 0) >= 1)      score += 8;
  if ((stat.hits ?? 0) >= 3)    score += 10;
  if ((stat.strikeouts ?? 0) >= 10) score += 12;
  if (stat.isProspect)           score += 10;
  return Math.min(score, 100);
}

function deriveAction(stat: any): string {
  const score = deriveBuyScore(stat);
  if (stat.trend === "hot" && score >= 65)  return "buy";
  if (stat.trend === "up"  && score >= 40)  return "watch";
  if (stat.trend === "cold" || stat.trend === "down") return "sell";
  return "hold";
}

function deriveVerdict(stat: any): string {
  const note = stat.performanceNote ?? "";
  const line = stat.statLine ?? "";
  if (note && line) return `${line} — ${note}`;
  return note || line || "No update today.";
}

function deriveMarketDNA(stat: any): { demand: string; speed: string; risk: string; trend: string } {
  const trend = stat.trend === "hot" ? "up" : stat.trend === "cold" ? "down" : stat.trend ?? "flat";
  const demand = stat.trend === "hot" ? "High" : stat.trend === "up" ? "Moderate" : "Low";
  const speed  = stat.trend === "hot" ? "Fast" : "Normal";
  const risk   = stat.isProspect ? "High" : stat.trend === "cold" ? "Elevated" : "Low";
  return { demand, speed, risk, trend };
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function derivePlayerId(playerName: string): string {
  return playerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolvePlayerNameFromBody(body: any): string {
  const raw =
    body?.playerName
    ?? body?.name
    ?? body?.fullName
    ?? body?.player
    ?? "";
  return String(raw).trim();
}

function parseLimit(value: unknown, fallback = 10): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), 1), 50);
}

function normalizeSearchQuery(query: string): string {
  return query
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function derivePlayerNameFromSearchQuery(query: string): string {
  const cleaned = normalizeSearchQuery(query);
  if (!cleaned) {
    return "";
  }

  const stopTokens = new Set([
    "auto",
    "autograph",
    "chrome",
    "bowman",
    "topps",
    "refractor",
    "parallel",
    "psa",
    "sgc",
    "bgs",
    "rc",
    "rookie",
    "card",
    "set",
    "edition",
    "first",
    "1st",
    "draft",
    "prospect",
    "gem",
    "mint",
  ]);

  const tokens = cleaned
    .split(" ")
    .filter((token) => token.length > 1)
    .filter((token) => !/^\d{2,4}$/.test(token))
    .filter((token) => !stopTokens.has(token.toLowerCase()));

  if (tokens.length >= 2) {
    return `${tokens[0]} ${tokens[1]}`.trim();
  }
  return tokens[0] ?? "";
}

async function fetchPlayerSuggestions(query: string, limit: number): Promise<Array<{
  playerId: string;
  playerName: string;
  team?: string;
  league?: string;
}>> {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return [];
  }

  const endpoint = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(normalized)}&sportIds=1,11,12,13,14`;

  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) {
      return [];
    }

    const data = await response.json() as {
      people?: Array<{
        id?: number;
        fullName?: string;
        currentTeam?: { name?: string };
        sport?: { id?: number };
      }>;
    };

    return (data.people ?? [])
      .map((person) => {
        const name = String(person.fullName ?? "").trim();
        if (!name) {
          return null;
        }
        const sportId = Number(person.sport?.id ?? 0);
        const league = sportId === 1 ? "MLB" : sportId > 1 ? "MiLB" : undefined;
        return {
          playerId: String(person.id ?? derivePlayerId(name)),
          playerName: name,
          team: person.currentTeam?.name,
          league,
        };
      })
      .filter((player): player is NonNullable<typeof player> => Boolean(player))
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function resolveAuthenticatedUserId(req: Request): Promise<string | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    return null;
  }

  const user = await getUserBySession(sessionId);
  return user?.userId ?? null;
}

// Backward-compatible endpoints used by older iOS DailyIQ views.
router.get("/mlb", async (_req: Request, res: Response) => {
  try {
    await refreshDailyRealData(false);
    const stats = getDailyMLB();
    const meta = getDailyDataStatus();
    return res.json({
      date: meta.dataDate ?? todayStr(),
      stats,
      meta,
    });
  } catch (err) {
    console.error("[dailyiq/mlb] GET error:", err);
    return res.status(500).json({ error: "Failed to load MLB daily stats" });
  }
});

router.get("/milb", async (_req: Request, res: Response) => {
  try {
    await refreshDailyRealData(false);
    const stats = getDailyMiLB();
    const meta = getDailyDataStatus();
    return res.json({
      date: meta.dataDate ?? todayStr(),
      stats,
      meta,
    });
  } catch (err) {
    console.error("[dailyiq/milb] GET error:", err);
    return res.status(500).json({ error: "Failed to load MiLB daily stats" });
  }
});

// ── GET /api/dailyiq/brief ────────────────────────────────────────────────────
router.get("/brief", async (_req: Request, res: Response) => {
  try {
    await refreshDailyRealData(false);

    const mlb  = getDailyMLB();
    const milb = getDailyMiLB();
    const meta = getDailyDataStatus();

    // Top MLB performers
    const topMLB = [...mlb]
      .filter((s) => s.trend === "hot" || s.trend === "up" || (s.hr ?? 0) >= 1)
      .sort((a, b) => {
        const scoreA = (a.hr ?? 0) * 6 + (a.hits ?? 0) * 2 + (a.strikeouts ?? 0);
        const scoreB = (b.hr ?? 0) * 6 + (b.hits ?? 0) * 2 + (b.strikeouts ?? 0);
        return scoreB - scoreA;
      })
      .slice(0, 4);

    // Top MiLB prospects
    const topMiLB = [...milb]
      .filter((s) => s.isProspect && (s.trend === "hot" || s.trend === "up"))
      .sort((a, b) => {
        const scoreA = (a.hr ?? 0) * 6 + (a.hits ?? 0) * 2 + (a.rbi ?? 0) * 2;
        const scoreB = (b.hr ?? 0) * 6 + (b.hits ?? 0) * 2 + (b.rbi ?? 0) * 2;
        return scoreB - scoreA;
      })
      .slice(0, 3);

    const cards = [
      ...topMLB.map((stat, i) => ({
        id: `mlb-${i}-${stat.playerName.replace(/\s+/g, "-").toLowerCase()}`,
        label: stat.trend === "hot" ? "MLB HOT" : "MLB",
        action: deriveAction(stat),
        playerName: stat.playerName,
        cardTitle: `${stat.team ?? ""} · ${stat.position ?? ""}`.trim().replace(/^·\s*/, ""),
        cardYear: null,
        product: null,
        fairMarketValue: null,
        quickSaleValue: null,
        premiumValue: null,
        verdict: deriveVerdict(stat),
        dealScore: deriveBuyScore(stat),
        marketDNA: deriveMarketDNA(stat),
        compsUsed: null,
      })),
      ...topMiLB.map((stat, i) => ({
        id: `milb-${i}-${stat.playerName.replace(/\s+/g, "-").toLowerCase()}`,
        label: "PROSPECT WATCH",
        action: deriveAction(stat),
        playerName: stat.playerName,
        cardTitle: `${stat.team ?? ""} · ${stat.position ?? ""}`.trim().replace(/^·\s*/, ""),
        cardYear: null,
        product: null,
        fairMarketValue: null,
        quickSaleValue: null,
        premiumValue: null,
        verdict: deriveVerdict(stat),
        dealScore: deriveBuyScore(stat),
        marketDNA: deriveMarketDNA(stat),
        compsUsed: null,
      })),
    ];

    res.json({
      date: meta.dataDate ?? todayStr(),
      cards,
    });
  } catch (err) {
    console.error("[dailyiq/brief] error:", err);
    res.status(500).json({ error: "Failed to build daily brief" });
  }
});

router.get("/watch", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  try {
    await refreshDailyRealData(false);
    const watchlist = watchPlayersRepository.getList(userId);
    const players = await getWatchPlayerFeed(userId);
    const meta = getDailyDataStatus();
    return res.json({
      userId,
      watchlist,
      count: players.length,
      players,
      meta,
    });
  } catch (err) {
    console.error("[dailyiq/watch] GET error:", err);
    return res.status(500).json({ error: "Failed to load watch list" });
  }
});

router.post("/watch", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const playerName = resolvePlayerNameFromBody(req.body);
  if (!playerName) {
    return res.status(400).json({ error: "playerName is required" });
  }

  const added = watchPlayersRepository.addPlayer(userId, {
    playerId: String(req.body?.playerId ?? derivePlayerId(playerName)),
    playerName,
    team: typeof req.body?.team === "string" ? req.body.team : undefined,
    league: typeof req.body?.league === "string" ? req.body.league : undefined,
  });
  if (!added) {
    return res.status(409).json({ error: `${playerName} is already on your watch list` });
  }

  return res.status(201).json({ message: `${playerName} added to your watch list`, item: added });
});

router.delete("/watch", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const playerName = String(req.body?.playerName ?? "").trim();
  if (!playerName) {
    return res.status(400).json({ error: "playerName is required" });
  }

  const removed = watchPlayersRepository.removePlayerByName(userId, playerName);
  if (!removed) {
    return res.status(404).json({ error: `${playerName} not found on your watch list` });
  }

  return res.json({ message: `${playerName} removed from your watch list` });
});

router.get("/watchlist", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  try {
    await refreshDailyRealData(false);
    const watchlist = watchPlayersRepository.getList(userId);
    const players = await getWatchPlayerFeed(userId);
    const meta = getDailyDataStatus();
    return res.json({
      userId,
      count: watchlist.length,
      watchlist,
      players,
      meta,
    });
  } catch (err) {
    console.error("[dailyiq/watchlist] GET error:", err);
    return res.status(500).json({ error: "Failed to load watch list" });
  }
});

router.post("/watchlist", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const playerName = resolvePlayerNameFromBody(req.body);
  if (!playerName) {
    return res.status(400).json({ error: "playerName is required" });
  }

  const added = watchPlayersRepository.addPlayer(userId, {
    playerId: String(req.body?.playerId ?? derivePlayerId(playerName)),
    playerName,
    team: typeof req.body?.team === "string" ? req.body.team : undefined,
    league: typeof req.body?.league === "string" ? req.body.league : undefined,
  });

  if (!added) {
    return res.status(409).json({ error: `${playerName} is already on your watch list` });
  }

  return res.status(201).json({ message: `${playerName} added to your watch list`, item: added });
});

router.post("/watchlist/search", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const explicitPlayerName = resolvePlayerNameFromBody(req.body);
  const rawQuery = String(req.body?.query ?? req.body?.search ?? "").trim();
  const playerName = explicitPlayerName || derivePlayerNameFromSearchQuery(rawQuery);

  if (!playerName) {
    return res.status(400).json({ error: "query or playerName is required" });
  }

  const added = watchPlayersRepository.addPlayer(userId, {
    playerId: String(req.body?.playerId ?? derivePlayerId(playerName)),
    playerName,
    team: typeof req.body?.team === "string" ? req.body.team : undefined,
    league: typeof req.body?.league === "string" ? req.body.league : undefined,
  });

  if (!added) {
    return res.status(409).json({ error: `${playerName} is already on your watch list` });
  }

  return res.status(201).json({
    message: `${playerName} added to your watch list`,
    item: added,
    resolvedFrom: explicitPlayerName ? "playerName" : "query",
  });
});

router.get("/watchlist/top", async (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit, 10);
  const players = watchPlayersRepository.getTopWatched(limit);
  return res.json({
    count: players.length,
    players,
  });
});

router.get("/watchlist/suggest", async (req: Request, res: Response) => {
  const query = String(req.query.q ?? req.query.query ?? "").trim();
  const limit = parseLimit(req.query.limit, 8);
  if (query.length < 2) {
    return res.json({ query, suggestions: [] });
  }

  const suggestions = await fetchPlayerSuggestions(query, limit);
  return res.json({
    query,
    suggestions,
  });
});

router.delete("/watchlist/:playerId", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const playerId = String(req.params.playerId ?? "").trim();
  if (!playerId) {
    return res.status(400).json({ error: "playerId is required" });
  }

  const removed = watchPlayersRepository.removePlayer(userId, playerId);
  if (!removed) {
    return res.status(404).json({ error: `${playerId} not found on your watch list` });
  }

  return res.json({ message: `${playerId} removed from your watch list` });
});

export default router;
