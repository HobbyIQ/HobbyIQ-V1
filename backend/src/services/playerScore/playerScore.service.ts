// PlayerScoreService — combines card market trend + MLB performance into a
// single 0-100 PlayerIQ score per player.
//
// playerIQScore = market.marketScore * 0.60 + performance.performanceScore * 0.40
//
// Reads cardSnapshots from trend_history (partition /cardId, written
// fire-and-forget on every estimate). Writes to player_trends (partition
// /playerId) as one upserted document per player.
//
// Also fires a fire-and-forget per-update history snapshot to
// player_trend_history (partition /playerId, doc id = {playerId}_{ts}).

import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import {
  deriveLabel,
  playerNameSlug,
  canonicalizePlayerName,
  type Confidence,
  type MarketScore,
  type PerformanceScore,
  type PlayerIQDirection,
  type PlayerIQScore,
  type PlayerScore,
  type TrendSnapshot,
} from "../../types/playerScore.js";
import { getMlbMomentum } from "./mlbStats.service.js";
import { getRecentSnapshotsByPlayer } from "./trendHistory.service.js";

const DB_NAME = process.env.COSMOS_DB ?? process.env.COSMOS_DATABASE ?? "hobbyiq";
const TRENDS_CONTAINER =
  process.env.COSMOS_PLAYER_TRENDS_CONTAINER ?? "player_trends";
const HISTORY_CONTAINER =
  process.env.COSMOS_PLAYER_TREND_HISTORY_CONTAINER ?? "player_trend_history";

const UPDATE_RATE_LIMIT_MS = 30 * 60 * 1000; // 30 min per player
const lastUpdateByPlayer = new Map<string, number>();

let trendsContainer: Container | null = null;
let historyContainer: Container | null = null;
let initPromise: Promise<void> | null = null;

async function initContainers(): Promise<void> {
  if (trendsContainer && historyContainer) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const conn = process.env.COSMOS_CONNECTION_STRING;
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      let client: CosmosClient | null = null;
      if (conn) client = new CosmosClient(conn);
      else if (endpoint && key) client = new CosmosClient({ endpoint, key });
      else if (endpoint) client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
      else return;

      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container: tc } = await database.containers.createIfNotExists({
        id: TRENDS_CONTAINER,
        partitionKey: { paths: ["/playerId"] },
      });
      const { container: hc } = await database.containers.createIfNotExists({
        id: HISTORY_CONTAINER,
        partitionKey: { paths: ["/playerId"] },
      });
      trendsContainer = tc;
      historyContainer = hc;
    } catch (err) {
      console.warn("[playerScore] init failed:", (err as Error).message);
    }
  })();
  return initPromise;
}

// ──────────────────────────────────────────────────────────────────────────
// Score computation
// ──────────────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Convert trend_history snapshots for a player into a MarketScore.
 *
 * Scoring math:
 *   - Use only the latest snapshot per cardId (one row per card).
 *   - avgTrendPct = median of impliedTrendPct across cards, capped ±60.
 *   - marketScore = 50 + avgTrendPct * 0.8   (12% trend → 59.6, +25% → 70, +50% → 90)
 *                   clamped to [0, 100].
 *   - direction:  >  3 → rising, <  -3 → falling, else stable.
 *   - confidence: cardCount >=3 → high, 1-2 → medium, 0 → low.
 */
