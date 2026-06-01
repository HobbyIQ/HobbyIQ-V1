// MLB Stats API helper.
//
// Port of compiq-functions/fn-stats-signals/__init__.py into TypeScript so
// the TS backend can compute PlayerScore.performance without going through
// the Python signal layer. Public API, no auth required.
//
// Cached per playerName for 2 hours (in-memory).

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export interface MlbMomentum {
  playerName: string;
  mlbPlayerId: number | null;
  /**
   * DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1 (2026-05-31): matched MLB
   * Stats API sportId from the resolver fanout (1=MLB, 11=AAA, 12=AA,
   * 13=A+, 14=A, 16=Rookie). Null when resolution failed at every level.
   * Drives `level` here and `league` + `level` on the persisted
   * `player_trends` doc — see playerScore.service.ts:buildPlayerScore.
   */
  sportId: number | null;
  statGroup: "hitting" | "pitching" | null;
  /** recent / baseline ratio. 1.0 = neutral. */
  momentumRatio: number;
  /** Clamped multiplier per fn-stats-signals (0.90 – 1.30). */
  multiplier: number;
  direction: "hot" | "cold" | "neutral";
  statLine: string | null;       // "5G: .333/.421/.667 (3 HR)"
  milestone: string | null;
  team: string | null;
  position: string | null;
  level: string | null;          // null for MLB (sportId=1), "AAA"/"AA"/etc for MiLB
  status: "ok" | "player_not_found" | "no_game_log" | "fetch_failed";
  updatedAt: string;
}

interface CacheEntry {
  expiresAt: number;
  value: MlbMomentum;
}
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const cache = new Map<string, CacheEntry>();

