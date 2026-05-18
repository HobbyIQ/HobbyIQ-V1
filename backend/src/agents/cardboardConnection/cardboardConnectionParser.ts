/**
 * Cardboard Connection Checklist Parser
 * ---------------------------------------------------------------------------
 * Authorization and provenance are documented in `backend/docs/data-sources.md`.
 *
 * Cardboard Connection's workbook layout is not Beckett-identical. The sample
 * (2022 Topps Series 1 Baseball) is a single-sheet stream with section headers
 * (BASE SET / INSERT / AUTOGRAPH / RELIC + subsection labels) followed by card
 * rows. This parser uses CC-specific section detection while preserving the
 * same downstream contract consumed by sweep staging.
 */

import * as XLSX from "xlsx";
import {
  type BeckettChecklistParsed,
  type ParsedCard,
  type ParsedParallel,
  type ParsedSection,
  type ParserDiagnostic,
  type RawRow,
  parseParallelText,
  looksLikeCardNumber,
} from "../beckett/beckettChecklistParser.js";

export interface CardboardConnectionParseOptions {
  sourceLabel?: string;
}

export function parseCardboardConnectionChecklist(
  bytes: Uint8Array | Buffer | ArrayBuffer,
  options: CardboardConnectionParseOptions = {},
): BeckettChecklistParsed {
  const input =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : (bytes as Buffer);

  const wb = XLSX.read(input, { type: "buffer" });
  const workbookDiagnostics: ParserDiagnostic[] = [];
  const sections: ParsedSection[] = [];
  const cards: ParsedCard[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      workbookDiagnostics.push({
        level: "warn",
        sheet: sheetName,
        rowIndex: null,
        message: "Sheet missing body; skipped.",
        rawRow: null,
      });
      continue;
    }

    const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, {
      header: 1,
      blankrows: false,
      defval: null,
    });

    const parsed = parseCardboardConnectionSheet(sheetName, rows);
    sections.push(...parsed.sections);
    cards.push(...parsed.cards);
    workbookDiagnostics.push(...parsed.diagnostics);
  }

  return {
    meta: {
      sheetNames: wb.SheetNames.slice(),
      parsedAt: new Date().toISOString(),
      sourceLabel: options.sourceLabel,
    },
    sections,
    cards,
    parallels: dedupeParallels(sections.flatMap((s) => s.parallels)),
    diagnostics: workbookDiagnostics,
  };
}

function parseCardboardConnectionSheet(
  sheetName: string,
  rows: RawRow[],
): { sections: ParsedSection[]; cards: ParsedCard[]; diagnostics: ParserDiagnostic[] } {
  const sections: ParsedSection[] = [];
  const cards: ParsedCard[] = [];
  const diagnostics: ParserDiagnostic[] = [];

  let currentCategory: "base" | "insert" | "autograph" | "relic" = "base";
  let currentSection = openSection("UNSCOPED", sheetName, false, false);
  sections.push(currentSection);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    if (isBlankRow(row)) continue;

    if (isHeaderRow(row)) {
      const headerText = String(row[0]).trim();
      const normalized = normalizeHeader(headerText);

      if (normalized === "AUTOGRAPH") {
        currentCategory = "autograph";
      } else if (normalized === "RELIC") {
        currentCategory = "relic";
      } else if (normalized === "INSERT") {
        currentCategory = "insert";
      } else if (normalized === "BASE SET") {
        currentCategory = "base";
      }

      currentSection = openSection(
        headerText,
        sheetName,
        currentCategory === "autograph" || /AUTOGRAPH/i.test(headerText),
        currentCategory === "relic" || /RELIC/i.test(headerText),
      );
      sections.push(currentSection);

      if (/PARALLEL|VARIATION/i.test(headerText)) {
        const parallel = parseParallelHeader(headerText);
        currentSection.parallels.push(parallel);
      } else if (isPackagingHeader(headerText)) {
        currentSection.diagnostics.push({
          level: "info",
          sheet: sheetName,
          rowIndex,
          message: `Packaging/distribution header captured: "${headerText}"`,
          rawRow: row,
        });
      }
      continue;
    }

    const card = parseCardRow({
      row,
      rowIndex,
      sheetName,
      sectionName: currentSection.name,
      isAutographSection: currentSection.isAutograph,
      isRelicSection: currentSection.isRelic,
    });

    if (card) {
      currentSection.cards.push(card);
      cards.push(card);
      continue;
    }

    currentSection.diagnostics.push({
      level: "warn",
      sheet: sheetName,
      rowIndex,
      message: "Unknown row shape; preserved for diagnostics.",
      rawRow: row,
    });
  }

  // Remove bootstrap placeholder if data opened real sections.
  const cleanedSections =
    sections.length > 1 && sections[0]?.name === "UNSCOPED"
      ? sections.slice(1)
      : sections;

  return { sections: cleanedSections, cards, diagnostics };
}

