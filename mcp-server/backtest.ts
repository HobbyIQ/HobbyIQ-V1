// Phase C — Prediction backtester.
//
// Reads predictions older than N days from `compiq_predictions`, looks up the
// actual sales that occurred in their 72h / 7d windows from the cached comp
// blob, computes per-prediction error + directional accuracy, and returns
// rolling MAE / MAPE / direction accuracy by bucket.
//
// This is the closed loop that lets us calibrate the confidence ceiling
// instead of guessing it.

import { CosmosClient, type Container } from "@azure/cosmos";
import type { CardComp, PriceResult } from "./pricing.js";
import { fetchPlayerComps } from "./compsLoader.js";
import { computeCompsAnalytics } from "./compsAnalytics.js";

const DB_NAME = process.env.COSMOS_DB ?? "hobbyiq";
const PRED_CONTAINER =
  process.env.COSMOS_PREDICTIONS_CONTAINER ?? "compiq_predictions";
const BACKTEST_CONTAINER =
  process.env.COSMOS_BACKTEST_CONTAINER ?? "compiq_backtest";

let predContainerP: Promise<Container | null> | null = null;
let backtestContainerP: Promise<Container | null> | null = null;

function getClient(): CosmosClient | null {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  if (conn) return new CosmosClient(conn);
  if (endpoint && key) return new CosmosClient({ endpoint, key });
  return null;
}

async function getPredContainer(): Promise<Container | null> {
  if (predContainerP) return predContainerP;
  predContainerP = (async () => {
    try {
      const c = getClient();
      if (!c) return null;
      const { database } = await c.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: PRED_CONTAINER,
        partitionKey: { paths: ["/player"] },
      });
      return container;
    } catch (err) {
      console.warn("[backtest] pred container init:", (err as Error).message);
      return null;
    }
  })();
  return predContainerP;
}

async function getBacktestContainer(): Promise<Container | null> {
  if (backtestContainerP) return backtestContainerP;
  backtestContainerP = (async () => {
    try {
      const c = getClient();
      if (!c) return null;
      const { database } = await c.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: BACKTEST_CONTAINER,
        partitionKey: { paths: ["/player"] },
      });
      return container;
    } catch (err) {
      console.warn("[backtest] backtest container init:", (err as Error).message);
      return null;
    }
  })();
  return backtestContainerP;
}

interface PredictionDoc {
  id: string;
  player: string;
  year: number;
  set: string;
  cardNumber: string;
  variant?: string;
  grade?: string;
  predicted72h: number;
  predicted7d: number;
  direction: string;
  confidence: number;
  compsCount: number;
  prediction?: PriceResult;
  timestamp: string;
  source: string;
}

export interface BacktestRow {
  id: string; // = "bt-" + predId
  predictionId: string;
  player: string;
  year: number;
  set: string;
  cardNumber: string;
  grade?: string;
  predictedAt: string;
  predicted72h: number;
  predicted7d: number;
  predictedDirection: string;
  confidence: number;
  // Actuals from comp window after prediction
  actualMedian72h: number | null;
  actualSamples72h: number;
  actualMedian7d: number | null;
  actualSamples7d: number;
  // Errors
  absError72h: number | null;
  absError7d: number | null;
  pctError72h: number | null;
  pctError7d: number | null;
  // Direction was correct?
  actualDirection7d: "rising" | "falling" | "stable" | "unknown";
  directionCorrect: boolean | null;
  scoredAt: string;
}