function neutral(playerName: string, status: MlbMomentum["status"]): MlbMomentum {
  return {
    playerName,
    mlbPlayerId: null,
    sportId: null,
    statGroup: null,
    momentumRatio: 1.0,
    multiplier: 1.0,
    direction: "neutral",
    statLine: null,
    milestone: null,
    team: null,
    position: null,
    level: null,
    status,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function avgStat(games: any[], key: string): number {
  const vals = games
    .map((g) => g?.stat?.[key])
    .filter((v) => v !== undefined && v !== null);
  if (vals.length === 0) return 0;
  return vals.reduce((a, v) => a + Number(v), 0) / vals.length;
}

function fmtRatio(num: number): string {
  return num.toFixed(3).replace(/^0/, "");
}

function buildHittingStatLine(splits: any[]): string | null {
  const last5 = splits.slice(-5);
  if (last5.length === 0) return null;
  const avg = avgStat(last5, "avg");
  const obp = avgStat(last5, "obp");
  const slg = avgStat(last5, "slg");
  const hrs = last5.reduce((a, g) => a + Number(g?.stat?.homeRuns ?? 0), 0);
  return `${last5.length}G: ${fmtRatio(avg)}/${fmtRatio(obp)}/${fmtRatio(slg)} (${hrs} HR)`;
}

function buildPitchingStatLine(splits: any[]): string | null {
  const last3 = splits.slice(-3);
  if (last3.length === 0) return null;
  const era = avgStat(last3, "era");
  const ks = last3.reduce((a, g) => a + Number(g?.stat?.strikeOuts ?? 0), 0);
  const ip = last3
    .map((g) => Number(g?.stat?.inningsPitched ?? 0))
    .reduce((a, v) => a + v, 0);
  return `${last3.length}GS: ${era.toFixed(2)} ERA · ${ks} K · ${ip.toFixed(1)} IP`;
}

/**
 * Compute MLB momentum for a player. Cached 2h per playerName.
 * Returns `multiplier: 1.0, status: "player_not_found"` for unknown players
 * so callers (PlayerScoreService) can degrade gracefully without throwing.
 */
export async function getMlbMomentum(playerName: string): Promise<MlbMomentum> {
  const key = playerName.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1 (2026-05-31): resolve via
  // searchPlayerPerson (MLB → MiLB fanout across sportIds 1/11/12/13/14/16)
  // instead of the prior MLB-only getPlayerId. MiLB players now resolve to
  // a numeric mlbPlayerId AND carry the matched sportId for league/level
  // derivation downstream in buildPlayerScore. Negative cache at the
  // getMlbMomentum level (CACHE_TTL_MS=2h) absorbs the 6-call cost on
  // un-resolvable names — only the first miss pays.
  const hit = await searchPlayerPerson(playerName);
  if (!hit) {
    const v = neutral(playerName, "player_not_found");
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: v });
    return v;
  }
  const personId = Number(hit.person?.id);
  if (!Number.isFinite(personId) || personId <= 0) {
    const v = neutral(playerName, "player_not_found");
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: v });
    return v;
  }
  const found = {
    id: personId,
    team: hit.person?.currentTeam?.name ?? null,
    position: hit.person?.primaryPosition?.abbreviation ?? null,
    sportId: hit.sportId,
  };

  const season = new Date().getUTCFullYear();
  let group: "hitting" | "pitching" | null = null;
  let splits: any[] = [];
  for (const g of ["hitting", "pitching"] as const) {
    const url =
      `${MLB_BASE}/people/${found.id}/stats?stats=gameLog&season=${season}&group=${g}`;
    const data = await fetchJson(url);
    const arr = data?.stats?.[0]?.splits;
    if (Array.isArray(arr) && arr.length > 0) {
      group = g;
      splits = arr;
      break;
    }
  }

  if (!group || splits.length === 0) {
    const v: MlbMomentum = {
      ...neutral(playerName, "no_game_log"),
      mlbPlayerId: found.id,
      sportId: found.sportId,
      team: found.team,
      position: found.position,
      // DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1: null for MLB (sportId=1),
      // mapped value for MiLB. SPORT_ID_TO_LEVEL[1] is "MLB", but the
      // MlbMomentum.level field's contract is "null for MLB" per its own
      // docstring above + the iOS chip-rendering convention.
      level: found.sportId === 1 ? null : levelFromSport(found.sportId),
    };
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: v });
    return v;
  }

  let momentum = 1.0;
  let statLine: string | null = null;
  if (group === "hitting") {
    const recentAvg = avgStat(splits.slice(-5), "avg");
    const baselineAvg = avgStat(splits.slice(-30), "avg");
    const recentOps = avgStat(splits.slice(-5), "ops");
    const baselineOps = avgStat(splits.slice(-30), "ops");
    const rAvg = baselineAvg > 0 ? recentAvg / baselineAvg : 1.0;
    const rOps = baselineOps > 0 ? recentOps / baselineOps : 1.0;
    momentum = (rAvg + rOps) / 2;
    statLine = buildHittingStatLine(splits);
  } else {
    const eraRecent = avgStat(splits.slice(-3), "era");
    const eraBaseline = avgStat(splits.slice(-15), "era");
    momentum = eraRecent > 0 ? eraBaseline / eraRecent : 1.0;
    statLine = buildPitchingStatLine(splits);
  }
  const multiplier = Math.round(Math.max(0.9, Math.min(1.3, momentum)) * 1000) / 1000;
  const direction: MlbMomentum["direction"] =
    momentum > 1.05 ? "hot" : momentum < 0.95 ? "cold" : "neutral";

  // Milestone watch (best-effort)
  let milestone: string | null = null;
  try {
    const careerUrl = `${MLB_BASE}/people/${found.id}/stats?stats=career&group=${group}`;
    const careerData = await fetchJson(careerUrl);
    const career = careerData?.stats?.[0]?.splits;
    if (Array.isArray(career) && career.length > 0) {
      const stat = career[career.length - 1]?.stat ?? {};
      const hr = Number(stat.homeRuns ?? 0);
      const hits = Number(stat.hits ?? 0);
      if (hr >= 495 && hr < 500) milestone = `approaching 500 HR (${hr} career HR)`;
      else if (hits >= 2990 && hits < 3000) milestone = `approaching 3000 hits (${hits} career hits)`;
    }
  } catch {
    milestone = null;
  }

  const value: MlbMomentum = {
    playerName,
    mlbPlayerId: found.id,
    sportId: found.sportId,
    statGroup: group,
    momentumRatio: Math.round(momentum * 1000) / 1000,
    multiplier,
    direction,
    statLine,
    milestone,
    team: found.team,
    position: found.position,
    // DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1: null for MLB (sportId=1) per
    // the MlbMomentum.level docstring contract; mapped value for MiLB.
    level: found.sportId === 1 ? null : levelFromSport(found.sportId),
    status: "ok",
    updatedAt: new Date().toISOString(),
  };
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Season + Career Stats (MLB.com-style player page payload)
//
// Surfaces yearByYear + career totals for both hitting and pitching so the iOS
// PlayerIQ detail view can render a full stats table when a watchlist row is
// tapped. Covers MLB and MiLB (sportIds 1, 11–14, 16). Cached 1h per name.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerStatsSeasonRow {
  season: string;          // "2024"
  team: string | null;     // "Los Angeles Dodgers"
  league: string | null;   // "American League" or "Pacific Coast League"
  level: string | null;    // "MLB" | "AAA" | "AA" | "A+" | "A" | "Rookie" | null
  stats: Record<string, string | number | null>;
}

