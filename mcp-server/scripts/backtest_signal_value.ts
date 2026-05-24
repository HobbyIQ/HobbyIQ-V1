// Synthetic backtest harness — signal-on vs signal-off MAPE delta.
//
// Design: docs/phase0/phase4b_backtest_design.md (commit b90aa4a) — §8 is the
// implementer checklist this script implements.
//
// Mechanic: per card in the cohort, run getPredictedPrice() twice — once with
// the live aggregator's signal payload, once with NEUTRAL_SIGNAL — against an
// IDENTICAL prediction-input comps window. Compare both predictions to the
// median price observed in a disjoint ground-truth window. Report paired
// MAPE delta, direction-accuracy delta, and Wilcoxon signed-rank p-value.
//
// Critical implementation point (design §8 Step 3):
//   - prediction-input window: [now - 60d, now - 14d]
//   - ground-truth window:     [now - 14d, now]
// Without this split, the prediction sees a copy of the answer in its input.
// The --self-test flag verifies the window logic before any real run.
//
// Usage:
//   npx tsx mcp-server/scripts/backtest_signal_value.ts --self-test
//   npx tsx mcp-server/scripts/backtest_signal_value.ts \
//     --cohort mcp-server/scripts/backtest_cohort_v1.json \
//     --output-json docs/phase0/backtest_runs/<ts>/results.json \
//     --output-md   docs/phase0/backtest_runs/<ts>/report.md \
//     [--limit N]   [--dry-run]   [--seed-anchor]
//
// Required env vars (when not --self-test / --dry-run):
//   AZURE_SIGNAL_FUNCTION_URL [+ KEY] — signal-on arm
//   AZURE_OPENAI_* or OPENAI_API_KEY  — both arms (OpenAI inference)
//   HOBBYIQ_BACKEND_URL               — for fetchPlayerComps()

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as assert from "node:assert/strict";

// Type-only imports — no runtime cost, no openai/cosmos pulled in for --self-test.
import type {
  Card,
  CardComp,
  SignalPayload,
  PriceResult,
} from "../pricing.js";

// Runtime imports (pricing.ts pulls openai/cosmos) are dynamic — see loadDeps().
// compsLoader.ts is INTENTIONALLY NOT imported: it doesn't forward grade params
// to the backend (sixth framing inversion of this arc — captured as a separate
// finding). The backtest uses fetchCompsForBacktest() below which calls the
// backend directly with gradeCompany + gradeValue so ground truth is
// grade-accurate.
type PricingModule = typeof import("../pricing.js");

let pricing: PricingModule | null = null;

async function loadDeps(): Promise<{ pricing: PricingModule }> {
  if (!pricing) pricing = await import("../pricing.js");
  return { pricing };
}

// ─── Grade parsing + backend fetcher (bypasses compsLoader's lossy path) ─────

interface ParsedGrade {
  gradeCompany?: string;
  gradeValue?: string;
}

// Convert cohort `grade` field ("raw" | "PSA 10" | "BGS 9.5" | ...) into the
// backend endpoint's gradeCompany + gradeValue query-param shape. The backend's
// translateResponse uses gradeCompany to dispatch raw vs graded paths and
// gradeValue to narrow within a graded company.
function parseGradeForBackend(grade?: string): ParsedGrade {
  if (!grade) return {};
  const trimmed = grade.trim();
  if (!trimmed) return {};
  const low = trimmed.toLowerCase();
  if (low === "raw" || low === "ungraded" || low === "none") return {};
  // Match "PSA 10" / "BGS 9.5" / "SGC 9" / "CGC 10" — company + numeric value
  const m = trimmed.match(/^([A-Za-z]+)\s+(\d+(?:\.\d+)?)$/);
  if (m) return { gradeCompany: m[1].toUpperCase(), gradeValue: m[2] };
  // Unknown format — log via the caller; default to raw path
  return {};
}

interface BackendCompsByPlayerResponse {
  player: string;
  product: string;
  cardYear?: number;
  cardIds: string[];
  comps: Array<{
    cardId: string;
    price: number;
    date: string;
    title: string;
    source: string;
  }>;
  cached: boolean;
  cacheAge?: number;
  warnings: string[];
}

