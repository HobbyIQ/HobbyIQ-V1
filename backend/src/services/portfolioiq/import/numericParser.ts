// CF-IMPORT-BE (2026-06-21) — numeric cell parser with strict/lenient modes.
//
// Per the banked CF-IMPORT-BE numerics-raw guardrail:
//   - Round-trip path  → strict (reject malformed; format drift IS corruption)
//   - Arbitrary path   → lenient on unambiguous formatting ($/,/%/whitespace)
//
// Same parser, different mode. The path detection happens upstream at the
// file-parse step (presence of holdingId/cardsightCardId columns).

export type NumericParseMode = "strict" | "lenient";

export interface NumericParseResult {
  /** Parsed numeric value, or null when the cell is empty / unparseable. */
  value: number | null;
  /** "ok" = parsed cleanly. "empty" = empty/null cell. "flagged" = non-numeric content that needs user attention (lenient only). "rejected" = malformed for the mode (strict only). */
  outcome: "ok" | "empty" | "flagged" | "rejected";
  /** Human-readable reason; only set when outcome !== "ok". Surfaces in the preview UI. */
  reason?: string;
}

// Treated as null on either mode.
const EMPTY_SENTINELS = new Set(["", "-", "n/a", "na", "null", "none", "—", "–"]);

/**
 * Parse a cell value as a number under the given mode.
 *
 * `strict` mode (round-trip path):
 *   - Plain numbers parse cleanly.
 *   - Empty / null / sentinel-empty → outcome="empty", value=null.
 *   - Anything with formatting characters ($, comma, %, etc.) → outcome="rejected".
 *
 * `lenient` mode (arbitrary path):
 *   - Plain numbers parse cleanly.
 *   - Empty / null / sentinel-empty → outcome="empty", value=null.
 *   - Strip $, €, £ prefix; thousands separators (,); whitespace.
 *   - Trailing % → FLAGGED (CF-IMPORT-VOLUME refinement, 2026-06-21).
 *     No user-editable column has percentage semantics — the only %-
 *     semantic columns are computed and on the always-ignore set, so a
 *     stray "12.5%" in a price column is almost certainly a user typo,
 *     not "0.125". Same don't-guess discipline as ambiguous dates: flag
 *     for review, never silently coerce. (Pre-CF-IMPORT-VOLUME this
 *     branch divided by 100.)
 *   - Genuinely non-numeric (e.g. "about $20") → outcome="flagged" with reason; never throws or rejects the batch.
 */
export function parseNumeric(input: unknown, mode: NumericParseMode): NumericParseResult {
  if (input === null || input === undefined) {
    return { value: null, outcome: "empty" };
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { value: null, outcome: "rejected", reason: "non-finite number" };
    return { value: input, outcome: "ok" };
  }
  const raw = String(input);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || EMPTY_SENTINELS.has(trimmed.toLowerCase())) {
    return { value: null, outcome: "empty" };
  }

  if (mode === "strict") {
    // Strict mode: plain number only. No currency, no commas, no percent.
    const n = Number(trimmed);
    if (Number.isFinite(n) && trimmed === String(n) || /^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { value: Number(trimmed), outcome: "ok" };
    }
    return { value: null, outcome: "rejected", reason: `strict mode requires raw numeric (got "${raw}")` };
  }

  // Lenient mode: strip unambiguous formatting and re-parse.
  let s = trimmed;

  // CF-IMPORT-VOLUME (2026-06-21): trailing % → FLAG, don't coerce.
  // No user-editable column carries percentage semantics, so a stray
  // "12.5%" in a price column is a user typo, not "0.125". Flag for
  // review (same don't-guess discipline as ambiguous dates).
  if (s.endsWith("%")) {
    return {
      value: null,
      outcome: "flagged",
      reason: `trailing % in "${raw}" — no user-editable column has percentage semantics; review during reconciliation`,
    };
  }

  // Strip leading currency symbols.
  s = s.replace(/^[\$€£¥]+/, "").trim();
  // Strip thousands separators (commas) and any other whitespace inside.
  s = s.replace(/,/g, "").replace(/\s+/g, "");

  // Parenthesized negatives (accounting style): "(1,234.56)" → -1234.56
  let negate = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negate = true;
    s = s.slice(1, -1);
  }

  if (s.length === 0) {
    return { value: null, outcome: "flagged", reason: `couldn't extract a number from "${raw}"` };
  }

  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { value: null, outcome: "flagged", reason: `non-numeric content in "${raw}"` };
  }

  let value = Number(s);
  if (!Number.isFinite(value)) {
    return { value: null, outcome: "flagged", reason: `unparseable numeric "${raw}"` };
  }
  if (negate) value = -value;
  return { value, outcome: "ok" };
}