export interface PlayerStatsGroup {
  yearByYear: PlayerStatsSeasonRow[];
  career: Record<string, string | number | null> | null;
}

export interface PlayerDraftInfo {
  year: string | null;          // "2009"
  round: string | null;         // "1"
  pickNumber: number | null;    // 25
  team: string | null;          // "Los Angeles Angels"
  school: string | null;        // "Millville Sr HS"
  type: string | null;          // "Rule 4 / June Amateur Draft"
}

export interface PlayerStatsPayload {
  playerName: string;
  mlbPlayerId: number | null;
  fullName: string | null;
  nickName: string | null;
  position: string | null;
  primaryNumber: string | null;
  currentTeam: string | null;
  currentTeamId: number | null;
  currentLevel: string | null;       // "MLB" | "AAA" | ... | null
  bats: string | null;
  throws: string | null;
  height: string | null;             // "6' 1\""
  weight: number | null;             // 235 (lbs)
  currentAge: number | null;
  active: boolean | null;
  birthDate: string | null;
  birthCity: string | null;
  birthStateProvince: string | null;
  birthCountry: string | null;
  mlbDebutDate: string | null;
  draft: PlayerDraftInfo | null;
  highSchool: string | null;         // "Millville (NJ)"
  college: string | null;            // "Vanderbilt"
  hitting: PlayerStatsGroup | null;
  pitching: PlayerStatsGroup | null;
  status: "ok" | "player_not_found" | "no_stats" | "fetch_failed";
  source: "mlb_stats_api";
  updatedAt: string;
}

interface StatsCacheEntry {
  expiresAt: number;
  value: PlayerStatsPayload;
}
const STATS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const statsCache = new Map<string, StatsCacheEntry>();

const SPORT_ID_TO_LEVEL: Record<number, string> = {
  1: "MLB",
  11: "AAA",
  12: "AA",
  13: "A+",
  14: "A",
  16: "Rookie",
};

function neutralStats(playerName: string, status: PlayerStatsPayload["status"]): PlayerStatsPayload {
  return {
    playerName,
    mlbPlayerId: null,
    fullName: null,
    nickName: null,
    position: null,
    primaryNumber: null,
    currentTeam: null,
    currentTeamId: null,
    currentLevel: null,
    bats: null,
    throws: null,
    height: null,
    weight: null,
    currentAge: null,
    active: null,
    birthDate: null,
    birthCity: null,
    birthStateProvince: null,
    birthCountry: null,
    mlbDebutDate: null,
    draft: null,
    highSchool: null,
    college: null,
    hitting: null,
    pitching: null,
    status,
    source: "mlb_stats_api",
    updatedAt: new Date().toISOString(),
  };
}

// Same hitting + pitching stat whitelist used by MLB.com (compact set).
const HITTING_KEYS: string[] = [
  "gamesPlayed", "atBats", "runs", "hits", "doubles", "triples", "homeRuns",
  "rbi", "baseOnBalls", "strikeOuts", "stolenBases", "avg", "obp", "slg", "ops",
];
const PITCHING_KEYS: string[] = [
  "wins", "losses", "era", "gamesPlayed", "gamesStarted", "saves",
  "inningsPitched", "hits", "runs", "earnedRuns", "baseOnBalls", "strikeOuts",
  "whip", "homeRuns",
];

function projectStat(stat: any, keys: string[]): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (!stat || typeof stat !== "object") return out;
  for (const k of keys) {
    const v = stat[k];
    out[k] = v === undefined ? null : v;
  }
  return out;
}

