// CF-HOLDING-FIELD-NORMALIZER (Drew, 2026-07-14): the standard for
// cleaning messy eBay-imported holding fields before they hit the
// suggester, resolver, or comp bridge. Pure functions — no I/O, fully
// testable, safe to call defensively at multiple points in the pipeline.
//
// WHY THIS EXISTS
// ---------------
// eBay title parsing produces messy structured fields:
//   setName:   "2026 Bowman" (year duplicated with cardYear),
//              "bowman baseball" (casing / category noise),
//              "2025-26 Bowman" (year-range prefix)
//   parallel:  "Chrome" (that's a set, not a parallel),
//              "Chrome Refractor" (set prefix + real parallel),
//              "Chrome Prospects Refractor" (set + subset + parallel)
//   playerName: "Refractors Eric Hartman" (parallel word leaked into name)
//   cardNumber: lowercase, whitespace variance
//
// Uncleaned, these produce garbage queries like
// "2026 2026 Bowman Eric Hartman Chrome #CPA-EHA" that CH's tokenizer
// zeros out. The 2026-07-14 probe on Drew's 36 active holdings had 32
// return no candidates from EITHER vendor — the messy-field bug, not
// a catalog gap.
//
// RULES
// -----
// Each rule is a pure transformation with a name + reason so the
// normalize() summary can report what changed. Rules compose in the
// order defined below. Every rule is opt-outable via NormalizeOptions
// for testing / edge-case suppression.
//
// Adding a new rule:
//   1. Add it to the RULES array
//   2. Add a test in holdingFieldNormalizer.test.ts pinning the
//      before/after
//   3. Document the pattern (real observed messy value) in the rule's
//      comment so future readers know why the rule exists
//
// Rules are additive/defensive — normalize() must always be safe to
// call on already-clean data (idempotent). If a rule can't confidently
// clean a value, leave it unchanged rather than guess.

export interface NormalizableHoldingFields {
  playerName?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean | null;
}

export interface NormalizeOptions {
  /** Set of rule names to skip (for tests). Defaults to none. */
  skipRules?: Set<string>;
}

export interface NormalizeChange {
  rule: string;
  field: "playerName" | "setName" | "parallel" | "cardNumber";
  before: string | null;
  after: string | null;
}

export interface NormalizeResult {
  fields: NormalizableHoldingFields;
  changes: NormalizeChange[];
}

/**
 * Vocabulary shared by parallel-decontamination + player-decontamination.
 * Words that CAN appear in the parallel field or leak into playerName
 * that shouldn't be there. Case-insensitive.
 */
/**
 * Words that are SET/SUBSET names, not parallel names. Safe to strip
 * from the parallel field's leading tokens because a real parallel
 * ("Blue Refractor", "Green Shimmer") wouldn't start with these.
 * Used by R3 (parallel_strip_subset_prefix).
 */
const SUBSET_WORDS = [
  "chrome",
  "prospects",
  "prospect",
  "autographs",
  "autograph",
  "baseball",
  "basketball",
  "football",
  "hockey",
];

/**
 * Words that CAN legitimately appear in a parallel name but should
 * NEVER be the leading token of a player's name. Union with
 * SUBSET_WORDS for R4 (playerName_strip_leading_noise). Kept separate
 * from SUBSET_WORDS so R3 doesn't wrongly strip "Sapphire" from a
 * "Sapphire Refractor" parallel string (Sapphire IS a subset but the
 * parallel-scope word is different than the leaking-into-player case).
 *
 * OBSERVED (2026-07-14 audit):
 *   playerName "Sapphire Owen Carey" for a BSPA-OC card — Sapphire is
 *   the Bowman Sapphire subset name that leaked into the parser output.
 */
const PLAYERNAME_LEADING_NOISE_EXTRA = [
  "sapphire",
  "sterling",
  "heritage",
  "topps",
  "bowman",
  "panini",
  "prizm",
  "select",
  "optic",
  "mosaic",
  "refractors",
  "refractor",
];

/**
 * Words that IF they're the entire parallel field (or the whole prefix
 * of it) mean the parallel is set/subset noise, not a real parallel.
 * Real parallels can INCLUDE "Refractor" (base refractor is a real SKU)
 * so we only strip the WORDS above, then check what's left.
 */
const PARALLEL_NULL_ON_EMPTY = true;

interface Rule {
  name: string;
  apply(fields: NormalizableHoldingFields, changes: NormalizeChange[]): NormalizableHoldingFields;
}

