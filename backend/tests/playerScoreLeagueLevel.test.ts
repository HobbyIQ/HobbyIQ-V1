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
      {
        match: /people\/search\?names=.+sportId=1$/,
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
    expect(doc.league).toBe("MLB");
    expect(doc.level).toBeNull();
    expect(doc.mlbPlayerId).toBe(99001);
    expect(doc.id).toBe("99001");
    expect(doc.playerId).toBe("99001");

    // Resolver was called once for sportId=1 and game-log fetched.
    const urls = fetchStub.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("sportId=1") && u.includes("people/search"))).toBe(true);
    expect(urls.some((u) => u.includes("people/99001/stats") && u.includes("group=hitting"))).toBe(true);
  });
});

describe("DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1 — MiLB player (sportId=12 / AA)", () => {
  it("falls through MLB + AAA, resolves at AA, returns league='MiLB' + level='AA' + game logs", async () => {
    const playerName = "Phase1Test AAProspect";
    const fetchStub = stubFetch([
      // sportId=1 (MLB) — empty
      { match: /people\/search\?names=.+sportId=1$/, body: { people: [] } },
      // sportId=11 (AAA) — empty
      { match: /people\/search\?names=.+sportId=11$/, body: { people: [] } },
      // sportId=12 (AA) — hit
      {
        match: /people\/search\?names=.+sportId=12$/,
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
    expect(doc.league).toBe("MiLB");
    expect(doc.level).toBe("AA");
    expect(doc.mlbPlayerId).toBe(99012);
    expect(doc.id).toBe("99012");
    expect(doc.playerId).toBe("99012");

    // Resolver iterated MLB → AAA → AA (three /people/search calls).
    const searchCalls = fetchStub.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes("/people/search"));
    expect(searchCalls.length).toBe(3);
    expect(searchCalls[0]).toContain("sportId=1");
    expect(searchCalls[1]).toContain("sportId=11");
    expect(searchCalls[2]).toContain("sportId=12");
  });
});

// ─── §3 deferred — CURRENT (unchanged) behavior assertion ───────────────────

describe("DAILYIQ-PLAYERSCORE-LEAGUE-LEVEL Phase 1 — unresolved player (current slug fallback)", () => {
  it("falls through ALL sportIds and CURRENT behavior is slug-form id + isValidCosmosId still accepts it (slug retirement deferred)", async () => {
    // Asserts the §3-deferred contract: no_mlb_match conversion is NOT in
    // this CF. The writer still produces a slug-keyed doc, and the dedup
    // helper + read-side fallback in playeriq.routes.ts L62-63/L117 keep
    // working as today. When DAILYIQ-PLAYERSCORE-SLUG-FALLBACK-RETIRE lands,
    // this test flips to assert a skip with reason="no_mlb_match".
    const playerName = "Phase1Test Unresolvable";
    stubFetch([
      // Every sportId returns empty.
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

    const doc = buildPlayerScore(playerName, NEUTRAL_MARKET, perf);
    // CURRENT behavior: mlbPlayerId null → playerId falls back to slug.
    expect(doc.mlbPlayerId).toBeNull();
    expect(doc.id).toBe("phase1test-unresolvable");
    expect(doc.playerId).toBe("phase1test-unresolvable");
    // League stays "unknown" (sportId is null, not 1, not numeric MiLB).
    expect(doc.league).toBe("unknown");
    expect(doc.level).toBeNull();

    // The slug-keyed id is a VALID Cosmos id (a-z/0-9/-) so the upsert
    // guard does NOT short-circuit — slug write still lands today.
    expect(isValidCosmosId(doc.id)).toBe(true);
  });
});
