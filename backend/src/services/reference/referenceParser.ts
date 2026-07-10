// CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4). Workbook → document
// transformer. Reads a .xlsx via SheetJS and emits ParallelDoc[] / SetDoc[]
// ready for Cosmos bulk upsert.
//
// The four Phase 1 workbooks (Bowman, Topps, Other, Vintage) share the same
// sheet-level structure — a Master sheet (parallels) OR a Catalog sheet
// (vintage sets) — but differ in column headers per workbook. The parser
// coerces both into the canonical types.

import * as XLSX from "xlsx";
import { slug, sha1Id } from "../../shared/slug.js";
import {
  ParallelDoc,
  SetDoc,
  SCHEMA_VERSION,
  Confidence,
  isLicensedProduct,
} from "./referenceCatalog.types.js";

// ─── Header aliases — Phase 1 workbooks are not perfectly consistent ──
// Bowman workbook uses "Year / Product / Card Set / Parallel / Print Run /
// Numbered / Auto / Confidence / Notes". Topps + Other should match; the
// header-normalizer here means new workbooks with minor column drift still
// parse without a schema change.

const HEADER_ALIASES: Record<string, string> = {
  year: "year",
  product: "product",
  "card set": "cardSet",
  cardset: "cardSet",
  set: "cardSet",
  parallel: "parallel",
  "parallel name": "parallel",
  "print run": "printRun",
  printrun: "printRun",
  numbered: "numbered",
  auto: "auto",
  autograph: "auto",
  confidence: "confidence",
  notes: "notes",
  // Vintage set catalog columns
  "year text": "yearText",
  yeartext: "yearText",
  "set name": "setName",
  setname: "setName",
  manufacturer: "manufacturer",
  "set type": "setType",
  settype: "setType",
  type: "setType",
  "set size": "setSize",
  setsize: "setSize",
  size: "setSize",
  format: "format",
};

function normalizeHeader(h: string): string {
  const key = String(h).toLowerCase().trim();
  return HEADER_ALIASES[key] ?? key;
}

function pickSheet(
  workbook: XLSX.WorkBook,
  candidates: ReadonlyArray<string>,
): XLSX.WorkSheet | null {
  for (const name of candidates) {
    if (workbook.Sheets[name]) return workbook.Sheets[name];
    const ci = Object.keys(workbook.Sheets).find(
      (n) => n.toLowerCase() === name.toLowerCase(),
    );
    if (ci) return workbook.Sheets[ci];
  }
  return null;
}

/**
 * Read a workbook's data sheet as an array of row objects keyed by
 * normalized column names. Skips leading blank rows and preserves
 * printRun as-is (blank ↔ null downstream).
 */
function readRows(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  // header:1 returns an array-of-arrays; we normalize headers ourselves so
  // consistency across workbooks is one code path, not per-file overrides.
  const arr = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  if (arr.length === 0) return [];
  const headerRow = arr[0].map((c) => normalizeHeader(String(c ?? "").trim()));
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < arr.length; i++) {
    const cells = arr[i];
    if (!cells || cells.length === 0) continue;
    // A row with every cell empty is not a data row.
    const nonEmpty = cells.some((c) => c !== null && c !== undefined && String(c).trim() !== "");
    if (!nonEmpty) continue;
    const rec: Record<string, unknown> = {};
    for (let c = 0; c < headerRow.length; c++) {
      rec[headerRow[c]] = cells[c];
    }
    rows.push(rec);
  }
  return rows;
}

function parseInt10(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/[,\s]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolYN(v: unknown): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "y" || s === "yes" || s === "true" || s === "1";
}

function parseConfidence(v: unknown): Confidence {
  const s = String(v ?? "").trim().toLowerCase();
  if (s.startsWith("verified")) return "Verified";
  if (s.startsWith("high")) return "High";
  return "Medium";
}

export interface ParseParallelsOptions {
  /** Emitter for the "updatedAt" field on each doc. Injected for testability. */
  now?: () => string;
}

/**
 * Parse a Bowman / Topps / Other parallels workbook (buffer) into
 * ParallelDoc[]. Returns the ordered array plus a `sheetRowCount` so the
 * CLI can enforce parsed == source row parity as a pre-write gate.
 */
