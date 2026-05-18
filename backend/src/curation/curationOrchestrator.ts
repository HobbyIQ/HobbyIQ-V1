/**
 * Curation Orchestrator — Phase B (rewrite) curation pipeline.
 *
 * Walks a directory of staged Beckett files
 * (`backend/data/beckett-sweep/{year}/{brand}.json`) and runs the
 * four-phase Phase B harness:
 *
 *   Phase 1 (analyze):  staged → EligibilityReport (per set)
 *   Phase 2 (generate): EligibilityReport → Worksheet (only when eligible)
 *   Phase 3 (review):   OUT OF BAND — owner fills worksheets by hand
 *   Phase 4 (apply):    Worksheet → applyWorksheet (default DRY RUN)
 *
 * Phases 1 and 2 are safe to run against a partial sweep — every set is
 * analyzed independently, and ineligible sets are recorded in the
 * eligibility report without touching `parallel_attributes`.
 *
 * Phase 4 is intentionally a no-op by default. Even when `apply: true` is
 * passed, the orchestrator only operates on worksheets the owner has
 * explicitly marked `status: "reviewed"`; everything else is recorded as
 * `skipped-pending-review`.
 *
 * Resumability: every phase writes its outputs to disk before moving on.
 * Re-running the orchestrator re-reads cached outputs and skips work that's
 * already done unless `force: true`.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  analyzeEligibility,
  type EligibilityReport,
  type StagedFileLike,
} from "./eligibilityAnalyzer.js";
import { generateWorksheet, type Worksheet } from "./worksheetGenerator.js";
import { applyWorksheet, type ApplyWorksheetResult } from "./applyWorksheet.js";
import type { Container } from "@azure/cosmos";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  /** Required — absolute path to the sweep root (the dir with year subfolders). */
  sweepDir: string;
  /** Required — absolute path where eligibility + worksheets + apply reports land. */
  outDir: string;
  /** Restrict to specific years. Empty/undefined = all years found. */
  years?: readonly number[];
  /** Restrict to specific brands (matched on staged file `brand` field). */
  brands?: readonly string[];
  /** Force regenerate eligibility reports and worksheets. Default false. */
  force?: boolean;
  /** Phases to run. Default: ["analyze", "generate"]. */
  phases?: readonly OrchestratorPhase[];
  /** Required when phase "apply" is included AND apply=true. */
  cosmosContainer?: Container;
  /** Pass `apply: true` to actually upsert during phase "apply". Default false. */
  apply?: boolean;
  /** Required when phase "apply" is included — written into `reviewedBy`. */
  reviewedBy?: string;
  /** Pin for tests. Defaults to `new Date().toISOString()`. */
  now?: string;
}

export type OrchestratorPhase = "analyze" | "generate" | "apply";

export interface PerSetOutcome {
  set: string;
  brand: string;
  year: number;
  stagedPath: string;
  eligibilityPath: string;
  worksheetPath: string | null;
  /** True when an eligibility report was written (or refreshed) this run. */
  analyzed: boolean;
  /** True when a worksheet was generated this run. */
  worksheetGenerated: boolean;
  /** True when a worksheet existed and was eligible for apply phase. */
  worksheetApplyable: boolean;
  /** Set during phase "apply" when applicable. */
  applyResult?: ApplyWorksheetResult;
  /** Set when something failed at the per-set level (file missing, parse, etc.). */
  error?: string;
  /** True when no Phase B action was taken (ineligible OR pending review). */
  skipped: boolean;
  skippedReason?: string;
}

