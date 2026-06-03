// CF-ML-MOAT-OUTCOMES (2026-06-03): prediction-outcome capture service.
//
// Storage shape (per approved design):
//   Container `prediction_outcomes`
//   Partition /cardsightCardId (co-located with prediction_log)
//   Doc id   ${predictionDocId}__h${horizonDays}
//
// State machine (TERMINAL unless noted):
//   sales in window         -> cardsight_graded_window | cardsight_raw_window
//                              realizedOutcomePrice = median(in-window prices)
//                              TERMINAL
//   re-query OK, 0 sales    -> no_sales_in_window
//                              realizedOutcomePrice = null
//                              TERMINAL (illiquidity signal — do NOT retry)
//   Cardsight notFound      -> not_found
//                              realizedOutcomePrice = null
//                              TERMINAL (card aged out of catalog)
//   Cardsight 5xx / timeout -> upstream_error
//                              realizedOutcomePrice = null
//                              RETRY next run, cap at 5 attempts
//                              At attempt 5 -> TERMINAL upstream_error
//
// Idempotency: every captureOutcome writes by composite id
//   `${predictionDocId}__h${horizonDays}`. A second invocation with the
//   same prediction + horizon overwrites the same doc atomically.
//   findCandidates() filters out doc states already TERMINAL, so the
//   job never re-processes a captured outcome.
//
// Cardsight quota: callers loop over candidates and pass each to
// captureOutcome; per-run cap is enforced at the JOB layer, not here.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import {
  getPricing,
  CardsightApiError,
  CardsightTimeoutError,
  type CardsightPricingResponse,
  type CardsightSaleRecord,
} from "../compiq/cardsight.client.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type OutcomeSource =
  | "cardsight_graded_window"
  | "cardsight_raw_window"
  | "no_sales_in_window"
  | "not_found"
  | "upstream_error";

export interface PredictionRow {
  id: string;
  cardsightCardId: string;
  timestamp: string;          // ISO
  joinable: boolean;
  gradeCompany: string | null;
  gradeValue: number | null;
}

export interface OutcomeDoc {
  id: string;
  predictionDocId: string;
  cardsightCardId: string;
  predictionTimestamp: string;
  horizonDays: number;
  windowStart: string;        // = predictionTimestamp
  windowEnd: string;          // = predictionTimestamp + horizonDays (FIXED)
  outcomeSource: OutcomeSource;
  realizedOutcomePrice: number | null;
  realizedOutcomeAggregation: "median" | null;
  nSalesInWindow: number;
  salesSample: Array<{ price: number; date: string }>;
  capturedAt: string;
  captureRunId: string;
  captureAttempt: number;
  engineVersion: string;
  schemaVersion: 1;
  docType: "prediction_outcome";
}

export interface CaptureResult {
  outcomeSource: OutcomeSource;
  terminal: boolean;
  nSalesInWindow: number;
  realizedOutcomePrice: number | null;
  captureAttempt: number;
  cardsightCallsUsed: number;   // 0 or 1
}

const UPSTREAM_ERROR_RETRY_CAP = 5;
const SALES_SAMPLE_CAP = 20;

function outcomeDocId(predictionDocId: string, horizonDays: number): string {
  return `${predictionDocId}__h${horizonDays}`;
}

// ─── Cosmos lazy init ───────────────────────────────────────────────────────

let _outcomesContainer: Container | null = null;
let _predictionLogContainer: Container | null = null;
let _initPromise: Promise<void> | null = null;
const isTestMode = process.env.NODE_ENV === "test";

// Test in-memory stores. Keyed for partition-aware reads.
const _testOutcomesByKey = new Map<string, OutcomeDoc>(); // key = `${partition}::${id}`
const _testPredictionLog: PredictionRow[] = [];

function testKey(id: string, partition: string): string {
  return `${partition}::${id}`;
}

export function _resetForTests(): void {
  _testOutcomesByKey.clear();
  _testPredictionLog.length = 0;
  _outcomesContainer = null;
  _predictionLogContainer = null;
  _initPromise = null;
}

/** Test-only: seed a prediction row that findCandidates will see. */
export function _seedPredictionForTests(row: PredictionRow): void {
  _testPredictionLog.push(row);
}