function levelFromSport(sportId: number | null | undefined): string | null {
  if (sportId == null) return null;
  return SPORT_ID_TO_LEVEL[sportId] ?? null;
}

function extractDraft(person: any): PlayerDraftInfo | null {
  if (!person) return null;
  const drafts = Array.isArray(person.drafts) ? person.drafts : [];
  // Prefer the entry where the player was actually drafted (isDrafted=true);
  // fall back to the first record otherwise.
  const d = drafts.find((x: any) => x?.isDrafted) ?? drafts[0];
  if (!d && person.draftYear == null) return null;
  return {
    year: d?.year ?? (person.draftYear != null ? String(person.draftYear) : null),
    round: d?.pickRound ?? null,
    pickNumber: typeof d?.pickNumber === "number" ? d.pickNumber : null,
    team: d?.team?.name ?? null,
    school: d?.school?.name ?? null,
    type: d?.draftType?.description ?? null,
  };
}

function extractHighSchool(person: any): string | null {
  const hs = person?.education?.highschools;
  if (!Array.isArray(hs) || hs.length === 0) return null;
  const first = hs[0];
  if (!first?.name) return null;
  return first.state ? `${first.name} (${first.state})` : first.name;
}

function extractCollege(person: any): string | null {
  const cols = person?.education?.colleges;
  if (!Array.isArray(cols) || cols.length === 0) return null;
  const first = cols[0];
  if (!first?.name) return null;
  return first.state ? `${first.name} (${first.state})` : first.name;
}

export { levelFromSport };