export function computeMarketScore(
  playerName: string,
  cardSnapshots: TrendSnapshot[],
): MarketScore {
  // Latest snapshot per cardId
  const latestByCard = new Map<string, TrendSnapshot>();
  for (const s of cardSnapshots) {
    const prev = latestByCard.get(s.cardId);
    if (!prev || Date.parse(s.timestamp) > Date.parse(prev.timestamp)) {
      latestByCard.set(s.cardId, s);
    }
  }
  const cards = Array.from(latestByCard.values());

  if (cards.length === 0) {
    return {
      marketScore: 50,
      marketDirection: "stable",
      avgTrendPct: 0,
      totalSamples: 0,
      cardCount: 0,
      topCardName: null,
      confidence: "low",
    };
  }

  const trendPcts = cards.map((c) => c.impliedTrendPct);
  const avgTrendPct = Math.round(median(trendPcts) * 10) / 10;
  const marketScore = Math.round(clamp(50 + avgTrendPct * 0.8, 0, 100));
  const direction: PlayerIQDirection =
    avgTrendPct > 3 ? "rising" : avgTrendPct < -3 ? "falling" : "stable";
  const totalSamples = cards.reduce((a, c) => a + (c.totalSamples ?? 0), 0);

  // Top card by absolute trend magnitude
  let topCard: TrendSnapshot | null = null;
  let topMag = -Infinity;
  for (const c of cards) {
    const m = Math.abs(c.impliedTrendPct ?? 0);
    if (m > topMag) {
      topMag = m;
      topCard = c;
    }
  }
  const topCardName = topCard
    ? [topCard.year, topCard.set, topCard.cardNumber ? `#${topCard.cardNumber}` : null]
        .filter(Boolean)
        .join(" ")
        .trim() || null
    : null;

  const cardCount = cards.length;
  const confidence: Confidence =
    cardCount >= 3 ? "high" : cardCount >= 1 ? "medium" : "low";

  return {
    marketScore,
    marketDirection: direction,
    avgTrendPct,
    totalSamples,
    cardCount,
    topCardName,
    confidence,
  };
}

/**
 * Compute PerformanceScore from MLB Stats API momentum.
 *
 *   performanceScore = 50 + (momentumRatio - 1.0) * 100
 *                      clamped to [0, 100].
 *
 * Examples: 1.00 → 50,  1.10 → 60,  1.30 → 80,  0.85 → 35.
 * MiLB or unknown players → 50 / "low" confidence.
 */
export async function computePerformanceScore(
  playerName: string,
): Promise<PerformanceScore & { mlbPlayerId: number | null; team: string | null; position: string | null }> {
  const mom = await getMlbMomentum(playerName);
  if (mom.status !== "ok") {
    return {
      performanceScore: 50,
      performanceDirection: "stable",
      momentumRatio: 1.0,
      statLine: mom.statLine,
      statGroup: mom.statGroup,
      milestone: mom.milestone,
      confidence: "low",
      mlbPlayerId: mom.mlbPlayerId,
      team: mom.team,
      position: mom.position,
    };
  }
  const performanceScore = Math.round(clamp(50 + (mom.momentumRatio - 1.0) * 100, 0, 100));
  const performanceDirection: PlayerIQDirection =
    mom.direction === "hot" ? "rising" : mom.direction === "cold" ? "falling" : "stable";
  return {
    performanceScore,
    performanceDirection,
    momentumRatio: mom.momentumRatio,
    statLine: mom.statLine,
    statGroup: mom.statGroup,
    milestone: mom.milestone,
    confidence: "high",
    mlbPlayerId: mom.mlbPlayerId,
    team: mom.team,
    position: mom.position,
  };
}

/**
 * Blend market and performance into the combined PlayerIQ score.
 * playerIQScore = market * 0.60 + performance * 0.40
 */
