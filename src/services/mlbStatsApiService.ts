// @ts-nocheck
export {};
"use strict";
// MLB Stats API Ã¢â‚¬â€ free, no key required
// Docs: https://github.com/toddrob99/MLB-StatsAPI
// Used to fetch real per-player game logs for the Watch Players feed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLastGameStat = getLastGameStat;
exports.getTopPerformersBySportIds = getTopPerformersBySportIds;
const BASE = "https://statsapi.mlb.com/api/v1";
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ In-memory daily caches Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const playerIdCache = new Map();
const statCache = new Map();
function todayStr() {
    return new Date().toISOString().split("T")[0];
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function safeJson(url) {
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok)
            return null;
        return (await resp.json());
    }
    catch {
        return null;
    }
}
async function resolvePlayerId(playerName) {
    const key = playerName.toLowerCase();
    if (playerIdCache.has(key))
        return playerIdCache.get(key) ?? null;
    const url = `${BASE}/people/search?names=${encodeURIComponent(playerName)}&sportIds=1,11,12,13,14`;
    const data = await safeJson(url);
    const id = data?.people?.[0]?.id ?? null;
    playerIdCache.set(key, id);
    return id;
}
function formatHittingLine(s) {
    const parts = [];
    const hits = Number(s["hits"] ?? 0);
    const ab = Number(s["atBats"] ?? 0);
    if (ab > 0)
        parts.push(`${hits}/${ab}`);
    if (Number(s["homeRuns"] ?? 0) > 0)
        parts.push(`${s["homeRuns"]} HR`);
    if (Number(s["rbi"] ?? 0) > 0)
        parts.push(`${s["rbi"]} RBI`);
    if (Number(s["baseOnBalls"] ?? 0) > 0)
        parts.push(`${s["baseOnBalls"]} BB`);
    if (Number(s["strikeOuts"] ?? 0) > 0)
        parts.push(`${s["strikeOuts"]} K`);
    if (Number(s["stolenBases"] ?? 0) > 0)
        parts.push(`${s["stolenBases"]} SB`);
    return parts.join(", ") || "No stats";
}
function formatPitchingLine(s) {
    const parts = [];
    if (s["inningsPitched"] !== undefined)
        parts.push(`${s["inningsPitched"]} IP`);
    if (s["earnedRuns"] !== undefined)
        parts.push(`${s["earnedRuns"]} ER`);
    if (Number(s["strikeOuts"] ?? 0) > 0)
        parts.push(`${s["strikeOuts"]} K`);
    if (Number(s["baseOnBalls"] ?? 0) > 0)
        parts.push(`${s["baseOnBalls"]} BB`);
    if (s["hits"] !== undefined)
        parts.push(`${s["hits"]} H`);
    return parts.join(", ") || "No stats";
}
function toNumber(value) {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}
function normalizeInningsPitched(ip) {
    if (typeof ip !== "string" || ip.length === 0)
        return 0;
    const parts = ip.split(".");
    const whole = toNumber(parts[0]);
    const outs = toNumber(parts[1]);
    return whole + Math.min(Math.max(outs, 0), 2) / 3;
}
function hitterScore(stat) {
    return (toNumber(stat.hits) * 2) +
        (toNumber(stat.homeRuns) * 6) +
        (toNumber(stat.rbi) * 2) +
        (toNumber(stat.stolenBases) * 2);
}
function pitcherScore(stat) {
    return (normalizeInningsPitched(stat.inningsPitched) * 2) +
        (toNumber(stat.strikeOuts) * 1.5) -
        (toNumber(stat.earnedRuns) * 2);
}
function deriveTrendFromScore(score) {
    if (score >= 12)
        return "hot";
    if (score >= 6)
        return "up";
    if (score <= 0)
        return "cold";
    return "flat";
}
function hasMeaningfulLine(score, batting, pitching) {
    if (score >= 4)
        return true;
    return toNumber(batting?.homeRuns) >= 1 || toNumber(pitching?.strikeOuts) >= 7;
}
function buildPerformer(player, teamAbbrev, level, batting, pitching) {
    const battingScore = hitterScore(batting ?? {});
    const pitchingScore = pitcherScore(pitching ?? {});
    const isPitcher = pitchingScore > battingScore;
    const score = Math.max(battingScore, pitchingScore);
    if (!hasMeaningfulLine(score, batting, pitching))
        return null;
    return {
        playerName: player?.person?.fullName ?? "Unknown",
        team: teamAbbrev,
        level,
        position: player?.position?.abbreviation ?? (isPitcher ? "P" : "POS"),
        statLine: isPitcher ? formatPitchingLine(pitching ?? {}) : formatHittingLine(batting ?? {}),
        performanceNote: isPitcher ? "Strong pitching line from yesterday" : "Strong hitting line from yesterday",
        trend: deriveTrendFromScore(score),
        hr: toNumber(batting?.homeRuns),
        hits: toNumber(batting?.hits),
        rbi: toNumber(batting?.rbi),
        strikeouts: toNumber((isPitcher ? pitching?.strikeOuts : batting?.strikeOuts)),
        era: isPitcher ? null : null,
        isProspect: level === "MiLB",
        buySignal: score >= 10,
        score,
    };
}
async function getScheduleGamePksBySport(date, sportId) {
    const url = `${BASE}/schedule?sportId=${sportId}&date=${date}`;
    const data = await safeJson(url);
    const dates = data?.dates ?? [];
    const games = dates.flatMap((d) => d.games ?? []);
    return games.map((g) => g.gamePk).filter(Boolean);
}
async function getTopPerformersBySportIds(date, sportIds, level, limit = 30) {
    const gamePks = [];
    for (const sportId of sportIds) {
        const pks = await getScheduleGamePksBySport(date, sportId);
        gamePks.push(...pks);
    }
    if (gamePks.length === 0)
        return [];
    const performers = [];
    for (const gamePk of gamePks) {
        const box = await safeJson(`${BASE}/game/${gamePk}/boxscore`);
        const teams = [box?.teams?.home, box?.teams?.away];
        for (const team of teams) {
            const teamAbbrev = team?.team?.abbreviation ?? "";
            const players = team?.players ?? {};
            for (const key of Object.keys(players)) {
                const player = players[key];
                const batting = player?.stats?.batting;
                const pitching = player?.stats?.pitching;
                const perf = buildPerformer(player, teamAbbrev, level, batting, pitching);
                if (perf)
                    performers.push(perf);
            }
        }
    }
    const bestByPlayer = new Map();
    for (const p of performers) {
        const key = `${p.level}:${p.playerName.toLowerCase()}`;
        const existing = bestByPlayer.get(key);
        if (!existing || p.score > existing.score) {
            bestByPlayer.set(key, p);
        }
    }
    return Array.from(bestByPlayer.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((p) => {
        const { score, ...rest } = p;
        return rest;
    });
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Public API Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
/**
 * Returns the most recent game stat for a player from this season.
 * Returns null if the player can't be found on the MLB Stats API.
 */
async function getLastGameStat(playerName) {
    const today = todayStr();
    const cacheKey = playerName.toLowerCase();
    const cached = statCache.get(cacheKey);
    if (cached && cached.cachedDate === today)
        return cached.result;
    const personId = await resolvePlayerId(playerName);
    if (!personId) {
        statCache.set(cacheKey, { result: null, cachedDate: today });
        return null;
    }
    const season = new Date().getFullYear();
    // Try pitching first, then hitting
    for (const group of ["pitching", "hitting"]) {
        const url = `${BASE}/people/${personId}/stats?stats=gameLog&season=${season}&group=${group}&sportId=1`;
        const data = await safeJson(url);
        const splits = data?.stats?.[0]?.splits;
        if (!splits || splits.length === 0)
            continue;
        const last = splits[splits.length - 1];
        const statLine = group === "pitching" ? formatPitchingLine(last.stat) : formatHittingLine(last.stat);
        const result = {
            date: last.date,
            statLine,
            position: last.position?.abbreviation ?? (group === "pitching" ? "P" : "POS"),
            team: last.team?.abbreviation ?? "",
            played: true,
        };
        statCache.set(cacheKey, { result, cachedDate: today });
        return result;
    }
    statCache.set(cacheKey, { result: null, cachedDate: today });
    return null;
}
