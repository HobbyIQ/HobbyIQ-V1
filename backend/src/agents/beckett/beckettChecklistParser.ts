/**
 * Beckett Checklist Parser
 * ---------------------------------------------------------------------------
 * Parses Beckett's `.xlsx` set-checklist files into a structured intermediate
 * representation that captures every card category Beckett publishes:
 *   - Base cards
 *   - Inserts
 *   - Parallels (with print runs)
 *   - Autographs
 *   - Relics
 *   - Numbered variants
 *
 * Authorization for fetching the upstream files is recorded in
 * `backend/docs/data-sources.md`.
 *
 * Design principles:
 *   - Defensive over clever. Sheets vary by set; when the structure is
 *     unrecognized we emit a diagnostic and continue — never silently drop
 *     rows.
 *   - Audit trail. Every parsed card carries its raw cell array.
 *   - Phase A is read-only. The output of this parser is consumed in Phase B
 *     when it is written to `parallel_attributes` + the multiplier table.
 *
 * The intermediate representation is intentionally a superset of what
 * Phase B needs so we can audit before committing schemas.
 */

import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RawRow = (string | number | boolean | null)[];

/** A parallel/insert color tier with its print run (when stated). */
export interface ParsedParallel {
  /** "Sky Blue", "Gold", "Printing Plates", etc. */
  name: string;
  /** Numeric print run; `null` when stated as 1/1, missing, or unparseable. */
  printRun: number | null;
  /** True for "1/1" / "Superfractor" / "Platinum" style one-of-one tiers. */
  isOneOfOne: boolean;
  /**
   * Free-form note from parentheticals — e.g. "hobby only",
   * "each has Black, Cyan, Magenta and Yellow versions".
   */
  note: string | null;
  /** The raw text exactly as it appears in the workbook. */
  rawText: string;
}

/** A single card row extracted from a sheet. */
export interface ParsedCard {
  /** Card number as printed (e.g. "BP-1", "BCP-141", "BDB-AM", "36"). */
  cardNumber: string | null;
  /** Player or subject (always populated when row classified as a card). */
  player: string | null;
  /** Team / affiliation when present. */
  team: string | null;
  /** True when the row carried an "RC" or "(RC)" marker. */
  isRookie: boolean;
  /** True when the row carried a "1st" / "1st Bowman" marker. */
  isFirstBowman: boolean;
  /** True when the row was inside an "Autographs" sheet/section. */
  isAutograph: boolean;
  /** True when the row was inside a "Relics" sheet/section. */
  isRelic: boolean;
  /** Inline per-card print run (e.g. /99 stamped on a single auto row). */
  inlinePrintRun: number | null;
  /** Free-form marker tokens we did not interpret. */
  extraMarkers: string[];
  /** Section header this card belongs to (e.g. "Bowman Base Set"). */
  section: string | null;
  /** Sheet name this card was read from. */
  sheet: string;
  /** Original cell array for full audit trail. */
  rawRow: RawRow;
  /** 0-based row index inside the source sheet. */
  rowIndex: number;
}

/** Logical sub-section inside a sheet (one section per checklist heading). */
export interface ParsedSection {
  /** "Bowman Base Set", "Bowman Chrome Prospects Autographs Checklist", etc. */
  name: string;
  /** Sheet name this section was read from. */
  sheet: string;
  /** Stated card count when a "X cards." line was present. */
  declaredCount: number | null;
  /** Parallels associated with this section. */
  parallels: ParsedParallel[];
  /** Cards belonging to this section. */
  cards: ParsedCard[];
  /** Section is autograph-flavored (sheet name or header contains "Auto"). */
  isAutograph: boolean;
  /** Section is relic-flavored. */
  isRelic: boolean;
  /** Per-section parser diagnostics. */
  diagnostics: ParserDiagnostic[];
}

/** A diagnostic is anything the parser could not fully interpret. */
export interface ParserDiagnostic {
  level: "info" | "warn" | "error";
  sheet: string;
  rowIndex: number | null;
  message: string;
  rawRow: RawRow | null;
}