/** Test-only: peek a stored outcome by composite key. */
export async function _peekOutcomeForTests(
  predictionDocId: string,
  cardsightCardId: string,
  horizonDays: number,
): Promise<OutcomeDoc | null> {
  const id = outcomeDocId(predictionDocId, horizonDays);
  return _testOutcomesByKey.get(testKey(id, cardsightCardId)) ?? null;
}

async function ensureContainers(): Promise<{
  outcomes: Container | null;
  predictions: Container | null;
}> {
  if (isTestMode) return { outcomes: null, predictions: null };
  if (_outcomesContainer && _predictionLogContainer) {
    return { outcomes: _outcomesContainer, predictions: _predictionLogContainer };
  }
  if (!_initPromise) {
    _initPromise = (async () => {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const outcomesName =
        process.env.COSMOS_PREDICTION_OUTCOMES_CONTAINER ?? "prediction_outcomes";
      const predictionsName =
        process.env.COSMOS_PREDICTION_LOG_CONTAINER ?? "prediction_log";

      if (!endpoint && !connStr) {
        console.warn(
          "[predictionOutcomes] COSMOS not configured — captures are no-ops",
        );
        return;
      }
      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container: outcomes } = await database.containers.createIfNotExists({
        id: outcomesName,
        partitionKey: { paths: ["/cardsightCardId"] },
      });
      _outcomesContainer = outcomes;
      _predictionLogContainer = database.container(predictionsName);
      console.log(
        `[predictionOutcomes] Cosmos ready: outcomes=${outcomesName} predictions=${predictionsName}`,
      );
    })().catch((err) => {
      console.error("[predictionOutcomes] init failed:", err?.message ?? err);
    });
  }
  await _initPromise;
  return { outcomes: _outcomesContainer, predictions: _predictionLogContainer };
}

// ─── Storage primitives ─────────────────────────────────────────────────────

async function readExistingOutcome(
  predictionDocId: string,
  cardsightCardId: string,
  horizonDays: number,
): Promise<OutcomeDoc | null> {
  const id = outcomeDocId(predictionDocId, horizonDays);
  if (isTestMode) {
    return _testOutcomesByKey.get(testKey(id, cardsightCardId)) ?? null;
  }
  const { outcomes } = await ensureContainers();
  if (!outcomes) return null;
  try {
    const { resource } = await outcomes
      .item(id, cardsightCardId)
      .read<OutcomeDoc>();
    return resource ?? null;
  } catch {
    return null;
  }
}

async function upsertOutcome(doc: OutcomeDoc): Promise<void> {
  if (isTestMode) {
    _testOutcomesByKey.set(testKey(doc.id, doc.cardsightCardId), doc);
    return;
  }
  const { outcomes } = await ensureContainers();
  if (!outcomes) return;
  await outcomes.items.upsert(doc);
}

// ─── Pure helpers (filter, median, bucket selection) ────────────────────────

/**
 * Compute the fixed window end given a prediction's timestamp + horizon
 * in days. Window is half-open at the start (T, ...] so a sale RECORDED
 * exactly at T (extremely unlikely but possible) is excluded — that comp
 * would have been visible to the prediction at write time.
 */
export function computeWindowEnd(
  predictionTimestamp: string,
  horizonDays: number,
): string {
  const startMs = new Date(predictionTimestamp).getTime();
  const endMs = startMs + horizonDays * 86_400_000;
  return new Date(endMs).toISOString();
}

/**
 * Filter Cardsight sale records to those whose `date` is in
 * (windowStart, windowEnd]. Records with null date are excluded.
 */
export function filterRecordsToWindow(
  records: ReadonlyArray<CardsightSaleRecord>,
  windowStart: string,
  windowEnd: string,
): CardsightSaleRecord[] {
  return records.filter((r) => {
    if (r.date == null) return false;
    // ISO strings compare lexicographically the same as their dates.
    return r.date > windowStart && r.date <= windowEnd;
  });
}

