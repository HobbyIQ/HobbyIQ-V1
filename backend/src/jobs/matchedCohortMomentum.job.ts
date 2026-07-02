/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01):
 * Background job that pre-computes matched-cohort momentum for
 * portfolio-owned players and writes to Redis cache.
 *
 * Runtime `getPlayerTrendSnapshot` reads from that cache and prefers
 * the pre-computed matched-cohort over the raw sales-stats-by-player
 * signal.
 *
 * Design notes:
 * - Interval is 24h. Matched-cohort momentum is a slow-moving player-
 *   level signal; nightly refresh matches the analytical value + keeps
 *   CH call volume bounded.
 * - Cost per cycle: ~N_players × ~30 CH prices-by-card calls (with
 *   internal fanout capped by fetchCardHedgeMatchedCohort's concurrency
 *   knob). For 5k players × 30 cards = 150k calls. Sequential per-player
 *   pacing prevents CH rate-limit backoff.
 * - Env-gated: MATCHED_COHORT_JOB_ENABLED === "true" starts the job.
 *   Default off — flip on after review + deploy. Rollback = env=false.
 */

import { fetchCardHedgeMatchedCohort } from "../services/playerTrend/cardHedgeMatchedCohortProvider.js";
import {
  readMatchedCohortFromCache,
  writeMatchedCohortToCache,
} from "../services/playerTrend/matchedCohortCache.js";
import {
  listAllPortfolioUserIds,
  readUserDoc,
} from "../services/portfolioiq/portfolioStore.service.js";
import {
  getSalesStatsByPlayer,
  getTotalSalesByPlayer,
  searchCards,
} from "../services/compiq/cardhedge.client.js";
import { computeMomentumFromNormalizedWeeks } from "../services/playerTrend/momentum.compute.js";
import type { NormalizedWeeklySales } from "../services/playerTrend/playerTrend.types.js";
import {
  assembleMarketPlayersPayload,
  writeMarketPlayersPayload,
  type MarketPlayersJobInput,
} from "../services/dailyiq/marketPlayers.service.js";

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000; // 5min after boot
const DEFAULT_MAX_PLAYERS_PER_CYCLE = 500;
const DEFAULT_PER_PLAYER_DELAY_MS = 250; // rate-limit smoothing
const PROVIDER_NAME = "cardhedge";

let _running = false;
let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

function isEnabled(): boolean {
  const flag = String(process.env.MATCHED_COHORT_JOB_ENABLED ?? "").toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

function readIntervalMs(): number {
  const hours = Number(process.env.MATCHED_COHORT_JOB_INTERVAL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) * 3600 * 1000;
}

function readMaxPlayers(): number {
  const n = Number(process.env.MATCHED_COHORT_JOB_MAX_PLAYERS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PLAYERS_PER_CYCLE;
}

/**
 * CF-DAILYIQ-BOWMAN-2YR (2026-07-02): the 2025-2026 Bowman set names we
 * scan to build the Bowman universe. CH's naming is inconsistent across
 * years — 2025 products use "Chrome Baseball" in the set string; 2026
 * Bowman drops the "Chrome" suffix (verified via direct probe).
 * Bowman Draft Chrome exists for 2025 but not yet for 2026 (the draft
 * happens later in the year).
 */
const BOWMAN_2YR_SET_NAMES: readonly string[] = [
  "2025 Bowman Chrome Baseball",
  "2025 Bowman Draft Chrome Baseball",
  "2026 Bowman Baseball",
];
const BOWMAN_DISCOVERY_PAGE_SIZE = 50;
const BOWMAN_DISCOVERY_MAX_PAGES = 12; // 12 × 50 = 600 cards per set

/**
 * CF-DAILYIQ-BOWMAN-2YR: paginate CH's `/cards/card-search` across the
 * 2025-2026 Bowman set names to collect the unique player universe. Uses
 * the existing searchCards client (already cache-wrapped + no-empty-skip
 * via PR #242) so repeat calls hit cache. Errors on any set are absorbed
 * with a warning — a partial universe is preferable to no universe.
 */
async function collectBowman2YrPlayerUniverse(): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const setName of BOWMAN_2YR_SET_NAMES) {
    for (let page = 1; page <= BOWMAN_DISCOVERY_MAX_PAGES; page++) {
      let cards: Awaited<ReturnType<typeof searchCards>> = [];
      try {
        cards = await searchCards(
          "",
          BOWMAN_DISCOVERY_PAGE_SIZE,
          { set: setName },
          page,
        );
      } catch (err) {
        console.warn(
          `[matched-cohort] bowman-discovery ${setName} page=${page} failed: ${(err as Error)?.message ?? err}`,
        );
        break;
      }
      if (!cards.length) break;
      for (const c of cards) {
        const p = (c.player ?? "").trim();
        if (!p) continue;
        const key = p.toLowerCase();
        if (!seen.has(key)) seen.set(key, p);
      }
      // If the page returned fewer than page-size cards, we've reached the
      // end of the set — no need to poll further pages.
      if (cards.length < BOWMAN_DISCOVERY_PAGE_SIZE) break;
    }
  }
  return Array.from(seen.values());
}