export interface BeckettChecklistParsed {
  /** Captured metadata. Caller is responsible for stamping year/brand/sport. */
  meta: {
    sheetNames: string[];
    parsedAt: string;
    sourceLabel?: string;
  };
  /** All sections across all sheets, in workbook order. */
  sections: ParsedSection[];
  /**
   * Flat denormalized view of every card from every section/sheet — useful
   * for Phase B's bulk write to `parallel_attributes`.
   */
  cards: ParsedCard[];
  /** Aggregated, deduped parallels across every section. */
  parallels: ParsedParallel[];
  /** Workbook-level diagnostics. */
  diagnostics: ParserDiagnostic[];
}

export interface ParseOptions {
  /** Optional label stored in `meta.sourceLabel` for audit purposes. */
  sourceLabel?: string;
  /**
   * Force a specific sheet to be treated as flat tabular (each row = card).
   * Defaults to {"Teams","Master"} by case-insensitive name match.
   */
  flatSheetNames?: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseBeckettChecklist(
  bytes: Uint8Array | Buffer | ArrayBuffer,
  options: ParseOptions = {},
): BeckettChecklistParsed {
  // SheetJS accepts a Buffer or Uint8Array; normalize via "buffer" type.
  const input =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : (bytes as Buffer);

  const wb = XLSX.read(input, { type: "buffer" });
  const sheetNames = wb.SheetNames.slice();
  const flatSheetSet = new Set(
    (options.flatSheetNames ?? ["Teams", "Master"]).map((s) =>
      s.toLowerCase(),
    ),
  );

  const allSections: ParsedSection[] = [];
  const allCards: ParsedCard[] = [];
  const workbookDiagnostics: ParserDiagnostic[] = [];

  for (const sheetName of sheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      workbookDiagnostics.push({
        level: "warn",
        sheet: sheetName,
        rowIndex: null,
        message: "Sheet present in SheetNames but has no body — skipped.",
        rawRow: null,
      });
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, {
      header: 1,
      blankrows: false,
      defval: null,
    });

    if (rows.length === 0) {
      workbookDiagnostics.push({
        level: "info",
        sheet: sheetName,
        rowIndex: null,
        message: "Empty sheet — skipped.",
        rawRow: null,
      });
      continue;
    }

    if (flatSheetSet.has(sheetName.toLowerCase())) {
      const flatSection = parseFlatSheet(sheetName, rows);
      allSections.push(flatSection);
      allCards.push(...flatSection.cards);
    } else {
      const sections = parseHeaderStyleSheet(sheetName, rows);
      allSections.push(...sections);
      for (const sec of sections) allCards.push(...sec.cards);
    }
  }

  const parallels = dedupeParallels(
    allSections.flatMap((s) => s.parallels),
  );

  return {
    meta: {
      sheetNames,
      parsedAt: new Date().toISOString(),
      sourceLabel: options.sourceLabel,
    },
    sections: allSections,
    cards: allCards,
    parallels,
    diagnostics: workbookDiagnostics,
  };
}

// ---------------------------------------------------------------------------
// Sheet parsers
// ---------------------------------------------------------------------------