export interface OrchestratorSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sweepDir: string;
  outDir: string;
  phases: readonly OrchestratorPhase[];
  apply: boolean;
  stagedFilesFound: number;
  analyzedCount: number;
  eligibleCount: number;
  worksheetsGeneratedCount: number;
  worksheetsAppliedCount: number;
  errorCount: number;
  outcomes: PerSetOutcome[];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runOrchestrator(
  opts: OrchestratorOptions,
): Promise<OrchestratorSummary> {
  const phases = opts.phases ?? (["analyze", "generate"] as const);
  const force = opts.force ?? false;
  const apply = opts.apply ?? false;
  const now = opts.now ?? new Date().toISOString();
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();

  if (apply && !phases.includes("apply")) {
    throw new Error(`[orchestrator] apply=true but "apply" phase not in phases list`);
  }
  if (apply && !opts.cosmosContainer) {
    throw new Error(`[orchestrator] apply=true requires cosmosContainer`);
  }
  if (apply && !opts.reviewedBy) {
    throw new Error(`[orchestrator] apply=true requires reviewedBy`);
  }

  await fs.mkdir(opts.outDir, { recursive: true });
  await fs.mkdir(path.join(opts.outDir, "eligibility"), { recursive: true });
  await fs.mkdir(path.join(opts.outDir, "worksheets"), { recursive: true });
  await fs.mkdir(path.join(opts.outDir, "apply-reports"), { recursive: true });

  const stagedFiles = await discoverStagedFiles(opts.sweepDir, opts.years, opts.brands);
  const outcomes: PerSetOutcome[] = [];

  for (const stagedPath of stagedFiles) {
    const outcome = await processStaged({
      stagedPath,
      outDir: opts.outDir,
      phases,
      force,
      apply,
      now,
      container: opts.cosmosContainer,
      reviewedBy: opts.reviewedBy,
    });
    outcomes.push(outcome);
  }

  const finishedMs = Date.now();
  const summary: OrchestratorSummary = {
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - startMs,
    sweepDir: opts.sweepDir,
    outDir: opts.outDir,
    phases,
    apply,
    stagedFilesFound: stagedFiles.length,
    analyzedCount: outcomes.filter((o) => o.analyzed).length,
    eligibleCount: outcomes.filter((o) => o.worksheetApplyable || o.worksheetGenerated).length,
    worksheetsGeneratedCount: outcomes.filter((o) => o.worksheetGenerated).length,
    worksheetsAppliedCount: outcomes.filter(
      (o) => o.applyResult && (o.applyResult.upsertedCount > 0 || o.applyResult.dryRunCount > 0),
    ).length,
    errorCount: outcomes.filter((o) => o.error).length,
    outcomes,
  };
  await fs.writeFile(
    path.join(opts.outDir, "SUMMARY.json"),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Per-set processing
// ---------------------------------------------------------------------------

interface ProcessStagedArgs {
  stagedPath: string;
  outDir: string;
  phases: readonly OrchestratorPhase[];
  force: boolean;
  apply: boolean;
  now: string;
  container?: Container;
  reviewedBy?: string;
}

async function processStaged(args: ProcessStagedArgs): Promise<PerSetOutcome> {
  const { stagedPath, outDir, phases, force, apply, now, container, reviewedBy } = args;

  let staged: StagedFileLike;
  try {
    const text = await fs.readFile(stagedPath, "utf-8");
    staged = JSON.parse(text) as StagedFileLike;
  } catch (err) {
    return {
      set: stagedPath,
      brand: "",
      year: 0,
      stagedPath,
      eligibilityPath: "",
      worksheetPath: null,
      analyzed: false,
      worksheetGenerated: false,
      worksheetApplyable: false,
      skipped: true,
      skippedReason: "staged-read-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const fileSlug = sanitize(`${staged.year}__${staged.brand}`);
  const eligibilityPath = path.join(outDir, "eligibility", `${fileSlug}.json`);
  const worksheetPath = path.join(outDir, "worksheets", `${fileSlug}.json`);

  const outcome: PerSetOutcome = {
    set: staged.setLabel,
    brand: staged.brand,
    year: staged.year,
    stagedPath,
    eligibilityPath,
    worksheetPath: null,
    analyzed: false,
    worksheetGenerated: false,
    worksheetApplyable: false,
    skipped: false,
  };

  // ---- Phase 1: analyze -----------------------------------------------
  let report: EligibilityReport | null = null;
  if (phases.includes("analyze")) {
    const exists = await fileExists(eligibilityPath);
    if (!exists || force) {
      report = analyzeEligibility(staged);
      await fs.writeFile(eligibilityPath, JSON.stringify(report, null, 2), "utf-8");
      outcome.analyzed = true;
    } else {
      try {
        report = JSON.parse(await fs.readFile(eligibilityPath, "utf-8")) as EligibilityReport;
      } catch (err) {
        outcome.error = `eligibility-read-failed: ${err instanceof Error ? err.message : String(err)}`;
        outcome.skipped = true;
        outcome.skippedReason = "eligibility-read-failed";
        return outcome;
      }
    }
  }

  // If we didn't run analyze (skipped phase) but need it for generate/apply,
  // produce one in-memory without writing.
  if (!report && (phases.includes("generate") || phases.includes("apply"))) {
    report = analyzeEligibility(staged);
  }

  if (!report) {
    outcome.skipped = true;
    outcome.skippedReason = "no-analysis-requested";
    return outcome;
  }

  if (!report.eligible) {
    outcome.skipped = true;
    outcome.skippedReason = `ineligible:${report.eligibilityReason}`;
    return outcome;
  }

  // ---- Phase 2: generate worksheet -----------------------------------
  if (phases.includes("generate")) {
    const exists = await fileExists(worksheetPath);
    if (!exists || force) {
      const ws = generateWorksheet(report, { generatedAt: now });
      await fs.writeFile(worksheetPath, JSON.stringify(ws, null, 2), "utf-8");
      outcome.worksheetGenerated = true;
      outcome.worksheetPath = worksheetPath;
    } else {
      outcome.worksheetPath = worksheetPath;
    }
  }

  // ---- Phase 4: apply ---------------------------------------------------
  if (phases.includes("apply")) {
    if (!(await fileExists(worksheetPath))) {
      outcome.skipped = true;
      outcome.skippedReason = "apply:worksheet-missing";
      return outcome;
    }
    let ws: Worksheet;
    try {
      ws = JSON.parse(await fs.readFile(worksheetPath, "utf-8")) as Worksheet;
    } catch (err) {
      outcome.error = `worksheet-read-failed: ${err instanceof Error ? err.message : String(err)}`;
      outcome.skipped = true;
      outcome.skippedReason = "apply:worksheet-read-failed";
      return outcome;
    }
    if (ws.status !== "reviewed") {
      outcome.skipped = true;
      outcome.skippedReason = `apply:status-${ws.status}`;
      return outcome;
    }
    if (!reviewedBy) {
      outcome.error = "reviewedBy required for apply phase";
      outcome.skipped = true;
      outcome.skippedReason = "apply:missing-reviewedBy";
      return outcome;
    }
    outcome.worksheetApplyable = true;
    try {
      const result = await applyWorksheet(ws, {
        container,
        apply,
        reviewedBy,
        worksheetPath,
      });
      outcome.applyResult = result;
      const reportPath = path.join(outDir, "apply-reports", `${fileSlug}.json`);
      await fs.writeFile(reportPath, JSON.stringify(result, null, 2), "utf-8");
    } catch (err) {
      outcome.error = `apply-failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function discoverStagedFiles(
  sweepDir: string,
  years?: readonly number[],
  brands?: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  let yearDirs: string[];
  try {
    yearDirs = await fs.readdir(sweepDir);
  } catch {
    return [];
  }
  const yearSet = years && years.length > 0 ? new Set(years.map(String)) : null;
  for (const entry of yearDirs) {
    if (yearSet && !yearSet.has(entry)) continue;
    if (!/^\d{4}$/.test(entry)) continue;
    const yearPath = path.join(sweepDir, entry);
    let files: string[];
    try {
      files = await fs.readdir(yearPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      if (f === "SUMMARY.json" || f === "unmatchedParallels.json") continue;
      found.push(path.join(yearPath, f));
    }
  }
  // Brand filter: must read each file's brand field. Keep this cheap by
  // matching on the filename slug first.
  if (!brands || brands.length === 0) {
    found.sort();
    return found;
  }
  const brandSlugs = new Set(brands.map(brandFilename));
  const filtered: string[] = [];
  for (const p of found) {
    const base = path.basename(p, ".json");
    if (brandSlugs.has(base)) {
      filtered.push(p);
    }
  }
  filtered.sort();
  return filtered;
}

function brandFilename(brand: string): string {
  return brand.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
