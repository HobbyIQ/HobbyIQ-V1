/**
 * DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1 — write-path resolver migration tests.
 *
 * Verifies the §1+§2 cuts:
 *   §1  MlbMomentum carries `sportId` (1=MLB, 11-16=MiLB) from the MLB→MiLB
 *       fanout in `searchPlayerPerson`; null when no level resolves.
 *   §2  `buildPlayerScore` derives `league` ("MLB" / "MiLB" / "unknown") and
 *       `level` (null for MLB, mapped value for MiLB) from that sportId,
 *       replacing the prior hard-coded `league = mlbPlayerId ? "MLB" : "unknown"`
 *       and `level = null`.
 *
 * Scope: §1+§2 only. §3 (slug-fallback retirement) is deferred to its own CF
 * after the read-side audit surfaced two `playeriq.routes.ts` reader sites
 * (L62-63, L117) that call `playerNameSlug(name)` at request time. The
 * "unresolved player" test below intentionally asserts the CURRENT slug
 * fallback behavior, not a `no_mlb_match` skip — that's the deferred CF's job.
 *
 * Strategy: stub global `fetch`, route by URL prefix, return canned MLB Stats
 * API payloads. Unique player names per test bypass the 2h in-memory cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { computePerformanceScore, buildPlayerScore, __playerScoreInternals } from "../src/services/playerScore/playerScore.service";
import { __mlbStatsInternals } from "../src/services/playerScore/mlbStats.service";
import type { MarketScore } from "../src/types/playerScore";

const { isValidCosmosId } = __playerScoreInternals;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NEUTRAL_MARKET: MarketScore = {
  marketScore: 50,
  marketDirection: "stable",
  avgTrendPct: 0,
  totalSamples: 0,
  cardCount: 0,
  topCardName: null,
  confidence: "low",
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

/**
 * Build a fetch stub that routes by URL pattern. The MLB Stats API endpoints
 * we cover:
 *   /people/search?names=X&sportId=N  → resolver fanout
 *   /people/{id}/stats?stats=gameLog  → momentum stat source
 *   /people/{id}/stats?stats=career   → milestone watch (best-effort)
 *
 * Routes are matched in order; first match wins. Unmatched URLs return null
 * (treated as "no data" by fetchJson).
 */