export function computePlayerIQScore(
  market: MarketScore,
  performance: PerformanceScore,
): PlayerIQScore {
  const playerIQScore = Math.round(market.marketScore * 0.6 + performance.performanceScore * 0.4);

  // Direction = whichever signal dominates the blended movement.
  // If both agree, use that. If they disagree, lean on whichever has
  // the larger deviation from "stable" (50).
  const mDev = market.marketScore - 50;
  const pDev = performance.performanceScore - 50;
  let dir: PlayerIQDirection = "stable";
  if (Math.abs(mDev) >= Math.abs(pDev)) dir = market.marketDirection;
  else dir = performance.performanceDirection;

  // If the combined score itself is very flat, override to stable.
  if (playerIQScore >= 45 && playerIQScore <= 55 && Math.abs(mDev) < 5 && Math.abs(pDev) < 5) {
    dir = "stable";
  }

  return {
    playerIQScore,
    playerIQLabel: deriveLabel(playerIQScore, dir),
    playerIQDirection: dir,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Cosmos read / write
// ──────────────────────────────────────────────────────────────────────────

function overallConfidence(market: Confidence, performance: Confidence): Confidence {
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
  // Take the lower of the two as the overall confidence floor.
  return rank[market] <= rank[performance] ? market : performance;
}

/** Build a full PlayerScore doc from its parts. */
export function buildPlayerScore(
  playerName: string,
  market: MarketScore,
  performance: PerformanceScore & { mlbPlayerId: number | null; team: string | null; position: string | null },
  dataSource: PlayerScore["dataSource"] = "realtime_estimate",
): PlayerScore {
  const blended = computePlayerIQScore(market, performance);
  const playerId =
    performance.mlbPlayerId != null
      ? String(performance.mlbPlayerId)
      : playerNameSlug(playerName);
  return {
    id: playerId,
    playerId,
    playerName,
    mlbPlayerId: performance.mlbPlayerId,
    team: performance.team,
    position: performance.position,
    league: performance.mlbPlayerId ? "MLB" : "unknown",
    level: null,
    market,
    performance: {
      performanceScore: performance.performanceScore,
      performanceDirection: performance.performanceDirection,
      momentumRatio: performance.momentumRatio,
      statLine: performance.statLine,
      statGroup: performance.statGroup,
      milestone: performance.milestone,
      confidence: performance.confidence,
    },
    playerIQScore: blended.playerIQScore,
    playerIQLabel: blended.playerIQLabel,
    playerIQDirection: blended.playerIQDirection,
    updatedAt: new Date().toISOString(),
    dataSource,
    confidence: overallConfidence(market.confidence, performance.confidence),
  };
}

/**
 * Validate a Cosmos document id / partition-key value.
 *
 * Defends against Cosmos HTTP 400 rejections per
 * `docs/phase0/cosmos_21_failure_rate_investigation.md` (commit 44e3884) —
 * 22.6% of player_trends upserts were failing with 400 Bad Request.
 * The most concrete cause is `playerNameSlug` returning the empty string
 * for edge-case inputs (e.g. `"..."`, `"?"`, non-ASCII-only names),
 * which produces an empty `id` field that Cosmos rejects.
 *
 * Rules:
 *  - non-empty string
 *  - ≤ 255 characters
 *  - no `/`, `\`, `?`, `#` (Cosmos id-character restrictions)
 */
function isValidCosmosId(id: string | null | undefined): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.length > 255) return false;
  if (/[/\\?#]/.test(id)) return false;
  return true;
}

// Skip-rate telemetry. Sampled to avoid log noise on every estimate call.
const _upsertStats = { attempts: 0, skipped_invalid_id: 0, lastLogAt: 0 };
function logUpsertStatsThrottled(): void {
  const now = Date.now();
  if (now - _upsertStats.lastLogAt < 5 * 60 * 1000) return;
  if (_upsertStats.attempts === 0) return;
  const skipRate = Math.round((_upsertStats.skipped_invalid_id / _upsertStats.attempts) * 1000) / 10;
  console.log(JSON.stringify({
    event: "playerScore_upsert_stats",
    source: "playerScore.service",
    attempts: _upsertStats.attempts,
    skipped_invalid_id: _upsertStats.skipped_invalid_id,
    skipRatePct: skipRate,
  }));
  _upsertStats.lastLogAt = now;
}

/**
 * Numeric id discriminator. Per CF-PLAYERTRENDS-DUPLICATE-RECORDS (see
 * docstring on PlayerScore.playerId in types/playerScore.ts), numeric
 * MLB-id form is canonical and slug form is transient. The write-path
 * merge only fires when the incoming id is numeric (slug→slug merges
 * are a no-op by definition — there's nothing to merge INTO).
 */
const NUMERIC_PLAYER_ID_RE = /^\d+$/;

/**
 * Copy player_trend_history snapshots from a slug-form partition to the
 * numeric-form partition. Cosmos doesn't allow in-place partition-key
 * mutation, so this is delete-and-rewrite per snapshot.
 *
 * Idempotency:
 *  - Existence-checked at target partition before each create — re-runs
 *    skip already-copied snapshots.
 *  - Source delete tolerates "already deleted" (404) — concurrent runs
 *    or partial prior runs don't double-fail.
 *
 * Failure semantics: per-snapshot errors are counted and surfaced via
 * the return value (caller surfaces as an aggregated
 * `playerScore_slug_merge_partial_failure` event when count > 0).
 * Does NOT throw — partial copy is acceptable and the parent slug
 * record gets deleted regardless (see comment on caller).
 */
async function copyAndDeleteHistorySnapshots(
  fromPlayerId: string,
  toPlayerId: string,
): Promise<{ copied: number; skipped: number; errors: number }> {
  if (!historyContainer) return { copied: 0, skipped: 0, errors: 0 };

  let snapshots: Array<Record<string, unknown> & { id: string; playerId: string; snapshotAt?: string }>;
  try {
    const { resources } = await historyContainer.items
      .query<Record<string, unknown> & { id: string; playerId: string; snapshotAt?: string }>(
        {
          query: 'SELECT * FROM c WHERE c["playerId"] = @pid',
          parameters: [{ name: "@pid", value: fromPlayerId }],
        },
        { partitionKey: fromPlayerId },
      )
      .fetchAll();
    snapshots = resources;
  } catch (err) {
    return { copied: 0, skipped: 0, errors: 1 };
  }

  let copied = 0;
  let skipped = 0;
  let errors = 0;

  for (const s of snapshots) {
    // Re-key: snapshot id is `{playerId}_{ts}` per historyDoc construction;
    // rebuild with the target playerId prefix.
    const suffix = s.id.startsWith(`${fromPlayerId}_`)
      ? s.id.slice(fromPlayerId.length + 1)
      : String(
          (typeof s.snapshotAt === "string" && Date.parse(s.snapshotAt))
            || Date.now(),
        );
    const newId = `${toPlayerId}_${suffix}`;

    // Existence check at target partition. 404 = doesn't exist, proceed.
    let existsAtTarget = false;
    try {
      const { resource } = await historyContainer.item(newId, toPlayerId).read();
      if (resource) existsAtTarget = true;
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code !== 404) {
        errors += 1;
        continue;
      }
    }

    if (existsAtTarget) {
      // Already copied in a prior run. Clean up the source snapshot and
      // move on.
      try {
        await historyContainer.item(s.id, fromPlayerId).delete();
      } catch (_) {
        // Tolerate — source may also have been deleted by a prior run.
      }
      skipped += 1;
      continue;
    }

    try {
      await historyContainer.items.create({ ...s, id: newId, playerId: toPlayerId });
      copied += 1;
    } catch (err) {
      errors += 1;
      continue;
    }

    try {
      await historyContainer.item(s.id, fromPlayerId).delete();
    } catch (_) {
      // Tolerate — concurrent run or partial state. The copy succeeded;
      // leaving the source snapshot does not double-count downstream
      // because the parent slug player_trends record is about to be
      // deleted, making this partition unreachable.
    }
  }

  return { copied, skipped, errors };
}

/**
 * CF-PLAYERTRENDS-DUPLICATE-RECORDS write-path fix.
 *
 * Merges any orphan slug-form player_trends records into the canonical
 * numeric record before the numeric upsert lands. Called from
 * `upsertPlayerScore` ONLY when the incoming id is numeric.
 *
 * Concurrent-call safety: this helper is called per-upsert. If two
 * upserts for the same player race, both query (both see the slug
 * candidate), both attempt history copy (each snapshot is existence-
 * checked at target partition, so duplicates short-circuit), both
 * attempt slug delete (first wins, second 404s and tolerates). Net
 * result: idempotent under concurrency without explicit locking.
 *
 * Partial-failure semantics: per-snapshot errors do NOT block the
 * parent slug record's delete. Partial state (some snapshots copied,
 * some not) is acceptable because (a) re-running the merge is
 * idempotent and (b) leaving the slug record in place would cause
 * infinite re-merge attempts on every future upsert. The aggregated
 * `playerScore_slug_merge_partial_failure` warn event surfaces the
 * partial-state cases as grep-able discrete findings for post-deploy
 * telemetry; per-snapshot logs alone would bury the signal in noise.
 */
async function mergeSlugRecordsIfPresent(
  canonical: string,
  numericId: string,
  numericPlayerId: string,
): Promise<void> {
  if (!canonical || !trendsContainer || !historyContainer) return;

  let candidates: PlayerScore[];
  try {
    const { resources } = await trendsContainer.items
      .query<PlayerScore>({
        query:
          'SELECT * FROM c WHERE c["playerNameNormalized"] = @canonical AND c.id != @numericId',
        parameters: [
          { name: "@canonical", value: canonical },
          { name: "@numericId", value: numericId },
        ],
      })
      .fetchAll();
    candidates = resources;
  } catch (err) {
    // Query failure is non-fatal — fall through; the numeric upsert
    // proceeds and the slug record remains for the next attempt.
    console.warn(JSON.stringify({
      event: "playerScore_slug_merge_query_failed",
      source: "playerScore.service",
      canonical,
      numericId,
      message: (err as Error).message,
    }));
    return;
  }

  for (const slug of candidates) {
    // Defensive: only dedupe slug-form into numeric. If we ever see a
    // numeric-vs-numeric duplicate (shouldn't happen under MLB id
    // uniqueness), log and skip rather than silently merge.
    if (NUMERIC_PLAYER_ID_RE.test(slug.id)) {
      console.warn(JSON.stringify({
        event: "playerScore_dedupe_unexpected_numeric_collision",
        source: "playerScore.service",
        canonical,
        numericId,
        otherId: slug.id,
      }));
      continue;
    }

    const histCounts = await copyAndDeleteHistorySnapshots(
      slug.playerId,
      numericPlayerId,
    );

    try {
      await trendsContainer.item(slug.id, slug.playerId).delete();
      console.log(JSON.stringify({
        event: "playerScore_slug_record_merged",
        source: "playerScore.service",
        canonical,
        numericId,
        slugId: slug.id,
        slugPlayerId: slug.playerId,
        historyCopied: histCounts.copied,
        historySkipped: histCounts.skipped,
        historyErrors: histCounts.errors,
      }));
      if (histCounts.errors > 0) {
        // Higher-signal aggregated event per CF-PLAYERTRENDS-DUPLICATE-
        // RECORDS Phase 2 Addition 1. Grep-able as a discrete finding:
        // "any merges land in partial state?" Per-snapshot logs alone
        // would bury this in noise.
        console.warn(JSON.stringify({
          event: "playerScore_slug_merge_partial_failure",
          source: "playerScore.service",
          canonical,
          numericId,
          slugId: slug.id,
          historyCopied: histCounts.copied,
          historySkipped: histCounts.skipped,
          historyErrors: histCounts.errors,
        }));
      }
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code !== 404) {
        console.warn(JSON.stringify({
          event: "playerScore_slug_record_delete_failed",
          source: "playerScore.service",
          slugId: slug.id,
          slugPlayerId: slug.playerId,
          message: (err as Error).message,
        }));
      }
      // 404 = concurrent run already deleted; tolerate silently.
    }
  }
}