interface ScoreInput {
  predicted: number;
  actuals: number[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pctErr(predicted: number, actual: number): number {
  if (actual === 0) return 0;
  return ((predicted - actual) / actual) * 100;
}

function scoreActuals(
  predicted: number,
  actuals: number[]
): { median: number | null; abs: number | null; pct: number | null; n: number } {
  const med = median(actuals);
  if (med === null) return { median: null, abs: null, pct: null, n: 0 };
  return {
    median: med,
    abs: Math.abs(predicted - med),
    pct: pctErr(predicted, med),
    n: actuals.length,
  };
}

export interface BacktestSummary {
  scanned: number;
  scored: number;
  skipped_no_actuals: number;
  by_bucket: Record<
    string,
    {
      n: number;
      mae_72h: number | null;
      mape_72h: number | null;
      mae_7d: number | null;
      mape_7d: number | null;
      direction_accuracy_pct: number | null;
      avg_confidence: number;
    }
  >;
  errors: string[];
}

interface RunOpts {
  // Only score predictions older than this many days (so 7d window is closed)
  minAgeDays?: number;
  // Cap how many we score per run
  limit?: number;
  // Optional player filter
  player?: string;
}

/**
 * Score predictions: fetch unscored predictions older than minAgeDays,
 * look up actual comp medians in their 72h/7d windows, write a backtest row,
 * and return a rolling summary.
 */
export async function runBacktest(opts: RunOpts = {}): Promise<BacktestSummary> {
  const minAgeDays = opts.minAgeDays ?? 7;
  const limit = Math.min(opts.limit ?? 200, 1000);

  const summary: BacktestSummary = {
    scanned: 0,
    scored: 0,
    skipped_no_actuals: 0,
    by_bucket: {},
    errors: [],
  };

  const pred = await getPredContainer();
  const bt = await getBacktestContainer();
  if (!pred || !bt) {
    summary.errors.push("cosmos_unavailable");
    return summary;
  }

  const cutoff = new Date(Date.now() - minAgeDays * 86_400_000).toISOString();

  // Pull predictions that are old enough; we de-dupe by checking backtest existence per id.
  const queryParts = [
    "SELECT TOP @limit c.id, c.player, c.year, c[\"set\"] as setName, c.cardNumber, c.variant, c.grade, c.predicted72h, c.predicted7d, c.direction, c.confidence, c.compsCount, c[\"timestamp\"] as ts FROM c",
    "WHERE c[\"timestamp\"] <= @cutoff AND c.source = 'predict'",
  ];
  const params: { name: string; value: string | number }[] = [
    { name: "@limit", value: limit },
    { name: "@cutoff", value: cutoff },
  ];
  if (opts.player) {
    queryParts.push("AND c.player = @player");
    params.push({ name: "@player", value: opts.player });
  }
  queryParts.push("ORDER BY c[\"timestamp\"] DESC");

  const { resources: predictions } = await pred.items
    .query<PredictionDoc & { ts: string; setName?: string }>({ query: queryParts.join(" "), parameters: params })
    .fetchAll();

  summary.scanned = predictions.length;

  // MCP rewire Phase 1 — group by player+product so each cohort's fetch can be
  // narrowed by product once compsLoader is rewired (Phase 2) to call the new
  // backend `/api/compiq/comps-by-player` endpoint.
  //
  // CF-BACKTEST-COSMOS-GRADE-FLOW (2026-05-24) — grouping now also keys on
  // grade. Before this change, raw + PSA 10 predictions for the same
  // player+product shared a fetch, and the cached comps were reused across
  // grade variants → mixed-grade actuals, asymmetric scoring. Mirrors the
  // synthetic backtest's grade-aware grouping (scripts/backtest_signal_value.ts
  // groupCohort + groupKey at commit 73cae0d). Predictions without grade
  // collapse to "__raw__" so backward compatibility is preserved.
  //
  // Worst-case backtest impact per Q2 finding: 2-3× the prior fetch count
  // for players with predictions across multiple products. Phase 1 keeps the
  // blob-read shape (fetchPlayerComps(player) only), so the per-player
  // compsCache below collapses repeated player keys back to one blob fetch.
  // Phase 2 replaces the cache with one fetch per (player, product) cohort.
  const UNKNOWN_PRODUCT_FALLBACK = "__unknown_product__";
  type PredItem = PredictionDoc & { ts: string; setName?: string };
  const normalizeGradeKey = (g?: string): string => {
    const key = (g ?? "").trim().toLowerCase() || "raw";
    return key === "raw" ? "__raw__" : (g as string);
  };
  const byPlayerProductGrade = new Map<string, PredItem[]>();
  for (const p of predictions) {
    const product = p.setName ?? p.set ?? UNKNOWN_PRODUCT_FALLBACK;
    const normGrade = normalizeGradeKey(p.grade);
    const key = `${p.player}|${product}|${normGrade}`;
    const arr = byPlayerProductGrade.get(key) ?? [];
    arr.push(p);
    byPlayerProductGrade.set(key, arr);
  }

  const bucketRows = new Map<string, BacktestRow[]>();
  // Cache key matches the group key (player|product|grade), so each grade
  // variant gets its own grade-filtered comp set.
  const compsCacheByGroup = new Map<string, CardComp[]>();

  for (const [groupKey, preds] of byPlayerProductGrade.entries()) {
    const player = preds[0].player;
    const product = preds[0].setName ?? preds[0].set ?? UNKNOWN_PRODUCT_FALLBACK;
    // All preds in this group share the same normalized grade, so preds[0].grade
    // represents the whole group.
    const grade = preds[0].grade;
    let comps: CardComp[];
    try {
      const cached = compsCacheByGroup.get(groupKey);
      if (cached) {
        comps = cached;
      } else {
        // Pass the prediction's year so the backend can year-filter the
        // catalog search; preds in a group can span multiple years but
        // share player+product+grade, so we use the first pred's year as the
        // representative (good-enough for backtest scoring).
        const year = Number.isFinite(preds[0].year) ? preds[0].year : undefined;
        comps = await fetchPlayerComps(player, product, {
          cardYear: year,
          preferredGrade: grade,
        });
        compsCacheByGroup.set(groupKey, comps);
      }
    } catch (err) {
      summary.errors.push(`${groupKey}: ${(err as Error).message}`);
      continue;
    }

    for (const p of preds) {
      // Skip if already scored
      const existingId = `bt-${p.id}`;
      try {
        const { resource } = await bt.item(existingId, p.player).read();
        if (resource) continue;
      } catch {
        // not found — proceed
      }

      const predTime = new Date(p.ts).getTime();
      if (!Number.isFinite(predTime)) continue;

      const within = (postMs: number) =>
        comps
          .filter((c) => {
            const t = new Date(c.date).getTime();
            return Number.isFinite(t) && t >= predTime && t - predTime <= postMs;
          })
          .map((c) => c.price);

      const actuals72 = within(3 * 86_400_000);
      const actuals7d = within(7 * 86_400_000);

      const s72 = scoreActuals(p.predicted72h, actuals72);
      const s7d = scoreActuals(p.predicted7d, actuals7d);

      // Actual direction: compare actual_7d_median vs the comp baseline 30 days BEFORE prediction
      const baselineComps = comps
        .filter((c) => {
          const t = new Date(c.date).getTime();
          return (
            Number.isFinite(t) &&
            t < predTime &&
            predTime - t <= 30 * 86_400_000
          );
        })
        .map((c) => c.price);
      const baseline = median(baselineComps);

      let actualDir: BacktestRow["actualDirection7d"] = "unknown";
      if (s7d.median !== null && baseline !== null && baseline > 0) {
        const change = ((s7d.median - baseline) / baseline) * 100;
        if (change > 5) actualDir = "rising";
        else if (change < -5) actualDir = "falling";
        else actualDir = "stable";
      }
      const directionCorrect =
        actualDir === "unknown" ? null : actualDir === p.direction;

      if (s72.median === null && s7d.median === null) {
        summary.skipped_no_actuals += 1;
        continue;
      }

      const row: BacktestRow = {
        id: existingId,
        predictionId: p.id,
        player: p.player,
        year: p.year,
        set: p.setName ?? p.set,
        cardNumber: p.cardNumber,
        grade: p.grade,
        predictedAt: p.ts,
        predicted72h: p.predicted72h,
        predicted7d: p.predicted7d,
        predictedDirection: p.direction,
        confidence: p.confidence,
        actualMedian72h: s72.median,
        actualSamples72h: s72.n,
        actualMedian7d: s7d.median,
        actualSamples7d: s7d.n,
        absError72h: s72.abs,
        absError7d: s7d.abs,
        pctError72h: s72.pct === null ? null : Math.round(s72.pct * 10) / 10,
        pctError7d: s7d.pct === null ? null : Math.round(s7d.pct * 10) / 10,
        actualDirection7d: actualDir,
        directionCorrect,
        scoredAt: new Date().toISOString(),
      };

      try {
        await bt.items.upsert(row);
        summary.scored += 1;
      } catch (err) {
        summary.errors.push(`upsert ${row.id}: ${(err as Error).message}`);
        continue;
      }

      // Bucket: confidence band
      const band =
        p.confidence >= 80
          ? "conf_80_plus"
          : p.confidence >= 60
          ? "conf_60_79"
          : p.confidence >= 40
          ? "conf_40_59"
          : "conf_under_40";
      const arr = bucketRows.get(band) ?? [];
      arr.push(row);
      bucketRows.set(band, arr);
    }
  }

  for (const [bucket, rows] of bucketRows.entries()) {
    const ae72 = rows.map((r) => r.absError72h).filter((v): v is number => v !== null);
    const pe72 = rows.map((r) => r.pctError72h).filter((v): v is number => v !== null).map(Math.abs);
    const ae7d = rows.map((r) => r.absError7d).filter((v): v is number => v !== null);
    const pe7d = rows.map((r) => r.pctError7d).filter((v): v is number => v !== null).map(Math.abs);
    const dirRows = rows.filter((r) => r.directionCorrect !== null);
    const dirCorrect = dirRows.filter((r) => r.directionCorrect === true).length;
    const meanOrNull = (xs: number[]) =>
      xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;

    summary.by_bucket[bucket] = {
      n: rows.length,
      mae_72h: meanOrNull(ae72),
      mape_72h: meanOrNull(pe72),
      mae_7d: meanOrNull(ae7d),
      mape_7d: meanOrNull(pe7d),
      direction_accuracy_pct: dirRows.length
        ? Math.round((dirCorrect / dirRows.length) * 1000) / 10
        : null,
      avg_confidence:
        Math.round(
          (rows.reduce((a, r) => a + r.confidence, 0) / rows.length) * 10
        ) / 10,
    };
  }

  return summary;
}

/**
 * Read-only summary of all backtest rows already scored (no scoring side-effects).
 */
export async function backtestSummary(player?: string): Promise<BacktestSummary> {
  const summary: BacktestSummary = {
    scanned: 0,
    scored: 0,
    skipped_no_actuals: 0,
    by_bucket: {},
    errors: [],
  };
  const bt = await getBacktestContainer();
  if (!bt) {
    summary.errors.push("cosmos_unavailable");
    return summary;
  }

  const queryParts = ["SELECT * FROM c"];
  const params: { name: string; value: string }[] = [];
  if (player) {
    queryParts.push("WHERE c.player = @p");
    params.push({ name: "@p", value: player });
  }

  const { resources: rows } = await bt.items
    .query<BacktestRow>({ query: queryParts.join(" "), parameters: params })
    .fetchAll();

  summary.scanned = rows.length;
  summary.scored = rows.length;

  const buckets = new Map<string, BacktestRow[]>();
  for (const r of rows) {
    const band =
      r.confidence >= 80
        ? "conf_80_plus"
        : r.confidence >= 60
        ? "conf_60_79"
        : r.confidence >= 40
        ? "conf_40_59"
        : "conf_under_40";
    const arr = buckets.get(band) ?? [];
    arr.push(r);
    buckets.set(band, arr);
  }
  for (const [bucket, rs] of buckets.entries()) {
    const pe72 = rs
      .map((r) => r.pctError72h)
      .filter((v): v is number => v !== null)
      .map(Math.abs);
    const pe7d = rs
      .map((r) => r.pctError7d)
      .filter((v): v is number => v !== null)
      .map(Math.abs);
    const ae72 = rs.map((r) => r.absError72h).filter((v): v is number => v !== null);
    const ae7d = rs.map((r) => r.absError7d).filter((v): v is number => v !== null);
    const dirRows = rs.filter((r) => r.directionCorrect !== null);
    const dirCorrect = dirRows.filter((r) => r.directionCorrect === true).length;
    const meanOrNull = (xs: number[]) =>
      xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
    summary.by_bucket[bucket] = {
      n: rs.length,
      mae_72h: meanOrNull(ae72),
      mape_72h: meanOrNull(pe72),
      mae_7d: meanOrNull(ae7d),
      mape_7d: meanOrNull(pe7d),
      direction_accuracy_pct: dirRows.length
        ? Math.round((dirCorrect / dirRows.length) * 1000) / 10
        : null,
      avg_confidence:
        Math.round((rs.reduce((a, r) => a + r.confidence, 0) / rs.length) * 10) / 10,
    };
  }
  return summary;
}

// Suppress unused import warnings (kept for future analytics-vs-actual joins)
void computeCompsAnalytics;
