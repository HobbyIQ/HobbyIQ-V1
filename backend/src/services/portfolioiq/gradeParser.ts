// CF-AUTOPRICE-GRADE-CONTRACT — parse legacy grade-label strings into
// canonical (gradeCompany, gradeValue) tuples for one-time Cosmos backfill.
//
// Used by scripts/backfill-grade-fields.ts. NOT a backend runtime shim:
// autoPriceHolding reads canonical fields directly; this parser exists
// only to convert pre-canonical-contract stored data so existing
// graded holdings get correct PSA/BGS/SGC comp pools after iOS contract
// rolls out.
//
// Conservative parsing: when the label is unambiguous, return the
// canonical tuple. When ambiguous (unknown company token, no numeric
// value, etc.) return null so the script can surface unparseable cases
// for manual review rather than guess.

export interface ParsedGrade {
  gradeCompany: string;
  gradeValue: number;
  /**
   * CF-BGS-BLACK-LABEL-INGEST (PR #495 follow-up): true when the input
   * label carried "Black Label" / "Pristine" / a standalone "BL" token
   * adjacent to a BGS 10. Absent for every other grade. Consumers
   * (autoPriceHolding, catalog inference, backfill scripts) use this to
   * pass "10 Black Label" as the grade string to getGraderPremium so
   * the 9x fallback tier fires instead of the regular BGS 10 3.5x tier.
   */
  isBlackLabel?: boolean;
}

// Adjacent "Black Label" / "Pristine" / "BL" indicators on a BGS 10.
// Match any of these anywhere in the input string; scoped to BGS 10 by
// the caller (this file is a plain regex — the scoping check lives in
// parseGradeLabel's return path).
const BGS_BLACK_LABEL_PATTERNS = [
  /\bblack\s+label\b/i,
  /\bpristine\b/i,
  /\bbl\b/i,
];

// PSA's flagship label vernacular for a 10 — has multiple textual forms.
// Recognized as PSA 10 even when only the descriptor appears.
const PSA_10_PATTERNS = [
  /\bgem[\s-]*mt\b/i,
  /\bgem[\s-]*mint\b/i,
  /\bpristine\b/i,
];

// PSA's full grade-label vernacular. The slab printing uses descriptor
// words alongside the numeric grade ("MINT 9", "NM-MT 8", "EX-MT 6").
// iOS card-scan path historically captured these labels verbatim. When
// the parser sees a descriptor word paired with a numeric in the [1, 10]
// range, infer the company as PSA and use the numeric as the value.
//
// This is a CONSERVATIVE heuristic for backfill of legacy data — labels
// that match this pattern are virtually always from PSA slabs. BGS uses
// "MINT" too but pairs with a decimal grade ("BGS 9.5") that explicit
// company tokenization handles. SGC uses numeric-only labels ("SGC 9").
//
// Operators reviewing the backfill output can override individual
// inferences if they know a holding is actually BGS/SGC/CGC.
const PSA_DESCRIPTOR_PATTERNS = [
  /\bgem[\s-]*mt\b/i,
  /\bgem[\s-]*mint\b/i,
  /\bmint\b/i,         // PSA grades 9-10
  /\bnm[\s-]*mt\b/i,   // Near Mint-Mint, PSA 8
  /\bnm\b/i,           // Near Mint, PSA 7
  /\bex[\s-]*mt\b/i,   // Excellent-Mint, PSA 6
  /\bex\b/i,           // Excellent, PSA 5
  /\bvg[\s-]*ex\b/i,   // VG-Excellent, PSA 4
  /\bvg\b/i,           // Very Good, PSA 3
  /\bgood\b/i,         // PSA 2
  /\bpoor\b/i,         // PSA 1
];

// Company token recognition. Order matters: longer tokens checked first
// to avoid "BGS" matching when the label is actually "CGC BGS-format
// double-stamped" (rare but possible).
// Match company token followed by either a word boundary (PSA 10) or
// a digit (PSA10). `\b` alone wouldn't match between PSA and 10 because
// both letters and digits are \w characters.
const COMPANY_TOKENS: Array<{ token: RegExp; canonical: string }> = [
  { token: /\bpsa(?=\b|\d)/i, canonical: "PSA" },
  { token: /\bbgs(?=\b|\d)/i, canonical: "BGS" },
  { token: /\bsgc(?=\b|\d)/i, canonical: "SGC" },
  { token: /\bcgc(?=\b|\d)/i, canonical: "CGC" },
  { token: /\bcsg(?=\b|\d)/i, canonical: "CSG" },
  { token: /\bhga(?=\b|\d)/i, canonical: "HGA" },
];