/**
 * Upsert a PlayerScore document. Also fires a fire-and-forget write to
 * `player_trend_history` so the PlayerIQView score chart has data over time.
 *
 * Never throws. Skips with structured warning when `score.id` or
 * `score.playerId` fails Cosmos id validation (see `isValidCosmosId`).
 */
export async function upsertPlayerScore(score: PlayerScore): Promise<void> {
  _upsertStats.attempts += 1;

  // Pre-flight validation. Cosmos rejects empty / oversized / special-char
  // ids with HTTP 400, which previously dominated 97% of failures in
  // hobbyiq-comps-centralus (~22.6% of all writes). Skip + log instead of
  // letting Cosmos reject; counter visible via `playerScore_upsert_stats`.
  if (!isValidCosmosId(score.id) || !isValidCosmosId(score.playerId)) {
    _upsertStats.skipped_invalid_id += 1;
    console.warn(JSON.stringify({
      event: "playerScore_upsert_skipped_invalid_id",
      source: "playerScore.service",
      playerName: score.playerName ?? null,
      id: score.id ?? null,
      playerId: score.playerId ?? null,
      mlbPlayerId: score.mlbPlayerId ?? null,
    }));
    logUpsertStatsThrottled();
    return;
  }

  // CF-PLAYERNAME-CANONICALIZATION (2026-05-28): always set
  // playerNameNormalized on write. Indexed exact-match lookup field for
  // getPlayerScoreByName. Independent of any other normalization paths
  // in the codebase.
  const docToWrite: PlayerScore = {
    ...score,
    playerNameNormalized: canonicalizePlayerName(score.playerName),
  };

  try {
    await initContainers();
    if (!trendsContainer) return;

    // CF-PLAYERTRENDS-DUPLICATE-RECORDS (2026-05-28): merge any orphan
    // slug-form record for this canonical player into the numeric one
    // BEFORE upsert. Only fires when current id is numeric — slug→slug
    // merges are a no-op by definition. See `mergeSlugRecordsIfPresent`
    // docstring for concurrent-call safety + partial-failure semantics.
    if (
      NUMERIC_PLAYER_ID_RE.test(docToWrite.id)
      && typeof docToWrite.playerNameNormalized === "string"
      && docToWrite.playerNameNormalized.length > 0
    ) {
      await mergeSlugRecordsIfPresent(
        docToWrite.playerNameNormalized,
        docToWrite.id,
        docToWrite.playerId,
      );
    }

    await trendsContainer.items.upsert(docToWrite);
  } catch (err) {
    console.warn("[playerScore] upsert failed:", (err as Error).message);
    return;
  }
  logUpsertStatsThrottled();

  // Fire-and-forget history write
  void (async () => {
    try {
      if (!historyContainer) return;
      const historyDoc = {
        ...docToWrite,
        id: `${score.playerId}_${Date.now()}`,
        playerId: score.playerId, // partition key
        snapshotAt: score.updatedAt,
      };
      await historyContainer.items.create(historyDoc);
    } catch (err) {
      console.warn("[playerScore] history write failed:", (err as Error).message);
    }
  })();
}

