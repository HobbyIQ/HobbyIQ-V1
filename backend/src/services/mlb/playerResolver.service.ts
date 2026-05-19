// MLB player resolver.
//
// Resolves a playerName (free-text) to an MLB Stats API personId.
// Used by PortfolioIQ at addHolding time so each holding stores a stable
// playerId for cross-system joins (PlayerScore, DailyIQ).
//
// PR #68 (2026-05). Backfill of pre-existing holdings is intentionally a
// separate PR (#69) so this slice stays small and reviewable.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
// MLB + MiLB sportIds: 1=MLB, 11=AAA, 12=AA, 13=High-A, 14=Low-A, 16=Rookie.
const SPORT_IDS = "1,11,12,13,14,16";

export type ResolveConfidence = "high" | "medium" | "low" | "ambiguous";

export interface ResolvedPlayer {
  playerId: string;
  displayName: string;
  confidence: ResolveConfidence;
  matchCount: number;
}

interface CacheEntry {
  expiresAt: number;
  value: ResolvedPlayer | null;
}

const MAX_CACHE = 1000;
const TTL_HIT_MS = 60 * 60 * 1000; // 1h for resolved
const TTL_MISS_MS = 5 * 60 * 1000; // 5m for nulls (misspellings)
const FETCH_TIMEOUT_MS = 8000;

// Insertion-ordered Map gives LRU behaviour when we delete+set on read.
const cache = new Map<string, CacheEntry>();

/**
 * Normalize a player name for cache keys and matching:
 *  - lowercase
 *  - strip punctuation (periods, commas, apostrophes)
 *  - drop common suffixes (jr, sr, ii, iii, iv)
 *  - collapse whitespace
 */
export function normalizePlayerName(raw: string): string {
  if (!raw) return "";
  let s = String(raw).toLowerCase();
  s = s.replace(/[.,'’`]/g, "");
  s = s.replace(/\s+(jr|sr|ii|iii|iv)\b\.?/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function cacheKey(normalized: string, year: number | undefined): string {
  return `${normalized}|${year ?? "any"}`;
}

function readCache(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // LRU touch: re-insert to move to most-recent end.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCache(key: string, value: ResolvedPlayer | null) {
  const ttl = value ? TTL_HIT_MS : TTL_MISS_MS;
  cache.set(key, { expiresAt: Date.now() + ttl, value });
  // Evict oldest until under cap.
  while (cache.size > MAX_CACHE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/** Test-only: reset cache between cases. */
export function _clearPlayerResolverCache(): void {
  cache.clear();
}

async function fetchPeople(name: string): Promise<any[]> {
  const url = `${MLB_BASE}/people/search?names=${encodeURIComponent(name)}&sportIds=${SPORT_IDS}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return [];
    const data: any = await r.json();
    return Array.isArray(data?.people) ? data.people : [];
  } finally {
    clearTimeout(t);
  }
}

function extractDebutYear(person: any): number | null {
  const d = person?.mlbDebutDate;
  if (typeof d !== "string" || d.length < 4) return null;
  const y = Number(d.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

/**
 * Filter candidates by whether the card-year falls within a plausible
 * career window relative to the player's MLB debut.
 *
 * Window: debut_year - 5 (covers Bowman 1st / prospect cards issued before
 * MLB debut) through debut_year + 30 (covers HoF career length).
 * Candidates with no debutDate are kept in case the player is a current
 * prospect who has not debuted yet.
 */
function filterByYear(people: any[], cardYear: number): any[] {
  return people.filter((p) => {
    const debut = extractDebutYear(p);
    if (debut === null) return true; // unknown debut — keep
    return cardYear >= debut - 5 && cardYear <= debut + 30;
  });
}

function buildResolved(person: any, confidence: ResolveConfidence, matchCount: number): ResolvedPlayer {
  return {
    playerId: String(person.id),
    displayName: String(person.fullName ?? person.nameFirstLast ?? ""),
    confidence,
    matchCount,
  };
}

export interface ResolvePlayerOptions {
  year?: number;
}

export async function resolvePlayer(
  name: string,
  opts: ResolvePlayerOptions = {},
): Promise<ResolvedPlayer | null> {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;

  const normalized = normalizePlayerName(trimmed);
  if (!normalized) return null;

  const year = typeof opts.year === "number" && Number.isFinite(opts.year) ? opts.year : undefined;
  const key = cacheKey(normalized, year);

  const cached = readCache(key);
  if (cached) return cached.value;

  let people: any[] = [];
  try {
    people = await fetchPeople(trimmed);
  } catch {
    // Network/timeout errors must not poison the cache — return null without writing.
    return null;
  }

  if (people.length === 0) {
    writeCache(key, null);
    return null;
  }

  if (people.length === 1) {
    const resolved = buildResolved(people[0], "high", 1);
    writeCache(key, resolved);
    return resolved;
  }

  // Multiple matches.
  if (year !== undefined) {
    const filtered = filterByYear(people, year);
    if (filtered.length === 1) {
      const resolved = buildResolved(filtered[0], "medium", people.length);
      writeCache(key, resolved);
      return resolved;
    }
    if (filtered.length > 1) {
      const resolved = buildResolved(filtered[0], "ambiguous", people.length);
      writeCache(key, resolved);
      return resolved;
    }
    // Year filtered everyone out — fall back to first match, low confidence.
  }

  const resolved = buildResolved(people[0], "low", people.length);
  writeCache(key, resolved);
  return resolved;
}