/** Median of an array of numbers. Returns null on empty input. */
export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Normalize a grader company name for comparison: trim + lowercase.
 * Handles whitespace + case drift between the prediction's stored
 * gradeCompany and Cardsight's company_name.
 *   "PSA" / "psa" / " PSA " → "psa"
 *   null / "" / "   "        → null
 */
export function normalizeCompany(c: unknown): string | null {
  if (c == null) return null;
  const s = String(c).trim().toLowerCase();
  return s.length === 0 ? null : s;
}

/**
 * Normalize a grade value for comparison. Numeric values are coerced
 * through Number() so "10" / 10 / "10.0" / "10.00" all normalize to
 * "10", and "9.5" / 9.5 / "9.50" all normalize to "9.5". Non-numeric
 * grade strings (e.g. "10 OC", "Authentic", qualifier codes) fall back
 * to trimmed + lowercased string compare so qualifier variations stay
 * correctly distinct.
 */
export function normalizeGrade(g: unknown): string | null {
  if (g == null) return null;
  if (typeof g === "number" && Number.isFinite(g)) {
    return String(g);
  }
  if (typeof g === "string") {
    const trimmed = g.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    if (!Number.isNaN(n) && Number.isFinite(n)) {
      return String(n);
    }
    return trimmed.toLowerCase();
  }
  return null;
}

/**
 * Select the Cardsight records bucket for a prediction. Returns:
 *   - graded records when gradeCompany + gradeValue match a (company, grade)
 *     bucket in the response (after normalization on both axes)
 *   - raw records when no grade was specified
 *   - empty array when a graded match was requested but the bucket is
 *     absent (so the outcome lands as no_sales_in_window — distinct from
 *     not_found which is the whole card missing)
 *
 * CF-ML-MOAT-OUTCOMES-NORM (2026-06-03): normalization on BOTH sides
 * protects against silent terminal-no-sales writes from format drift.
 * The prediction_log row may carry gradeValue as number OR string at
 * runtime (Cosmos returns whatever was stored); Cardsight's typed
 * shape is string but real responses occasionally emit numeric. We
 * normalize through Number() so the comparison is mathematically
 * equivalent regardless of representation.
 */
export function selectBucket(
  pricing: CardsightPricingResponse,
  gradeCompany: string | null,
  gradeValue: number | string | null,
): { records: CardsightSaleRecord[]; bucket: "graded" | "raw" } {
  const targetCompany = normalizeCompany(gradeCompany);
  const targetGrade = normalizeGrade(gradeValue);
  // Graded path requires BOTH a company AND a grade to match — partial
  // matches (company without grade) fall through to "no records" rather
  // than promoting to raw, which would silently change the comp universe.
  if (targetCompany !== null && targetGrade !== null) {
    const company = (pricing.graded ?? []).find(
      (g) => normalizeCompany(g.company_name) === targetCompany,
    );
    if (!company) return { records: [], bucket: "graded" };
    const grade = (company.grades ?? []).find(
      (g) => normalizeGrade(g.grade_value) === targetGrade,
    );
    if (!grade) return { records: [], bucket: "graded" };
    return { records: grade.records ?? [], bucket: "graded" };
  }
  return { records: pricing.raw?.records ?? [], bucket: "raw" };
}

// ─── Public capture API ─────────────────────────────────────────────────────

/**
 * Capture (or retry) the outcome for a single prediction past its horizon.
 * Idempotent: if a TERMINAL outcome doc already exists for the
 * (predictionDocId, horizonDays) pair, this function is a no-op and
 * returns the stored result. Re-querying upstream_error docs is supported
 * up to UPSTREAM_ERROR_RETRY_CAP attempts before going terminal.
 *
 * Returns `cardsightCallsUsed` so the JOB layer can enforce per-run
 * quota caps without coupling the service to scheduling concerns.
 */
