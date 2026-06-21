// CF-IMPORT-BE (2026-06-21) — date cell parser with confidence classification.
//
// Don't-guess discipline per the banked guardrail: ISO 8601 + Excel-serial
// + unambiguous "Apr 15, 2026"-style formats parse confidently; ambiguous
// formats (12/05/2024 — MM/DD vs DD/MM) get flagged in the preview, never
// silently coerced.

export type DateConfidence = "confident" | "ambiguous" | "invalid" | "empty";

export interface DateParseResult {
  /** Parsed ISO-8601 date string (YYYY-MM-DD), or null. */
  value: string | null;
  confidence: DateConfidence;
  reason?: string;
}

const EMPTY_SENTINELS = new Set(["", "-", "n/a", "na", "null", "none", "—", "–"]);

// Excel serial-date epoch: 1900-01-01 = serial 1. (Excel quirks: serial 60
// doesn't exist for a non-leap-year — Lotus bug Excel inherited. We use the
// standard "1899-12-30 + serial days" formula that handles real dates 1900+.)
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * Parse a cell value into an ISO-8601 date string + confidence tag.
 *
 * Confident:
 *   - ISO 8601 (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)
 *   - Excel serial number (numeric, in range)
 *   - Unambiguous month-name formats: "Apr 15, 2026", "15 Apr 2026", "2026-Apr-15"
 *
 * Ambiguous:
 *   - "12/05/2024" (MM/DD vs DD/MM — flag, don't guess)
 *   - Similar slash/dash separators with all-numeric pieces
 *
 * Invalid:
 *   - Genuinely unparseable strings.
 *
 * Empty:
 *   - null/undefined/empty/sentinel-empty.
 */
export function parseDate(input: unknown): DateParseResult {
  if (input === null || input === undefined) {
    return { value: null, confidence: "empty" };
  }

  // Excel serial (numeric input)
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 1 || input > 1_000_000) {
      return { value: null, confidence: "invalid", reason: "numeric outside Excel serial range" };
    }
    const ms = EXCEL_EPOCH_MS + input * 86_400_000;
    return { value: isoDate(new Date(ms)), confidence: "confident" };
  }

  const raw = String(input);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || EMPTY_SENTINELS.has(trimmed.toLowerCase())) {
    return { value: null, confidence: "empty" };
  }

  // ISO 8601 (YYYY-MM-DD or full timestamp)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(T|$)/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (isValidYMD(y, m, d)) {
      return { value: `${pad4(y)}-${pad2(m)}-${pad2(d)}`, confidence: "confident" };
    }
    return { value: null, confidence: "invalid", reason: `ISO-shaped but not a valid date: "${raw}"` };
  }

  // Excel serial as a string (e.g. "45397")
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 1 && n < 1_000_000) {
      const ms = EXCEL_EPOCH_MS + n * 86_400_000;
      return { value: isoDate(new Date(ms)), confidence: "confident" };
    }
  }

  // Month-name formats: confident
  // "Apr 15, 2026", "15 Apr 2026", "April 15, 2026", "2026-Apr-15", etc.
  const monthName = parseMonthNameFormat(trimmed);
  if (monthName) {
    return { value: monthName, confidence: "confident" };
  }

  // Numeric slash/dash separators: AMBIGUOUS (MM/DD vs DD/MM)
  // Match patterns like 12/05/2024, 12-05-2024, 5/12/24, etc.
  const slashMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slashMatch) {
    const a = Number(slashMatch[1]);
    const b = Number(slashMatch[2]);
    const yRaw = Number(slashMatch[3]);
    // Year inference: 2-digit → +2000 if <50 else +1900 (Excel convention)
    const year = yRaw < 100 ? (yRaw < 50 ? 2000 + yRaw : 1900 + yRaw) : yRaw;

    // Unambiguous case: one of the components is > 12 → can't be a month
    if (a > 12 && b <= 12) {
      // DD/MM/YYYY clearly (e.g. "15/04/2026")
      if (isValidYMD(year, b, a)) {
        return { value: `${pad4(year)}-${pad2(b)}-${pad2(a)}`, confidence: "confident" };
      }
    }
    if (b > 12 && a <= 12) {
      // MM/DD/YYYY clearly (e.g. "04/15/2026")
      if (isValidYMD(year, a, b)) {
        return { value: `${pad4(year)}-${pad2(a)}-${pad2(b)}`, confidence: "confident" };
      }
    }
    if (a <= 12 && b <= 12) {
      // Genuinely ambiguous — flag for user resolution
      return {
        value: null,
        confidence: "ambiguous",
        reason: `"${raw}" could be MM/DD/YYYY or DD/MM/YYYY — please disambiguate during review`,
      };
    }
    // Both > 12: invalid
    return { value: null, confidence: "invalid", reason: `"${raw}" has invalid month/day` };
  }

  return { value: null, confidence: "invalid", reason: `unrecognized date format: "${raw}"` };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function pad4(n: number): string {
  return n < 10 ? `000${n}` : n < 100 ? `00${n}` : n < 1000 ? `0${n}` : String(n);
}
function isoDate(d: Date): string {
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function isValidYMD(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 9999) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Cross-check via Date roundtrip
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const MONTHS_LONG: ReadonlyArray<string> = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTHS_SHORT: ReadonlyArray<string> = MONTHS_LONG.map((m) => m.slice(0, 3));

function monthIndex(name: string): number | null {
  const lc = name.toLowerCase();
  const longIdx = MONTHS_LONG.indexOf(lc);
  if (longIdx >= 0) return longIdx;
  const shortIdx = MONTHS_SHORT.indexOf(lc);
  if (shortIdx >= 0) return shortIdx;
  return null;
}

function parseMonthNameFormat(s: string): string | null {
  // "Apr 15, 2026" / "April 15, 2026" / "Apr 15 2026"
  const m1 = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:,\s*|\s+)(\d{4})$/);
  if (m1) {
    const mi = monthIndex(m1[1]!);
    const d = Number(m1[2]);
    const y = Number(m1[3]);
    if (mi !== null && isValidYMD(y, mi + 1, d)) {
      return `${pad4(y)}-${pad2(mi + 1)}-${pad2(d)}`;
    }
  }
  // "15 Apr 2026" / "15 April 2026"
  const m2 = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (m2) {
    const mi = monthIndex(m2[2]!);
    const d = Number(m2[1]);
    const y = Number(m2[3]);
    if (mi !== null && isValidYMD(y, mi + 1, d)) {
      return `${pad4(y)}-${pad2(mi + 1)}-${pad2(d)}`;
    }
  }
  // "2026-Apr-15" / "2026-April-15"
  const m3 = s.match(/^(\d{4})-([A-Za-z]+)\.?-(\d{1,2})$/);
  if (m3) {
    const mi = monthIndex(m3[2]!);
    const y = Number(m3[1]);
    const d = Number(m3[3]);
    if (mi !== null && isValidYMD(y, mi + 1, d)) {
      return `${pad4(y)}-${pad2(mi + 1)}-${pad2(d)}`;
    }
  }
  return null;
}