// Direct backend fetcher with grade-filter pass-through. Returns the
// translated comps already filtered by gradeCompany/gradeValue server-side
// (see backend/src/services/compiq/cardsight.translator.ts §5.3 ADR).
// Each returned comp's `grade` field reflects the requested grade for
// downstream rendering — the underlying sales are server-filtered.
async function fetchCompsForBacktest(
  player: string,
  product: string,
  year: number | undefined,
  gradeLabel: string | undefined,
): Promise<CardComp[]> {
  const backendUrl =
    process.env.HOBBYIQ_BACKEND_URL?.trim() ??
    process.env.COMPIQ_BACKEND_URL?.trim() ??
    "";
  if (!backendUrl) {
    throw new Error("fetchCompsForBacktest: HOBBYIQ_BACKEND_URL not set");
  }
  const params = new URLSearchParams({
    playerName: player.trim(),
    product: product.trim(),
  });
  if (year != null && Number.isFinite(year)) params.set("cardYear", String(year));
  const parsed = parseGradeForBackend(gradeLabel);
  if (parsed.gradeCompany) params.set("gradeCompany", parsed.gradeCompany);
  if (parsed.gradeValue) params.set("gradeValue", parsed.gradeValue);

  const url = `${backendUrl.replace(/\/$/, "")}/api/compiq/comps-by-player?${params}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[fetchCompsForBacktest] HTTP ${res.status} for ${player}|${product}|${year}|grade=${gradeLabel ?? "raw"}`);
      return [];
    }
    const body = (await res.json()) as BackendCompsByPlayerResponse;
    if (!Array.isArray(body?.comps) || body.comps.length === 0) {
      console.warn(`[fetchCompsForBacktest] empty comps for ${player}|${product}|${year}|grade=${gradeLabel ?? "raw"} (cardIds=${body?.cardIds?.length ?? 0}, warnings=${JSON.stringify(body?.warnings ?? [])})`);
      return [];
    }
    return body.comps.map((c) => ({
      price: Number(c.price),
      date: c.date,
      grade: gradeLabel ?? "raw",
      source: c.source ?? "cardsight",
      title: c.title,
    }));
  } catch (err) {
    console.warn(`[fetchCompsForBacktest] failed for ${player}|${product}|${year}|grade=${gradeLabel ?? "raw"}: ${(err as Error).message}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface CohortEntry {
  playerName: string;
  year: number;
  set: string; // also used as `product` for fetchPlayerComps
  cardNumber: string;
  variant?: string;
  grade?: string;
  isRookie?: boolean;
  printRun?: number;
  jerseyNumber?: number;
  // If set, used as anchorPrice for the Card; otherwise auto-computed
  // from prediction-input window median.
  anchorPriceOverride?: number | null;
}

interface CohortFile {
  cohort_id: string;
  description?: string;
  cards: CohortEntry[];
}

interface PerCardResult {
  cardId: string;
  cohortIndex: number;
  playerName: string;
  year: number;
  set: string;
  cardNumber: string;
  grade?: string;
  variant?: string;

  // Window provenance
  asOfDate: string;
  prediction_input_window: { from: string; to: string; n: number };
  ground_truth_window: { from: string; to: string; n: number };
  actualMedian: number | null;
  actualMedian_source: string;
  inputMedian: number;

  // Arms
  signals_on:
    | {
        predicted_price_72h: number;
        predicted_price_7d: number;
        predicted_direction: string;
        confidence: number;
        key_drivers: string[];
        risk_flags: string[];
        signal_payload: SignalPayload;
      }
    | { error: string };
  signals_off:
    | {
        predicted_price_72h: number;
        predicted_price_7d: number;
        predicted_direction: string;
        confidence: number;
        key_drivers: string[];
        risk_flags: string[];
      }
    | { error: string };

  // Deltas (null if any arm or actual missing)
  deltas: {
    abs_error_on_72h: number | null;
    abs_error_off_72h: number | null;
    abs_error_on_7d: number | null;
    abs_error_off_7d: number | null;
    pct_error_on_72h: number | null;
    pct_error_off_72h: number | null;
    pct_error_on_7d: number | null;
    pct_error_off_7d: number | null;
    direction_correct_on: boolean | null;
    direction_correct_off: boolean | null;
    actual_direction: "rising" | "falling" | "stable" | "unknown";
  };

  signal_on_wins_72h: boolean | null;
  signal_on_wins_7d: boolean | null;
}

interface AggregateBucket {
  n: number;
  mape_on: number | null;
  mape_off: number | null;
  delta: number | null;
}

interface AggregateResult {
  run_id: string;
  cohort_id: string;
  asOfDate: string;
  prediction_input_window_days: { from_days_ago: number; to_days_ago: number };
  ground_truth_window_days: { from_days_ago: number; to_days_ago: number };
  cohort_size: number;
  scored_pairs: number;
  skipped: { no_actuals: number; prediction_failed: number };

  aggregate: {
    mape_on_72h: number | null;
    mape_off_72h: number | null;
    mape_delta_72h: number | null;
    mape_on_7d: number | null;
    mape_off_7d: number | null;
    mape_delta_7d: number | null;
    wilcoxon_pvalue_72h: number | null;
    wilcoxon_pvalue_7d: number | null;
    direction_acc_on: number | null;
    direction_acc_off: number | null;
    direction_acc_delta: number | null;
  };

  by_confidence_band: Record<string, AggregateBucket>;
  verdict_branch: VerdictBranch;
}

type VerdictBranch =
  | "signals_help_strong"            // delta > 2 pt, p < 0.05
  | "signals_help_marginal"          // delta 0.5-2 pt, p < 0.05
  | "signals_neutral"                // |delta| < 0.5 OR p >= 0.05
  | "signals_hurt"                   // delta < 0 (clearly)
  | "insufficient_data";             // n too small, no significance

// ─── Window math (PURE FUNCTIONS — exercised by --self-test) ─────────────────

const DAY_MS = 86_400_000;

// Window bounds for prediction-input: [asOf - 60d, asOf - 14d)
// Window bounds for ground-truth:      [asOf - 14d, asOf]
// Half-open on input-window upper bound so the 14d boundary belongs to one
// window only. Both bounds inclusive on outer edges per design.
const PREDICTION_INPUT_FROM_DAYS = 60;
const PREDICTION_INPUT_TO_DAYS = 14;   // upper bound exclusive
const GROUND_TRUTH_FROM_DAYS = 14;     // lower bound inclusive
const GROUND_TRUTH_TO_DAYS = 0;

function isInPredictionInputWindow(saleDate: Date, asOf: Date): boolean {
  const ms = asOf.getTime() - saleDate.getTime();
  if (ms < 0) return false; // future sale relative to asOf — exclude
  // STRICT on both ends so the 14d boundary belongs to ground-truth only,
  // and the 60d boundary belongs to neither (matches design §8 Step 3 intent
  // that windows are non-overlapping and 14d is the "ground truth begins" mark).
  return ms > PREDICTION_INPUT_TO_DAYS * DAY_MS &&
         ms < PREDICTION_INPUT_FROM_DAYS * DAY_MS;
}

function isInGroundTruthWindow(saleDate: Date, asOf: Date): boolean {
  const ms = asOf.getTime() - saleDate.getTime();
  if (ms < 0) return false; // future sale — exclude
  // Inclusive at both ends: [asOf - 14d, asOf]. The 14d boundary belongs HERE.
  return ms >= GROUND_TRUTH_TO_DAYS * DAY_MS &&
         ms <= GROUND_TRUTH_FROM_DAYS * DAY_MS;
}

function filterPredictionInputComps(comps: CardComp[], asOf: Date): CardComp[] {
  return comps.filter((c) => {
    const d = parseSaleDate(c.date);
    return d !== null && isInPredictionInputWindow(d, asOf);
  });
}

function filterGroundTruthComps(comps: CardComp[], asOf: Date): CardComp[] {
  return comps.filter((c) => {
    const d = parseSaleDate(c.date);
    return d !== null && isInGroundTruthWindow(d, asOf);
  });
}

function parseSaleDate(date: string | undefined): Date | null {
  if (!date || typeof date !== "string") return null;
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function median(xs: number[]): number | null {
  const filtered = xs.filter((v) => Number.isFinite(v));
  if (filtered.length === 0) return null;
  const sorted = [...filtered].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(xs: number[]): number | null {
  const filtered = xs.filter((v) => Number.isFinite(v));
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

// Wilcoxon signed-rank test with normal approximation (two-tailed).
// Pairs: array of (signal_on_error, signal_off_error). Tests H0: median
// difference is zero. Returns p-value, or null if n < 6 (test inappropriate).
function wilcoxonSignedRank(
  pairs: Array<{ on: number; off: number }>,
): { p: number; n_effective: number } | null {
  const diffs = pairs
    .map((p) => p.off - p.on) // positive = signal-on better
    .filter((d) => d !== 0); // discard ties
  const n = diffs.length;
  if (n < 6) return null;

  const ranked = diffs
    .map((d) => ({ abs: Math.abs(d), sign: Math.sign(d) }))
    .sort((a, b) => a.abs - b.abs);
  // Average ranks for ties
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && ranked[j + 1].abs === ranked[i].abs) j++;
    const avgRank = ((i + 1) + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let wPlus = 0;
  let wMinus = 0;
  for (let k = 0; k < n; k++) {
    if (ranked[k].sign > 0) wPlus += ranks[k];
    else wMinus += ranks[k];
  }
  const T = Math.min(wPlus, wMinus);
  const mu = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  if (sigma === 0) return { p: 1, n_effective: n };
  const z = (T - mu) / sigma;
  const p = 2 * standardNormalCdf(-Math.abs(z));
  return { p, n_effective: n };
}

// Standard normal CDF via Abramowitz-Stegun 7.1.26 approximation of erf.
function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  // |error| < 1.5e-7
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// ─── Self-tests (exercised by --self-test before any real run) ───────────────

async function runSelfTests(): Promise<void> {
  console.log("[self-test] temporal split — boundary cases");
  const asOf = new Date("2026-05-24T00:00:00Z");

  // Cases per design §8 Step 3 + spec Step 2 substep 3
  const cases: Array<{ label: string; date: string; expectInput: boolean; expectGT: boolean }> = [
    { label: "70d ago (before input window)",  date: "2026-03-15T00:00:00Z", expectInput: false, expectGT: false },
    { label: "60d ago (boundary, lower input)", date: "2026-03-25T00:00:00Z", expectInput: false, expectGT: false }, // exclusive at 60d
    { label: "59d ago (in input)",              date: "2026-03-26T00:00:00Z", expectInput: true,  expectGT: false },
    { label: "30d ago (in input)",              date: "2026-04-24T00:00:00Z", expectInput: true,  expectGT: false },
    { label: "14d ago (boundary, lower GT)",    date: "2026-05-10T00:00:00Z", expectInput: false, expectGT: true },  // exclusive at 14d for input, inclusive for GT
    { label: "13d ago (in GT)",                 date: "2026-05-11T00:00:00Z", expectInput: false, expectGT: true },
    { label: "1d ago (in GT)",                  date: "2026-05-23T00:00:00Z", expectInput: false, expectGT: true },
    { label: "0d (today, in GT)",               date: "2026-05-24T00:00:00Z", expectInput: false, expectGT: true },
    { label: "5d future (excluded)",            date: "2026-05-29T00:00:00Z", expectInput: false, expectGT: false },
  ];
  for (const tc of cases) {
    const d = new Date(tc.date);
    const inInput = isInPredictionInputWindow(d, asOf);
    const inGT = isInGroundTruthWindow(d, asOf);
    try {
      assert.equal(inInput, tc.expectInput, `${tc.label}: prediction-input membership`);
      assert.equal(inGT, tc.expectGT, `${tc.label}: ground-truth membership`);
      // Critical invariant: a comp cannot be in BOTH windows
      assert.ok(!(inInput && inGT), `${tc.label}: must not be in both windows`);
      console.log(`  ✓ ${tc.label} input=${inInput} gt=${inGT}`);
    } catch (err) {
      console.error(`  ✗ ${tc.label} expected input=${tc.expectInput} gt=${tc.expectGT}, got input=${inInput} gt=${inGT}`);
      throw err;
    }
  }

  // filterPredictionInputComps + filterGroundTruthComps: window isolation
  const mockComps: CardComp[] = [
    { price: 100, date: "2026-04-15T00:00:00Z", grade: "raw" }, // ~39d → input
    { price: 110, date: "2026-04-25T00:00:00Z", grade: "raw" }, // ~29d → input
    { price: 130, date: "2026-05-15T00:00:00Z", grade: "raw" }, // ~9d  → GT
    { price: 140, date: "2026-05-22T00:00:00Z", grade: "raw" }, // ~2d  → GT
    { price: 95,  date: "2026-02-01T00:00:00Z", grade: "raw" }, // ~112d → neither
  ];
  const input = filterPredictionInputComps(mockComps, asOf);
  const gt = filterGroundTruthComps(mockComps, asOf);
  assert.equal(input.length, 2, "prediction-input filter count");
  assert.equal(gt.length, 2, "ground-truth filter count");
  // Hard isolation: no overlap
  const inputDates = new Set(input.map((c) => c.date));
  for (const g of gt) {
    assert.ok(!inputDates.has(g.date), `comp ${g.date} leaked across windows`);
  }
  console.log("  ✓ window isolation (no comp in both windows)");

  // Stats sanity
  assert.equal(median([1, 2, 3, 4, 5]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);

  // Wilcoxon — small sample returns null
  assert.equal(wilcoxonSignedRank([{ on: 1, off: 2 }]), null);
  // Strong effect → small p
  const strongEffect = Array.from({ length: 20 }, (_, i) => ({ on: 1, off: 5 + i * 0.1 }));
  const wilcoxResult = wilcoxonSignedRank(strongEffect);
  assert.ok(wilcoxResult && wilcoxResult.p < 0.01, "Wilcoxon should detect strong effect");
  console.log(`  ✓ Wilcoxon strong-effect test: p=${wilcoxResult!.p.toFixed(6)} n=${wilcoxResult!.n_effective}`);

  console.log("\n[self-test] ALL PASSED ✓");
}

// ─── Cohort + comp fetch ─────────────────────────────────────────────────────

interface CohortGroup {
  player: string;
  product: string;
  year: number;
  // Grade label included so each grade variant fetches its own grade-filtered
  // comps from the backend. Without this, ground-truth medians mix raw + PSA
  // sales (e.g., raw card's "actual" = PSA 10 median).
  grade?: string;
  members: Array<{ entry: CohortEntry; index: number }>;
}

function groupCohort(cohort: CohortEntry[]): CohortGroup[] {
  const map = new Map<string, CohortGroup>();
  cohort.forEach((entry, index) => {
    // Normalize grade for grouping: undefined / "" / "raw" all collapse to
    // "__raw__" so they share a fetch. Graded variants ("PSA 10") get their
    // own key.
    const gradeKey = (entry.grade ?? "").trim().toLowerCase() || "raw";
    const normGrade = gradeKey === "raw" ? "__raw__" : entry.grade;
    const key = `${entry.playerName}|${entry.set}|${entry.year}|${normGrade}`;
    if (!map.has(key)) {
      map.set(key, {
        player: entry.playerName,
        product: entry.set,
        year: entry.year,
        grade: entry.grade,
        members: [],
      });
    }
    map.get(key)!.members.push({ entry, index });
  });
  return Array.from(map.values());
}

// ─── Per-card prediction pair ────────────────────────────────────────────────

interface PredictionArmResult {
  ok: boolean;
  result?: PriceResult;
  signalPayload?: SignalPayload; // populated only for signal-on arm
  error?: string;
}

async function runSignalOnArm(card: Card): Promise<PredictionArmResult> {
  // Fetch signals ONCE up front, pass the captured payload as override so
  // signal-on and signal-off arms agree on which payload counts as "on."
  const { pricing: p } = await loadDeps();
  try {
    const signals = await p.fetchSignals(card.playerName);
    const result = await p.getPredictedPrice(card, { signalsOverride: signals });
    return { ok: true, result, signalPayload: signals };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function runSignalOffArm(card: Card): Promise<PredictionArmResult> {
  const { pricing: p } = await loadDeps();
  try {
    const result = await p.getPredictedPrice(card, { signalsOverride: p.NEUTRAL_SIGNAL });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function inferActualDirection(
  actualMedian: number,
  inputMedian: number,
): "rising" | "falling" | "stable" {
  if (inputMedian <= 0) return "stable";
  const change = (actualMedian - inputMedian) / inputMedian;
  if (change > 0.05) return "rising";
  if (change < -0.05) return "falling";
  return "stable";
}

function abs(n: number): number { return Math.abs(n); }
function pctErr(predicted: number, actual: number): number {
  if (actual === 0) return 0;
  return Math.abs((predicted - actual) / actual) * 100;
}

function cardIdentity(c: CohortEntry): string {
  return `${c.playerName}|${c.year}|${c.set}|${c.cardNumber}|${c.grade ?? "raw"}|${c.variant ?? "base"}`;
}

function confidenceBand(confidence: number): string {
  if (confidence >= 80) return "conf_80_plus";
  if (confidence >= 60) return "conf_60_79";
  if (confidence >= 40) return "conf_40_59";
  return "conf_under_40";
}

// ─── Aggregate + interpret ───────────────────────────────────────────────────

function aggregate(
  perCard: PerCardResult[],
  runId: string,
  cohortId: string,
  asOf: Date,
): AggregateResult {
  // Build paired arrays for stats (only cards where BOTH arms succeeded AND actual is present)
  const pairs72: Array<{ on: number; off: number; band: string; confidence: number }> = [];
  const pairs7d: Array<{ on: number; off: number; band: string; confidence: number }> = [];
  const dirOn: boolean[] = [];
  const dirOff: boolean[] = [];

  for (const p of perCard) {
    const on = "predicted_price_72h" in p.signals_on ? p.signals_on : null;
    const off = "predicted_price_72h" in p.signals_off ? p.signals_off : null;
    if (!on || !off || p.actualMedian === null) continue;
    const band = confidenceBand(on.confidence);
    pairs72.push({
      on: pctErr(on.predicted_price_72h, p.actualMedian),
      off: pctErr(off.predicted_price_72h, p.actualMedian),
      band,
      confidence: on.confidence,
    });
    pairs7d.push({
      on: pctErr(on.predicted_price_7d, p.actualMedian),
      off: pctErr(off.predicted_price_7d, p.actualMedian),
      band,
      confidence: on.confidence,
    });
    if (p.deltas.direction_correct_on !== null) dirOn.push(p.deltas.direction_correct_on);
    if (p.deltas.direction_correct_off !== null) dirOff.push(p.deltas.direction_correct_off);
  }

  const mape_on_72h = mean(pairs72.map((p) => p.on));
  const mape_off_72h = mean(pairs72.map((p) => p.off));
  const mape_delta_72h =
    mape_on_72h !== null && mape_off_72h !== null ? mape_off_72h - mape_on_72h : null;
  const mape_on_7d = mean(pairs7d.map((p) => p.on));
  const mape_off_7d = mean(pairs7d.map((p) => p.off));
  const mape_delta_7d =
    mape_on_7d !== null && mape_off_7d !== null ? mape_off_7d - mape_on_7d : null;

  const w72 = wilcoxonSignedRank(pairs72.map((p) => ({ on: p.on, off: p.off })));
  const w7d = wilcoxonSignedRank(pairs7d.map((p) => ({ on: p.on, off: p.off })));

  const dir_on_acc = dirOn.length ? (dirOn.filter(Boolean).length / dirOn.length) * 100 : null;
  const dir_off_acc = dirOff.length ? (dirOff.filter(Boolean).length / dirOff.length) * 100 : null;
  const dir_delta = dir_on_acc !== null && dir_off_acc !== null ? dir_on_acc - dir_off_acc : null;

  // By confidence band
  const by_band: Record<string, AggregateBucket> = {};
  const allBands = ["conf_80_plus", "conf_60_79", "conf_40_59", "conf_under_40"];
  for (const b of allBands) {
    const rows = pairs7d.filter((p) => p.band === b);
    const mOn = mean(rows.map((r) => r.on));
    const mOff = mean(rows.map((r) => r.off));
    by_band[b] = {
      n: rows.length,
      mape_on: mOn,
      mape_off: mOff,
      delta: mOn !== null && mOff !== null ? mOff - mOn : null,
    };
  }

  // Verdict branch per design §8 Step 8 — uses 7d delta as primary, 72h as secondary.
  // Insufficient_data fires before "neutral" when n < 20 OR wilcoxon returned null.
  let verdict_branch: VerdictBranch;
  const n = pairs7d.length;
  const delta = mape_delta_7d;
  const p_value = w7d?.p ?? null;
  if (n < 20 || p_value === null) {
    verdict_branch = "insufficient_data";
  } else if (delta === null) {
    verdict_branch = "insufficient_data";
  } else if (delta < 0) {
    // Signal-OFF MAPE < signal-ON MAPE means signal-OFF is BETTER, so signals HURT.
    verdict_branch = p_value < 0.05 ? "signals_hurt" : "signals_neutral";
  } else if (delta > 2 && p_value < 0.05) {
    verdict_branch = "signals_help_strong";
  } else if (delta >= 0.5 && p_value < 0.05) {
    verdict_branch = "signals_help_marginal";
  } else {
    verdict_branch = "signals_neutral";
  }

  const scoredPairs = pairs7d.length;
  const skipNoActuals = perCard.filter((p) => p.actualMedian === null).length;
  const skipFailed = perCard.filter(
    (p) => "error" in p.signals_on || "error" in p.signals_off,
  ).length;

  return {
    run_id: runId,
    cohort_id: cohortId,
    asOfDate: asOf.toISOString(),
    prediction_input_window_days: {
      from_days_ago: PREDICTION_INPUT_FROM_DAYS,
      to_days_ago: PREDICTION_INPUT_TO_DAYS,
    },
    ground_truth_window_days: {
      from_days_ago: GROUND_TRUTH_FROM_DAYS,
      to_days_ago: GROUND_TRUTH_TO_DAYS,
    },
    cohort_size: perCard.length,
    scored_pairs: scoredPairs,
    skipped: { no_actuals: skipNoActuals, prediction_failed: skipFailed },
    aggregate: {
      mape_on_72h: round2(mape_on_72h),
      mape_off_72h: round2(mape_off_72h),
      mape_delta_72h: round2(mape_delta_72h),
      mape_on_7d: round2(mape_on_7d),
      mape_off_7d: round2(mape_off_7d),
      mape_delta_7d: round2(mape_delta_7d),
      wilcoxon_pvalue_72h: w72 ? round6(w72.p) : null,
      wilcoxon_pvalue_7d: w7d ? round6(w7d.p) : null,
      direction_acc_on: round2(dir_on_acc),
      direction_acc_off: round2(dir_off_acc),
      direction_acc_delta: round2(dir_delta),
    },
    by_confidence_band: by_band,
    verdict_branch,
  };
}

function round2(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ─── Output writers ──────────────────────────────────────────────────────────

function verdictNarrative(v: VerdictBranch, agg: AggregateResult["aggregate"]): {
  headline: string;
  next_workstream: string;
} {
  const d72 = agg.mape_delta_72h ?? 0;
  const d7d = agg.mape_delta_7d ?? 0;
  const p7d = agg.wilcoxon_pvalue_7d;
  const pStr = p7d === null ? "n/a" : p7d.toFixed(4);
  switch (v) {
    case "signals_help_strong":
      return {
        headline: `Signals materially help — MAPE delta 72h=${d72}pt 7d=${d7d}pt at p=${pStr}.`,
        next_workstream: "CF-SIGNAL-CREDENTIAL-REPAIR justified. Prioritize highest-weighted degraded signal (ebay 0.20).",
      };
    case "signals_help_marginal":
      return {
        headline: `Signals marginally help — MAPE delta 72h=${d72}pt 7d=${d7d}pt at p=${pStr}.`,
        next_workstream: "Per-signal attribution (iteration 2 partial-arm runs) before committing to broad credential repair.",
      };
    case "signals_neutral":
      return {
        headline: `Signals don't move the needle — MAPE delta 72h=${d72}pt 7d=${d7d}pt at p=${pStr}.`,
        next_workstream: "CF-PHASE4B-PROMPT-AUDIT: is OpenAI ignoring the signal context? Investigate prompt-rendering before further signal work.",
      };
    case "signals_hurt":
      return {
        headline: `Signals HURT accuracy — MAPE delta 72h=${d72}pt 7d=${d7d}pt at p=${pStr}.`,
        next_workstream: "CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS: which signal(s) contribute negatively? HALT CF-SIGNAL-CREDENTIAL-REPAIR.",
      };
    case "insufficient_data":
      return {
        headline: `Insufficient data — n=${agg.mape_on_7d !== null ? "?" : "0"} scored, p=${pStr}.`,
        next_workstream: "Expand cohort and re-run. If still insufficient, investigate cardsight comp coverage in ground-truth window.",
      };
  }
}

