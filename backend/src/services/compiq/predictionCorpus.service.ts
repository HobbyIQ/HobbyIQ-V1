// CF-PREDICTION-CORPUS STEP 2 — Cosmos writer + container.
//
// Persists every CompIQ prediction emission into Cosmos `prediction_log` for
// post-launch accuracy measurement per the prediction credibility methodology
// (docs/phase0/prediction_credibility_methodology_2026-05-30.md).
//
// SHAPE: this writer takes the SAME in-memory emit object that
// compiqEstimate.service.ts already builds for the [compiq.prediction_emitted]
// stdout event (post-CF-PREDICTION-CORPUS-CARDID-EMISSION at 702dcfe's STEP 1).
// We write to Cosmos DIRECTLY at the emission site — NOT by parsing stdout /
// App Insights traces. Trace retention is ~30 min platform-wide per
// CF-PLATFORM-OBSERVABILITY-RETENTION; reading-from-logs path is dead.
//
// DUAL-EMIT BURN-IN per §2.4: caller keeps the stdout console.log AND calls
// this writer. After confirmed live for one week, drop stdout (separate CF).
//
// Cosmos:
//   db        = COSMOS_DB ?? "hobbyiq"
//   container = "prediction_log"
//   partition = /cardId
//   doc id    = `${cardId}_${epochMs}`            for resolved rows
//             = `__unresolved___${inputSigShort}_${epochMs}` for sentinel rows
//
// NULL-CARDID HANDLING (Option A per CF kickoff partition decision):
// Sentinel partition "__unresolved__" + sig-derived id suffix. joinable=false
// flags the row as unjoinable per methodology §3.5 LOW band — captured for
// record-keeping, excluded from accuracy claims. Single sentinel partition is
// hot-partition-at-scale debt; v1 single-user volume makes it hypothetical;
// CF-LAUNCH-READINESS-500 escalation path is hashed bucketing (forward-only
// schema change, no rewrite).
//
// RATE LIMIT: one write per (cardId-or-sentinel, input-signature) per 60 min,
// in-memory Map keyed by `${partitionKey}::${inputSigShort}`. Matches the
// trendHistory.service.ts:25-26 + :96-100 pattern. Pre-mark before async;
// rollback on Cosmos init failure so a transient outage doesn't permanently
// suppress a cardId's writes.
//
// FIRE-AND-FORGET: never throws, never blocks the prediction response. All
// errors caught + throttled-warn. Mirrors trendHistory.service.ts:92-142.
//
// COMPLETENESS COUNTER (CF-PREDICTION-CORPUS STEP 3): NOT in this file —
// separate `predictionCorpusHealth.service.ts` per methodology §2.6.

import { createHash } from "crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
// Import the canonical TrendIQ direction + coverage types so this service
// can't drift from the emission site's actual shape. (Earlier rev hand-rolled
// a subset of TrendIQCoverage and a wrong-vocabulary TrendIQDirection;
// fixed by importing the source of truth here.)
import type {
  TrendIQDirection,
  TrendIQCoverage,
  TrendIQWeights,
} from "./trendIQ.types.js";
import type { PredictionCorpusSource } from "../../types/compiq.types.js";
// DIRECTION_BAND_PCT + derivePredictionDirection live in the neutral
// predictionConstants module so the future read path (CF-PREDICTION-
// ACCURACY-DASHBOARD) imports them without coupling to this write-path
// service. Per methodology §4.3 single-source-of-truth invariant.
import { derivePredictionDirection } from "./predictionConstants.js";
// PHASE-4A-2.2 (2026-06-02): read per-prediction cache stats at write time
// so PredictionLogDocument.cache_hit reflects whether the prediction
// served entirely from the cache.
import { cacheStatsContext } from "../shared/cache.service.js";
// STEP 3: write-completeness health counter. Per methodology §2.6 we
// record each attempt + success/failure resolution into a Cosmos doc
// per-replica per-day. The counter calls are fire-and-forget and
// never throw — same discipline as this writer.
import {
  recordAttempt,
  recordSuccess,
  recordFailure,
} from "./predictionCorpusHealth.service.js";

