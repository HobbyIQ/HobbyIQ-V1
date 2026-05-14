// Last 7 / Last 15 game-log aggregates from MLB Stats API.
// Free, no auth: https://statsapi.mlb.com/api/v1/people/{id}/stats?stats=gameLog
// Works for both MLB and MiLB players (sportId resolved automatically by gameLog).

export interface RecentFormSplit {
  games: number;
  // hitter
  atBats?: number;
  hits?: number;
  homeRuns?: number;
  rbis?: number;
  runs?: number;
  walks?: number;
  strikeouts?: number;
  battingAverage?: string;
  ops?: string;
  // pitcher
  inningsPitched?: string;
  earnedRuns?: number;
  wins?: number;
  losses?: number;
  saves?: number;
  era?: string;
  whip?: string;
}

export interface RecentForm {
  last7: RecentFormSplit;
  last15: RecentFormSplit;
}

interface GameLogStat {
  gameType?: string;
  date?: string;
  stat?: Record<string, unknown>;
}

interface GameLogSplit {
  group?: { displayName?: string };
  type?: { displayName?: string };
  splits?: GameLogStat[];
}

interface GameLogResponse {
  stats?: GameLogSplit[];
}

const CACHE_TTL_MS = Number(process.env.DAILYIQ_RECENT_FORM_CACHE_MS ?? 15 * 60 * 1000);
const cache = new Map<string, { cachedAtMs: number; form: RecentForm | null }>();

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseInnings(value: unknown): number {
  // MLB API returns IP as "5.2" meaning 5 and 2/3 innings.
  if (typeof value !== "string") return num(value);
  const [whole, frac] = value.split(".");
  const wholeNum = Number(whole) || 0;
  const fracNum = frac === "1" ? 1 / 3 : frac === "2" ? 2 / 3 : 0;
  return wholeNum + fracNum;
}

function formatInnings(totalThirds: number): string {
  const whole = Math.floor(totalThirds);
  const frac = totalThirds - whole;
  if (frac < 1 / 6) return `${whole}.0`;
  if (frac < 1 / 2) return `${whole}.1`;
  return `${whole}.2`;
}

function formatRate(numerator: number, denominator: number, digits = 3): string {
  if (denominator <= 0) return ".000";
  const rate = numerator / denominator;
  return rate.toFixed(digits).replace(/^0\./, ".");
}

function aggregateHitting(splits: GameLogStat[]): RecentFormSplit {
  let ab = 0, h = 0, hr = 0, rbi = 0, runs = 0, bb = 0, k = 0;
  let totalBases = 0, hbp = 0, sf = 0;
  for (const split of splits) {
    const s = split.stat ?? {};
    ab += num(s.atBats);
    h += num(s.hits);
    hr += num(s.homeRuns);
    rbi += num(s.rbi);
    runs += num(s.runs);
    bb += num(s.baseOnBalls);
    k += num(s.strikeOuts);
    const doubles = num(s.doubles);
    const triples = num(s.triples);
    const singles = num(s.hits) - doubles - triples - num(s.homeRuns);
    totalBases += singles + 2 * doubles + 3 * triples + 4 * num(s.homeRuns);
    hbp += num(s.hitByPitch);
    sf += num(s.sacFlies);
  }
  const obpDenom = ab + bb + hbp + sf;
  const obp = obpDenom > 0 ? (h + bb + hbp) / obpDenom : 0;
  const slg = ab > 0 ? totalBases / ab : 0;
  return {
    games: splits.length,
    atBats: ab,
    hits: h,
    homeRuns: hr,
    rbis: rbi,
    runs,
    walks: bb,
    strikeouts: k,
    battingAverage: formatRate(h, ab),
    ops: (obp + slg).toFixed(3).replace(/^0\./, "."),
  };
}

function aggregatePitching(splits: GameLogStat[]): RecentFormSplit {
  let outs = 0, er = 0, h = 0, bb = 0, k = 0, w = 0, l = 0, sv = 0;
  for (const split of splits) {
    const s = split.stat ?? {};
    outs += parseInnings(s.inningsPitched) * 3;
    er += num(s.earnedRuns);
    h += num(s.hits);
    bb += num(s.baseOnBalls);
    k += num(s.strikeOuts);
    w += num(s.wins);
    l += num(s.losses);
    sv += num(s.saves);
  }
  const ip = outs / 3;
  const era = ip > 0 ? (er * 9) / ip : 0;
  const whip = ip > 0 ? (h + bb) / ip : 0;
  return {
    games: splits.length,
    inningsPitched: formatInnings(outs / 3),
    earnedRuns: er,
    strikeouts: k,
    walks: bb,
    wins: w,
    losses: l,
    saves: sv,
    era: era.toFixed(2),
    whip: whip.toFixed(2),
  };
}

export async function fetchRecentForm(
  mlbPersonId: number,
  isPitcher: boolean,
  season: number,
): Promise<RecentForm | null> {
  const cacheKey = `${mlbPersonId}:${isPitcher ? "P" : "H"}:${season}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAtMs < CACHE_TTL_MS) {
    return cached.form;
  }

  const group = isPitcher ? "pitching" : "hitting";
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbPersonId}/stats?stats=gameLog&group=${group}&season=${season}&gameType=R`;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "HobbyIQ/1.0", Accept: "application/json" },
    });
    if (!response.ok) {
      cache.set(cacheKey, { cachedAtMs: Date.now(), form: null });
      return null;
    }
    const payload = (await response.json()) as GameLogResponse;
    const games = (payload.stats?.[0]?.splits ?? [])
      .filter((s) => s.gameType !== "S") // exclude spring training
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

    const last7Games = games.slice(-7);
    const last15Games = games.slice(-15);
    const aggregator = isPitcher ? aggregatePitching : aggregateHitting;

    const form: RecentForm = {
      last7: aggregator(last7Games),
      last15: aggregator(last15Games),
    };
    cache.set(cacheKey, { cachedAtMs: Date.now(), form });
    return form;
  } catch {
    cache.set(cacheKey, { cachedAtMs: Date.now(), form: null });
    return null;
  }
}