const RULES: Rule[] = [
  // ── R1 setName: strip year prefix ──────────────────────────────────
  // OBSERVED: setName "2026 Bowman" combined with cardYear=2026 → query
  // built "2026 2026 Bowman ..." (year doubled). Also "2025-26 Bowman"
  // (year-range prefix) with cardYear=2025.
  {
    name: "setName_strip_year_prefix",
    apply(fields, changes) {
      const set = fields.setName;
      const year = fields.cardYear;
      if (!set || typeof year !== "number") return fields;
      // Match leading year OR year-range (2025-26 / 2025-2026)
      const yearReSingle = new RegExp(`^\\s*${year}\\s+`);
      const yearReRange = new RegExp(`^\\s*${year}-(?:${(year % 100 + 1).toString().padStart(2, "0")}|${year + 1})\\s+`);
      let stripped = set;
      if (yearReRange.test(set)) stripped = set.replace(yearReRange, "").trim();
      else if (yearReSingle.test(set)) stripped = set.replace(yearReSingle, "").trim();
      if (stripped !== set && stripped.length > 0) {
        changes.push({ rule: "setName_strip_year_prefix", field: "setName", before: set, after: stripped });
        return { ...fields, setName: stripped };
      }
      return fields;
    },
  },

  // ── R2 setName: title-case normalization ───────────────────────────
  // OBSERVED: "bowman baseball" (all-lowercase from eBay title parser).
  // CH's set filter is case-sensitive on some paths; canonicalize to
  // Title Case so the wire form matches CH's catalog.
  {
    name: "setName_title_case",
    apply(fields, changes) {
      const set = fields.setName;
      if (!set) return fields;
      // Only touch when the string is entirely lowercase — mixed case is
      // intentional (e.g., "Bowman's Best" already correct).
      if (set !== set.toLowerCase()) return fields;
      const titled = set.replace(/\b\w/g, (c) => c.toUpperCase());
      if (titled !== set) {
        changes.push({ rule: "setName_title_case", field: "setName", before: set, after: titled });
        return { ...fields, setName: titled };
      }
      return fields;
    },
  },

  // ── R3 parallel: strip subset-prefix words ─────────────────────────
  // OBSERVED: parallel="Chrome Refractor" → parallel should be
  // "Refractor" (Chrome is the set). parallel="Chrome Prospects
  // Refractor" → parallel should be "Refractor". parallel="Chrome" alone
  // → parallel should be null (no real parallel info).
  {
    name: "parallel_strip_subset_prefix",
    apply(fields, changes) {
      const p = fields.parallel;
      if (!p) return fields;
      // Split into tokens (whitespace + hyphen boundary), lowercase for
      // comparison against SUBSET_WORDS but keep original casing for the
      // rebuild.
      const tokens = p.split(/\s+/).filter((t) => t.length > 0);
      // Drop leading tokens that are subset noise.
      let i = 0;
      while (i < tokens.length && SUBSET_WORDS.includes(tokens[i].toLowerCase())) i++;
      const remaining = tokens.slice(i);
      if (i === 0) return fields;                    // no subset prefix found
      if (remaining.length === 0) {
        // Whole parallel was noise → null it out (per PARALLEL_NULL_ON_EMPTY).
        if (PARALLEL_NULL_ON_EMPTY) {
          changes.push({ rule: "parallel_strip_subset_prefix", field: "parallel", before: p, after: null });
          return { ...fields, parallel: null };
        }
        return fields;
      }
      const rebuilt = remaining.join(" ");
      changes.push({ rule: "parallel_strip_subset_prefix", field: "parallel", before: p, after: rebuilt });
      return { ...fields, parallel: rebuilt };
    },
  },

  // ── R4 playerName: strip leading subset/set/brand words ────────────
  // OBSERVED: playerName "Refractors Eric Hartman" — parallel word leak.
  // OBSERVED: playerName "Sapphire Owen Carey" — subset word leak.
  // Union of SUBSET_WORDS + PLAYERNAME_LEADING_NOISE_EXTRA covers both
  // parallel-word leaks (refractor, refractors) and set/brand leaks
  // (Sapphire, Sterling, Bowman, Topps, etc.).
  {
    name: "playerName_strip_leading_noise",
    apply(fields, changes) {
      const name = fields.playerName;
      if (!name) return fields;
      const noiseWords = new Set([...SUBSET_WORDS, ...PLAYERNAME_LEADING_NOISE_EXTRA]);
      const tokens = name.split(/\s+/).filter((t) => t.length > 0);
      let i = 0;
      while (i < tokens.length && noiseWords.has(tokens[i].toLowerCase())) i++;
      if (i === 0) return fields;
      const remaining = tokens.slice(i);
      if (remaining.length === 0) return fields;     // don't null the whole player
      const rebuilt = remaining.join(" ");
      changes.push({ rule: "playerName_strip_leading_noise", field: "playerName", before: name, after: rebuilt });
      return { ...fields, playerName: rebuilt };
    },
  },

  // ── R5 cardNumber: uppercase + trim ────────────────────────────────
  // OBSERVED: "cpa-eha" (lowercase). CH's catalog stores numbers uppercase.
  // Trivial fix, high impact when hit.
  {
    name: "cardNumber_uppercase_trim",
    apply(fields, changes) {
      const num = fields.cardNumber;
      if (!num) return fields;
      const cleaned = num.trim().toUpperCase();
      if (cleaned !== num) {
        changes.push({ rule: "cardNumber_uppercase_trim", field: "cardNumber", before: num, after: cleaned });
        return { ...fields, cardNumber: cleaned };
      }
      return fields;
    },
  },
];

/**
 * Apply every enabled rule in order, returning the cleaned fields plus
 * an audit trail of every change. Idempotent — normalize(normalize(x)) === normalize(x).
 */
export function normalizeHoldingFields(
  fields: NormalizableHoldingFields,
  opts: NormalizeOptions = {},
): NormalizeResult {
  const skip = opts.skipRules ?? new Set<string>();
  const changes: NormalizeChange[] = [];
  let current = { ...fields };
  for (const rule of RULES) {
    if (skip.has(rule.name)) continue;
    current = rule.apply(current, changes);
  }
  return { fields: current, changes };
}

/** Testing helper — expose rule names so tests can pin the full set. */
export function _getRuleNames(): string[] {
  return RULES.map((r) => r.name);
}