async function writeJsonOutput(
  outputPath: string,
  aggregate: AggregateResult,
  perCard: PerCardResult[],
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const payload = { aggregate, per_card: perCard };
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
}

async function writeMarkdownOutput(
  outputPath: string,
  aggregate: AggregateResult,
  perCard: PerCardResult[],
): Promise<void> {
  const a = aggregate.aggregate;
  const v = verdictNarrative(aggregate.verdict_branch, a);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const topWins = [...perCard]
    .filter((p) => p.signal_on_wins_7d === true)
    .sort((a, b) => {
      const da = (a.deltas.abs_error_off_7d ?? 0) - (a.deltas.abs_error_on_7d ?? 0);
      const db = (b.deltas.abs_error_off_7d ?? 0) - (b.deltas.abs_error_on_7d ?? 0);
      return db - da;
    })
    .slice(0, 5);
  const topLosses = [...perCard]
    .filter((p) => p.signal_on_wins_7d === false)
    .sort((a, b) => {
      const da = (a.deltas.abs_error_on_7d ?? 0) - (a.deltas.abs_error_off_7d ?? 0);
      const db = (b.deltas.abs_error_on_7d ?? 0) - (b.deltas.abs_error_off_7d ?? 0);
      return db - da;
    })
    .slice(0, 5);

  const fmt = (n: number | null) => (n === null ? "—" : String(n));
  const lines: string[] = [];
  lines.push(`# Backtest run — ${aggregate.run_id}`);
  lines.push("");
  lines.push(`**Cohort:** ${aggregate.cohort_id} | **N=${aggregate.cohort_size}, scored=${aggregate.scored_pairs}**`);
  lines.push(`**As-of date:** ${aggregate.asOfDate}`);
  lines.push(`**Windows:** prediction-input [now-${PREDICTION_INPUT_FROM_DAYS}d, now-${PREDICTION_INPUT_TO_DAYS}d) | ground-truth [now-${GROUND_TRUTH_FROM_DAYS}d, now]`);
  lines.push(`**Skipped:** ${aggregate.skipped.no_actuals} no-actuals, ${aggregate.skipped.prediction_failed} prediction-failed`);
  lines.push("");
  lines.push(`## Verdict — \`${aggregate.verdict_branch}\``);
  lines.push("");
  lines.push(`> ${v.headline}`);
  lines.push("");
  lines.push(`**Next workstream:** ${v.next_workstream}`);
  lines.push("");
  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | 72h | 7d |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| MAPE signal-on | ${fmt(a.mape_on_72h)} | ${fmt(a.mape_on_7d)} |`);
  lines.push(`| MAPE signal-off | ${fmt(a.mape_off_72h)} | ${fmt(a.mape_off_7d)} |`);
  lines.push(`| **MAPE delta** (off - on) | **${fmt(a.mape_delta_72h)}** | **${fmt(a.mape_delta_7d)}** |`);
  lines.push(`| Wilcoxon p-value | ${fmt(a.wilcoxon_pvalue_72h)} | ${fmt(a.wilcoxon_pvalue_7d)} |`);
  lines.push("");
  lines.push(`| Direction accuracy | signal-on | signal-off | delta (on - off) |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| 7d direction acc % | ${fmt(a.direction_acc_on)} | ${fmt(a.direction_acc_off)} | ${fmt(a.direction_acc_delta)} |`);
  lines.push("");
  lines.push(`## By confidence band (7d)`);
  lines.push("");
  lines.push(`| Band | n | MAPE on | MAPE off | delta |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const [band, bucket] of Object.entries(aggregate.by_confidence_band)) {
    lines.push(`| ${band} | ${bucket.n} | ${fmt(bucket.mape_on)} | ${fmt(bucket.mape_off)} | ${fmt(bucket.delta)} |`);
  }
  lines.push("");
  if (topWins.length > 0) {
    lines.push(`## Top 5 cards where signals helped most (7d)`);
    lines.push("");
    lines.push(`| Card | actual | on err% | off err% | delta abs |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const c of topWins) {
      lines.push(`| ${c.cardId} | ${fmt(c.actualMedian)} | ${fmt(c.deltas.pct_error_on_7d)} | ${fmt(c.deltas.pct_error_off_7d)} | ${fmt(round2((c.deltas.abs_error_off_7d ?? 0) - (c.deltas.abs_error_on_7d ?? 0)))} |`);
    }
    lines.push("");
  }
  if (topLosses.length > 0) {
    lines.push(`## Top 5 cards where signals hurt most (7d)`);
    lines.push("");
    lines.push(`| Card | actual | on err% | off err% | delta abs |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const c of topLosses) {
      lines.push(`| ${c.cardId} | ${fmt(c.actualMedian)} | ${fmt(c.deltas.pct_error_on_7d)} | ${fmt(c.deltas.pct_error_off_7d)} | ${fmt(round2((c.deltas.abs_error_on_7d ?? 0) - (c.deltas.abs_error_off_7d ?? 0)))} |`);
    }
    lines.push("");
  }
  lines.push(`## What this measurement does NOT prove`);
  lines.push("");
  lines.push(`- Does not isolate per-signal contribution (iteration 2 partial-arm runs would).`);
  lines.push(`- May include retrospective leakage (signal payload references catalysts that already moved ground-truth comps — design §3.6).`);
  lines.push(`- OpenAI nondeterminism: a single run reflects one sample of the prediction distribution. Re-run with \`--repeats\` to reduce noise.`);
  lines.push(`- Synthetic backtest treats observed sales as ground truth; cohort selection bias (Cardsight-trackable cards) is documented in design §10.5.`);
  lines.push("");

  await fs.writeFile(outputPath, lines.join("\n"), "utf8");
}

// ─── Multi-run summary (--repeats N) ────────────────────────────────────────

interface PerCardConsistency {
  cardId: string;
  runs_scored: number;
  signal_on_wins_7d_rate: number | null; // 0..1 (fraction of runs signal-on closer)
  direction_correct_on_rate: number | null;
  direction_correct_off_rate: number | null;
  mean_pct_error_on_7d: number | null;
  mean_pct_error_off_7d: number | null;
  stable_arm_winner_7d: "on" | "off" | "mixed" | "no_actuals";
}

interface MultiRunSummary {
  run_id: string;
  cohort_id: string;
  repeats: number;
  cohort_size: number;
  prediction_input_window_days: AggregateResult["prediction_input_window_days"];
  ground_truth_window_days: AggregateResult["ground_truth_window_days"];
  per_run: Array<{
    run_index: number;
    run_id: string;
    scored_pairs: number;
    mape_delta_72h: number | null;
    mape_delta_7d: number | null;
    direction_acc_delta: number | null;
    wilcoxon_pvalue_7d: number | null;
    verdict_branch: VerdictBranch;
  }>;
  cross_run_stats: {
    mape_delta_72h_mean: number | null;
    mape_delta_72h_stdev: number | null;
    mape_delta_72h_sign_stability: number | null; // fraction of runs matching mean sign
    mape_delta_7d_mean: number | null;
    mape_delta_7d_stdev: number | null;
    mape_delta_7d_sign_stability: number | null;
    direction_acc_delta_mean: number | null;
    direction_acc_delta_stdev: number | null;
  };
  per_card_consistency: PerCardConsistency[];
  multi_run_verdict:
    | "stable_signals_help"      // sign stable + delta > 0.5pt
    | "stable_signals_hurt"      // sign stable + delta < -0.5pt
    | "stable_neutral"           // sign stable + |delta| < 0.5pt
    | "unstable_high_variance"   // sign unstable across runs — noise dominates
    | "insufficient_data";       // too few scored pairs
  next_workstream_recommendation: string;
}

function stdev(xs: number[]): number | null {
  const filtered = xs.filter((v) => Number.isFinite(v));
  if (filtered.length < 2) return null;
  const m = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  const variance = filtered.reduce((a, b) => a + (b - m) * (b - m), 0) / (filtered.length - 1);
  return Math.sqrt(variance);
}

function signStability(values: Array<number | null>, mean: number | null): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0 || mean === null || mean === 0) return null;
  const meanSign = Math.sign(mean);
  const matching = v.filter((x) => Math.sign(x) === meanSign).length;
  return matching / v.length;
}

function computeMultiRunSummary(
  perRunResults: PerCardResult[][],
  perRunAggregates: AggregateResult[],
  runId: string,
  cohortId: string,
  repeats: number,
): MultiRunSummary {
  const cohortSize = perRunResults[0]?.length ?? 0;
  // Per-run summary records
  const per_run = perRunAggregates.map((a, i) => ({
    run_index: i + 1,
    run_id: a.run_id,
    scored_pairs: a.scored_pairs,
    mape_delta_72h: a.aggregate.mape_delta_72h,
    mape_delta_7d: a.aggregate.mape_delta_7d,
    direction_acc_delta: a.aggregate.direction_acc_delta,
    wilcoxon_pvalue_7d: a.aggregate.wilcoxon_pvalue_7d,
    verdict_branch: a.verdict_branch,
  }));

  // Cross-run stats over the per-run deltas
  const d72 = per_run.map((r) => r.mape_delta_72h);
  const d7d = per_run.map((r) => r.mape_delta_7d);
  const dDir = per_run.map((r) => r.direction_acc_delta);
  const d72clean = d72.filter((v): v is number => v !== null);
  const d7dclean = d7d.filter((v): v is number => v !== null);
  const dDirclean = dDir.filter((v): v is number => v !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const m72 = mean(d72clean);
  const m7d = mean(d7dclean);
  const mDir = mean(dDirclean);

  const cross_run_stats = {
    mape_delta_72h_mean: round2(m72),
    mape_delta_72h_stdev: round2(stdev(d72clean)),
    mape_delta_72h_sign_stability: round2(signStability(d72, m72)),
    mape_delta_7d_mean: round2(m7d),
    mape_delta_7d_stdev: round2(stdev(d7dclean)),
    mape_delta_7d_sign_stability: round2(signStability(d7d, m7d)),
    direction_acc_delta_mean: round2(mDir),
    direction_acc_delta_stdev: round2(stdev(dDirclean)),
  };

  // Per-card consistency: walk perRunResults grouped by cardId
  const byCard = new Map<string, PerCardResult[]>();
  for (const runResults of perRunResults) {
    for (const r of runResults) {
      const arr = byCard.get(r.cardId) ?? [];
      arr.push(r);
      byCard.set(r.cardId, arr);
    }
  }
  const per_card_consistency: PerCardConsistency[] = [];
  for (const [cardId, runs] of byCard.entries()) {
    const wins = runs
      .map((r) => r.signal_on_wins_7d)
      .filter((v): v is boolean => v !== null);
    const dirOn = runs
      .map((r) => r.deltas.direction_correct_on)
      .filter((v): v is boolean => v !== null);
    const dirOff = runs
      .map((r) => r.deltas.direction_correct_off)
      .filter((v): v is boolean => v !== null);
    const pctOn = runs
      .map((r) => r.deltas.pct_error_on_7d)
      .filter((v): v is number => v !== null);
    const pctOff = runs
      .map((r) => r.deltas.pct_error_off_7d)
      .filter((v): v is number => v !== null);
    const onWinRate = wins.length ? wins.filter(Boolean).length / wins.length : null;
    let stableWinner: PerCardConsistency["stable_arm_winner_7d"] = "no_actuals";
    if (wins.length === 0) stableWinner = "no_actuals";
    else if (onWinRate !== null && onWinRate >= 0.7) stableWinner = "on";
    else if (onWinRate !== null && onWinRate <= 0.3) stableWinner = "off";
    else stableWinner = "mixed";
    per_card_consistency.push({
      cardId,
      runs_scored: wins.length,
      signal_on_wins_7d_rate: onWinRate === null ? null : round2(onWinRate),
      direction_correct_on_rate: dirOn.length ? round2(dirOn.filter(Boolean).length / dirOn.length) : null,
      direction_correct_off_rate: dirOff.length ? round2(dirOff.filter(Boolean).length / dirOff.length) : null,
      mean_pct_error_on_7d: pctOn.length ? round2(pctOn.reduce((a, b) => a + b, 0) / pctOn.length) : null,
      mean_pct_error_off_7d: pctOff.length ? round2(pctOff.reduce((a, b) => a + b, 0) / pctOff.length) : null,
      stable_arm_winner_7d: stableWinner,
    });
  }

  // Verdict
  const stability = cross_run_stats.mape_delta_7d_sign_stability;
  const delta = cross_run_stats.mape_delta_7d_mean;
  const meanScored = per_run.length ? per_run.reduce((a, r) => a + r.scored_pairs, 0) / per_run.length : 0;
  let verdict: MultiRunSummary["multi_run_verdict"];
  let recommendation: string;
  if (meanScored < 6) {
    verdict = "insufficient_data";
    recommendation = "Too few scored pairs even with repeats. Investigate cardsight comp coverage in ground-truth window before expanding cohort.";
  } else if (stability === null || stability < 0.7) {
    verdict = "unstable_high_variance";
    recommendation =
      "Aggregate signs flip across runs → OpenAI nondeterminism dominates at this N. " +
      "Recommended next: CF-BACKTEST-DETERMINISTIC (lock temperature=0 + seed) " +
      "rather than CF-PHASE4B-BACKTEST.2 (N=100 expansion — would just multiply the noise).";
  } else if (delta === null) {
    verdict = "insufficient_data";
    recommendation = "Aggregate delta unavailable; check per-run aggregates for errors.";
  } else if (Math.abs(delta) < 0.5) {
    verdict = "stable_neutral";
    recommendation =
      "Stable result: signals neither help nor hurt meaningfully. " +
      "Recommended next: CF-PHASE4B-PROMPT-AUDIT — investigate whether OpenAI is using signal context at all.";
  } else if (delta < 0) {
    verdict = "stable_signals_hurt";
    recommendation =
      "Stable result: signals consistently HURT accuracy across runs. " +
      "Recommended next: CF-PHASE4B-SIGNAL-HARM-DIAGNOSIS — investigate which signals contribute negatively.";
  } else {
    // delta > 0.5
    verdict = "stable_signals_help";
    recommendation =
      delta > 2
        ? "Stable result: signals materially help (>2pt MAPE delta). Recommended next: CF-PHASE4B-SIGNAL-REPAIR — credential acquisition for 4 degraded signals."
        : "Stable result: signals marginally help (0.5-2pt MAPE delta). Recommended next: CF-PHASE4B-PER-SIGNAL-ATTRIBUTION — figure out which signals contribute.";
  }

  return {
    run_id: runId,
    cohort_id: cohortId,
    repeats,
    cohort_size: cohortSize,
    prediction_input_window_days: perRunAggregates[0]?.prediction_input_window_days ?? { from_days_ago: 60, to_days_ago: 14 },
    ground_truth_window_days: perRunAggregates[0]?.ground_truth_window_days ?? { from_days_ago: 14, to_days_ago: 0 },
    per_run,
    cross_run_stats,
    per_card_consistency,
    multi_run_verdict: verdict,
    next_workstream_recommendation: recommendation,
  };
}

async function writeMultiRunMarkdown(
  outputPath: string,
  m: MultiRunSummary,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const fmt = (n: number | null) => (n === null ? "—" : String(n));
  const lines: string[] = [];
  lines.push(`# Multi-run backtest — ${m.run_id} (--repeats=${m.repeats})`);
  lines.push("");
  lines.push(`**Cohort:** ${m.cohort_id} | **N=${m.cohort_size} × ${m.repeats} runs**`);
  lines.push(`**Windows:** prediction-input [now-${m.prediction_input_window_days.from_days_ago}d, now-${m.prediction_input_window_days.to_days_ago}d) | ground-truth [now-${m.ground_truth_window_days.from_days_ago}d, now]`);
  lines.push("");
  lines.push(`## Verdict — \`${m.multi_run_verdict}\``);
  lines.push("");
  lines.push(`**Recommendation:** ${m.next_workstream_recommendation}`);
  lines.push("");
  lines.push(`## Per-run aggregates`);
  lines.push("");
  lines.push(`| run | scored | MAPE delta 72h | MAPE delta 7d | Wilcoxon p (7d) | Dir-acc delta | verdict |`);
  lines.push(`|---:|---:|---:|---:|---:|---:|---|`);
  for (const r of m.per_run) {
    lines.push(`| ${r.run_index} | ${r.scored_pairs} | ${fmt(r.mape_delta_72h)} | ${fmt(r.mape_delta_7d)} | ${fmt(r.wilcoxon_pvalue_7d)} | ${fmt(r.direction_acc_delta)} | ${r.verdict_branch} |`);
  }
  lines.push("");
  lines.push(`## Cross-run stats`);
  lines.push("");
  lines.push(`| Metric | mean | stdev | sign stability |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| MAPE delta 72h | ${fmt(m.cross_run_stats.mape_delta_72h_mean)} | ${fmt(m.cross_run_stats.mape_delta_72h_stdev)} | ${fmt(m.cross_run_stats.mape_delta_72h_sign_stability)} |`);
  lines.push(`| MAPE delta 7d | ${fmt(m.cross_run_stats.mape_delta_7d_mean)} | ${fmt(m.cross_run_stats.mape_delta_7d_stdev)} | ${fmt(m.cross_run_stats.mape_delta_7d_sign_stability)} |`);
  lines.push(`| Direction-acc delta | ${fmt(m.cross_run_stats.direction_acc_delta_mean)} | ${fmt(m.cross_run_stats.direction_acc_delta_stdev)} | — |`);
  lines.push("");
  lines.push(`Sign stability = fraction of runs where the per-run delta has the same sign as the cross-run mean. 1.0 = perfectly stable; ≤ 0.7 = unstable / noise-dominated.`);
  lines.push("");
  lines.push(`## Per-card consistency (stable winners across runs)`);
  lines.push("");
  const consistentHelpers = m.per_card_consistency.filter((c) => c.stable_arm_winner_7d === "on");
  const consistentHurters = m.per_card_consistency.filter((c) => c.stable_arm_winner_7d === "off");
  const mixed = m.per_card_consistency.filter((c) => c.stable_arm_winner_7d === "mixed");
  lines.push(`- **Stable signal-helpers** (signal-on wins ≥70% of runs): ${consistentHelpers.length}`);
  lines.push(`- **Stable signal-hurters** (signal-on wins ≤30% of runs): ${consistentHurters.length}`);
  lines.push(`- **Mixed/flipping** (signal-on wins 31-69% of runs): ${mixed.length}`);
  lines.push("");
  if (consistentHelpers.length > 0) {
    lines.push(`### Cards where signals CONSISTENTLY help`);
    lines.push("");
    lines.push(`| Card | runs scored | on win-rate | mean on err% | mean off err% |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const c of consistentHelpers) {
      lines.push(`| ${c.cardId} | ${c.runs_scored} | ${fmt(c.signal_on_wins_7d_rate)} | ${fmt(c.mean_pct_error_on_7d)} | ${fmt(c.mean_pct_error_off_7d)} |`);
    }
    lines.push("");
  }
  if (consistentHurters.length > 0) {
    lines.push(`### Cards where signals CONSISTENTLY hurt`);
    lines.push("");
    lines.push(`| Card | runs scored | on win-rate | mean on err% | mean off err% |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const c of consistentHurters) {
      lines.push(`| ${c.cardId} | ${c.runs_scored} | ${fmt(c.signal_on_wins_7d_rate)} | ${fmt(c.mean_pct_error_on_7d)} | ${fmt(c.mean_pct_error_off_7d)} |`);
    }
    lines.push("");
  }
  if (mixed.length > 0) {
    lines.push(`### Cards that FLIP across runs (noise candidates)`);
    lines.push("");
    lines.push(`| Card | runs scored | on win-rate |`);
    lines.push(`|---|---:|---:|`);
    for (const c of mixed) {
      lines.push(`| ${c.cardId} | ${c.runs_scored} | ${fmt(c.signal_on_wins_7d_rate)} |`);
    }
    lines.push("");
  }
  lines.push(`## What this run does NOT prove`);
  lines.push("");
  lines.push(`- Multi-run aggregation reduces OpenAI nondeterminism but doesn't address parallel-mixing in actuals (CF-BACKTEST-PARALLEL-FILTER).`);
  lines.push(`- Per-card stability is more informative than aggregate for individual recommendations; aggregate is for "does this signal pipeline help in general."`);
  lines.push(`- If verdict is \`unstable_high_variance\`, address the noise (CF-BACKTEST-DETERMINISTIC) before expanding the cohort.`);
  lines.push("");
  await fs.writeFile(outputPath, lines.join("\n"), "utf8");
}

// ─── Driver ──────────────────────────────────────────────────────────────────

interface CliOpts {
  selfTest: boolean;
  dryRun: boolean;
  cohortPath: string | null;
  outputJson: string | null;
  outputMd: string | null;
  limit: number | null;
  repeats: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    selfTest: false,
    dryRun: false,
    cohortPath: null,
    outputJson: null,
    outputMd: null,
    limit: null,
    repeats: 1,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-test") opts.selfTest = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--cohort") opts.cohortPath = argv[++i];
    else if (a === "--output-json") opts.outputJson = argv[++i];
    else if (a === "--output-md") opts.outputMd = argv[++i];
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--repeats") opts.repeats = Math.max(1, Number(argv[++i]));
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

function checkEnvOrThrow(): void {
  const missing: string[] = [];
  if (!process.env.AZURE_SIGNAL_FUNCTION_URL) missing.push("AZURE_SIGNAL_FUNCTION_URL");
  if (!process.env.HOBBYIQ_BACKEND_URL && !process.env.COMPIQ_BACKEND_URL) {
    missing.push("HOBBYIQ_BACKEND_URL (or COMPIQ_BACKEND_URL)");
  }
  const hasOpenAI = process.env.OPENAI_API_KEY ||
    (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT);
  if (!hasOpenAI) missing.push("OPENAI_API_KEY OR (AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_DEPLOYMENT)");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) {
    await runSelfTests();
    return;
  }

  if (!opts.cohortPath) {
    throw new Error("--cohort <path> is required");
  }
  if (!opts.outputJson || !opts.outputMd) {
    throw new Error("--output-json AND --output-md are both required");
  }
  if (!opts.dryRun) checkEnvOrThrow();

  const cohortRaw = await fs.readFile(opts.cohortPath, "utf8");
  const cohort = JSON.parse(cohortRaw) as CohortFile;
  if (!Array.isArray(cohort.cards) || cohort.cards.length === 0) {
    throw new Error("Cohort file has no cards");
  }
  const cards = opts.limit ? cohort.cards.slice(0, opts.limit) : cohort.cards;
  console.log(`[backtest] cohort=${cohort.cohort_id} cards=${cards.length}${opts.limit ? ` (limit ${opts.limit})` : ""}`);

  const asOf = new Date();
  const asOfStr = asOf.toISOString();
  const runId = asOfStr.replace(/[:.]/g, "-");
  const groups = groupCohort(cards);
  console.log(`[backtest] cohort-groups (player+product+year): ${groups.length}`);

  // Fetch comps per (player, product, year, grade) group — grade-aware so
  // ground-truth medians for raw cards aren't contaminated by PSA 10 sales
  // (and vice versa). Bypasses compsLoader.fetchPlayerComps because that
  // helper doesn't forward grade params to the backend (production gap
  // captured as a separate finding).
  const groupComps = new Map<string, CardComp[]>();
  const groupKey = (g: CohortGroup) => {
    const gradeKey = (g.grade ?? "").trim().toLowerCase() || "raw";
    const normGrade = gradeKey === "raw" ? "__raw__" : g.grade;
    return `${g.player}|${g.product}|${g.year}|${normGrade}`;
  };
  for (const g of groups) {
    const key = groupKey(g);
    if (opts.dryRun) {
      console.log(`[backtest] DRY: would fetchCompsForBacktest(${g.player}, ${g.product}, year=${g.year}, grade=${g.grade ?? "raw"})`);
      groupComps.set(key, []);
      continue;
    }
    try {
      console.log(`[backtest] fetching comps: ${g.player} | ${g.product} | ${g.year} | grade=${g.grade ?? "raw"}`);
      const comps = await fetchCompsForBacktest(g.player, g.product, g.year, g.grade);
      groupComps.set(key, comps);
      console.log(`  → ${comps.length} comps returned`);
    } catch (err) {
      console.warn(`  ✗ fetch failed: ${(err as Error).message}`);
      groupComps.set(key, []);
    }
  }

  // Per-card pipeline — extracted to a function so --repeats N can call it
  // multiple times over the same comp data (comps don't change in seconds;
  // OpenAI nondeterminism is what we're measuring across repeats).
  async function executePredictionRun(runIndex: number, totalRuns: number): Promise<PerCardResult[]> {
    if (totalRuns > 1) console.log(`\n[backtest] === RUN ${runIndex + 1} of ${totalRuns} ===`);
    const runResults: PerCardResult[] = await runPerCardLoop();
    return runResults;
  }

  // The actual per-card loop. Closed over groups, groupComps, asOf, asOfStr, opts.
  async function runPerCardLoop(): Promise<PerCardResult[]> {
  const results: PerCardResult[] = [];
  for (const g of groups) {
    const key = groupKey(g);
    const allComps = groupComps.get(key) ?? [];
    const inputComps = filterPredictionInputComps(allComps, asOf);
    const gtComps = filterGroundTruthComps(allComps, asOf);
    const inputMed = median(inputComps.map((c) => c.price));
    const gtMed = median(gtComps.map((c) => c.price));

    const inputFrom = inputComps.length ? inputComps[inputComps.length - 1]?.date : "";
    const inputTo = inputComps.length ? inputComps[0]?.date : "";
    const gtFrom = gtComps.length ? gtComps[gtComps.length - 1]?.date : "";
    const gtTo = gtComps.length ? gtComps[0]?.date : "";

    for (const { entry, index } of g.members) {
      const anchorPrice = entry.anchorPriceOverride ?? (inputMed ?? 0);
      const card: Card = {
        id: cardIdentity(entry),
        playerName: entry.playerName,
        year: entry.year,
        set: entry.set,
        cardNumber: entry.cardNumber,
        variant: entry.variant,
        grade: entry.grade,
        isRookie: entry.isRookie,
        printRun: entry.printRun ?? undefined,
        jerseyNumber: entry.jerseyNumber,
        anchorPrice: anchorPrice > 0 ? anchorPrice : 1, // guard
        recentComps: inputComps,
      };

      if (opts.dryRun) {
        console.log(`[backtest] DRY: would predict ${card.id} (input n=${inputComps.length}, gt n=${gtComps.length}, anchor=${anchorPrice})`);
        continue;
      }
      if (!Number.isFinite(card.anchorPrice) || card.anchorPrice <= 0) {
        console.warn(`  ✗ skip ${card.id}: no usable anchor price (input window empty)`);
        results.push(makeSkipResult(entry, index, asOfStr, inputComps.length, gtComps.length, gtMed, inputMed ?? 0, "no_input_comps"));
        continue;
      }

      console.log(`[backtest] ${card.id}`);
      const onArm = await runSignalOnArm(card);
      console.log(`  signal-on:  ${onArm.ok ? `72h=${onArm.result!.predicted_price_72h} 7d=${onArm.result!.predicted_price_7d} conf=${onArm.result!.confidence}` : `ERROR: ${onArm.error}`}`);
      const offArm = await runSignalOffArm(card);
      console.log(`  signal-off: ${offArm.ok ? `72h=${offArm.result!.predicted_price_72h} 7d=${offArm.result!.predicted_price_7d} conf=${offArm.result!.confidence}` : `ERROR: ${offArm.error}`}`);

      const actualMedian = gtMed;
      const actualDir =
        actualMedian !== null && inputMed !== null && inputMed > 0
          ? inferActualDirection(actualMedian, inputMed)
          : "unknown";

      const onErr72 = onArm.ok && actualMedian !== null ? Math.abs(onArm.result!.predicted_price_72h - actualMedian) : null;
      const offErr72 = offArm.ok && actualMedian !== null ? Math.abs(offArm.result!.predicted_price_72h - actualMedian) : null;
      const onErr7d = onArm.ok && actualMedian !== null ? Math.abs(onArm.result!.predicted_price_7d - actualMedian) : null;
      const offErr7d = offArm.ok && actualMedian !== null ? Math.abs(offArm.result!.predicted_price_7d - actualMedian) : null;

      const r: PerCardResult = {
        cardId: card.id,
        cohortIndex: index,
        playerName: card.playerName,
        year: card.year,
        set: card.set,
        cardNumber: card.cardNumber,
        grade: card.grade,
        variant: card.variant,
        asOfDate: asOfStr,
        prediction_input_window: { from: inputFrom, to: inputTo, n: inputComps.length },
        ground_truth_window: { from: gtFrom, to: gtTo, n: gtComps.length },
        actualMedian,
        actualMedian_source: `median of ${gtComps.length} comps in [now-${GROUND_TRUTH_FROM_DAYS}d, now]`,
        inputMedian: inputMed ?? 0,
        signals_on: onArm.ok
          ? {
              predicted_price_72h: onArm.result!.predicted_price_72h,
              predicted_price_7d: onArm.result!.predicted_price_7d,
              predicted_direction: onArm.result!.predicted_direction,
              confidence: onArm.result!.confidence,
              key_drivers: onArm.result!.key_drivers,
              risk_flags: onArm.result!.risk_flags,
              signal_payload: onArm.signalPayload!,
            }
          : { error: onArm.error! },
        signals_off: offArm.ok
          ? {
              predicted_price_72h: offArm.result!.predicted_price_72h,
              predicted_price_7d: offArm.result!.predicted_price_7d,
              predicted_direction: offArm.result!.predicted_direction,
              confidence: offArm.result!.confidence,
              key_drivers: offArm.result!.key_drivers,
              risk_flags: offArm.result!.risk_flags,
            }
          : { error: offArm.error! },
        deltas: {
          abs_error_on_72h: onErr72,
          abs_error_off_72h: offErr72,
          abs_error_on_7d: onErr7d,
          abs_error_off_7d: offErr7d,
          pct_error_on_72h: onErr72 !== null && actualMedian !== null ? round2(pctErr(onArm.result!.predicted_price_72h, actualMedian)) : null,
          pct_error_off_72h: offErr72 !== null && actualMedian !== null ? round2(pctErr(offArm.result!.predicted_price_72h, actualMedian)) : null,
          pct_error_on_7d: onErr7d !== null && actualMedian !== null ? round2(pctErr(onArm.result!.predicted_price_7d, actualMedian)) : null,
          pct_error_off_7d: offErr7d !== null && actualMedian !== null ? round2(pctErr(offArm.result!.predicted_price_7d, actualMedian)) : null,
          direction_correct_on:
            onArm.ok && actualDir !== "unknown"
              ? onArm.result!.predicted_direction === actualDir
              : null,
          direction_correct_off:
            offArm.ok && actualDir !== "unknown"
              ? offArm.result!.predicted_direction === actualDir
              : null,
          actual_direction: actualDir,
        },
        signal_on_wins_72h:
          onErr72 !== null && offErr72 !== null ? onErr72 < offErr72 : null,
        signal_on_wins_7d:
          onErr7d !== null && offErr7d !== null ? onErr7d < offErr7d : null,
      };
      results.push(r);
    }
  }

  return results;
  } // end runPerCardLoop

  if (opts.dryRun) {
    // Dry run still executes the loop once (logs DRY messages)
    await executePredictionRun(0, 1);
    console.log("\n[backtest] DRY-RUN complete — no predictions made, no output files written.");
    return;
  }

  // Multi-run execution: loop N times, collect per-run results.
  // Comp data is fetched once above; only predictions repeat (where the noise is).
  const perRunResults: PerCardResult[][] = [];
  const perRunAggregates: AggregateResult[] = [];
  for (let r = 0; r < opts.repeats; r++) {
    const runResults = await executePredictionRun(r, opts.repeats);
    perRunResults.push(runResults);
    const runId_r = opts.repeats > 1 ? `${runId}-r${r + 1}` : runId;
    const agg = aggregate(runResults, runId_r, cohort.cohort_id, asOf);
    perRunAggregates.push(agg);
  }

  if (opts.repeats === 1) {
    // Single-run mode — preserve original output behavior
    await writeJsonOutput(opts.outputJson, perRunAggregates[0], perRunResults[0]);
    await writeMarkdownOutput(opts.outputMd, perRunAggregates[0], perRunResults[0]);
    console.log(`\n[backtest] DONE. Verdict: ${perRunAggregates[0].verdict_branch}`);
    console.log(`  JSON: ${opts.outputJson}`);
    console.log(`  MD:   ${opts.outputMd}`);
    return;
  }

  // Multi-run mode — write per-run outputs to subdirectories + multi-run summary
  const outputDir = path.dirname(opts.outputJson);
  for (let r = 0; r < opts.repeats; r++) {
    const runDir = path.join(outputDir, `run_${r + 1}`);
    await fs.mkdir(runDir, { recursive: true });
    await writeJsonOutput(path.join(runDir, "results.json"), perRunAggregates[r], perRunResults[r]);
    await writeMarkdownOutput(path.join(runDir, "report.md"), perRunAggregates[r], perRunResults[r]);
  }
  const multiRun = computeMultiRunSummary(perRunResults, perRunAggregates, runId, cohort.cohort_id, opts.repeats);
  await fs.writeFile(opts.outputJson, JSON.stringify(multiRun, null, 2), "utf8");
  await writeMultiRunMarkdown(opts.outputMd, multiRun);
  console.log(`\n[backtest] DONE (${opts.repeats} runs).`);
  console.log(`  Per-run dirs:    ${outputDir}/run_{1..${opts.repeats}}/`);
  console.log(`  Multi-run JSON:  ${opts.outputJson}`);
  console.log(`  Multi-run MD:    ${opts.outputMd}`);
  console.log(`  Verdict:         ${multiRun.multi_run_verdict}`);
}

function makeSkipResult(
  entry: CohortEntry,
  index: number,
  asOfStr: string,
  inputN: number,
  gtN: number,
  gtMed: number | null,
  inputMed: number,
  reason: string,
): PerCardResult {
  return {
    cardId: cardIdentity(entry),
    cohortIndex: index,
    playerName: entry.playerName,
    year: entry.year,
    set: entry.set,
    cardNumber: entry.cardNumber,
    grade: entry.grade,
    variant: entry.variant,
    asOfDate: asOfStr,
    prediction_input_window: { from: "", to: "", n: inputN },
    ground_truth_window: { from: "", to: "", n: gtN },
    actualMedian: gtMed,
    actualMedian_source: "skipped",
    inputMedian: inputMed,
    signals_on: { error: `skipped: ${reason}` },
    signals_off: { error: `skipped: ${reason}` },
    deltas: {
      abs_error_on_72h: null,
      abs_error_off_72h: null,
      abs_error_on_7d: null,
      abs_error_off_7d: null,
      pct_error_on_72h: null,
      pct_error_off_72h: null,
      pct_error_on_7d: null,
      pct_error_off_7d: null,
      direction_correct_on: null,
      direction_correct_off: null,
      actual_direction: "unknown",
    },
    signal_on_wins_72h: null,
    signal_on_wins_7d: null,
  };
}

main().catch((err) => {
  console.error("[backtest] FAILED:", err);
  process.exit(1);
});

// abs is unused after refactor — keep export to silence lint without removing the helper.
void abs;
