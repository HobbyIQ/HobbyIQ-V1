// CF-IMPORT-BE (2026-06-21) — xlsx/csv file → parsed rows.
//
// Path detection happens here: presence of holdingId/cardId in
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

// CF-CARDLADDER-IMPORT (Drew, 2026-07-27). Card Ladder + a few other
// sheets ship a single "Condition" column carrying the full grade
// string ("PSA 10", "BGS 9.5", "SGC 10", "BGS 10 Black Label", "Raw",
// "Ungraded", etc.). Our schema splits that across two fields —
// gradeCompany + gradeValue — so the header auto-map points such
// columns at the pseudo-canonical "_gradeCombined" and the row parser
// (see splitConditionString) fans it out.
const GRADE_COMBINED_PSEUDO = "_gradeCombined";
const GRADERS = ["PSA", "BGS", "SGC", "CGC"] as const;
type Grader = (typeof GRADERS)[number];

interface SplitCondition {
  gradeCompany: Grader | null;
  gradeValue: number | null;
  /** Free-text tail we couldn't fit into (company, value) — e.g. "Black Label", "Pristine". */
  qualifier: string | null;
  /** Original string, preserved for the row-flags reason. */
  raw: string;
  /** True when the value looks like a real grade string we could split. */
  matched: boolean;
}

function splitConditionString(input: string): SplitCondition {
  const raw = String(input ?? "").trim();
  const out: SplitCondition = { gradeCompany: null, gradeValue: null, qualifier: null, raw, matched: false };
  if (!raw) return out;

  // "Raw" / "Ungraded" — leave gradeCompany + gradeValue null so the
  // downstream normalizer treats this as a raw card.
  if (/^(raw|ungraded)$/i.test(raw)) {
    out.matched = true;
    return out;
  }

  // <Company> <numeric grade> <optional qualifier>. Company may be
  // followed by a space, hyphen, or nothing.
  const m = raw.match(/^\s*(PSA|BGS|SGC|CGC)\b[\s\-]*([0-9]+(?:\.5)?)\b(.*)$/i);
  if (m) {
    const company = m[1].toUpperCase() as Grader;
    const value = Number(m[2]);
    const qualifier = m[3]?.trim() || null;
    if (Number.isFinite(value) && value > 0 && value <= 10) {
      out.gradeCompany = company;
      out.gradeValue = value;
      out.qualifier = qualifier;
      out.matched = true;
    }
  }
  return out;
}

/**
 * Parse a file buffer (xlsx) or string (csv) into rows + path detection.
 */
export function parseHoldingsFile(
  input: Buffer | string,
  format: FileFormat,
): FileParseResult {
  // CF-IMPORT-SERIAL-IS-TEXT (D12-b, 2026-08-29). SheetJS's CSV reader
  // types cells on the way in, and "/50" in a Serial column came out as the
  // number 18264 — Excel's serial for 1950-01-01 — so the print run never
  // reached the resolver and "12/50" became December 1950. Every column has
  // its own parser below (parseNumeric / parseDate / parseBoolean); the CSV
  // reader's job is to deliver the text. `raw: true` makes it do only that.
  // (xlsx cells carry the type Excel stored; that is the user's file.)
  const wb = format === "xlsx"
    ? XLSX.read(input as Buffer, { type: "buffer", cellDates: false })
    : XLSX.read(input as string, { type: "string", cellDates: false, raw: true });

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

      // CF-CARDLADDER-IMPORT: fan the combined condition column out into
      // gradeCompany + gradeValue at parse time so downstream sees the
      // normal two-column shape. NEVER stores anything under the
      // pseudo-canonical itself.
      if (canonical === GRADE_COMBINED_PSEUDO) {
        const s = rawValue === null || rawValue === undefined ? "" : String(rawValue);
        if (!s.trim()) continue;   // empty condition = raw, leave both null
        const split = splitConditionString(s);
        if (split.matched) {
          if (split.gradeCompany && split.gradeValue != null) {
            // Only overwrite the two grade cells when the incoming
            // combined string is a real grade — a "Raw" / "Ungraded"
            // value leaves both untouched (matches our raw-card
            // convention of grade fields absent).
            cells["gradeCompany"] = {
              value: split.gradeCompany,
              rawHeader,
              outcome: "ok",
            };
            cells["gradeValue"] = {
              value: split.gradeValue,
              rawHeader,
              outcome: "ok",
            };
            if (split.qualifier && split.qualifier.length > 0) {
              // Qualifier ("Black Label", "Pristine") gets appended to
              // notes so the visual distinction survives the round-trip.
              const existingNote = cells["notes"]?.value as string | undefined;
              const noteBits = [existingNote, `Condition: ${split.qualifier}`].filter(Boolean);
              cells["notes"] = {
                value: noteBits.join(" · "),
                rawHeader,
                outcome: "ok",
              };
            }
          }
        } else {
          // Non-standard condition string — carry it through as a note
          // so nothing is silently lost.
          const existingNote = cells["notes"]?.value as string | undefined;
          const noteBits = [existingNote, `Condition: ${s.trim()}`].filter(Boolean);
          cells["notes"] = {
            value: noteBits.join(" · "),
            rawHeader,
            outcome: "ok",
          };
          flags.push({ column: "condition", reason: `Couldn't split "${s.trim()}" into grade company + value` });
        }
        continue;
      }

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

      // CF-CARDLADDER-IMPORT: don't overwrite an already-populated
      // cell with an empty value. Two sheet columns can target the
      // same canonical (Card Ladder's Population + Notes both map to
      // "notes"; condition-qualifier also writes there). Iteration
      // order is column order, so an empty Notes column that comes
      // AFTER a populated Population column was clobbering the good
      // data. First-non-empty-wins semantics guard the notes / string
      // fields against that.
      const existing = cells[canonical];
      if (
        existing
        && (existing.value !== null && existing.value !== undefined && existing.value !== "")
        && (parsed.value === null || parsed.value === undefined || parsed.value === "")
      ) {
        continue;
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