/**
 * Parse a grade-label string into canonical (gradeCompany, gradeValue).
 * Returns null for raw/ungraded cards (empty string, "Raw", "Ungraded")
 * and for labels that can't be confidently parsed.
 *
 * Recognized formats:
 *   - "PSA 10", "PSA10", "psa 10"   → { gradeCompany: "PSA", gradeValue: 10 }
 *   - "BGS 9.5", "BGS9.5"           → { gradeCompany: "BGS", gradeValue: 9.5 }
 *   - "GEM MT 10", "Gem Mt 10"      → { gradeCompany: "PSA", gradeValue: 10 }
 *                                       (PSA's official label vernacular)
 *   - "SGC 9", "CGC 9"              → expected company tokens
 *   - ""  / "Raw" / "Ungraded"      → null (not graded)
 *   - "10" / "9.5" / number-only    → null (no company; surfaced for review)
 *   - "GEM" alone                   → null (no value; surfaced for review)
 */
export function parseGradeLabel(label: string | null | undefined): ParsedGrade | null {
  if (!label) return null;
  const trimmed = String(label).trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === "raw" || lower === "ungraded" || lower === "none") return null;

  // ── Detect company token ─────────────────────────────────────────────
  let detectedCompany: string | null = null;
  for (const { token, canonical } of COMPANY_TOKENS) {
    if (token.test(trimmed)) {
      detectedCompany = canonical;
      break;
    }
  }

  // ── Detect numeric value ─────────────────────────────────────────────
  // Look for a decimal number (e.g. 9.5) or integer (10, 9, 8). The
  // value can be a string anywhere in the label — we extract the first
  // standalone number after company tokens are stripped.
  let strippedForNumber = trimmed;
  for (const { token } of COMPANY_TOKENS) {
    strippedForNumber = strippedForNumber.replace(token, " ");
  }
  // Also strip PSA-10 descriptor phrases so the trailing number isn't
  // shadowed by literal "MT" or "MINT" residue.
  strippedForNumber = strippedForNumber
    .replace(/\bgem[\s-]*(mt|mint)\b/gi, " ")
    .replace(/\bmt\b/gi, " ")
    .replace(/\bmint\b/gi, " ")
    .replace(/\bpristine\b/gi, " ");

  const numberMatch = strippedForNumber.match(/(\d+(?:\.\d+)?)/);
  let detectedValue: number | null = null;
  if (numberMatch) {
    const parsed = Number(numberMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) {
      detectedValue = parsed;
    }
  }

  // ── PSA descriptor-only fallback (no numeric, descriptor signals 10) ─
  // Labels like "GEM MT" / "PRISTINE" without a numeric value are PSA's
  // top-grade conventions. Only infer PSA 10 when the descriptor IS
  // present AND no other company token competes AND no numeric is found.
  if (!detectedCompany && !detectedValue) {
    const isPsa10Descriptor = PSA_10_PATTERNS.some((re) => re.test(trimmed));
    if (isPsa10Descriptor) {
      return { gradeCompany: "PSA", gradeValue: 10 };
    }
  }

  // ── PSA descriptor + numeric → infer PSA ─────────────────────────────
  // "GEM MT 10" / "MINT 9" / "NM-MT 8" / "EX-MT 6" etc. all follow PSA's
  // slab-label vernacular. When no explicit company token but a PSA
  // descriptor is present alongside a valid grade numeric, infer PSA.
  // Conservative backfill heuristic — BGS/SGC use either explicit company
  // tokens (handled above) or decimal grades that don't match these
  // integer-only descriptor patterns.
  if (!detectedCompany && detectedValue !== null) {
    const hasPsaDescriptor = PSA_DESCRIPTOR_PATTERNS.some((re) => re.test(trimmed));
    if (hasPsaDescriptor) {
      return { gradeCompany: "PSA", gradeValue: detectedValue };
    }
  }

  // ── Decide ───────────────────────────────────────────────────────────
  if (detectedCompany && detectedValue !== null) {
    // CF-BGS-BLACK-LABEL-INGEST: elevate a BGS 10 to Black Label ONLY
    // when the input carries one of the tier indicators AND the tuple
    // is exactly (BGS, 10). "PSA 10 Pristine" (which some Cardsight
    // labels use for gem-mint 10s) intentionally does NOT flip this
    // bit — it's a BGS-only tier.
    if (
      detectedCompany === "BGS"
      && detectedValue === 10
      && BGS_BLACK_LABEL_PATTERNS.some((re) => re.test(trimmed))
    ) {
      return {
        gradeCompany: detectedCompany,
        gradeValue: detectedValue,
        isBlackLabel: true,
      };
    }
    return { gradeCompany: detectedCompany, gradeValue: detectedValue };
  }

  // Ambiguous: surface for manual review by returning null. The
  // backfill script logs unparseable labels so an operator can fix
  // them before re-running.
  return null;
}