function stubFetch(routes: Array<{ match: RegExp; body: unknown; ok?: boolean }>) {
  const fn = vi.fn(async (url: string) => {
    for (const r of routes) {
      if (r.match.test(url)) return jsonResponse(r.body, r.ok ?? true);
    }
    return jsonResponse({ people: [] });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
  // CF-RESOLVER-COVERAGE-GAP (2026-06-01): the roster-scan resolver caches a
  // module-scoped index. Reset between tests so each setup builds fresh.
  __mlbStatsInternals.resetRosterIndex();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── §1+§2 happy paths ──────────────────────────────────────────────────────

describe("DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1 — MLB player (sportId=1)", () => {
  it("resolves at MLB tier, returns league='MLB' + level=null", async () => {
    // Unique name → cache miss.
    const playerName = "Phase1Test MLBStar";
    const fetchStub = stubFetch([
      // sportId=1 resolver hit
      // CF-RESOLVER-COVERAGE-GAP (2026-06-01): the new resolver pulls rosters
      // via /sports/{sid}/players?season=YYYY (currentYear + previous). MLB
      // player lands at sportId=1.
      {
        match: /\/sports\/1\/players\?season=2026/,
        body: {
          people: [
            {
              id: 99001,
              fullName: "Phase1Test MLBStar",
              currentTeam: { name: "Los Angeles Angels" },
              primaryPosition: { abbreviation: "CF" },
            },
          ],
        },
      },
      // hitting game log returns splits
      {
        match: /people\/99001\/stats\?stats=gameLog.+group=hitting$/,
        body: {
          stats: [
            {
              splits: [
                { stat: { avg: 0.310, ops: 0.940, homeRuns: 1 } },
                { stat: { avg: 0.300, ops: 0.910, homeRuns: 0 } },
                { stat: { avg: 0.295, ops: 0.880, homeRuns: 1 } },
                { stat: { avg: 0.305, ops: 0.920, homeRuns: 2 } },
                { stat: { avg: 0.290, ops: 0.870, homeRuns: 0 } },
              ],
            },
          ],
        },
      },
      // career milestone watch (best-effort, can be empty)
      {
        match: /people\/99001\/stats\?stats=career/,
        body: { stats: [{ splits: [{ stat: { homeRuns: 200, hits: 1500 } }] }] },
      },
    ]);

    const perf = await computePerformanceScore(playerName);
    expect(perf.mlbPlayerId).toBe(99001);
    expect(perf.sportId).toBe(1);
    expect(perf.team).toBe("Los Angeles Angels");
    expect(perf.position).toBe("CF");
    expect(perf.statGroup).toBe("hitting");
    expect(perf.confidence).toBe("high");

    const doc = buildPlayerScore(playerName, NEUTRAL_MARKET, perf);
    expect(doc).not.toBeNull();
    expect(doc!.league).toBe("MLB");
    expect(doc!.level).toBeNull();
    expect(doc!.mlbPlayerId).toBe(99001);
    expect(doc!.id).toBe("99001");
    expect(doc!.playerId).toBe("99001");

    // Resolver pulled the sportId=1 roster (post-CF mechanism) + game-log.
    const urls = fetchStub.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => /\/sports\/1\/players\?season=2026/.test(u))).toBe(true);
    expect(urls.some((u) => u.includes("people/99001/stats") && u.includes("group=hitting"))).toBe(true);
  });
});

describe("DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1 — MiLB player (sportId=12 / AA)", () => {
  it("falls through MLB + AAA, resolves at AA, returns league='MiLB' + level='AA' + game logs", async () => {
    const playerName = "Phase1Test AAProspect";
    const fetchStub = stubFetch([
      // CF-RESOLVER-COVERAGE-GAP (2026-06-01): roster-scan endpoint. AA
      // prospect lands at sportId=12 / season=2026 only; other sportId
      // rosters return empty (catch-all in stubFetch handles them).
      {
        match: /\/sports\/12\/players\?season=2026/,
        body: {
          people: [
            {
              id: 99012,
              fullName: "Phase1Test AAProspect",
              currentTeam: { name: "Tulsa Drillers" },
              primaryPosition: { abbreviation: "SS" },
            },
          ],
        },
      },
      // hitting game log
      {
        match: /people\/99012\/stats\?stats=gameLog.+group=hitting$/,
        body: {
          stats: [
            {
              splits: [
                { stat: { avg: 0.288, ops: 0.860, homeRuns: 0 } },
                { stat: { avg: 0.275, ops: 0.820, homeRuns: 1 } },
                { stat: { avg: 0.295, ops: 0.880, homeRuns: 0 } },
                { stat: { avg: 0.300, ops: 0.900, homeRuns: 2 } },
                { stat: { avg: 0.285, ops: 0.850, homeRuns: 0 } },
              ],
            },
          ],
        },
      },
      // career milestone — empty / harmless
      { match: /people\/99012\/stats\?stats=career/, body: { stats: [] } },
    ]);

    const perf = await computePerformanceScore(playerName);
    expect(perf.mlbPlayerId).toBe(99012);
    expect(perf.sportId).toBe(12);
    expect(perf.team).toBe("Tulsa Drillers");
    expect(perf.position).toBe("SS");
    expect(perf.statGroup).toBe("hitting");
    expect(perf.statLine).toMatch(/^5G:/);
    expect(perf.confidence).toBe("high");

    const doc = buildPlayerScore(playerName, NEUTRAL_MARKET, perf);
    expect(doc).not.toBeNull();
    expect(doc!.league).toBe("MiLB");
    expect(doc!.level).toBe("AA");
    expect(doc!.mlbPlayerId).toBe(99012);
    expect(doc!.id).toBe("99012");
    expect(doc!.playerId).toBe("99012");

    // CF-RESOLVER-COVERAGE-GAP (2026-06-01): the new resolver scans rosters
    // once per (sportId, season) rather than iterating /people/search per
    // sportId. Verify the AA roster GET was made (the prior MLB/AAA fanout
    // assertion is mechanism-specific to the retired /people/search path and
    // no longer load-bearing).
    const rosterCalls = fetchStub.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => /\/sports\/\d+\/players\?season=/.test(u));
    expect(rosterCalls.some((u) => /\/sports\/12\/players\?season=2026/.test(u))).toBe(true);
  });
});