// Test-only internal accessors.
export const __playerScoreInternals = {
  isValidCosmosId,
  resetStats: (): void => {
    _upsertStats.attempts = 0;
    _upsertStats.skipped_invalid_id = 0;
    _upsertStats.lastLogAt = 0;
  },
  getStats: () => ({ ..._upsertStats }),
  // CF-PLAYERTRENDS-DUPLICATE-RECORDS test surface
  mergeSlugRecordsIfPresent,
  copyAndDeleteHistorySnapshots,
  NUMERIC_PLAYER_ID_RE,
  setContainersForTest: (trends: Container | null, history: Container | null): void => {
    trendsContainer = trends;
    historyContainer = history;
  },
};

/** Read by playerId (preferred — single-partition lookup). */
export async function getPlayerScore(playerId: string): Promise<PlayerScore | null> {
  try {
    await initContainers();
    if (!trendsContainer) return null;
    const { resource } = await trendsContainer.item(playerId, playerId).read<PlayerScore>();
    return resource ?? null;
  } catch (err) {
    const status = (err as { code?: number }).code;
    if (status !== 404) {
      console.warn("[playerScore] read failed:", (err as Error).message);
    }
    return null;
  }
}

/**
 * Extract structured detail from an Azure Cosmos SDK error for
 * CF-PLAYERTRENDS-QUERY-FAILURE diagnostics. The SDK's `ErrorResponse`
 * carries code/substatus/body/activityId — all of which are discarded
 * by the existing `(err as Error).message` log path. The body is the
 * load-bearing artifact (names the specific Cosmos sub-error like
 * "Cross partition query is required..." / continuation issues / etc.).
 */
