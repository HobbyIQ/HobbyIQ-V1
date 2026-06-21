// CF-EXPORT-BE (2026-06-21): holdings → .xlsx/.csv export.
//
// Ships the canonical 28-column schema CF-IMPORT-BE will consume as its
// round-trip contract. Column order is deliberate:
//   1. Stable identity (cardsightCardId, holdingId) — the import's
//      resolution-free anchor. Re-import without editing these = zero
//      resolver calls.
//   2. Card identity (user-editable; drives resolver fallback when
//      cardsightCardId absent).
//   3. Grade.
//   4. Acquisition (full user-editable surface).
//   5. Listing intent.
//   6. Computed / read-only (engine-derived; warned-if-edited, ignored on
//      import).
//
// Computed columns are exported with the user-visible values so the
// spreadsheet is useful as a snapshot — they're explicitly read-only on
// import so a user-edit doesn't silently override engine numbers.

import * as XLSX from "xlsx";
import type { PortfolioHoldingWire } from "./responseAssembly.js";

export type ExportFormat = "xlsx" | "csv";

/**
 * Canonical column order. Add fields here (and only here) — the import
 * pipeline reads this list as its template definition, so the export
 * schema is the import contract.
 */
export interface ExportColumn {
  /** Spreadsheet header text. */
  header: string;
  /** Holding-wire property key. */
  key: keyof PortfolioHoldingWire;
  /**
   * "identity"   — stable FK / id. Resolution-free re-import anchor.
   * "identity-edit" — card identity, user-editable, drives resolver fallback.
   * "grade"      — grade/cert metadata.
   * "acquisition" — full user-editable.
   * "listing"    — listing intent.
   * "computed"   — engine-derived. READ-ONLY on import.
   */
  group:
    | "identity"
    | "identity-edit"
    | "grade"
    | "acquisition"
    | "listing"
    | "computed";
}

export const EXPORT_COLUMNS: ReadonlyArray<ExportColumn> = [
  // ─── Stable identity (round-trip anchor) ───────────────────────────────
  { header: "holdingId",            key: "id",                  group: "identity" },
  { header: "cardsightCardId",      key: "cardsightCardId",     group: "identity" },
  { header: "cardsightGradeId",     key: "cardsightGradeId",    group: "identity" },
  // ─── Card identity (user-editable; resolver fallback) ──────────────────
  { header: "playerName",           key: "playerName",          group: "identity-edit" },
  { header: "cardYear",             key: "cardYear",            group: "identity-edit" },
  { header: "product",              key: "product",             group: "identity-edit" },
  { header: "cardTitle",            key: "cardTitle",           group: "identity-edit" },
  { header: "cardNumber",           key: "cardNumber",          group: "identity-edit" },
  { header: "parallel",             key: "parallel",            group: "identity-edit" },
  { header: "variation",            key: "variation",           group: "identity-edit" },
  { header: "serialNumber",         key: "serialNumber",        group: "identity-edit" },
  { header: "isAuto",               key: "isAuto",              group: "identity-edit" },
  // ─── Grade ──────────────────────────────────────────────────────────────
  { header: "gradeCompany",         key: "gradeCompany",        group: "grade" },
  { header: "gradeValue",           key: "gradeValue",          group: "grade" },
  { header: "certNumber",           key: "certNumber",          group: "grade" },
  { header: "certGrader",           key: "certGrader",          group: "grade" },
  // ─── Acquisition ────────────────────────────────────────────────────────
  { header: "quantity",             key: "quantity",            group: "acquisition" },
  { header: "purchasePrice",        key: "purchasePrice",       group: "acquisition" },
  { header: "totalCostBasis",       key: "totalCostBasis",      group: "acquisition" },
  { header: "purchaseDate",         key: "purchaseDate",        group: "acquisition" },
  { header: "purchaseSource",       key: "purchaseSource",      group: "acquisition" },
  { header: "notes",                key: "notes",               group: "acquisition" },
  // ─── Listing intent ─────────────────────────────────────────────────────
  { header: "listingPrice",         key: "listingPrice",        group: "listing" },
  { header: "listingUrl",           key: "listingUrl",          group: "listing" },
  // ─── Computed (READ-ONLY on import) ────────────────────────────────────
  { header: "fairMarketValue",      key: "fairMarketValue",     group: "computed" },
  { header: "estimatedValue",       key: "estimatedValue",      group: "computed" },
  { header: "valuationStatus",      key: "valuationStatus",     group: "computed" },
  { header: "totalProfitLoss",      key: "totalProfitLoss",     group: "computed" },
  { header: "totalProfitLossPct",   key: "totalProfitLossPct",  group: "computed" },
  { header: "currentValue",         key: "currentValue",        group: "computed" },
  { header: "lastUpdated",          key: "lastUpdated",         group: "computed" },
];

/** Headers in canonical order — the import side reads this for round-trip detection. */
export function exportColumnHeaders(): string[] {
  return EXPORT_COLUMNS.map((c) => c.header);
}

/** Headers that are READ-ONLY on import (computed group). */
export function readonlyImportHeaders(): string[] {
  return EXPORT_COLUMNS.filter((c) => c.group === "computed").map((c) => c.header);
}

function cellValue(holding: PortfolioHoldingWire, key: keyof PortfolioHoldingWire): unknown {
  const v = holding[key];
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return v.join(", "); // photos field — defensive
  return v;
}

/**
 * Build the export rows in canonical column order.
 * Exported separately from XLSX/CSV serialization so tests can lock the
 * row shape without parsing a workbook.
 */
export function buildExportRows(
  holdings: ReadonlyArray<PortfolioHoldingWire>,
): Array<Record<string, unknown>> {
  return holdings.map((h) => {
    const row: Record<string, unknown> = {};
    for (const col of EXPORT_COLUMNS) {
      row[col.header] = cellValue(h, col.key);
    }
    return row;
  });
}

/**
 * Build the workbook + filename for download. Returns:
 *   - format=xlsx: ArrayBuffer (Express's res.send accepts Buffer; we wrap in Buffer.from)
 *   - format=csv:  utf-8 string
 */
export interface ExportPayload {
  buffer: Buffer | string;
  contentType: string;
  filename: string;
}

export function buildHoldingsExport(
  holdings: ReadonlyArray<PortfolioHoldingWire>,
  format: ExportFormat,
  now: Date = new Date(),
): ExportPayload {
  const rows = buildExportRows(holdings);
  const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD

  if (format === "csv") {
    const csv = buildCsv(rows);
    return {
      buffer: csv,
      contentType: "text/csv; charset=utf-8",
      filename: `hobbyiq-holdings-${stamp}.csv`,
    };
  }

  // xlsx
  const headers = exportColumnHeaders();
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Holdings");
  const xlsxArrayBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return {
    buffer: xlsxArrayBuf,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: `hobbyiq-holdings-${stamp}.xlsx`,
  };
}

/**
 * Minimal CSV builder. RFC-4180-ish: comma-delimited, double-quote
 * escaping, CRLF row terminator. No external dep — the import side will
 * parse with `xlsx`'s CSV reader for round-trip symmetry.
 */
function buildCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  const headers = exportColumnHeaders();
  const lines: string[] = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\r\n");
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\"") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
