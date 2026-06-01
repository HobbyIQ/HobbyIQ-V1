/**
 * CF-RESOLVER-COVERAGE-GAP (2026-06-01) — roster-scan resolver tests.
 *
 * Verifies the fix that replaced the top-K-prominence /people/search primitive
 * with a /sports/{sid}/players?season=YYYY roster-scan + in-memory normalized-
 * name → entry index.
 *
 * Covers:
 *   1-6. Each of the 6 diagnosed misses now resolves to the expected MLB id
 *        (802528 / 805906 / 815843 / 829823 / 703610 / 702568).
 *   7.   Caller-level — getMlbMomentum("Mason Morris") resolves end-to-end and
 *        carries sportId=14 into MlbMomentum (the previously-impossible case
 *        before this CF).
 *   8.   Accent fold — query "Agustín Acosta" (accented) matches the ASCII
 *        roster fullName "Agustin Acosta".
 *   9.   Ambiguous name (two different MLB ids share a normalized fullName) →
 *        returns null + mlb_resolver_ambiguous_name warn fired.
 *   10.  Stale-cache fallback — TTL expires, refresh fails, last-good index
 *        keeps serving + mlb_roster_refresh_failed warn fired.
 *   11.  Cold-start lazy populate — first call fetches all (sid × season)
 *        slots; second call hits cache (no additional fetches).
 *   12.  Cold-start FAIL — all slots empty → returns null + cold_start_failed
 *        warn fired.
 *
 * Strategy: stub global fetch with a URL-pattern router (same shape as
 * playerScoreLeagueLevel.test.ts). Reset the module-scoped roster index between
 * tests via __mlbStatsInternals.resetRosterIndex().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  getMlbMomentum,
  searchMlbPerson,
  __mlbStatsInternals,
} from "../src/services/playerScore/mlbStats.service";

// ─── Test fixtures — the 6 diagnosed misses keyed by (sportId, season) ──────

const MISSED_PROSPECTS = [
  { id: 802528, fullName: "Agustin Acosta", sid: 16, season: 2026 },
  { id: 805906, fullName: "Gage Wood",       sid: 14, season: 2026 },
  { id: 815843, fullName: "Josh Hammond",    sid: 14, season: 2026 },
  { id: 829823, fullName: "Juan Tomas",      sid: 16, season: 2026 },
  { id: 703610, fullName: "Justin Lamkin",   sid: 12, season: 2026 },
  { id: 702568, fullName: "Mason Morris",    sid: 14, season: 2026 },
] as const;

const ROSTER_FIXTURES: Record<string, any[]> = {
  // Build per-(sid, season) people arrays from the prospects above.
  "1_2026": [{ id: 660271, fullName: "Shohei Ohtani" }],
  "11_2026": [],
  "12_2026": [{ id: 703610, fullName: "Justin Lamkin" }],
  "13_2026": [],
  "14_2026": [
    { id: 805906, fullName: "Gage Wood" },
    { id: 815843, fullName: "Josh Hammond" },
    { id: 702568, fullName: "Mason Morris" },
  ],
  "16_2026": [
    { id: 802528, fullName: "Agustin Acosta" },
    { id: 829823, fullName: "Juan Tomas" },
  ],
  // Previous season — currentYear-1=2025
  "1_2025": [], "11_2025": [], "12_2025": [], "13_2025": [], "14_2025": [], "16_2025": [],
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    async json() {
      return body;
    },
  } as unknown as Response;
}

interface FetchRoute { match: RegExp; body: unknown; ok?: boolean; }

function stubFetchWithRouter(routes: FetchRoute[]) {
  const fn = vi.fn(async (url: string) => {
    for (const r of routes) {
      if (r.match.test(url)) return jsonResponse(r.body, r.ok ?? true);
    }
    return jsonResponse({ people: [] });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Build the standard roster-scan route table from ROSTER_FIXTURES. */
