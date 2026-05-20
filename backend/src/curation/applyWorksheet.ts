/**
 * Apply Worksheet — Phase B (rewrite) curation pipeline.
 *
 * Reads a curator-reviewed worksheet (`status: "reviewed"`), builds
 * `ParallelAttributesRecord` objects, validates them, and (by default) does
 * a DRY RUN. Pass `apply: true` to actually upsert.
 *
 * Locked rules (per phase-b-rewrite-prompt.md):
 *   - DRY RUN is the default. The orchestrator does NOT call this with
 *     `apply: true` — only the owner runs the apply step out-of-band.
 *   - Refuses worksheets where `status !== "reviewed"`.
 *   - Refuses worksheets where `reviewedAt` is missing/before `generatedAt`.
 *   - Refuses if any required owner field is still blank (color, reviewer
 *     note).
 *   - Builds `sourceCitation` with the new
 *     `"beckett-checklist+owner-curation"` variant and embeds the
 *     worksheet path + Beckett URL for full audit.
 *   - Never mutates the worksheet on disk.
 */

import type { Container } from "@azure/cosmos";
import type { ItemResponse } from "@azure/cosmos";
import {
  parallelAttributesId,
  upsertParallelAttributes,
  validateParallelAttributesRecord,
  type ParallelAttributesRecord,
  type SourceCitation,
} from "../services/parallelsReference/ingestion.js";
import type { Worksheet, WorksheetParallelRow } from "./worksheetGenerator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApplyWorksheetOptions {
  /** Required when `apply: true`. */
  container?: Container;
  /** When `true`, run `upsertParallelAttributes`. When `false` (default), no I/O. */
  apply?: boolean;
  /** Required — written into `reviewedBy` on every record. */
  reviewedBy: string;
  /** Required — the worksheet's on-disk path for `sourceCitation.worksheetPath`. */
  worksheetPath: string;
}

export type RowOutcome =
  | "dry-run-would-upsert"
  | "upserted"
  | "skipped-by-flag"
  | "skipped-validation-error";

export interface RowResult {
  canonicalParallelName: string;
  isAutograph: boolean;
  recordId: string;
  outcome: RowOutcome;
  error?: string;
}

export interface ApplyWorksheetResult {
  set: string;
  brand: string;
  year: number;
  totalRows: number;
  upsertedCount: number;
  dryRunCount: number;
  skippedCount: number;
  errorCount: number;
  rows: RowResult[];
  apply: boolean;
}

// ---------------------------------------------------------------------------
// Validation gates
// ---------------------------------------------------------------------------

function assertWorksheetIsApplyable(ws: Worksheet): void {
  if (ws.worksheetType !== "phase-b-curation") {
    throw new Error(
      `[applyWorksheet] unexpected worksheetType="${ws.worksheetType}"`,
    );
  }
  if (ws.status !== "reviewed") {
    throw new Error(
      `[applyWorksheet] worksheet status must be "reviewed", got "${ws.status}". ` +
        `Owner has not finalized this worksheet.`,
    );
  }
  if (!ws.reviewedAt) {
    throw new Error(`[applyWorksheet] worksheet missing reviewedAt timestamp`);
  }
  const reviewed = Date.parse(ws.reviewedAt);
  const generated = Date.parse(ws.generatedAt);
  if (!Number.isFinite(reviewed) || !Number.isFinite(generated)) {
    throw new Error(`[applyWorksheet] invalid reviewedAt/generatedAt ISO format`);
  }
  if (reviewed < generated) {
    throw new Error(
      `[applyWorksheet] reviewedAt (${ws.reviewedAt}) is BEFORE generatedAt ` +
        `(${ws.generatedAt}) — refusing to apply.`,
    );
  }
  if (!ws.reviewerNote || ws.reviewerNote.trim() === "") {
    throw new Error(
      `[applyWorksheet] reviewerNote is empty — owner must annotate the worksheet ` +
        `before applying.`,
    );
  }
}