function parseHeaderStyleSheet(
  sheetName: string,
  rows: RawRow[],
): ParsedSection[] {
  const sheetIsAutograph = /autograph/i.test(sheetName);
  const sheetIsRelic = /relic/i.test(sheetName);

  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  let mode: "data" | "parallels" = "data";

  const openSection = (name: string): ParsedSection => {
    const sec: ParsedSection = {
      name,
      sheet: sheetName,
      declaredCount: null,
      parallels: [],
      cards: [],
      isAutograph: sheetIsAutograph || /autograph/i.test(name),
      isRelic: sheetIsRelic || /relic/i.test(name),
      diagnostics: [],
    };
    sections.push(sec);
    return sec;
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const classification = classifyRow(row);

    switch (classification.kind) {
      case "blank":
        // Blank rows close parallel-collection mode but keep the section.
        mode = "data";
        break;

      case "section-header": {
        current = openSection(classification.text);
        mode = "data";
        break;
      }

      case "count": {
        if (!current) {
          // Implicit section: the workbook started with a count line; back-fill.
          current = openSection(`(${sheetName})`);
        }
        current.declaredCount = classification.count;
        break;
      }

      case "parallels-marker":
        if (!current) current = openSection(`(${sheetName})`);
        mode = "parallels";
        break;

      case "parallel-or-prose": {
        if (!current) current = openSection(`(${sheetName})`);
        if (mode === "parallels") {
          const parallel = parseParallelText(classification.text);
          if (parallel) {
            current.parallels.push(parallel);
          } else {
            current.diagnostics.push({
              level: "info",
              sheet: sheetName,
              rowIndex: i,
              message:
                `Parallels-mode row did not match print-run pattern: ` +
                `"${classification.text}". Captured as raw note.`,
              rawRow: row,
            });
            current.parallels.push({
              name: classification.text,
              printRun: null,
              isOneOfOne: false,
              note: null,
              rawText: classification.text,
            });
          }
        } else {
          // Stray prose outside parallels mode — log but don't drop.
          current.diagnostics.push({
            level: "warn",
            sheet: sheetName,
            rowIndex: i,
            message:
              `Single-column prose row outside parallels mode: ` +
              `"${classification.text}". Skipped (not a card).`,
            rawRow: row,
          });
        }
        break;
      }

      case "card": {
        if (!current) current = openSection(`(${sheetName})`);
        mode = "data";
        const card = buildCardFromRow({
          row,
          rowIndex: i,
          sheet: sheetName,
          section: current.name,
          isAutographSection: current.isAutograph,
          isRelicSection: current.isRelic,
          numberCell: classification.numberCell,
        });
        current.cards.push(card);
        break;
      }

      case "unknown": {
        if (!current) current = openSection(`(${sheetName})`);
        current.diagnostics.push({
          level: "warn",
          sheet: sheetName,
          rowIndex: i,
          message: `Unrecognized row shape — skipped.`,
          rawRow: row,
        });
        break;
      }
    }
  }

  return sections;
}

/**
 * Flat sheets (Teams, Master) are tabular: each row is a card. The first
 * non-null cells differ — Teams leads with team, Master leads with set name —
 * but in both cases the player + card-number can be located by inspecting
 * the first few cells.
 */
function parseFlatSheet(sheetName: string, rows: RawRow[]): ParsedSection {
  const section: ParsedSection = {
    name: sheetName,
    sheet: sheetName,
    declaredCount: null,
    parallels: [],
    cards: [],
    isAutograph: /autograph/i.test(sheetName),
    isRelic: /relic/i.test(sheetName),
    diagnostics: [],
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (isBlankRow(row)) continue;

    // Locate the card number: first cell whose value matches a card-number
    // pattern (integer or alphanumeric like BP-12 / BCP-141 / BDB-AM).
    let numberIdx = -1;
    for (let c = 0; c < row.length; c += 1) {
      if (looksLikeCardNumber(row[c])) {
        numberIdx = c;
        break;
      }
    }

    if (numberIdx === -1) {
      section.diagnostics.push({
        level: "warn",
        sheet: sheetName,
        rowIndex: i,
        message:
          `Flat-sheet row has no card-number cell — skipped. ` +
          `Expected an integer or alphanumeric token like "BP-12".`,
        rawRow: row,
      });
      continue;
    }

    const playerIdx = nextNonNull(row, numberIdx + 1);
    const teamIdx = nextNonNullNonMarker(row, playerIdx + 1);

    // First column before the number (when present) is team-or-set context.
    const contextCell = numberIdx > 0 ? row[0] : null;
    const setOrTeam =
      typeof contextCell === "string" && contextCell.trim() !== ""
        ? contextCell.trim()
        : null;

    const markers = collectMarkers(row, [numberIdx, playerIdx, teamIdx]);

    section.cards.push({
      cardNumber: String(row[numberIdx]).trim(),
      player: stringOrNull(row[playerIdx]),
      team: stringOrNull(row[teamIdx]),
      isRookie: markers.isRookie,
      isFirstBowman: markers.isFirstBowman,
      isAutograph: section.isAutograph,
      isRelic: section.isRelic,
      inlinePrintRun: markers.inlinePrintRun,
      extraMarkers: markers.extras,
      section: setOrTeam ?? section.name,
      sheet: sheetName,
      rawRow: row,
      rowIndex: i,
    });
  }

  return section;
}

// ---------------------------------------------------------------------------
// Row classification
// ---------------------------------------------------------------------------

type Classification =
  | { kind: "blank" }
  | { kind: "section-header"; text: string }
  | { kind: "count"; count: number }
  | { kind: "parallels-marker" }
  | { kind: "parallel-or-prose"; text: string }
  | { kind: "card"; numberCell: number }
  | { kind: "unknown" };