// ─── Constants ────────────────────────────────────────────────────────────

const DB_NAME = process.env.COSMOS_DB ?? process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_NAME =
  process.env.COSMOS_PREDICTION_LOG_CONTAINER ?? "prediction_log";

const RATE_LIMIT_MS = 60 * 60 * 1000; // 60 minutes per (cardId-or-sentinel, sig)

/**
 * Sentinel partition value for prediction rows emitted without a resolved
 * cardId. Never collides with a real 36-char Cardsight UUID.
 * See methodology doc §2.2 "Null-cardId handling" addendum.
 *
 * STAYS WRITER-LOCAL by design. The sentinel is a write-path concern;
 * readers MUST filter on the `joinable` flag — NEVER on this sentinel
 * value pattern — per the migration-stable filter rule (methodology
 * §2.2 joinable field). Keeping the sentinel un-exported-to-read-path
 * enforces the discipline at the type system level: a reader that
 * imported this constant would be writing a query that breaks on the
 * A→B partition upgrade at CF-LAUNCH-READINESS-500.
 */
export const UNRESOLVED_CARDID_SENTINEL = "__unresolved__";

// ─── Cosmos init (lazy, mirrors trendHistory.service.ts) ──────────────────

let cachedContainer: Container | null = null;
let initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const conn = process.env.COSMOS_CONNECTION_STRING;
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;

      let client: CosmosClient | null = null;
      if (conn) {
        client = new CosmosClient(conn);
      } else if (endpoint && key) {
        client = new CosmosClient({ endpoint, key });
      } else if (endpoint) {
        client = new CosmosClient({
          endpoint,
          aadCredentials: new DefaultAzureCredential(),
        });
      } else {
        return null;
      }

      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_NAME,
        partitionKey: { paths: ["/cardId"] },
      });
      cachedContainer = container;
      return container;
    } catch (err) {
      console.warn(
        "[predictionCorpus] init failed:",
        (err as Error).message,
      );
      return null;
    }
  })();

  return initPromise;
}

// ─── Rate-limit state ─────────────────────────────────────────────────────

const lastWriteByKey = new Map<string, number>();

// ─── Input + document shapes (mirror methodology §2.2) ────────────────────

/**
 * Input to writePredictionLog — the SAME object shape compiqEstimate.service.ts
 * builds for its existing [compiq.prediction_emitted] stdout JSON.stringify.
 *
 * Caller passes this verbatim from the emission site; writer transforms into
 * the PredictionLogDocument by adding `id`, sentinel-handling cardId,
 * deriving `joinable` + `predictionDirection`.
 */
