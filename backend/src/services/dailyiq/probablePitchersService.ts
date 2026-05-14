// Tomorrow's probable pitchers from MLB Stats API.
// Endpoint: /schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher(stats)
// Free, no auth.

export interface TomorrowMatchup {
  opponentAbbreviation: string;
  opponentName: string;
  isHome: boolean;
  gameTimeUtc: string;
  probablePitcherName?: string;
  probablePitcherEra?: string;
  probablePitcherWins?: number;
  probablePitcherLosses?: number;
  probablePitcherHand?: string; // "L" or "R"
}

interface ProbablePitcher {
  id?: number;
  fullName?: string;
  pitchHand?: { code?: string };
  stats?: Array<{
    group?: { displayName?: string };
    type?: { displayName?: string };
    splits?: Array<{ stat?: Record<string, unknown> }>;
  }>;
}

interface ScheduleTeamWrapper {
  team?: { id?: number; name?: string; abbreviation?: string };
  probablePitcher?: ProbablePitcher;
}

interface ScheduleGame {
  gameDate?: string;
  status?: { abstractGameState?: string };
  teams?: { away?: ScheduleTeamWrapper; home?: ScheduleTeamWrapper };
}

interface ScheduleResponse {
  dates?: Array<{ date?: string; games?: ScheduleGame[] }>;
}

const CACHE_TTL_MS = Number(process.env.DAILYIQ_PROBABLE_CACHE_MS ?? 30 * 60 * 1000);
let cache: { date: string; cachedAtMs: number; byTeam: Map<string, TomorrowMatchup> } | null = null;

function pickEraStat(pitcher?: ProbablePitcher): { era?: string; wins?: number; losses?: number } {
  const splits = pitcher?.stats?.find((s) => s.group?.displayName === "pitching")?.splits ?? [];
  const stat = splits[0]?.stat;
  if (!stat) return {};
  const era = typeof stat.era === "string" ? stat.era : typeof stat.era === "number" ? String(stat.era) : undefined;
  const wins = typeof stat.wins === "number" ? stat.wins : undefined;
  const losses = typeof stat.losses === "number" ? stat.losses : undefined;
  return { era, wins, losses };
}

export async function fetchTomorrowProbablePitchers(date: string): Promise<Map<string, TomorrowMatchup>> {
  if (cache && cache.date === date && Date.now() - cache.cachedAtMs < CACHE_TTL_MS) {
    return cache.byTeam;
  }

  const byTeam = new Map<string, TomorrowMatchup>();
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher(stats(group=[pitching],type=[season]))`;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "HobbyIQ/1.0", Accept: "application/json" },
    });
    if (!response.ok) {
      cache = { date, cachedAtMs: Date.now(), byTeam };
      return byTeam;
    }
    const payload = (await response.json()) as ScheduleResponse;

    for (const dateObj of payload.dates ?? []) {
      for (const game of dateObj.games ?? []) {
        const away = game.teams?.away;
        const home = game.teams?.home;
        const awayAbbr = away?.team?.abbreviation;
        const homeAbbr = home?.team?.abbreviation;
        const awayName = away?.team?.name ?? "";
        const homeName = home?.team?.name ?? "";
        const gameTime = game.gameDate ?? "";

        if (awayAbbr && homeAbbr) {
          const homePitcherStats = pickEraStat(home?.probablePitcher);
          byTeam.set(awayAbbr, {
            opponentAbbreviation: homeAbbr,
            opponentName: homeName,
            isHome: false,
            gameTimeUtc: gameTime,
            probablePitcherName: home?.probablePitcher?.fullName,
            probablePitcherHand: home?.probablePitcher?.pitchHand?.code,
            probablePitcherEra: homePitcherStats.era,
            probablePitcherWins: homePitcherStats.wins,
            probablePitcherLosses: homePitcherStats.losses,
          });

          const awayPitcherStats = pickEraStat(away?.probablePitcher);
          byTeam.set(homeAbbr, {
            opponentAbbreviation: awayAbbr,
            opponentName: awayName,
            isHome: true,
            gameTimeUtc: gameTime,
            probablePitcherName: away?.probablePitcher?.fullName,
            probablePitcherHand: away?.probablePitcher?.pitchHand?.code,
            probablePitcherEra: awayPitcherStats.era,
            probablePitcherWins: awayPitcherStats.wins,
            probablePitcherLosses: awayPitcherStats.losses,
          });
        }
      }
    }
  } catch {
    // swallow — return whatever we accumulated (likely empty)
  }

  cache = { date, cachedAtMs: Date.now(), byTeam };
  return byTeam;
}

export function getTomorrowDateUTC(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + 1);
  return now.toISOString().slice(0, 10);
}