function classifyRow(row: RawRow): Classification {
  if (isBlankRow(row)) return { kind: "blank" };

  const populated = row
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v !== null && x.v !== "");

  if (populated.length === 0) return { kind: "blank" };

  // --- card-number-led rows ---------------------------------------------
  // A row whose first non-null cell parses as a card number AND has more
  // populated cells (player/team) is a card row.
  const firstIdx = populated[0]!.i;
  if (looksLikeCardNumber(row[firstIdx]) && populated.length >= 2) {
    return { kind: "card", numberCell: firstIdx };
  }

  // Autograph buyback style: col 0 null, col 1 player name.
  if (
    row[0] === null &&
    typeof row[1] === "string" &&
    (row[1] as string).trim() !== ""
  ) {
    // Use the synthetic numberCell of -1 to indicate "no number on this row".
    return { kind: "card", numberCell: -1 };
  }

  // --- single-column text rows (headers / counts / parallels) -----------
  if (populated.length === 1 && firstIdx === 0) {
    const text = String(row[0]).trim();
    if (text === "") return { kind: "blank" };

    if (/^Parallels?:\s*$/i.test(text)) {
      return { kind: "parallels-marker" };
    }

    const countMatch = text.match(/^(\d+)\s+(?:cards?|players?|subjects?)\.?$/i);
    if (countMatch) {
      return { kind: "count", count: Number(countMatch[1]) };
    }

    // Anything else single-col we treat either as a section header or as
    // a parallel/prose line — the caller's state machine decides via `mode`.
    if (looksLikeSectionHeader(text)) {
      return { kind: "section-header", text };
    }
    return { kind: "parallel-or-prose", text };
  }

  return { kind: "unknown" };
}

function looksLikeSectionHeader(text: string): boolean {
  // Headers end in "Checklist" / "Set" / "Cards" or look like a title-case
  // phrase ("Bowman in 3-D Autographs Checklist", "Bowman Base Set").
  if (/checklist\s*$/i.test(text)) return true;
  if (/\bset\s*$/i.test(text)) return true;
  if (/\bautographs?\s*$/i.test(text)) return true;
  if (/\brelics?\s*$/i.test(text)) return true;
  // Avoid classifying short parallel names like "Red - /5" — those carry a
  // ` - /N` token and never reach here because parallel-or-prose handles them.
  return false;
}

// ---------------------------------------------------------------------------
// Card row → ParsedCard
// ---------------------------------------------------------------------------

function buildCardFromRow(args: {
  row: RawRow;
  rowIndex: number;
  sheet: string;
  section: string;
  isAutographSection: boolean;
  isRelicSection: boolean;
  numberCell: number;
}): ParsedCard {
  const { row, rowIndex, sheet, section, numberCell } = args;

  let cardNumber: string | null = null;
  let firstAfterNumber: number;

  if (numberCell >= 0) {
    cardNumber = String(row[numberCell]).trim();
    firstAfterNumber = numberCell + 1;
  } else {
    // No card number on this row (e.g. buyback autograph players).
    cardNumber = null;
    firstAfterNumber = 0;
  }

  const playerIdx = nextNonNull(row, firstAfterNumber);
  const teamIdx = nextNonNullNonMarker(row, playerIdx + 1);

  const markers = collectMarkers(row, [numberCell, playerIdx, teamIdx]);

  return {
    cardNumber,
    player: stringOrNull(row[playerIdx]),
    team: stringOrNull(row[teamIdx]),
    isRookie: markers.isRookie,
    isFirstBowman: markers.isFirstBowman,
    isAutograph: args.isAutographSection,
    isRelic: args.isRelicSection,
    inlinePrintRun: markers.inlinePrintRun,
    extraMarkers: markers.extras,
    section,
    sheet,
    rawRow: row,
    rowIndex,
  };
}

interface MarkerSet {
  isRookie: boolean;
  isFirstBowman: boolean;
  inlinePrintRun: number | null;
  extras: string[];
}