// ─── §3 RETIRED (Part 1) — no_mlb_match skip / no row ───────────────────────

describe("DAILYIQ-PLAYERSCORE-SLUG-FALLBACK-RETIRE Part 1 — unresolved player (no row, structured warn)", () => {
  it("falls through ALL sportIds → buildPlayerScore returns null + emits playerScore_no_mlb_match_skip warn", async () => {
    // Post-retirement contract: the writer no longer manufactures a
    // slug-keyed orphan row when MLB resolution misses at every level.
    // buildPlayerScore early-returns null and emits a structured warn
    // (distinct from isValidCosmosId rejection so the two skip classes
    // remain separable in telemetry). Callers (updatePlayerScoreFromEstimate
    // + refreshPlayerScoreForJob) skip the upsert when the builder returns
    // null. Pre-retirement behavior — slug-form id, league "unknown",
    // isValidCosmosId true — is the prior contract this test flipped from.
    const playerName = "PartOneTest Unresolvable";
    stubFetch([
      // CF-RESOLVER-COVERAGE-GAP (2026-06-01): all roster GETs return empty
      // people arrays — cold-start build produces 0 entries, resolver returns
      // null (which propagates as mlbPlayerId=null, the contract this test
      // verifies). Also stub the legacy /people/search path as empty for any
      // unrelated callers.
      { match: /\/sports\/\d+\/players\?season=/, body: { people: [] } },
      { match: /people\/search/, body: { people: [] } },
    ]);

    const perf = await computePerformanceScore(playerName);
    expect(perf.mlbPlayerId).toBeNull();
    expect(perf.sportId).toBeNull();
    expect(perf.team).toBeNull();
    expect(perf.position).toBeNull();
    // Unresolved players get the "low confidence" stable-stub from the
    // neutral momentum return; performanceScore=50.
    expect(perf.performanceScore).toBe(50);
    expect(perf.confidence).toBe("low");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = buildPlayerScore(playerName, NEUTRAL_MARKET, perf);

    // No row produced. This is the load-bearing assertion of the CF —
    // downstream callers `updatePlayerScoreFromEstimate` +
    // `refreshPlayerScoreForJob` short-circuit before upsert when buildPlayerScore
    // returns null, so unresolvable names stop generating new orphan rows
    // in player_trends.
    expect(doc).toBeNull();

    // Structured warn emitted exactly once with reason="no_mlb_match".
    // The dedicated reason value lets ops tooling distinguish this skip
    // class from `isValidCosmosId` rejections (well-formed name → bad
    // Cosmos id) and from `playerScore_upsert_stats` throttled aggregate.
    const noMatchCalls = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("playerScore_no_mlb_match_skip"));
    expect(noMatchCalls.length).toBe(1);
    const parsed = JSON.parse(noMatchCalls[0]);
    expect(parsed.event).toBe("playerScore_no_mlb_match_skip");
    expect(parsed.source).toBe("playerScore.service");
    expect(parsed.reason).toBe("no_mlb_match");
    expect(parsed.playerName).toBe(playerName);

    // Sanity: isValidCosmosId would still have accepted the prior slug
    // form — this proves the new skip path is distinct from the existing
    // bad-id guard rather than incidentally overlapping with it.
    expect(isValidCosmosId("partonetest-unresolvable")).toBe(true);

    warnSpy.mockRestore();
  });
});
