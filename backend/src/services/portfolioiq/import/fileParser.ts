// CF-IMPORT-BE (2026-06-21) — xlsx/csv file → parsed rows.
//
// Path detection happens here: presence of holdingId/cardsightCardId in
// the header row triggers round-trip mode (strict numeric parse, skip
// auto-map). Otherwise arbitrary mode (lenient parse + auto-map proposed).

import * as XLSX from "xlsx";
import { EXPORT_COLUMNS, type ExportColumn } from "../exportHoldings.service.js";
import { autoMapHeaders, type AutoMapResult } from "./headerAutoMap.js";
import { parseNumeric, type NumericParseResult } from "./numericParser.js";
import { parseDate, type DateParseResult } from "./dateParser.js";

export type FileFormat = "xlsx" | "csv";

export interface ParsedRow {
  /** 1-indexed row number in the sheet (header is row 1, first data row is 2). */
  rowNumber: number;
  /** Raw cells keyed by raw header name (pre-mapping). */
  rawCells: Record<string, unknown>;
  /** Cells mapped + parsed to canonical column keys with per-cell parse outcomes. */
  cells: Record<string, ParsedCell>;
  /** Per-row parse-side flags (date ambiguities, lenient-mode flags). User resolves at preview time. */
  flags: Array<{ column: string; reason: string }>;
}

export interface ParsedCell {
  /** The parsed canonical value, or null when empty/flagged/rejected. */
  value: unknown;
  /** Where the cell came from in the raw row (preserves auditability). */
  rawHeader: string;
  /** What the parser said about the cell. */
  outcome: "ok" | "empty" | "flagged" | "rejected";
  reason?: string;
}

export interface FileParseResult {
  isRoundTrip: boolean;
  autoMap: AutoMapResult;
  rows: ParsedRow[];
  /** Total rows in the file (excluding header). */
  totalRows: number;
}

/**
 * Numeric columns (canonical). Driven by EXPORT_COLUMNS's group: only
 * the user-editable surface gets numeric parsing — computed columns are
 * ignored per the banked guardrail.
 */
const NUMERIC_USER_EDITABLE_COLUMNS = new Set([
  "cardYear",
  "gradeValue",
  "quantity",
  "purchasePrice",
  "totalCostBasis",
  "listingPrice",
]);

const DATE_COLUMNS = new Set(["purchaseDate"]);

/** Computed columns — always dropped from the parsed payload per banked guardrail. */
const COMPUTED_IGNORE_SET = new Set(
  EXPORT_COLUMNS.filter((c) => c.group === "computed").map((c) => c.header),
);

/** Boolean columns. */
const BOOLEAN_COLUMNS = new Set(["isAuto"]);

/**
 * Parse a file buffer (xlsx) or string (csv) into rows + path detection.
 */
export function parseHoldingsFile(
  input: Buffer | string,
  format: FileFormat,
): FileParseResult {
  const wb = format === "xlsx"
    ? XLSX.read(input as Buffer, { type: "buffer", cellDates: false })
    : XLSX.read(input as string, { type: "string", cellDates: false });

  // Use the first sheet (CF-EXPORT-BE writes "Holdings"; arbitrary sheets vary)
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return {
      isRoundTrip: false,
      autoMap: { isRoundTrip: false, mapping: {}, unmapped: [], missingCanonical: [] },
      rows: [],
      totalRows: 0,
    };
  }
  const sheet = wb.Sheets[sheetName]!;
  const arr = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });

  if (arr.length === 0) {
    return {
      isRoundTrip: false,
      autoMap: { isRoundTrip: false, mapping: {}, unmapped: [], missingCanonical: [] },
      rows: [],
      totalRows: 0,
    };
  }

  const rawHeaders = Object.keys(arr[0]!);
  const autoMap = autoMapHeaders(rawHeaders);
  const isRoundTrip = autoMap.isRoundTrip;
  const numericMode = isRoundTrip ? "strict" : "lenient";

  const parsedRows: ParsedRow[] = arr.map((raw, i) => {
    const cells: Record<string, ParsedCell> = {};
    const flags: Array<{ column: string; reason: string }> = [];

    for (const [rawHeader, rawValue] of Object.entries(raw)) {
      const canonical = autoMap.mapping[rawHeader];
      if (!canonical) continue; // Unmapped — user will assign in reconciliation step
      if (COMPUTED_IGNORE_SET.has(canonical)) continue; // Drop computed columns

      let parsed: ParsedCell;

      if (NUMERIC_USER_EDITABLE_COLUMNS.has(canonical)) {
        const r: NumericParseResult = parseNumeric(rawValue, numericMode);
        parsed = { value: r.value, rawHeader, outcome: r.outcome, reason: r.reason };
        if (r.outcome === "flagged" || r.outcome === "rejected") {
          flags.push({ column: canonical, reason: r.reason ?? "parse issue" });
        }
      } else if (DATE_COLUMNS.has(canonical)) {
        const d: DateParseResult = parseDate(rawValue);
        const ok = d.confidence === "confident" || d.confidence === "empty";
        parsed = {
          value: d.value,
          rawHeader,
          outcome: ok ? (d.confidence === "empty" ? "empty" : "ok") : "flagged",
          reason: d.reason,
        };
        if (d.confidence === "ambiguous" || d.confidence === "invalid") {
          flags.push({ column: canonical, reason: d.reason ?? "date parse issue" });
        }
      } else if (BOOLEAN_COLUMNS.has(canonical)) {
        parsed = parseBoolean(rawValue, rawHeader);
        if (parsed.outcome === "flagged") {
          flags.push({ column: canonical, reason: parsed.reason ?? "non-boolean value" });
        }
      } else {
        // String / passthrough columns
        const s = rawValue === null || rawValue === undefined || rawValue === "" ? null : String(rawValue);
        parsed = { value: s, rawHeader, outcome: s === null ? "empty" : "ok" };
      }

      cells[canonical] = parsed;
    }

    return {
      rowNumber: i + 2, // header is row 1
      rawCells: raw,
      cells,
      flags,
    };
  });

  return {
    isRoundTrip,
    autoMap,
    rows: parsedRows,
    totalRows: parsedRows.length,
  };
}

function parseBoolean(raw: unknown, rawHeader: string): ParsedCell {
  if (raw === null || raw === undefined || raw === "") {
    return { value: null, rawHeader, outcome: "empty" };
  }
  if (typeof raw === "boolean") return { value: raw, rawHeader, outcome: "ok" };
  const s = String(raw).trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "y" || s === "1") return { value: true, rawHeader, outcome: "ok" };
  if (s === "false" || s === "no" || s === "n" || s === "0") return { value: false, rawHeader, outcome: "ok" };
  return { value: null, rawHeader, outcome: "flagged", reason: `non-boolean value "${raw}"` };
}