export interface PredictionEmitInput {
  cardId: string | null;
  playerName: string | null;
  cardYear: number | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  fairMarketValue: number | null;
  // CF-PREDICTION-CORPUS-EMISSION-COVERAGE (2026-05-31): the FMV-mechanism
  // axis. Tags how `fairMarketValue` was computed — distinct from
  // `predictedPriceMechanism` (how the FORWARD prediction was computed).
  // Stratifies MAPE / accuracy queries by which fallback path served the
  // row, so the corpus can answer "is sibling-pool MAPE worse than
  // main-pipeline MAPE?" Required.
  fmvMechanism: "main-pipeline" | "sibling-pool-weighted-median" | "unavailable";
  // CF-PREDICTION-CORPUS-EMISSION-COVERAGE: the headline price the user
  // actually saw on the wire. predictedPrice ?? fairMarketValue ?? null —
  // names the MAPE target unambiguously regardless of path. Paired with
  // `surfacedPriceSource` for stratification.
  surfacedPrice: number | null;
  surfacedPriceSource: "predictedPrice" | "fairMarketValue" | "none";
  predictedPrice: number | null;
  predictedPriceRange: { low: number; high: number } | null;
  predictedPriceMechanism: "trendiq-projection" | "multiplier-anchored" | "unavailable";
  forwardProjectionFactor: number;
  trendIQ: {
    composite: number;
    // trendIQ.direction + .coverage are the internal TrendIQ types
    // — distinct from `predictionDirection` (derived per DIRECTION_BAND_PCT
    // on the prediction-vs-FMV axis). Imported from trendIQ.types.ts to
    // prevent type-duplication drift.
    direction: TrendIQDirection;
    coverage: TrendIQCoverage;
    components: {
      playerMomentum: number | null;
      cardTrajectory: number | null;
      segmentTrajectory: number | null;
    };
    // PHASE-4B-SLICE-1 (2026-06-01): TrendIQResult.weights pass-through so
    // the buildDocument layer can hoist trendIQ_weights to a flat field for
    // query-axis clarity. Nullable on the stub branch (no trendIQ computed).
    weights: TrendIQWeights | null;
    lastUpdated: string | null;       // nullable: aggregator may have no
                                      // last-write timestamp (e.g. all signals
                                      // unavailable → composite 1.0 with no
                                      // timestamp anchor).
  };
  compsUsed: number;
  timestamp: string; // ISO 8601 — prediction emit time
  // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): attribution axis,
  // threaded from each computeEstimate caller. Flat fields (not nested
  // under a `callContext` object) so the emit-payload === stdout-shape
  // invariant holds across the dual-emit channel without parsing.
  // source uses the closed PredictionCorpusSource literal union — tsc
  // enforces every caller supplies one of the documented members.
  // routedFromHolding is the §4.2/4.3 sale-join switch (true → join
  // via holdingId+userId to PortfolioLedgerEntry; false → join via
  // cardId to the broader eBay-sold path).
  source: PredictionCorpusSource;
  userId: string | null;
  holdingId: string | null;
  routedFromHolding: boolean;
}

/**
 * Document shape persisted to Cosmos prediction_log.
 *
 * Differs from PredictionEmitInput in three ways:
 *   1. `id` added — composed per the sentinel/resolved id-format rules
 *   2. `cardId` is ALWAYS a string (sentinel `__unresolved__` when
 *      input was null) — required for partition key resolution
 *   3. `joinable` added — true iff cardId is a real Cardsight UUID
 *   4. `predictionDirection` added — derived per DIRECTION_BAND_PCT
 *   5. `source` always set (defaulted to "estimate" when input omitted)
 */
