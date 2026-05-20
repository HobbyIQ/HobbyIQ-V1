/**
 * Worksheet Generator — Phase B (rewrite) curation pipeline.
 *
 * Produces a per-set JSON worksheet that the OWNER fills in, then feeds back
 * through `applyWorksheet.ts` to upsert into `parallel_attributes`.
 *
 * Locked rules (per phase-b-rewrite-prompt.md):
 *   - One worksheet per eligible set.
 *   - Pre-fills every field that can be safely derived from the multiplier
 *     table. Owner-required fields (color, status) are left blank.
 *   - Marks pre-filled values as "from-registry"; owner edits flip them to
 *     "owner-edited" so the apply step can audit overrides.
 *   - Header includes the source URL, brand, year, registry version, and a
 *     `status: "pending"` field that the owner sets to `"reviewed"` to
 *     unlock `applyWorksheet.ts`.
 */

import type { EligibilityReport, CoveredParallel } from "./eligibilityAnalyzer.js";
import { getTableForYear, lookup, type MultiplierTableEntry } from "./multiplierTableRegistry.js";

// ---------------------------------------------------------------------------
// Worksheet types
// ---------------------------------------------------------------------------

export type WorksheetStatus = "pending" | "reviewed" | "skipped";
export type FieldProvenance = "from-registry" | "owner-edited" | "blank";

export interface WorksheetField<T> {
  value: T | null;
  provenance: FieldProvenance;
}

export interface WorksheetParallelRow {
  /** Beckett-raw spelling for owner cross-reference. */
  rawName: string;
  /** Title-Case canonical from the multiplier table — owner should not edit. */
  canonicalParallelName: string;
  isAutograph: boolean;
  /** Pre-filled from registry — integer ordering. */
  tierWithinSet: WorksheetField<number>;
  /** Pre-filled when registry provides; blank when registry returned null. */
  parentVariant: WorksheetField<string | null>;
  /** Pre-filled from registry's `printRun` text (e.g. "/250", "1/1"). */
  printRun: WorksheetField<string>;
  /** Pre-filled from registry. Float. Always > 0. */
  baselineMultiplier: WorksheetField<number>;
  /** Pre-filled from registry. Float. */
  refractorMultiplier: WorksheetField<number>;
  /** OWNER FILLS. Color label (e.g. "Blue", "Gold", "Black"). Required. */
  color: WorksheetField<string>;
  /** Pre-filled with registry colorTier label. */
  colorTier: WorksheetField<string>;
  /** OWNER FILLS. Free-form notes; surfaces in `sourceCitation.note`. */
  note: WorksheetField<string>;
  /** OWNER FLAGS. True = drop this row from the apply step. */
  skip: boolean;
}

export interface Worksheet {
  schemaVersion: 1;
  worksheetType: "phase-b-curation";
  status: WorksheetStatus;
  set: string;
  brand: string;
  year: number;
  beckettSourceUrl: string;
  registryVersion: string;
  generatedAt: string;
  /** Pre-filled count vs. blank-required count, for sanity-check at apply time. */
  preFilledCount: number;
  blankRequiredCount: number;
  /**
   * Owner sets this to a real ISO date when status flips to "reviewed".
   * `applyWorksheet.ts` refuses to ingest if missing or before
   * `generatedAt`.
   */
  reviewedAt: string | null;
  /** Owner-readable provenance line for the eventual `sourceCitation`. */
  reviewerNote: string;
  parallels: WorksheetParallelRow[];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface GenerateWorksheetOptions {
  /** ISO timestamp for `generatedAt`. Defaults to now. Pinnable for tests. */
  generatedAt?: string;
}

/**
 * Generate a worksheet from an eligibility report. Caller MUST pass an
 * eligible report — calling this on an ineligible report throws so we never
 * silently produce a half-curated worksheet.
 */
export function generateWorksheet(
  report: EligibilityReport,
  opts: GenerateWorksheetOptions = {},
): Worksheet {
  if (!report.eligible) {
    throw new Error(
      `[worksheetGenerator] cannot generate worksheet for ineligible set ` +
        `"${report.set}": reason=${report.eligibilityReason}`,
    );
  }
  const table = getTableForYear(report.brand, report.year);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  let preFilledCount = 0;
  let blankRequiredCount = 0;

  const parallels: WorksheetParallelRow[] = report.coveredParallels.map((covered) => {
    const entry = lookup(report.brand, covered.canonicalParallelName, { year: report.year });
    if (!entry) {
      // Defensive — eligibility analyzer already verified coverage, so this
      // is genuinely impossible. Throw so we don't silently corrupt the
      // worksheet with `value: null` on supposedly-pre-filled fields.
      throw new Error(
        `[worksheetGenerator] registry lookup failed for already-covered ` +
          `parallel "${covered.canonicalParallelName}" in brand "${report.brand}"`,
      );
    }

    const row = buildRow(covered, entry);
    // Tally pre-filled vs blank-required (color + reviewer note + parentVariant if registry-null).
    for (const field of [
      row.tierWithinSet,
      row.parentVariant,
      row.printRun,
      row.baselineMultiplier,
      row.refractorMultiplier,
      row.colorTier,
    ]) {
      if (field.provenance === "from-registry") preFilledCount += 1;
    }
    if (row.color.provenance === "blank") blankRequiredCount += 1;
    return row;
  });

  return {
    schemaVersion: 1,
    worksheetType: "phase-b-curation",
    status: "pending",
    set: report.set,
    brand: report.brand,
    year: report.year,
    beckettSourceUrl: report.sourceUrl,
    registryVersion: table.version,
    generatedAt,
    preFilledCount,
    blankRequiredCount,
    reviewedAt: null,
    reviewerNote: "",
    parallels,
  };
}

function buildRow(
  covered: CoveredParallel,
  entry: MultiplierTableEntry,
): WorksheetParallelRow {
  // The eligibility analyzer doesn't currently carry the autograph flag on
  // its per-parallel record — Beckett checklists treat the autograph
  // designation at the card level, not the parallel level. We default to
  // false here; if the owner wants an autograph variant they edit the row
  // (or duplicate it). `parallel_attributes` records autograph in the
  // composite key separately.
  const isAutograph = false;

  return {
    rawName: covered.rawName,
    canonicalParallelName: entry.canonicalParallelName,
    isAutograph,
    tierWithinSet: { value: entry.tierWithinSet, provenance: "from-registry" },
    parentVariant:
      entry.parentVariant === null
        ? { value: null, provenance: "blank" }
        : { value: entry.parentVariant, provenance: "from-registry" },
    printRun: { value: entry.printRun, provenance: "from-registry" },
    baselineMultiplier: { value: entry.baselineMultiplier, provenance: "from-registry" },
    refractorMultiplier: { value: entry.refractorMultiplier, provenance: "from-registry" },
    color: { value: null, provenance: "blank" },
    colorTier: { value: entry.colorTier, provenance: "from-registry" },
    note: { value: null, provenance: "blank" },
    skip: false,
  };
}