export function parseParallelsWorkbook(
  buf: Buffer,
  opts: ParseParallelsOptions = {},
): { docs: ParallelDoc[]; sheetRowCount: number; skipped: number } {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = pickSheet(wb, ["Master", "Parallels", "Sheet1"]);
  if (!sheet) {
    throw new Error(
      "parseParallelsWorkbook: no Master / Parallels / Sheet1 tab found. " +
        `Available tabs: ${Object.keys(wb.Sheets).join(", ")}`,
    );
  }
  const rows = readRows(sheet);
  const sheetRowCount = rows.length;
  const now = opts.now ?? (() => new Date().toISOString());
  const docs: ParallelDoc[] = [];
  let skipped = 0;

  for (const row of rows) {
    const year = parseInt10(row.year);
    const product = String(row.product ?? "").trim();
    const cardSet = String(row.cardSet ?? "").trim();
    const parallel = String(row.parallel ?? "").trim();
    if (year === null || !product || !cardSet || !parallel) {
      skipped++;
      continue;
    }
    const printRun = parseInt10(row.printRun);
    const numbered = parseBoolYN(row.numbered);
    const auto = parseBoolYN(row.auto);
    const notes = String(row.notes ?? "").trim();
    const runVaries = numbered && printRun === null;
    const perCardRun = /per[-\s]?card/i.test(notes);
    // perCardRun always emits printRun=null (spec guardrail).
    const emittedPrintRun = perCardRun ? null : printRun;
    const licensed = isLicensedProduct(product);
    const confidence = parseConfidence(row.confidence);
    const productKey = slug(product);
    const cardSetKey = slug(cardSet);
    const parallelKey = slug(parallel);
    const id = sha1Id(year, productKey, cardSetKey, parallelKey);
    docs.push({
      id,
      docType: "parallel",
      productKey,
      product,
      year,
      cardSetKey,
      cardSet,
      parallelKey,
      parallel,
      printRun: emittedPrintRun,
      numbered,
      runVaries,
      perCardRun,
      auto,
      licensed,
      confidence,
      notes,
      sourceUrl: null,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now(),
    });
  }

  return { docs, sheetRowCount, skipped };
}

/**
 * Parse a vintage-set-catalog workbook (buffer) into SetDoc[]. Same
 * parity contract as parseParallelsWorkbook.
 */
export function parseSetsWorkbook(
  buf: Buffer,
  opts: ParseParallelsOptions = {},
): { docs: SetDoc[]; sheetRowCount: number; skipped: number } {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = pickSheet(wb, ["Catalog", "Sets", "Master", "Sheet1"]);
  if (!sheet) {
    throw new Error(
      "parseSetsWorkbook: no Catalog / Sets / Master / Sheet1 tab found. " +
        `Available tabs: ${Object.keys(wb.Sheets).join(", ")}`,
    );
  }
  const rows = readRows(sheet);
  const sheetRowCount = rows.length;
  const now = opts.now ?? (() => new Date().toISOString());
  const docs: SetDoc[] = [];
  let skipped = 0;

  for (const row of rows) {
    const yearText = String(row.yearText ?? row.year ?? "").trim();
    const setName = String(row.setName ?? row.set ?? "").trim();
    if (!yearText || !setName) {
      skipped++;
      continue;
    }
    // sortYear: pick the first 4-digit number in yearText — handles
    // "1909-11", "1949–52", "1961", etc.
    const sortYearMatch = yearText.match(/\b(1[89]\d{2}|20\d{2})\b/);
    const sortYear = sortYearMatch ? parseInt(sortYearMatch[1], 10) : 0;
    const manufacturer = String(row.manufacturer ?? "").trim();
    const setType = String(row.setType ?? "").trim();
    const setSize = parseInt10(row.setSize);
    const format = String(row.format ?? "").trim();
    const notes = String(row.notes ?? "").trim();
    const confidence = String(row.confidence ?? "").trim();
    const setKey = slug(setName);
    const productKey = setKey;
    const id = sha1Id(yearText, setKey);
    docs.push({
      id,
      docType: "set",
      productKey,
      yearText,
      sortYear,
      setName,
      manufacturer,
      setType,
      setSize,
      format,
      notes,
      confidence,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now(),
    });
  }

  return { docs, sheetRowCount, skipped };
}