export async function searchMlbPerson(playerName: string): Promise<any | null> {
  const hit = await searchPlayerPerson(playerName);
  return hit?.person ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CF-RESOLVER-COVERAGE-GAP (2026-06-01) — roster-scan primitive.
//
// Diagnosed cause (docs/phase0 _resolver_gap_diagnosis_2026-06-01.json):
// /people/search?names=X is a top-K prominence index (~3 results per surname),
// not a roster query — and the sportId parameter is a no-op on its response
// shape. Non-prominent prospects fall through structurally. The 2026-06-01
// orphan-purge dry-run surfaced 6 current-roster prospects missed this way
// (agustin-acosta, gage-wood, josh-hammond, juan-tomas, justin-lamkin,
// mason-morris) plus the Justin Lamkin not-indexed-at-all case.
//
// Fix: pull the canonical roster via /sports/{sid}/players?season=YYYY
// (verified unpaginated + uncapped; full roster in one response), build an
// in-memory normalized-name → entry index, and look up by name.
// ─────────────────────────────────────────────────────────────────────────────

const ROSTER_SPORT_IDS = [1, 11, 12, 13, 14, 16] as const;
const ROSTER_SEASON_COUNT = 2;                          // current + previous
const ROSTER_TTL_MS = 12 * 60 * 60 * 1000;              // 12h
const ROSTER_FETCH_TIMEOUT_MS = 30_000;

interface RosterEntry {
  id: number;
  fullName: string;
  sportId: number;
  season: number;
  person: any;
}

interface RosterIndex {
  builtAt: number;
  sportSeasonsCovered: Array<{ sid: number; season: number }>;
  nameMap: Map<string, RosterEntry[]>;
  isStale: boolean;
}

let _rosterIndex: RosterIndex | null = null;
let _rosterRefreshPromise: Promise<RosterIndex | null> | null = null;

function normalizeNameForResolver(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // strip combining marks (accents)
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchRosterForSportSeason(sid: number, season: number): Promise<RosterEntry[]> {
  const url = `${MLB_BASE}/sports/${sid}/players?season=${season}`;
  const data = await fetchJson(url, ROSTER_FETCH_TIMEOUT_MS);
  if (!data || !Array.isArray(data.people)) return [];
  const out: RosterEntry[] = [];
  for (const p of data.people) {
    if (!p || typeof p.id !== "number" || typeof p.fullName !== "string") continue;
    out.push({ id: p.id, fullName: p.fullName, sportId: sid, season, person: p });
  }
  return out;
}

async function buildRosterIndex(): Promise<RosterIndex | null> {
  const currentYear = new Date().getUTCFullYear();
  const seasons: number[] = [];
  for (let i = 0; i < ROSTER_SEASON_COUNT; i++) seasons.push(currentYear - i);

  const nameMap = new Map<string, RosterEntry[]>();
  const covered: Array<{ sid: number; season: number }> = [];
  const failed: Array<{ sid: number; season: number }> = [];
  let totalEntries = 0;

  for (const season of seasons) {
    for (const sid of ROSTER_SPORT_IDS) {
      let entries: RosterEntry[];
      try {
        entries = await fetchRosterForSportSeason(sid, season);
      } catch {
        entries = [];
      }
      if (entries.length === 0) {
        failed.push({ sid, season });
        continue;
      }
      covered.push({ sid, season });
      totalEntries += entries.length;
      for (const e of entries) {
        const key = normalizeNameForResolver(e.fullName);
        if (!key) continue;
        let list = nameMap.get(key);
        if (!list) { list = []; nameMap.set(key, list); }
        list.push(e);
      }
    }
  }

  if (totalEntries === 0) {
    console.warn(JSON.stringify({
      event: "mlb_roster_index_build_failed",
      source: "mlbStats.service",
      attempted: seasons.length * ROSTER_SPORT_IDS.length,
      reason: "all_fetches_returned_empty",
    }));
    return null;
  }

  if (failed.length > 0) {
    console.warn(JSON.stringify({
      event: "mlb_roster_partial_index",
      source: "mlbStats.service",
      covered: covered.length,
      failed: failed.length,
      failedSlots: failed,
    }));
  }

  return {
    builtAt: Date.now(),
    sportSeasonsCovered: covered,
    nameMap,
    isStale: false,
  };
}

async function getOrBuildRosterIndex(): Promise<RosterIndex | null> {
  // Cold start — caller blocks on the synchronous build.
  if (_rosterIndex === null) {
    if (_rosterRefreshPromise === null) {
      _rosterRefreshPromise = (async () => {
        try {
          const built = await buildRosterIndex();
          if (built) _rosterIndex = built;
          return built;
        } finally {
          _rosterRefreshPromise = null;
        }
      })();
    }
    return await _rosterRefreshPromise;
  }

  // Warm — return current; kick off async soft-refresh if TTL expired.
  const age = Date.now() - _rosterIndex.builtAt;
  if (age >= ROSTER_TTL_MS && _rosterRefreshPromise === null) {
    _rosterIndex.isStale = true;
    _rosterRefreshPromise = (async () => {
      try {
        const built = await buildRosterIndex();
        if (built) {
          _rosterIndex = built;
        } else {
          console.warn(JSON.stringify({
            event: "mlb_roster_refresh_failed",
            source: "mlbStats.service",
            staleSinceMs: age,
          }));
        }
        return built;
      } finally {
        _rosterRefreshPromise = null;
      }
    })();
    // Do NOT await — return current (now-stale) index immediately.
  }
  return _rosterIndex;
}

/**
 * Resolve a player name to {person, sportId} via the in-memory roster index.
 *
 * Returns null when:
 *   - the index can't be built (cold-start failure)
 *   - no roster entry matches the normalized name
 *   - multiple roster entries with DIFFERENT ids match (ambiguous — log + null)
 *
 * Returns the entry with the most-recent season (ties: lowest sportId wins,
 * so MLB beats MiLB) when exactly-one player matches across possibly-multiple
 * (sportId, season) appearances.
 */
async function searchPlayerPerson(
  playerName: string,
): Promise<{ person: any; sportId: number } | null> {
  const normalized = normalizeNameForResolver(playerName);
  if (!normalized) return null;

  const index = await getOrBuildRosterIndex();
  if (!index) {
    console.warn(JSON.stringify({
      event: "mlb_roster_cold_start_failed",
      source: "mlbStats.service",
      playerName,
    }));
    return null;
  }

  const hits = index.nameMap.get(normalized);
  if (!hits || hits.length === 0) {
    console.warn(JSON.stringify({
      event: "mlb_resolver_index_miss",
      source: "mlbStats.service",
      playerName,
      indexAgeMs: Date.now() - index.builtAt,
    }));
    return null;
  }

  const uniqueIds = new Set<number>();
  for (const h of hits) uniqueIds.add(h.id);

  if (uniqueIds.size > 1) {
    console.warn(JSON.stringify({
      event: "mlb_resolver_ambiguous_name",
      source: "mlbStats.service",
      playerName,
      candidateIds: Array.from(uniqueIds),
      candidates: hits.map(h => ({ id: h.id, fullName: h.fullName, sportId: h.sportId, season: h.season })),
    }));
    return null;
  }

  // Single player, possibly across multiple (sportId, season) appearances.
  // Pick most-recent season; tie-break to lowest sportId (MLB=1 wins).
  let best = hits[0];
  for (const h of hits) {
    if (h.season > best.season || (h.season === best.season && h.sportId < best.sportId)) {
      best = h;
    }
  }
  return { person: best.person, sportId: best.sportId };
}

/**
 * Test-only internals — used by `mlbStatsResolverGap.test.ts` and other tests
 * that need to reset the module-scoped roster index between cases. NOT part
 * of the prod surface.
 */
export const __mlbStatsInternals = {
  resetRosterIndex(): void {
    _rosterIndex = null;
    _rosterRefreshPromise = null;
  },
  getRosterIndex(): RosterIndex | null {
    return _rosterIndex;
  },
  normalizeNameForResolver,
};

function buildGroup(
  yearSplits: any[],
  careerSplits: any[],
  keys: string[],
): PlayerStatsGroup | null {
  const yearRows: PlayerStatsSeasonRow[] = [];
  for (const sp of yearSplits) {
    const season = String(sp?.season ?? "").trim();
    if (!season) continue;
    yearRows.push({
      season,
      team: sp?.team?.name ?? null,
      league: sp?.league?.name ?? null,
      level: levelFromSport(sp?.sport?.id),
      stats: projectStat(sp?.stat, keys),
    });
  }
  // Sort ascending by season (string compare is fine for 4-digit years).
  yearRows.sort((a, b) => a.season.localeCompare(b.season));

  let career: Record<string, string | number | null> | null = null;
  if (Array.isArray(careerSplits) && careerSplits.length > 0) {
    career = projectStat(careerSplits[careerSplits.length - 1]?.stat, keys);
  }

  if (yearRows.length === 0 && !career) return null;
  return { yearByYear: yearRows, career };
}

/**
 * Get MLB.com-style season + career stats for a player. Covers MLB and MiLB
 * via the public Stats API; no credentials required. Cached 1h per name so
 * heavy traffic on a single watchlist row doesn't hammer statsapi.mlb.com.
 *
 * Never throws — returns a `status` field so callers can render an empty state.
 */
export async function getPlayerSeasonAndCareerStats(
  playerName: string,
): Promise<PlayerStatsPayload> {
  const trimmed = playerName.trim();
  if (!trimmed) return neutralStats("", "player_not_found");

  const key = trimmed.toLowerCase();
  const cached = statsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1: searchPlayerPerson now returns
  // {person, sportId}; this consumer only needs the inner person object.
  const found = await searchPlayerPerson(trimmed);
  const person = found?.person ?? null;
  if (!person || !person.id) {
    const v = neutralStats(trimmed, "player_not_found");
    statsCache.set(key, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, value: v });
    return v;
  }

  const personId = Number(person.id);

  // /people/search returns a slim record without bio fields — hydrate the
  // full record so we can show team, level, height/weight, draft, education.
  let hydrated: any = person;
  try {
    const peopleData = await fetchJson(
      `${MLB_BASE}/people/${personId}?hydrate=currentTeam(sport,league),education,draft,social`,
      8000,
    );
    const p = Array.isArray(peopleData?.people) && peopleData.people.length > 0
      ? peopleData.people[0]
      : null;
    if (p) hydrated = p;
  } catch {
    // Fall through — keep slim person record.
  }
  let currentLevel = levelFromSport(hydrated?.currentTeam?.sport?.id);

  // The hydrate above sometimes omits sport on the team record. Fall back to
  // /teams/{id} to resolve level when we have a team id but no sport.
  const currentTeamId = hydrated?.currentTeam?.id;
  if (!currentLevel && currentTeamId) {
    try {
      const teamData = await fetchJson(
        `${MLB_BASE}/teams/${currentTeamId}`,
        6000,
      );
      const t = Array.isArray(teamData?.teams) && teamData.teams.length > 0
        ? teamData.teams[0]
        : null;
      currentLevel = levelFromSport(t?.sport?.id);
    } catch {
      // Leave null.
    }
  }

  // One call covers both groups + both types (yearByYear + career) thanks to
  // the comma-list params Stats API accepts.
  const statsUrl =
    `${MLB_BASE}/people/${personId}/stats` +
    `?stats=yearByYear,career&group=hitting,pitching&hydrate=team(league),league,sport`;
  const statsData = await fetchJson(statsUrl, 12000);

  let hitting: PlayerStatsGroup | null = null;
  let pitching: PlayerStatsGroup | null = null;

  const extractBuckets = (data: any) => {
    if (!data || !Array.isArray(data.stats)) {
      return { hYear: [] as any[], hCareer: [] as any[], pYear: [] as any[], pCareer: [] as any[] };
    }
    const buckets = data.stats as any[];
    const bucket = (type: string, group: string): any[] => {
      const b = buckets.find(
        (x) =>
          (x?.type?.displayName ?? "").toLowerCase() === type &&
          (x?.group?.displayName ?? "").toLowerCase() === group,
      );
      return Array.isArray(b?.splits) ? b.splits : [];
    };
    return {
      hYear: bucket("yearbyyear", "hitting"),
      hCareer: bucket("career", "hitting"),
      pYear: bucket("yearbyyear", "pitching"),
      pCareer: bucket("career", "pitching"),
    };
  };

  let { hYear, hCareer, pYear, pCareer } = extractBuckets(statsData);

  // MLB Stats API defaults to MLB-only (sportId=1). MiLB-only players (e.g.
  // prospects) come back with empty splits. Refetch with leagueListId=milb_all
  // and merge any season rows we get back so the iOS Season & Career card
  // populates for prospects too.
  const initiallyEmpty =
    hYear.length === 0 && hCareer.length === 0 && pYear.length === 0 && pCareer.length === 0;
  if (initiallyEmpty) {
    const milbUrl =
      `${MLB_BASE}/people/${personId}/stats` +
      `?stats=yearByYear,career&group=hitting,pitching&leagueListId=milb_all` +
      `&hydrate=team(league),league,sport`;
    const milbData = await fetchJson(milbUrl, 12000);
    const milb = extractBuckets(milbData);
    hYear = milb.hYear;
    hCareer = milb.hCareer;
    pYear = milb.pYear;
    pCareer = milb.pCareer;
  }

  hitting = buildGroup(hYear, hCareer, HITTING_KEYS);
  pitching = buildGroup(pYear, pCareer, PITCHING_KEYS);

  const payload: PlayerStatsPayload = {
    playerName: trimmed,
    mlbPlayerId: personId,
    fullName: hydrated?.fullName ?? person?.fullName ?? null,
    nickName: hydrated?.nickName ?? null,
    position: hydrated?.primaryPosition?.abbreviation ?? person?.primaryPosition?.abbreviation ?? null,
    primaryNumber: hydrated?.primaryNumber ?? person?.primaryNumber ?? null,
    currentTeam: hydrated?.currentTeam?.name ?? null,
    currentTeamId: typeof hydrated?.currentTeam?.id === "number" ? hydrated.currentTeam.id : null,
    currentLevel,
    bats: hydrated?.batSide?.code ?? person?.batSide?.code ?? null,
    throws: hydrated?.pitchHand?.code ?? person?.pitchHand?.code ?? null,
    height: hydrated?.height ?? null,
    weight: typeof hydrated?.weight === "number" ? hydrated.weight : null,
    currentAge: typeof hydrated?.currentAge === "number" ? hydrated.currentAge : null,
    active: typeof hydrated?.active === "boolean" ? hydrated.active : null,
    birthDate: hydrated?.birthDate ?? person?.birthDate ?? null,
    birthCity: hydrated?.birthCity ?? null,
    birthStateProvince: hydrated?.birthStateProvince ?? null,
    birthCountry: hydrated?.birthCountry ?? null,
    mlbDebutDate: hydrated?.mlbDebutDate ?? person?.mlbDebutDate ?? null,
    draft: extractDraft(hydrated),
    highSchool: extractHighSchool(hydrated),
    college: extractCollege(hydrated),
    hitting,
    pitching,
    status: hitting || pitching ? "ok" : "no_stats",
    source: "mlb_stats_api",
    updatedAt: new Date().toISOString(),
  };

  statsCache.set(key, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, value: payload });
  return payload;
}