function parseCardRow(args: {
  row: RawRow;
  rowIndex: number;
  sheetName: string;
  sectionName: string;
  isAutographSection: boolean;
  isRelicSection: boolean;
}): ParsedCard | null {
  const { row, rowIndex, sheetName, sectionName, isAutographSection, isRelicSection } = args;

  const numberCell = row[0];
  if (!looksLikeCardNumber(numberCell)) return null;

  const player = stringOrNull(row[1]);
  const team = stringOrNull(row[2]);
  const marker = stringOrNull(row[3]);

  const markerTokens = marker ? [marker] : [];
  const normalizedMarker = marker?.toUpperCase() ?? "";

  // Preserve row even if expected columns are missing.
  if (!player) {
    return {
      cardNumber: String(numberCell).trim(),
      player: null,
      team,
      isRookie: false,
      isFirstBowman: false,
      isAutograph: isAutographSection,
      isRelic: isRelicSection,
      inlinePrintRun: null,
      extraMarkers: markerTokens,
      section: sectionName,
      sheet: sheetName,
      rawRow: row,
      rowIndex,
    };
  }

  return {
    cardNumber: String(numberCell).trim(),
    player,
    team,
    isRookie: /(^|\W)(RC|ROOKIE|ROOKIE CUP)(\W|$)/i.test(normalizedMarker),
    isFirstBowman: /(^|\W)1ST(\W|$)/i.test(normalizedMarker),
    isAutograph: isAutographSection,
    isRelic: isRelicSection,
    inlinePrintRun: parseInlinePrintRun([numberCell, player, team, marker]),
    extraMarkers: markerTokens,
    section: sectionName,
    sheet: sheetName,
    rawRow: row,
    rowIndex,
  };
}

function parseParallelHeader(headerText: string): ParsedParallel {
  const parsed = parseParallelText(headerText);
  if (parsed) return parsed;
  const slashMatch = headerText.match(/\/(\d{1,4})/);
  const run = slashMatch ? Number(slashMatch[1]) : null;
  return {
    name: headerText,
    printRun: Number.isFinite(run) ? run : null,
    isOneOfOne: /1\/1/i.test(headerText),
    note: null,
    rawText: headerText,
  };
}

function parseInlinePrintRun(cells: Array<unknown>): number | null {
  for (const cell of cells) {
    const text = typeof cell === "string" ? cell : "";
    const m = text.match(/\/(\d{1,4})/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

function openSection(
  name: string,
  sheet: string,
  isAutograph: boolean,
  isRelic: boolean,
): ParsedSection {
  return {
    name,
    sheet,
    declaredCount: null,
    parallels: [],
    cards: [],
    isAutograph,
    isRelic,
    diagnostics: [],
  };
}

function isHeaderRow(row: RawRow): boolean {
  const first = row[0];
  if (typeof first !== "string" || first.trim() === "") return false;
  if (looksLikeCardNumber(first)) return false;
  return row.slice(1).every((v) => v === null || String(v).trim() === "");
}

function normalizeHeader(text: string): string {
  return text.trim().toUpperCase();
}

function isPackagingHeader(text: string): boolean {
  return /HOBBY|RETAIL|BOXLOADER|EXCLUSIVE|JUMBO/i.test(text);
}

function isBlankRow(row: RawRow): boolean {
  return row.every((v) => v === null || String(v).trim() === "");
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function dedupeParallels(input: ParsedParallel[]): ParsedParallel[] {
  const out: ParsedParallel[] = [];
  const seen = new Set<string>();
  for (const p of input) {
    const key = `${p.name.toLowerCase()}|${p.printRun ?? "null"}|${p.isOneOfOne ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