function extractCosmosError(err: unknown): Record<string, unknown> {
  const e = err as Record<string, unknown>;
  return {
    code: e?.code ?? null,
    substatus: e?.substatus ?? null,
    activityId: e?.activityId ?? null,
    message: e instanceof Error ? e.message : String(err),
    body: e?.body ?? null,
    headers: e?.headers ?? null,
    diagnostics: e?.diagnostics ?? null,
    name: e?.name ?? null,
  };
}

/** Approximate response size in bytes for diff-vs-failures. Stringify is
 *  ~O(n); at ~19 calls/hour total volume this is cheap. */
function approxBytes(resources: unknown): number {
  try {
    return JSON.stringify(resources).length;
  } catch {
    return -1;
  }
}

/**
 * Read by playerName, canonicalized (case + punctuation + accent + suffix-
 * insensitive). Cross-partition query.
 *
 * CF-PLAYERNAME-CANONICALIZATION (2026-05-28). Primary query is indexed
 * exact-match on `playerNameNormalized`; falls back to LOWER(playerName)
 * for documents that haven't been backfilled yet (the 76 existing
 * records pre-2026-05-28). Once the backfill commit confirms all
 * documents carry playerNameNormalized, the fallback can be removed in
 * a cleanup commit.
 *
 * Existing CF-PLAYERTRENDS-QUERY-FAILURE diagnostic instrumentation is
 * preserved (closed 2026-05-28 as classification A — the 32% 400 rate
 * is benign SDK chatter). The success/failure event stream now also
 * serves as the verification harness for the canonicalization fix.
 */