function rosterRoutes(): FetchRoute[] {
  const routes: FetchRoute[] = [];
  for (const [key, people] of Object.entries(ROSTER_FIXTURES)) {
    const [sid, season] = key.split("_");
    routes.push({
      match: new RegExp(`/sports/${sid}/players\\?season=${season}(?:$|&)`),
      body: { people },
    });
  }
  return routes;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
  __mlbStatsInternals.resetRosterIndex();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── 1-6. The 6 diagnosed misses now resolve ────────────────────────────────

describe("CF-RESOLVER-COVERAGE-GAP — the 6 diagnosed misses now resolve via roster scan", () => {
  for (const prospect of MISSED_PROSPECTS) {
    it(`searchMlbPerson("${prospect.fullName}") → id ${prospect.id} (was null pre-CF)`, async () => {
      stubFetchWithRouter(rosterRoutes());
      const person = await searchMlbPerson(prospect.fullName);
      expect(person).not.toBeNull();
      expect(person?.id).toBe(prospect.id);
      expect(person?.fullName).toBe(prospect.fullName);
    });
  }
});

// ─── 7. Caller-level — getMlbMomentum carries sportId through ───────────────

describe("CF-RESOLVER-COVERAGE-GAP — caller-level end-to-end via getMlbMomentum", () => {
  it("getMlbMomentum('Mason Morris') resolves to id 702568 + sportId=14, returns MlbMomentum", async () => {
    stubFetchWithRouter([
      ...rosterRoutes(),
      // getMlbMomentum issues /people/{id}/stats?stats=gameLog — return empty so
      // the function takes the "no_game_log" path (we're testing the resolver,
      // not the momentum math).
      { match: /\/people\/702568\/stats\?stats=gameLog/, body: { stats: [] } },
    ]);
    const m = await getMlbMomentum("Mason Morris");
    expect(m.mlbPlayerId).toBe(702568);
    expect(m.sportId).toBe(14);
    expect(m.status).toBe("no_game_log");
    expect(m.level).toBe("A");  // SPORT_ID_TO_LEVEL[14] short form
  });
});

// ─── 8. Accent fold on the query side ───────────────────────────────────────

describe("CF-RESOLVER-COVERAGE-GAP — accent fold on query side", () => {
  it("query with accent 'Agustín Acosta' matches ASCII roster fullName 'Agustin Acosta'", async () => {
    stubFetchWithRouter(rosterRoutes());
    const person = await searchMlbPerson("Agustín Acosta");
    expect(person?.id).toBe(802528);
  });
});

// ─── 9. Ambiguous-name path ─────────────────────────────────────────────────

describe("CF-RESOLVER-COVERAGE-GAP — ambiguous-name handling", () => {
  it("two roster entries with same normalized fullName but DIFFERENT ids → null + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetchWithRouter([
      // Two distinct "John Smith" players in the same (sid, season). Real
      // case: rare but does happen across MLB history.
      { match: /\/sports\/14\/players\?season=2026/, body: {
        people: [
          { id: 999001, fullName: "John Smith" },
          { id: 999002, fullName: "John Smith" },
        ],
      } },
      ...rosterRoutes().filter(r => !r.match.test("/sports/14/players?season=2026")),
    ]);
    const person = await searchMlbPerson("John Smith");
    expect(person).toBeNull();
    const warns = warnSpy.mock.calls.map(c => String(c[0]));
    expect(warns.some(w => w.includes("mlb_resolver_ambiguous_name"))).toBe(true);
  });
});

// ─── 10. Stale-cache fallback (refresh fails) ───────────────────────────────

describe("CF-RESOLVER-COVERAGE-GAP — stale-cache fallback when refresh fails", () => {
  it("TTL expires + refresh returns empty → keeps serving last-good + refresh_failed warn", async () => {
    // Use real timers for this test — the async background refresh needs to
    // drain via the real event loop. Fake timers + setImmediate microtask
    // gymnastics make this flaky; real timers + a short await is clean.
    vi.useRealTimers();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First call — successful cold-start build.
    const fetchFn = stubFetchWithRouter(rosterRoutes());
    const first = await searchMlbPerson("Mason Morris");
    expect(first?.id).toBe(702568);
    const fetchCountAfterFirst = fetchFn.mock.calls.length;

    // Force the index to look TTL-expired by tampering with builtAt — cleaner
    // than fast-forwarding system time under fake timers.
    const idx = __mlbStatsInternals.getRosterIndex();
    expect(idx).not.toBeNull();
    if (idx) idx.builtAt = Date.now() - (13 * 60 * 60 * 1000);  // 13h ago

    // Swap fetch to an empty-everywhere router — the background refresh will
    // hit this and return empty, triggering the refresh-failed warn.
    vi.unstubAllGlobals();
    stubFetchWithRouter([{ match: /\/sports\/\d+\/players/, body: { people: [] } }]);

    // Call again — returns from stale cache immediately + kicks off async
    // refresh.
    const second = await searchMlbPerson("Mason Morris");
    expect(second?.id).toBe(702568);  // stale serves correctly

    // Wait for the async refresh to complete + log its warn.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const warns = warnSpy.mock.calls.map(c => String(c[0]));
    expect(warns.some(w => w.includes("mlb_roster_refresh_failed"))).toBe(true);
    expect(fetchCountAfterFirst).toBeGreaterThan(0);
  });
});

// ─── 11. Cold-start lazy populate — first call builds, second hits cache ────

describe("CF-RESOLVER-COVERAGE-GAP — cold-start lazy populate", () => {
  it("first searchMlbPerson triggers ROSTER_SPORT_IDS × ROSTER_SEASON_COUNT fetches; second uses cache", async () => {
    const fetchFn = stubFetchWithRouter(rosterRoutes());

    expect(__mlbStatsInternals.getRosterIndex()).toBeNull();

    const first = await searchMlbPerson("Mason Morris");
    expect(first?.id).toBe(702568);
    // 6 sportIds × 2 seasons = 12 roster fetches
    expect(fetchFn.mock.calls.length).toBe(12);
    expect(__mlbStatsInternals.getRosterIndex()).not.toBeNull();

    // Second call — no additional fetches (cache hit).
    const second = await searchMlbPerson("Gage Wood");
    expect(second?.id).toBe(805906);
    expect(fetchFn.mock.calls.length).toBe(12);  // unchanged
  });
});

// ─── 12. Cold-start FAIL — all slots empty → null + warn ────────────────────

describe("CF-RESOLVER-COVERAGE-GAP — cold-start failure (all slots empty)", () => {
  it("returns null when no roster fetch succeeds; fires cold_start_failed warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetchWithRouter([{ match: /\/sports\/\d+\/players/, body: { people: [] } }]);

    const person = await searchMlbPerson("Mason Morris");
    expect(person).toBeNull();

    const warns = warnSpy.mock.calls.map(c => String(c[0]));
    expect(warns.some(w => w.includes("mlb_roster_index_build_failed"))).toBe(true);
    expect(warns.some(w => w.includes("mlb_roster_cold_start_failed"))).toBe(true);
  });
});