function collectMarkers(row: RawRow, skipIndices: number[]): MarkerSet {
  const skip = new Set(skipIndices);
  const out: MarkerSet = {
    isRookie: false,
    isFirstBowman: false,
    inlinePrintRun: null,
    extras: [],
  };
  for (let i = 0; i < row.length; i += 1) {
    if (skip.has(i)) continue;
    const v = row[i];
    if (v === null || v === "") continue;
    const text = String(v).trim();
    if (text === "") continue;

    if (/^\(?RC\)?$/i.test(text)) {
      out.isRookie = true;
      continue;
    }
    if (/^1st(\s+Bowman)?$/i.test(text)) {
      out.isFirstBowman = true;
      continue;
    }
    const pr = text.match(/^\/(\d{1,5})$/);
    if (pr) {
      out.inlinePrintRun = Number(pr[1]);
      continue;
    }
    out.extras.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parallel text → ParsedParallel
// ---------------------------------------------------------------------------

const PARALLEL_PATTERNS: RegExp[] = [
  // "Sky Blue - /499", "Orange - /25 (hobby only)"
  /^(?<name>.+?)\s*-\s*\/(?<run>\d{1,5})(?:\s*\((?<note>[^)]+)\))?\s*$/i,
  // "Platinum - 1/1", "Superfractors - 1/1"
  /^(?<name>.+?)\s*-\s*1\s*\/\s*1(?:\s*\((?<note>[^)]+)\))?\s*$/i,
  // "Printing Plates - 1/1 (each has Black...)" handled by the prior pattern.
];

export function parseParallelText(text: string): ParsedParallel | null {
  const trimmed = text.trim();
  for (const re of PARALLEL_PATTERNS) {
    const m = trimmed.match(re);
    if (m && m.groups) {
      const isOneOfOne = !m.groups.run;
      const printRun = m.groups.run ? Number(m.groups.run) : null;
      return {
        name: m.groups.name.trim(),
        printRun,
        isOneOfOne,
        note: m.groups.note ? m.groups.note.trim() : null,
        rawText: text,
      };
    }
  }
  return null;
}

function dedupeParallels(parallels: ParsedParallel[]): ParsedParallel[] {
  const seen = new Map<string, ParsedParallel>();
  for (const p of parallels) {
    const key = `${p.name.toLowerCase()}::${p.printRun ?? "1of1"}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

function isBlankRow(row: RawRow): boolean {
  for (const v of row) {
    if (v !== null && v !== "" && !(typeof v === "string" && v.trim() === "")) {
      return false;
    }
  }
  return true;
}

function nextNonNull(row: RawRow, from: number): number {
  for (let i = from; i < row.length; i += 1) {
    const v = row[i];
    if (v !== null && v !== "" && !(typeof v === "string" && v.trim() === "")) {
      return i;
    }
  }
  return row.length; // out-of-range sentinel — `row[len]` is `undefined` → null
}

/**
 * Like `nextNonNull` but skips cells that look like markers (RC, 1st, /N).
 * Used when locating the team column so trailing markers aren't claimed as
 * the team name.
 */
function nextNonNullNonMarker(row: RawRow, from: number): number {
  for (let i = from; i < row.length; i += 1) {
    const v = row[i];
    if (v === null || v === "") continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (looksLikeMarker(v)) continue;
    return i;
  }
  return row.length;
}

function looksLikeMarker(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const t = String(v).trim();
  if (t === "") return false;
  if (/^\(?RC\)?$/i.test(t)) return true;
  if (/^1st(\s+Bowman)?$/i.test(t)) return true;
  if (/^\/\d{1,5}$/.test(t)) return true;
  return false;
}

function stringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Card number heuristic: a positive integer, or an alphanumeric token with an
 * internal dash (e.g. "BP-1", "BCP-141", "BDB-AM", "CPA-LD", "B3D-15"). The
 * prefix may contain digits (e.g. "B3D") provided it also contains at least
 * one letter — that lookahead is what prevents a plain "1-5" from being
 * mis-classified as a card number.
 */
export function looksLikeCardNumber(v: unknown): boolean {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 100000) {
    return Number.isInteger(v);
  }
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (t === "") return false;
  if (/^\d{1,5}$/.test(t)) return true;
  // Alphanumeric prefix (must contain a letter) + dash + alphanumerics:
  // BP-1, BCP-141, BDB-AM, CPA-LD, BDC-116, B3D-15.
  if (/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{1,5}-[A-Z0-9]{1,6}$/i.test(t)) return true;
  return false;
}