export async function getPlayerScoreByName(playerName: string): Promise<PlayerScore | null> {
  const canonical = canonicalizePlayerName(playerName);
  const inputCapture = {
    playerName,
    playerNameCanonical: canonical,
    playerNameLength: playerName?.length ?? null,
  };
  try {
    await initContainers();
    if (!trendsContainer) return null;

    // Primary: indexed exact-match on canonical form.
    const primary = await trendsContainer.items
      .query<PlayerScore>({
        query: 'SELECT TOP 1 * FROM c WHERE c["playerNameNormalized"] = @canonical',
        parameters: [{ name: "@canonical", value: canonical }],
      })
      .fetchAll();

    let matched = primary.resources?.[0] ?? null;
    let matchedVia: "canonical" | "legacy-lower" | "miss" = matched ? "canonical" : "miss";

    // Migration fallback: documents written before the backfill don't
    // have playerNameNormalized yet. Try LOWER(playerName) for those.
    // Removed in a cleanup commit after backfill completion verified.
    if (!matched) {
      const legacy = await trendsContainer.items
        .query<PlayerScore>({
          query: 'SELECT TOP 1 * FROM c WHERE LOWER(c["playerName"]) = @name',
          parameters: [{ name: "@name", value: playerName.trim().toLowerCase() }],
        })
        .fetchAll();
      matched = legacy.resources?.[0] ?? null;
      if (matched) matchedVia = "legacy-lower";
    }

    console.log(JSON.stringify({
      event: "playerScore_getByName_ok",
      source: "playerScore.service",
      caller: "getPlayerScoreByName",
      input: inputCapture,
      result: {
        rowCount: matched ? 1 : 0,
        matchedVia,
        hadHit: !!matched,
      },
    }));
    return matched;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "playerScore_getByName_failed",
      source: "playerScore.service",
      caller: "getPlayerScoreByName",
      input: inputCapture,
      query: 'SELECT TOP 1 * FROM c WHERE c["playerNameNormalized"] = @canonical',
      cosmosError: extractCosmosError(err),
    }));
    return null;
  }
}

/** Top players by playerIQScore, optionally filtered by direction. */
export async function getTopPlayersByScore(
  limit = 25,
  direction?: PlayerIQDirection,
): Promise<PlayerScore[]> {
  try {
    await initContainers();
    if (!trendsContainer) return [];

    const safeLimit = Math.max(1, Math.min(100, limit));
    const where = direction ? 'WHERE c["playerIQDirection"] = @dir' : "";
    const params = direction ? [{ name: "@dir", value: direction }] : [];
    const queryText = `SELECT TOP ${safeLimit} * FROM c ${where} ORDER BY c["playerIQScore"] DESC`;
    const inputCapture = {
      limit,
      safeLimit,
      direction: direction ?? null,
    };
    try {
      const { resources } = await trendsContainer.items
        .query<PlayerScore>({
          query: queryText,
          parameters: params,
        })
        .fetchAll();
      console.log(JSON.stringify({
        event: "playerScore_topQuery_ok",
        source: "playerScore.service",
        caller: "getTopPlayersByScore",
        input: inputCapture,
        query: queryText,
        result: {
          rowCount: resources?.length ?? 0,
          responseBytesApprox: approxBytes(resources),
        },
      }));
      return resources ?? [];
    } catch (innerErr) {
      // CF-PLAYERTRENDS-QUERY-FAILURE diagnostic instrumentation (paired
      // with getPlayerScoreByName above). Same structured-trace pattern,
      // same input-capture object as the success log for diff-ability.
      console.warn(JSON.stringify({
        event: "playerScore_topQuery_failed",
        source: "playerScore.service",
        caller: "getTopPlayersByScore",
        input: inputCapture,
        query: queryText,
        cosmosError: extractCosmosError(innerErr),
      }));
      return [];
    }
  } catch (err) {
    // Outer catch covers initContainers() failure (pre-query). Keep the
    // original simple log shape — this is not the cross-partition query
    // failure path that CF-PLAYERTRENDS-QUERY-FAILURE is investigating.
    console.warn("[playerScore] top query failed (pre-query):", (err as Error).message);
    return [];
  }
}