export async function captureOutcome(
  prediction: PredictionRow,
  opts: {
    horizonDays: number;
    runId: string;
    engineVersion: string;
    now?: Date; // injectable for tests
  },
): Promise<CaptureResult> {
  const now = opts.now ?? new Date();
  const existing = await readExistingOutcome(
    prediction.id,
    prediction.cardsightCardId,
    opts.horizonDays,
  );

  // Idempotency: TERMINAL doc → return its state as-is, no Cardsight call.
  if (existing && isTerminal(existing)) {
    return {
      outcomeSource: existing.outcomeSource,
      terminal: true,
      nSalesInWindow: existing.nSalesInWindow,
      realizedOutcomePrice: existing.realizedOutcomePrice,
      captureAttempt: existing.captureAttempt,
      cardsightCallsUsed: 0,
    };
  }

  const captureAttempt = (existing?.captureAttempt ?? 0) + 1;
  const windowStart = prediction.timestamp;
  const windowEnd = computeWindowEnd(prediction.timestamp, opts.horizonDays);

  // Cardsight call — wrapped in try/catch to map errors to upstream_error.
  let pricing: CardsightPricingResponse;
  let callsUsed = 1;
  try {
    pricing = await getPricing(prediction.cardsightCardId);
  } catch (err: unknown) {
    if (err instanceof CardsightTimeoutError || err instanceof CardsightApiError) {
      // Retryable unless we've hit the attempt cap.
      const terminal = captureAttempt >= UPSTREAM_ERROR_RETRY_CAP;
      const doc = buildOutcomeDoc({
        prediction,
        horizonDays: opts.horizonDays,
        windowStart,
        windowEnd,
        outcomeSource: "upstream_error",
        realizedOutcomePrice: null,
        nSalesInWindow: 0,
        salesSample: [],
        capturedAt: now.toISOString(),
        captureRunId: opts.runId,
        captureAttempt,
        engineVersion: opts.engineVersion,
      });
      await upsertOutcome(doc);
      return {
        outcomeSource: "upstream_error",
        terminal,
        nSalesInWindow: 0,
        realizedOutcomePrice: null,
        captureAttempt,
        cardsightCallsUsed: callsUsed,
      };
    }
    // Unknown error class — re-throw so the job can count it as a failure
    // but doesn't mistake it for a known-retryable upstream error.
    throw err;
  }

  if (pricing.notFound) {
    // Card aged out of Cardsight's catalog. TERMINAL.
    const doc = buildOutcomeDoc({
      prediction,
      horizonDays: opts.horizonDays,
      windowStart,
      windowEnd,
      outcomeSource: "not_found",
      realizedOutcomePrice: null,
      nSalesInWindow: 0,
      salesSample: [],
      capturedAt: now.toISOString(),
      captureRunId: opts.runId,
      captureAttempt,
      engineVersion: opts.engineVersion,
    });
    await upsertOutcome(doc);
    return {
      outcomeSource: "not_found",
      terminal: true,
      nSalesInWindow: 0,
      realizedOutcomePrice: null,
      captureAttempt,
      cardsightCallsUsed: callsUsed,
    };
  }

  // Select bucket + filter to window.
  const { records, bucket } = selectBucket(
    pricing,
    prediction.gradeCompany,
    prediction.gradeValue,
  );
  const inWindow = filterRecordsToWindow(records, windowStart, windowEnd);

  if (inWindow.length === 0) {
    // Real illiquidity signal. TERMINAL.
    const doc = buildOutcomeDoc({
      prediction,
      horizonDays: opts.horizonDays,
      windowStart,
      windowEnd,
      outcomeSource: "no_sales_in_window",
      realizedOutcomePrice: null,
      nSalesInWindow: 0,
      salesSample: [],
      capturedAt: now.toISOString(),
      captureRunId: opts.runId,
      captureAttempt,
      engineVersion: opts.engineVersion,
    });
    await upsertOutcome(doc);
    return {
      outcomeSource: "no_sales_in_window",
      terminal: true,
      nSalesInWindow: 0,
      realizedOutcomePrice: null,
      captureAttempt,
      cardsightCallsUsed: callsUsed,
    };
  }

  // Sales in window — compute median, write terminal success.
  const prices = inWindow.map((r) => r.price);
  const realized = median(prices);
  const sample = inWindow.slice(0, SALES_SAMPLE_CAP).map((r) => ({
    price: r.price,
    date: r.date!,  // filterRecordsToWindow guarantees non-null date
  }));
  const outcomeSource: OutcomeSource =
    bucket === "graded" ? "cardsight_graded_window" : "cardsight_raw_window";

  const doc = buildOutcomeDoc({
    prediction,
    horizonDays: opts.horizonDays,
    windowStart,
    windowEnd,
    outcomeSource,
    realizedOutcomePrice: realized,
    nSalesInWindow: inWindow.length,
    salesSample: sample,
    capturedAt: now.toISOString(),
    captureRunId: opts.runId,
    captureAttempt,
    engineVersion: opts.engineVersion,
  });
  await upsertOutcome(doc);
  return {
    outcomeSource,
    terminal: true,
    nSalesInWindow: inWindow.length,
    realizedOutcomePrice: realized,
    captureAttempt,
    cardsightCallsUsed: callsUsed,
  };
}