/**
 * Scan all portfolio holdings and return the unique set of player names.
 * Trims + case-normalizes for deduplication.
 */
async function collectUniquePortfolioPlayers(): Promise<string[]> {
  const seen = new Map<string, string>(); // normalized → original display form
  let userIds: string[] = [];
  try {
    userIds = await listAllPortfolioUserIds();
  } catch (err) {
    console.warn(
      `[matched-cohort] listAllPortfolioUserIds failed: ${(err as Error)?.message ?? err}`,
    );
    return [];
  }
  for (const userId of userIds) {
    try {
      const doc = await readUserDoc(userId);
      const holdings = doc.holdings ?? {};
      for (const holdingId in holdings) {
        const h = holdings[holdingId];
        const name = h?.playerName;
        if (typeof name !== "string") continue;
        const trimmed = name.trim();
        if (trimmed.length === 0) continue;
        const key = trimmed.toLowerCase();
        if (!seen.has(key)) seen.set(key, trimmed);
      }
    } catch (err) {
      console.warn(
        `[matched-cohort] readUserDoc(${userId}) failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }
  }
  return Array.from(seen.values());
}

async function runCycle(): Promise<void> {
  const start = Date.now();

  // CF-DAILYIQ-BOWMAN-2YR-WIDEN-MOMENTUM (2026-07-02): Bowman universe is
  // discovered UP FRONT so the matched-cohort loop can run on the union
  // of portfolio + Bowman universe. Previously discovery was mid-cycle
  // and the loop only ran on portfolio players; that made
  // bowman2yrTopMomentum stuck at ~2 rows (only Bowman players Drew owned
  // AND had a cohort). Running matched-cohort on the full Bowman universe
  // gives every 2025-2026 Bowman prospect a chance at the momentum list
  // regardless of whether the user holds one of their cards.
  //
  // Cost: ~500 additional matched-cohort computations. Each is one CH
  // /prices-by-card fan-out call (up to 30 cards, internal concurrency 5).
  // Sequential + 250ms per-player pacing = ~500 × ~750ms ≈ 6 min. Fits
  // comfortably in a 24h nightly cycle; iOS reads the precomputed cache
  // and doesn't feel this cost.
  const portfolioPlayers = await collectUniquePortfolioPlayers();
  let bowmanUniverse: string[] = [];
  try {
    bowmanUniverse = await collectBowman2YrPlayerUniverse();
    console.log(
      JSON.stringify({
        event: "bowman_universe_discovered",
        source: "matched-cohort-job",
        count: bowmanUniverse.length,
      }),
    );
  } catch (err) {
    console.warn(
      `[matched-cohort] bowman universe discovery failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
  }

  // Union with case-insensitive dedup. Portfolio players come first so
  // if we hit the MAX_PLAYERS cap, the user's own holdings are guaranteed
  // to be covered before any prospect discovery is trimmed.
  const unionMap = new Map<string, string>();
  for (const p of portfolioPlayers) unionMap.set(p.toLowerCase(), p);
  for (const p of bowmanUniverse) {
    const k = p.toLowerCase();
    if (!unionMap.has(k)) unionMap.set(k, p);
  }
  const playersAll = Array.from(unionMap.values());
  const maxPlayers = readMaxPlayers();
  const players = playersAll.slice(0, maxPlayers);
  console.log(
    JSON.stringify({
      event: "matched_cohort_cycle_start",
      source: "matched-cohort-job",
      portfolioPlayers: portfolioPlayers.length,
      bowmanUniverse: bowmanUniverse.length,
      playersDiscovered: playersAll.length,
      playersProcessing: players.length,
      cap: maxPlayers,
    }),
  );

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let cohortSizes = 0;
  // CF-MATCHED-COHORT-FAILURE-VISIBILITY (2026-07-02): the null-return case
  // (fetchCardHedgeMatchedCohort resolves to null, without throwing) was
  // being counted toward `failed` but not logged with the player name. That
  // hid ~17% of daily traffic in an opaque bucket — 13/74 in the observed
  // cycle. Emit a structured event per null-return so KQL can slice by
  // player name and drive the next tranche of CH catalog escalations or
  // sales-stats fixes.
  const nullPlayers: string[] = [];
  // Accumulators for the DailyIQ market-players precompute — populated
  // alongside the per-player cache writes so we don't re-scan CH later.
  const perPlayerCohorts: MarketPlayersJobInput["perPlayerCohorts"] = [];
  // CF-MATCHED-COHORT-CACHE-SKIP (2026-07-02): after CF-DAILYIQ-BOWMAN-2YR-
  // WIDEN-MOMENTUM (#248) the loop scans up to 500 players, and each
  // fetchCardHedgeMatchedCohort call fans out ~30 prices-by-card
  // requests to CH (5 concurrent internal, 6+ sec worst case per player).
  // Full-cycle runtime blew past 30 min in observed traffic — an
  // unacceptable oscillation between cycle refreshes.
  //
  // Fix: per-player cache-first. `readMatchedCohortFromCache` returns
  // null past the 48h stale tolerance; anything inside that window we
  // trust, populate the DailyIQ accumulator from, and skip the CH work
  // entirely. Steady state after the first cycle warms the cache:
  // ~500 fresh reads (fast Redis GETs, no CH) + a handful of expired-
  // entry refetches. Cycle time drops back to ~1-2 min.
  //
  // Freshness: cache TTL is 24h (DEFAULT_TTL_SEC in matchedCohortCache),
  // so this skip window == the job's cadence — no player goes more than
  // one cycle without a refresh.
  for (const player of players) {
    const cached = await readMatchedCohortFromCache(player);
    if (cached && cached.result) {
      const result = cached.result;
      succeeded += 1;
      skipped += 1;
      cohortSizes += result.cohort.length;
      if (result.medianRatio !== null) {
        perPlayerCohorts.push({
          player,
          cohort: {
            medianRatio: result.medianRatio,
            meanRatio: result.meanRatio ?? result.medianRatio,
            cohortSize: result.cohort.length,
            latestWeekActiveCards: result.latestWeekActiveCards,
            latestWeekStart: result.latestWeekStart,
            priorWindowWeeksCount: result.priorWindowWeeksCount,
            computedAtMs: cached.computedAtMs,
          },
        });
      }
      // Cache-hit path: no CH work, no rate-limit pacing needed.
      continue;
    }
    try {
      const result = await fetchCardHedgeMatchedCohort(player);
      if (result) {
        await writeMatchedCohortToCache(player, result, PROVIDER_NAME);
        succeeded += 1;
        cohortSizes += result.cohort.length;
        if (result.medianRatio !== null) {
          perPlayerCohorts.push({
            player,
            cohort: {
              medianRatio: result.medianRatio,
              meanRatio: result.meanRatio ?? result.medianRatio,
              cohortSize: result.cohort.length,
              latestWeekActiveCards: result.latestWeekActiveCards,
              latestWeekStart: result.latestWeekStart,
              priorWindowWeeksCount: result.priorWindowWeeksCount,
              computedAtMs: Date.now(),
            },
          });
        }
      } else {
        failed += 1;
        nullPlayers.push(player);
      }
    } catch (err) {
      failed += 1;
      console.warn(
        `[matched-cohort] player=${player} failed: ${(err as Error)?.message ?? err}`,
      );
    }
    // Only pace on the CH-hitting path; cache-hits above don't consume
    // upstream quota so we've already `continue`d past this.
    if (DEFAULT_PER_PLAYER_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, DEFAULT_PER_PLAYER_DELAY_MS));
    }
  }
  if (nullPlayers.length > 0) {
    // Single structured event with the full list — KQL can `mv-expand`
    // for per-player slicing. Cheaper than N per-player events for a
    // list that's expected to be O(20) in steady state.
    console.log(
      JSON.stringify({
        event: "matched_cohort_null_returns",
        source: "matched-cohort-job",
        count: nullPlayers.length,
        players: nullPlayers,
      }),
    );
  }

  // ── DailyIQ market-players precompute ───────────────────────────
  // Volume rank + supply-dry classification. Volume-rank must include
  // ALL discovered portfolio players, not just those with a matched-
  // cohort. Vintage HOFers (Griffey, Bonds, McGwire, Sandberg, etc.)
  // return null from the cohort-discovery step because their catalog
  // spans decades and the "same card sold in latest AND prior week"
  // matching doesn't fit the vintage sales pattern — but they can
  // dominate raw 30d volume (Griffey: 30k+, Bonds: 10k, McGwire: 6k)
  // and users absolutely want to see them ranked. Previously
  // topVolume30d was scoped to cohortPlayerNames, silently excluding
  // every vintage holding from the volume signal.
  //
  // CF-DAILYIQ-TOTAL-SALES-WIDEN (2026-07-02): pass the full discovered
  // player list into getTotalSalesByPlayer so the volume rank reflects
  // real market activity across the entire portfolio. Chunking + cache-
  // empty-skip (PRs #244/#245) make this safe at 60+ player batches.
  const cohortPlayerNames = perPlayerCohorts.map((r) => r.player);
  const perPlayerTotal30d: MarketPlayersJobInput["perPlayerTotal30d"] = [];
  const perPlayerVolumeRatio: MarketPlayersJobInput["perPlayerVolumeRatio"] = [];

  // CF-DAILYIQ-BOWMAN-2YR (2026-07-02): discover the 2025-2026 Bowman
  // player universe BEFORE the total-sales fetch so we can union the
  // two lists into one CH batch. The Bowman universe is ~450 players
  // in steady state; portfolio is ~75. After dedup + chunk-at-20,
  // that's ~25 CH HTTP calls per cycle — negligible cost, one batch.
  // CF-DAILYIQ-BOWMAN-2YR-WIDEN-MOMENTUM (2026-07-02): discovery already
  // happened at the top of the cycle, so `players` here is the union of
  // (portfolio + Bowman universe). Feed that same list to total-sales so
  // volume covers everyone the matched-cohort loop covered.
  try {
    const totals = players.length > 0
      ? await getTotalSalesByPlayer(players)
      : null;
    for (const r of totals?.results ?? []) {
      perPlayerTotal30d.push({ player: r.player, totalSales30d: r.total_sales });
    }
  } catch (err) {
    console.warn(
      `[matched-cohort] getTotalSalesByPlayer batch failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
  }
  // Volume ratio requires the per-player weekly stats; done one-by-one
  // since the endpoint returns per-player already, and this data is
  // already cached from earlier /search calls in most cases.
  for (const player of cohortPlayerNames) {
    try {
      const stats = await getSalesStatsByPlayer([player], "week");
      const pr = stats?.results?.find((r) => r.player === player);
      if (!pr) continue;
      const buckets: NormalizedWeeklySales[] = (pr.buckets ?? [])
        .filter((b) => !b.partial)
        .map((b) => ({
          weekStart: b.start,
          weekEnd: b.end,
          count: Number.isFinite(b.count) ? b.count : 0,
          totalDollars: Number.isFinite(b.total_amount) ? b.total_amount : 0,
          avgSale: Number.isFinite(b.average_sale) ? b.average_sale : 0,
        }));
      const momentum = computeMomentumFromNormalizedWeeks(buckets);
      perPlayerVolumeRatio.push({ player, volumeRatio: momentum.volumeRatio });
    } catch (err) {
      // absorb; player is skipped from supply_dry classification only
    }
  }

  try {
    const payload = assembleMarketPlayersPayload({
      perPlayerCohorts,
      perPlayerTotal30d,
      perPlayerVolumeRatio,
      bowmanUniverse,
    });
    await writeMarketPlayersPayload(payload);
    console.log(
      JSON.stringify({
        event: "market_players_payload_written",
        source: "matched-cohort-job",
        trending: payload.trending.length,
        fading: payload.fading.length,
        topVolume30d: payload.topVolume30d.length,
        supplyDryLeadingUp: payload.supplyDryLeadingUp.length,
        bowman2yrTopVolume30d: payload.bowman2yrTopVolume30d.length,
        bowman2yrTopMomentum: payload.bowman2yrTopMomentum.length,
      }),
    );
  } catch (err) {
    console.warn(
      `[matched-cohort] market-players precompute failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
  }

  console.log(
    JSON.stringify({
      event: "matched_cohort_cycle_end",
      source: "matched-cohort-job",
      elapsedMs: Date.now() - start,
      succeeded,
      failed,
      skipped,           // CF-MATCHED-COHORT-CACHE-SKIP (2026-07-02)
      fetched: succeeded - skipped,
      avgCohortSize: succeeded > 0 ? Math.round((cohortSizes / succeeded) * 10) / 10 : 0,
    }),
  );
}

/**
 * Start the matched-cohort periodic job. Idempotent — re-calling is a
 * no-op when already running. Returns without scheduling when the env
 * gate is off.
 */
export function startMatchedCohortJob(): void {
  if (_running) return;
  if (!isEnabled()) {
    console.log(
      "[matched-cohort] not started — MATCHED_COHORT_JOB_ENABLED not set to true",
    );
    return;
  }
  _running = true;
  const intervalMs = readIntervalMs();
  console.log(
    `[matched-cohort] starting — interval ${intervalMs / 3600000}h, first run in ${DEFAULT_FIRST_DELAY_MS / 60000}min`,
  );
  _firstRunTimer = setTimeout(async () => {
    try {
      await runCycle();
    } catch (e: unknown) {
      console.warn(
        `[matched-cohort] first cycle failed: ${(e as Error)?.message ?? e}`,
      );
    }
    _intervalTimer = setInterval(async () => {
      try {
        await runCycle();
      } catch (e: unknown) {
        console.warn(
          `[matched-cohort] cycle failed: ${(e as Error)?.message ?? e}`,
        );
      }
    }, intervalMs);
  }, DEFAULT_FIRST_DELAY_MS);
}

/** Stop the job. Used by tests + clean shutdown. */
export function stopMatchedCohortJob(): void {
  if (_firstRunTimer) {
    clearTimeout(_firstRunTimer);
    _firstRunTimer = null;
  }
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
  _running = false;
}

/** Test-only: reset in-memory state. */
export function _resetMatchedCohortJobForTests(): void {
  stopMatchedCohortJob();
}