/** Read player_trend_history snapshots for the PlayerIQView score chart. */
export async function getPlayerTrendHistory(
  playerId: string,
  limit = 30,
): Promise<PlayerScore[]> {
  try {
    await initContainers();
    if (!historyContainer) return [];
    const safeLimit = Math.max(1, Math.min(200, limit));
    const { resources } = await historyContainer.items
      .query<PlayerScore>({
        query: `SELECT TOP ${safeLimit} * FROM c WHERE c["playerId"] = @id ORDER BY c["updatedAt"] DESC`,
        parameters: [{ name: "@id", value: playerId }],
      }, { partitionKey: playerId })
      .fetchAll();
    return resources ?? [];
  } catch (err) {
    console.warn("[playerScore] history read failed:", (err as Error).message);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Real-time update from /api/compiq/estimate
// ──────────────────────────────────────────────────────────────────────────

/**
 * Refresh a player's PlayerScore from the latest trend_history snapshots
 * plus a fresh MLB momentum read. Fire-and-forget — never blocks the
 * triggering estimate response.
 *
 * Rate-limited to one update per playerName per 30 minutes (in-memory).
 *
 * @returns the upserted PlayerScore on success, null when rate-limited or
 *          on any error.
 */
export async function updatePlayerScoreFromEstimate(
  playerName: string,
): Promise<PlayerScore | null> {
  if (!playerName || !playerName.trim()) return null;
  const key = playerName.trim().toLowerCase();
  const now = Date.now();
  const last = lastUpdateByPlayer.get(key);
  if (last && now - last < UPDATE_RATE_LIMIT_MS) return null;
  lastUpdateByPlayer.set(key, now);

  try {
    const snapshots = await getRecentSnapshotsByPlayer(playerName, 7);
    const market = computeMarketScore(playerName, snapshots);
    const performance = await computePerformanceScore(playerName);
    const score = buildPlayerScore(playerName, market, performance, "realtime_estimate");
    await upsertPlayerScore(score);
    return score;
  } catch (err) {
    console.warn(
      `[playerScore] updatePlayerScoreFromEstimate(${playerName}) failed:`,
      (err as Error).message
    );
    // Roll back rate limiter so the next call can retry
    lastUpdateByPlayer.delete(key);
    return null;
  }
}

/**
 * Same as `updatePlayerScoreFromEstimate` but marked `dataSource: "nightly_job"`.
 * Bypasses the 30-min rate limiter (the nightly batch is the source of truth).
 */
export async function refreshPlayerScoreForJob(
  playerName: string,
): Promise<PlayerScore | null> {
  if (!playerName || !playerName.trim()) return null;
  try {
    const snapshots = await getRecentSnapshotsByPlayer(playerName, 7);
    const market = computeMarketScore(playerName, snapshots);
    const performance = await computePerformanceScore(playerName);
    const score = buildPlayerScore(playerName, market, performance, "nightly_job");
    await upsertPlayerScore(score);
    return score;
  } catch (err) {
    console.warn(
      `[playerScore] refreshPlayerScoreForJob(${playerName}) failed:`,
      (err as Error).message
    );
    return null;
  }
}
