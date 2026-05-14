/**
 * Tier runner. Engine invocation is injected so the harness mechanics
 * can be exercised without touching the live pricing engine (PR #1)
 * and the same machinery can drive real cases when PR #3 ships Tier 1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HARNESS_SCHEMA_VERSION,
  HarnessCase,
  HarnessRunResult,
  TIER_BUDGETS_MS,
  TierRunSummary,
} from "./types.js";
import { Clock } from "./clock.js";
import {
  CasePair,
  DiffSummary,
  formatSummary,
  summarize,
} from "./diff.js";
import { serializeSnapshot, snapshot } from "./snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HARNESS_ROOT = __dirname;
export const CORPUS_DIR = path.join(HARNESS_ROOT, "corpus");
export const SNAPSHOT_DIR = path.join(HARNESS_ROOT, "__snapshots__");

export type EngineInvoker = (
  c: HarnessCase,
  clock: Clock
) => Promise<Record<string, unknown>>;

export interface RunTierOptions {
  tier: 1 | 2 | 3;
  cases: HarnessCase[];
  invoke: EngineInvoker;
  clock: Clock;
  /** When true, overwrite committed baselines instead of comparing. */
  updateSnapshots?: boolean;
}

export interface RunTierOutcome {
  summary: TierRunSummary;
  results: HarnessRunResult[];
  diff: DiffSummary | null;
  diffText: string;
}

export function loadCorpus(file: string): HarnessCase[] {
  const full = path.join(CORPUS_DIR, file);
  if (!fs.existsSync(full)) return [];
  const raw = fs.readFileSync(full, "utf8");
  const parsed = JSON.parse(raw) as {
    schemaVersion: number;
    cases: HarnessCase[];
  };
  if (parsed.schemaVersion !== HARNESS_SCHEMA_VERSION) {
    throw new Error(
      `Corpus ${file} schemaVersion ${parsed.schemaVersion} != expected ${HARNESS_SCHEMA_VERSION}. Refresh required.`
    );
  }
  return parsed.cases;
}

function baselinePath(tier: 1 | 2 | 3, caseId: string): string {
  return path.join(SNAPSHOT_DIR, `tier${tier}`, `${caseId}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readBaseline(tier: 1 | 2 | 3, caseId: string): unknown | null {
  const p = baselinePath(tier, caseId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeBaseline(tier: 1 | 2 | 3, caseId: string, snap: unknown): void {
  const p = baselinePath(tier, caseId);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, serializeSnapshot(snap), "utf8");
}

function assertCase(
  c: HarnessCase,
  resultSnapshot: Record<string, unknown>
): string[] {
  const failures: string[] = [];
  // Expected price range — extracted from a small set of canonical fields.
  if (c.expectedPriceRange) {
    const priceFields = [
      "fairMarketValue",
      "fairMarketValueLive",
      "effectiveFmv",
      "marketTier",
    ];
    let priceFound: number | null = null;
    for (const f of priceFields) {
      const v = resultSnapshot[f];
      if (typeof v === "number" && Number.isFinite(v)) {
        priceFound = v;
        break;
      }
    }
    if (priceFound === null) {
      failures.push("price is null; expected range " +
        `[${c.expectedPriceRange.min}, ${c.expectedPriceRange.max}]`);
    } else if (
      priceFound < c.expectedPriceRange.min ||
      priceFound > c.expectedPriceRange.max
    ) {
      failures.push(
        `price ${priceFound} outside expected [${c.expectedPriceRange.min}, ${c.expectedPriceRange.max}]`
      );
    }
  }
  return failures;
}

export async function runTier(
  opts: RunTierOptions
): Promise<RunTierOutcome> {
  const start = Date.now();
  const budgetMs = TIER_BUDGETS_MS[opts.tier];
  const results: HarnessRunResult[] = [];
  const pairs: CasePair[] = [];

  for (const c of opts.cases) {
    const t0 = Date.now();
    let snap: Record<string, unknown> = {};
    const failureReasons: string[] = [];
    try {
      const raw = await opts.invoke(c, opts.clock);
      snap = snapshot(raw) as Record<string, unknown>;
    } catch (err) {
      failureReasons.push(`engine threw: ${(err as Error).message}`);
    }

    if (failureReasons.length === 0) {
      failureReasons.push(...assertCase(c, snap));
    }

    // Baseline comparison.
    if (opts.updateSnapshots) {
      writeBaseline(opts.tier, c.id, snap);
    } else {
      const baseline = readBaseline(opts.tier, c.id);
      pairs.push({ caseId: c.id, before: baseline ?? {}, after: snap });
      if (baseline === null) {
        failureReasons.push(
          "no committed baseline; run with --update-snapshots after review"
        );
      }
    }

    results.push({
      caseId: c.id,
      passed: failureReasons.length === 0,
      durationMs: Date.now() - t0,
      failureReasons,
      snapshot: snap,
    });
  }

  const durationMs = Date.now() - start;
  const budgetExceeded = durationMs > budgetMs;
  const diff = opts.updateSnapshots ? null : summarize(pairs);
  const diffText = diff ? formatSummary(diff) : "";

  const summary: TierRunSummary = {
    tier: opts.tier,
    cases: opts.cases.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    skipped: 0,
    durationMs,
    budgetMs,
    budgetExceeded,
  };

  return { summary, results, diff, diffText };
}

export function tierSkipped(
  tier: 1 | 2 | 3,
  reason: TierRunSummary["skipReason"]
): TierRunSummary {
  return {
    tier,
    cases: 0,
    passed: 0,
    failed: 0,
    skipped: 1,
    skipReason: reason,
    durationMs: 0,
    budgetMs: TIER_BUDGETS_MS[tier],
    budgetExceeded: false,
  };
}