interface PredictionLogDocument {
  id: string;
  cardId: string;
  /**
   * MIGRATION-STABLE FILTER. True iff cardId is a real Cardsight
   * UUID; false iff it's a sentinel value.
   *
   * LOAD-BEARING for downstream accuracy queries: every accuracy consumer
   * MUST filter on `joinable === true` — NEVER on the partition value
   * pattern (e.g. `WHERE cardId != "__unresolved__"`). The future
   * A→B upgrade at CF-LAUNCH-READINESS-500 (sentinel `__unresolved__` →
   * hashed buckets `__unresolved_XX__`) changes the partition value set
   * but does NOT change `joinable` semantics. Queries filtering on
   * `joinable` survive the upgrade unchanged; queries filtering on
   * partition-value strings break silently. Hard rule: joinable is the
   * only correct discriminator. Per methodology §2.2 addendum.
   */
  joinable: boolean;
  predictionDirection: "rising" | "falling" | "stable";
  playerName: string | null;
  cardYear: number | null;
  product: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  fairMarketValue: number | null;
  fmvMechanism: PredictionEmitInput["fmvMechanism"];
  surfacedPrice: number | null;
  surfacedPriceSource: PredictionEmitInput["surfacedPriceSource"];
  predictedPrice: number | null;
  predictedPriceRange: { low: number; high: number } | null;
  predictedPriceMechanism: "trendiq-projection" | "multiplier-anchored" | "unavailable";
  forwardProjectionFactor: number;
  trendIQ: PredictionEmitInput["trendIQ"];
  compsUsed: number;
  timestamp: string;
  // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): attribution axis,
  // identical shape to PredictionEmitInput (the writer copies these
  // verbatim from the input). The §4.2/4.3 sale-join consumer reads
  // `routedFromHolding` to switch between PortfolioLedgerEntry-join
  // (true) vs eBay-sold cardId-join (false). Methodology §2.2.
  source: PredictionEmitInput["source"];
  userId: string | null;
  holdingId: string | null;
  routedFromHolding: boolean;
  // PHASE-4A-2.2 (2026-06-02; semantic correction 2026-06-02 -FIX):
  // whether this prediction served entirely from cache. Set at the
  // cacheWrap boundary via the AsyncLocalStorage `cacheStatsContext`
  // scope opened by computeEstimate. Tri-state:
  //   null  = no cache calls happened (ctx absent OR ctx active but
  //           total hits+misses === 0; e.g. early-return prediction
  //           paths that emit before any pricing call)
  //   true  = at least one cache call AND zero misses (= all-cache-fresh)
  //   false = at least one miss (or stale-serve, which counts as miss)
  // Does NOT change which predictions get logged; the §4.2/§4.3 accuracy
  // instrument tolerates the new field (optional add, no existing field
  // changed).
  cache_hit: boolean | null;
  // PHASE-4A-2.2-FIX (2026-06-02): companion signal to cache_hit. Tri-state
  // mirroring cache_hit's null-if-no-cache-calls semantics:
  //   null  = no cache calls happened
  //   true  = at least one cacheWrap call served stale (Cardsight outage
  //           was observed during this prediction; the response carries
  //           a fallback value from a stale-but-within-window cache entry)
  //   false = no stale-serves in this prediction
  // The corpus-side counterpart to the deferred iOS-facing "approximate"
  // badge. Allows post-hoc analysis of "which predictions were affected
  // by Cardsight outages" without needing the API-output marker (still
  // deferred, iOS-gated).
  served_stale: boolean | null;
  // PHASE-4B-SLICE-1 (2026-06-01): flat top-level fields hoisted from
  // input.trendIQ for query-axis clarity. The nested trendIQ field above
  // retains its full structure (composite/direction/coverage/components/
  // weights/lastUpdated) for downstream consumers that need the whole
  // shape; these flat fields let accuracy queries answer the PROOF
  // question without traversing the nested struct:
  //
  //   Q: do non-neutral composites reach predictions?
  //     SELECT VALUE COUNT(1) FROM c
  //     WHERE c.trendIQ_composite != 1.0
  //
  //   Q: which predictions used a non-neutral PLAYER signal specifically?
  //     SELECT VALUE COUNT(1) FROM c
  //     WHERE c.playerMomentum_multiplier != 1.0
  //
  //   Q: what weight did Layer 1 actually carry when present?
  //     SELECT c.trendIQ_weights.playerMomentum FROM c
  //     WHERE c.trendIQ_weights != null
  //
  // Tri-state per the cache_hit precedent:
  //   trendIQ_composite      null when input.trendIQ absent (rare; stub
  //                          path emits composite=1.0, not null)
  //   playerMomentum_multiplier
  //                          null when Layer 1 absent (signal fetch
  //                          returned null OR aggregator unavailable)
  //   trendIQ_weights        null when coverage=insufficient OR stub
  //
  // §4.2/§4.3 accuracy instrument unchanged — these are additive
  // discriminators on top of the existing prediction-vs-outcome join.
  trendIQ_composite: number | null;
  playerMomentum_multiplier: number | null;
  trendIQ_weights: TrendIQWeights | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Stable SHA-256 hash over the normalized request tuple. Used for:
 *   (a) rate-limit dedup key per (cardId-or-sentinel, sig)
 *   (b) id-suffix collision avoidance in the sentinel partition
 *
 * Normalization: stringified JSON of the relevant input fields. Field order
 * is fixed for stability. null/undefined collapse to null in the JSON.
 */
function inputSignature(input: PredictionEmitInput): string {
  // CF-PREDICTION-CORPUS-EMISSION-COVERAGE (2026-05-31): `fmvMechanism`
  // joined the signature so a card that switches paths within the 60-min
  // rate-limit window (e.g., variant-mismatch yesterday → sibling-pool
  // today) produces a distinct row instead of being silently deduped.
  // A true-repeat (same identity, same path) still dedups within the
  // window — the intended invariant.
  const stable = JSON.stringify({
    playerName: input.playerName ?? null,
    cardYear: input.cardYear ?? null,
    product: input.product ?? null,
    parallel: input.parallel ?? null,
    gradeCompany: input.gradeCompany ?? null,
    gradeValue: input.gradeValue ?? null,
    fmvMechanism: input.fmvMechanism,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * Build the Cosmos doc from the input. Handles sentinel partition + id
 * format split for null-cardId rows.
 */
function buildDocument(
  input: PredictionEmitInput,
  epochMs: number,
): PredictionLogDocument {
  const sig = inputSignature(input);
  const sigShort = sig.slice(0, 8);

  let partitionKey: string;
  let docId: string;
  let joinable: boolean;

  if (input.cardId) {
    partitionKey = input.cardId;
    docId = `${input.cardId}_${epochMs}`;
    joinable = true;
  } else {
    partitionKey = UNRESOLVED_CARDID_SENTINEL;
    docId = `${UNRESOLVED_CARDID_SENTINEL}_${sigShort}_${epochMs}`;
    joinable = false;
  }

  return {
    id: docId,
    cardId: partitionKey,
    joinable,
    predictionDirection: derivePredictionDirection(
      input.predictedPrice,
      input.fairMarketValue,
    ),
    playerName: input.playerName,
    cardYear: input.cardYear,
    product: input.product,
    parallel: input.parallel,
    gradeCompany: input.gradeCompany,
    gradeValue: input.gradeValue,
    fairMarketValue: input.fairMarketValue,
    fmvMechanism: input.fmvMechanism,
    surfacedPrice: input.surfacedPrice,
    surfacedPriceSource: input.surfacedPriceSource,
    predictedPrice: input.predictedPrice,
    predictedPriceRange: input.predictedPriceRange,
    predictedPriceMechanism: input.predictedPriceMechanism,
    forwardProjectionFactor: input.forwardProjectionFactor,
    trendIQ: input.trendIQ,
    compsUsed: input.compsUsed,
    timestamp: input.timestamp,
    // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): attribution copied
    // verbatim from the emit object. source is now required from the
    // closed PredictionCorpusSource enum at the input layer — no more
    // ?? "estimate" defaulting.
    source: input.source,
    userId: input.userId,
    holdingId: input.holdingId,
    routedFromHolding: input.routedFromHolding,
    // PHASE-4A-2.2 (2026-06-02) + FIX (2026-06-02): cache_hit at the
    // cacheWrap boundary. computeEstimate opens an AsyncLocalStorage
    // scope around its body; every cacheWrap underneath tallies into
    // ctx.{hits,misses,staleServes}.
    //   null  = ctx absent OR ctx.hits + ctx.misses === 0 (no cache calls)
    //   true  = at least one cache call AND misses === 0
    //   false = any miss (stale-serves are tallied as misses too)
    cache_hit: (() => {
      const ctx = cacheStatsContext.getStore();
      if (!ctx) return null;
      if (ctx.hits + ctx.misses === 0) return null;
      return ctx.misses === 0;
    })(),
    // PHASE-4A-2.2-FIX (2026-06-02): served_stale companion. Mirrors
    // cache_hit's null-if-no-cache-calls semantics; reads the staleServes
    // counter that tallyStats increments on the stale-serve outcome.
    served_stale: (() => {
      const ctx = cacheStatsContext.getStore();
      if (!ctx) return null;
      if (ctx.hits + ctx.misses === 0) return null;
      return (ctx.staleServes ?? 0) > 0;
    })(),
    // PHASE-4B-SLICE-1 (2026-06-01): flat hoist of the three load-bearing
    // signal fields for the PROOF query. Sourced verbatim from
    // input.trendIQ (no transformation); nulls preserve the "absent" vs
    // "1.0 stub" distinction at the row level. The nested trendIQ field
    // above stays the source of truth; these fields are a query index.
    trendIQ_composite: input.trendIQ.composite ?? null,
    playerMomentum_multiplier: input.trendIQ.components.playerMomentum,
    trendIQ_weights: input.trendIQ.weights,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fire-and-forget Cosmos write for a prediction emission.
 *
 * Returns void synchronously. The async Cosmos write is wrapped in try/catch
 * so a Cosmos failure cannot produce an unhandled rejection. Never throws.
 * Never blocks the prediction response path.
 *
 * Rate-limited to one write per (cardId-or-sentinel, input-signature) per
 * 60 minutes (in-memory Map; resets on server restart — acceptable per the
 * trendHistory.service.ts:5-7 precedent).
 *
 * Pre-marks the rate-limit key BEFORE the async write to deduplicate
 * concurrent calls. Rollback on Cosmos init failure so a transient outage
 * doesn't permanently suppress a key's writes.
 */
/**
 * CF-ACCOUNT-DELETION (2026-06-04): anonymize every prediction_log row for
 * a user — null `userId`, null `holdingId`, set `routedFromHolding=false`.
 *
 * Card-identity fields (cardId, playerName, cardYear, etc.) are
 * PUBLIC information and stay intact — they're the ML training signal.
 * The §4.2/4.3 sale-join trace breaks post-deletion anyway (the user's
 * holdings/ledger are gone), so nulling these attribution axes is the
 * correct semantic.
 *
 * Returns the count of rows mutated. Idempotent: rerunning finds zero
 * matches (the WHERE clause filters on the original userId).
 */
export async function anonymizePredictionLogForUser(userId: string): Promise<number> {
  if (!userId || !String(userId).trim()) return 0;
  const container = await getContainer();
  if (!container) return 0;
  let updated = 0;
  try {
    const { resources } = await container.items
      .query<{ id: string; cardId: string }>({
        query: "SELECT c.id, c.cardId FROM c WHERE c.userId = @uid",
        parameters: [{ name: "@uid", value: userId }],
      })
      .fetchAll();
    for (const row of resources) {
      try {
        await container.item(row.id, row.cardId).patch([
          { op: "set", path: "/userId", value: null },
          { op: "set", path: "/holdingId", value: null },
          { op: "set", path: "/routedFromHolding", value: false },
        ]);
        updated += 1;
      } catch (err: any) {
        if (err?.code === 404) continue;
        console.error("[predictionCorpus] anonymizePredictionLogForUser item failed:", err?.message ?? err);
      }
    }
  } catch (err: any) {
    console.error("[predictionCorpus] anonymizePredictionLogForUser failed:", err?.message ?? err);
  }
  return updated;
}

export function writePredictionLog(input: PredictionEmitInput): void {
  const sig = inputSignature(input);
  const sigShort = sig.slice(0, 8);
  const partitionKey = input.cardId ?? UNRESOLVED_CARDID_SENTINEL;
  const rateLimitKey = `${partitionKey}::${sigShort}`;

  const now = Date.now();
  const last = lastWriteByKey.get(rateLimitKey);
  if (last && now - last < RATE_LIMIT_MS) return;
  // Pre-mark to deduplicate concurrent calls before the async write resolves.
  lastWriteByKey.set(rateLimitKey, now);

  // STEP 3 — record attempt POST-rate-limit-dedup, PRE-async-write.
  // joinable mirrors the buildDocument logic: real cardId → true; null → false.
  // Counter is fire-and-forget (per the health-service contract); never blocks.
  const joinable = !!input.cardId;
  recordAttempt(joinable);

  void (async () => {
    try {
      const container = await getContainer();
      if (!container) {
        // Cosmos unavailable. Roll back the rate-limit marker so the next
        // call can retry once Cosmos comes back. Count this as a failure
        // since we attempted to write but couldn't reach the container.
        lastWriteByKey.delete(rateLimitKey);
        recordFailure(new Error("Cosmos container unavailable"));
        return;
      }

      const doc = buildDocument(input, now);
      await container.items.create(doc);
      recordSuccess();
    } catch (err) {
      console.warn(
        "[predictionCorpus] write failed:",
        (err as Error).message,
      );
      recordFailure(err);
    }
  })();
}