function buildRecord(
  ws: Worksheet,
  row: WorksheetParallelRow,
  worksheetPath: string,
  reviewedBy: string,
): ParallelAttributesRecord {
  const tierWithinSet = row.tierWithinSet.value;
  if (tierWithinSet == null) {
    throw new Error(`tierWithinSet is null for "${row.canonicalParallelName}"`);
  }
  if (row.color.value == null || row.color.value.trim() === "") {
    throw new Error(`color is blank for "${row.canonicalParallelName}"`);
  }
  if (row.printRun.value == null) {
    throw new Error(`printRun is null for "${row.canonicalParallelName}"`);
  }

  const printRunInt = parsePrintRun(row.printRun.value);
  const id = parallelAttributesId(ws.set, row.canonicalParallelName, row.isAutograph);

  const sourceCitation: SourceCitation = {
    type: "beckett-checklist+owner-curation",
    date: ws.reviewedAt!,
    beckettSourceUrl: ws.beckettSourceUrl,
    worksheetPath,
    ...(row.note.value && row.note.value.trim() !== "" ? { note: row.note.value.trim() } : {}),
  };

  return {
    id,
    set: ws.set,
    parallelName: row.canonicalParallelName,
    color: row.color.value.trim(),
    printRun: printRunInt,
    isAutograph: row.isAutograph,
    parentVariant: row.parentVariant.value,
    tierWithinSet,
    sourceCitation,
    lastReviewedAt: ws.reviewedAt!,
    reviewedBy,
    schemaVersion: 1,
  };
}

/**
 * Parse a printRun text label (e.g. "/250", "1/1", "Unnumbered", "150") into
 * the positive-integer-or-null required by the `parallel_attributes`
 * validator.
 *
 *   "1/1"          → 1
 *   "/250"         → 250
 *   "250"          → 250
 *   ""             → null
 *   "Unnumbered"   → null
 */
export function parsePrintRun(input: string): number | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed === "" || /unnumbered|unknown|n\/a/i.test(trimmed)) return null;
  // "1/1" → 1 (one-of-one)
  const oneOfOne = /^1\s*\/\s*1$/.exec(trimmed);
  if (oneOfOne) return 1;
  // "/250" → 250
  const slash = /^\/\s*(\d+)$/.exec(trimmed);
  if (slash) {
    const n = Number(slash[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  // bare integer
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare) {
    const n = Number(bare[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Apply (or dry-run) a worksheet. Returns a structured outcome for every row.
 *
 * Never throws on per-row validation failures — those are recorded as
 * `skipped-validation-error` with the error message so the run can finish
 * and the operator sees the full picture in one report.
 *
 * Throws ONLY on global preconditions (status not reviewed, reviewedAt
 * missing, etc.).
 */
export async function applyWorksheet(
  ws: Worksheet,
  opts: ApplyWorksheetOptions,
): Promise<ApplyWorksheetResult> {
  assertWorksheetIsApplyable(ws);
  const apply = opts.apply === true;
  if (apply && !opts.container) {
    throw new Error(`[applyWorksheet] container is required when apply=true`);
  }

  const rows: RowResult[] = [];
  let upserted = 0;
  let dryRun = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of ws.parallels) {
    if (row.skip) {
      rows.push({
        canonicalParallelName: row.canonicalParallelName,
        isAutograph: row.isAutograph,
        recordId: "",
        outcome: "skipped-by-flag",
      });
      skipped += 1;
      continue;
    }

    let record: ParallelAttributesRecord;
    try {
      record = buildRecord(ws, row, opts.worksheetPath, opts.reviewedBy);
      validateParallelAttributesRecord(record);
    } catch (err: unknown) {
      rows.push({
        canonicalParallelName: row.canonicalParallelName,
        isAutograph: row.isAutograph,
        recordId: parallelAttributesId(ws.set, row.canonicalParallelName, row.isAutograph),
        outcome: "skipped-validation-error",
        error: err instanceof Error ? err.message : String(err),
      });
      errors += 1;
      continue;
    }

    if (!apply) {
      rows.push({
        canonicalParallelName: row.canonicalParallelName,
        isAutograph: row.isAutograph,
        recordId: record.id,
        outcome: "dry-run-would-upsert",
      });
      dryRun += 1;
      continue;
    }

    try {
      const resp: ItemResponse<ParallelAttributesRecord> = await upsertParallelAttributes(
        opts.container!,
        record,
      );
      // 200 = update, 201 = create. Anything else is unexpected.
      if (resp.statusCode !== 200 && resp.statusCode !== 201) {
        throw new Error(`unexpected upsert status ${resp.statusCode}`);
      }
      rows.push({
        canonicalParallelName: row.canonicalParallelName,
        isAutograph: row.isAutograph,
        recordId: record.id,
        outcome: "upserted",
      });
      upserted += 1;
    } catch (err: unknown) {
      rows.push({
        canonicalParallelName: row.canonicalParallelName,
        isAutograph: row.isAutograph,
        recordId: record.id,
        outcome: "skipped-validation-error",
        error: err instanceof Error ? err.message : String(err),
      });
      errors += 1;
    }
  }

  return {
    set: ws.set,
    brand: ws.brand,
    year: ws.year,
    totalRows: ws.parallels.length,
    upsertedCount: upserted,
    dryRunCount: dryRun,
    skippedCount: skipped,
    errorCount: errors,
    rows,
    apply,
  };
}