// ─── Candidate selection ────────────────────────────────────────────────────

/**
 * Find joinable predictions past the (horizonDays + ingestionBufferDays)
 * cutoff that DON'T already have a terminal outcome doc.
 *
 * Two-phase:
 *   1. Cross-partition query on prediction_log for time-matured rows.
 *   2. Per-candidate point-read on prediction_outcomes; skip terminal.
 *
 * The per-candidate read is fine at current single-user scale. At larger
 * scale the right optimization is a bulk-fetch of outcomes by partition,
 * but that's a Phase-N concern.
 */
export async function findCandidates(opts: {
  horizonDays: number;
  ingestionBufferDays: number;
  now?: Date;
}): Promise<PredictionRow[]> {
  const now = opts.now ?? new Date();
  const cutoffMs =
    now.getTime() - (opts.horizonDays + opts.ingestionBufferDays) * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let candidates: PredictionRow[];
  if (isTestMode) {
    candidates = _testPredictionLog.filter(
      (p) => p.joinable && p.timestamp <= cutoffIso,
    );
  } else {
    const { predictions } = await ensureContainers();
    if (!predictions) return [];
    const { resources } = await predictions.items
      .query<PredictionRow>({
        query:
          "SELECT c.id, c.cardsightCardId, c.timestamp, c.joinable, c.gradeCompany, c.gradeValue " +
          'FROM c WHERE c.joinable = true AND c.timestamp <= @cutoff ORDER BY c.timestamp ASC',
        parameters: [{ name: "@cutoff", value: cutoffIso }],
      })
      .fetchAll();
    candidates = resources;
  }

  // Filter out predictions that already have a TERMINAL outcome doc.
  const result: PredictionRow[] = [];
  for (const p of candidates) {
    const existing = await readExistingOutcome(
      p.id,
      p.cardsightCardId,
      opts.horizonDays,
    );
    if (existing && isTerminal(existing)) continue;
    result.push(p);
  }
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isTerminal(doc: OutcomeDoc): boolean {
  if (doc.outcomeSource !== "upstream_error") return true;
  // upstream_error: terminal only at the retry cap.
  return doc.captureAttempt >= UPSTREAM_ERROR_RETRY_CAP;
}

function buildOutcomeDoc(input: {
  prediction: PredictionRow;
  horizonDays: number;
  windowStart: string;
  windowEnd: string;
  outcomeSource: OutcomeSource;
  realizedOutcomePrice: number | null;
  nSalesInWindow: number;
  salesSample: Array<{ price: number; date: string }>;
  capturedAt: string;
  captureRunId: string;
  captureAttempt: number;
  engineVersion: string;
}): OutcomeDoc {
  return {
    id: outcomeDocId(input.prediction.id, input.horizonDays),
    predictionDocId: input.prediction.id,
    cardsightCardId: input.prediction.cardsightCardId,
    predictionTimestamp: input.prediction.timestamp,
    horizonDays: input.horizonDays,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    outcomeSource: input.outcomeSource,
    realizedOutcomePrice: input.realizedOutcomePrice,
    realizedOutcomeAggregation: input.realizedOutcomePrice !== null ? "median" : null,
    nSalesInWindow: input.nSalesInWindow,
    salesSample: input.salesSample,
    capturedAt: input.capturedAt,
    captureRunId: input.captureRunId,
    captureAttempt: input.captureAttempt,
    engineVersion: input.engineVersion,
    schemaVersion: 1,
    docType: "prediction_outcome",
  };
}
