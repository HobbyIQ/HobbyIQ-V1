/**
 * Beckett Parallel-Name Normalizer
 * ---------------------------------------------------------------------------
 * Beckett's parallel labels are noisy: typos ("Atomic Refracrtors"), trailing
 * "Refractor" sometimes present sometimes not, casing varies, parentheticals
 * ("hobby only", "/25") drift in. The 54-entry owner-curated multiplier
 * table ([chromeDraftMultipliers.ts](../../services/compiq/chromeDraftMultipliers.ts))
 * is the canonical source of truth for parallel names — every staged record
 * for Phase B must map to one of those 54 entries OR fall into the
 * owner-review queue.
 *
 * This module:
 *   1. Loads the canonical name list from the multiplier table.
 *   2. Provides `normalizeParallelName()` which returns
 *      `{canonical, confidence, rawInput, strategy}`.
 *   3. Maintains an unmatched-name accumulator so the sweep can dump
 *      `unmatchedParallels.json` for owner review.
 *
 * Strategy precedence (in order):
 *   1. Exact match against canonical                       → conf 1.00
 *   2. Case-insensitive + whitespace-normalized match      → conf 0.95
 *   3. Levenshtein distance ≤ 2 against canonical          → conf 0.85
 *   4. Known-typo lookup (seeded with the Beckett typos)   → conf per-entry
 *   5. No match                                            → conf 0.00
 *
 * Print-run extraction is OUT of scope here. Callers pass the *name only*
 * (e.g. "Atomic Refractors") — strip "/N" before calling.
 */

import { CHROME_DRAFT_MULTIPLIERS } from "../../services/compiq/chromeDraftMultipliers.js";

// ---------------------------------------------------------------------------
// Brand-scoped canonical tables (Phase A.3).
//
// The 54-entry CHROME_DRAFT_MULTIPLIERS table is Bowman Chrome / Draft only.
// To honor the A.3 architectural rule that multiplier tables are
// brand-scoped, the normalizer keys canonical lookups by brand family.
// Non-Bowman brands currently have NO curated canonical table, so every
// parallel name resolves to `unmatched` — those entries are the input to
// the owner's next curation pass.
//
// As the owner curates additional brand tables, add them here under their
// canonical brand name.
// ---------------------------------------------------------------------------

/** Brands that share the Bowman Chrome / Draft 54-entry multiplier table. */
const BOWMAN_FAMILY_BRANDS: ReadonlySet<string> = new Set([
  "Bowman",
  "Bowman Chrome",
  "Bowman Draft",
  "Bowman Sterling",
  "Bowman Platinum",
  "Bowman's Best",
  "Bowman Mega",
  "Bowman Inception",
  "Bowman Transcendent",
  "Bowman Heritage",
]);

const CANONICAL_NAMES: readonly string[] = Object.freeze(
  Object.keys(CHROME_DRAFT_MULTIPLIERS),
);

/**
 * Returns true when the given brand has a curated canonical table.
 * Non-curated brands always produce `unmatched` results — see A.3 spec.
 */
function brandHasCanonicalTable(brand: string | undefined): boolean {
  if (!brand) return true; // legacy callers (no brand) keep Bowman behavior
  return BOWMAN_FAMILY_BRANDS.has(brand);
}

/** Lowercase + whitespace-collapsed → canonical, for fast case-insensitive match. */
const NORMALIZED_TO_CANONICAL: Readonly<Record<string, string>> = Object.freeze(
  CANONICAL_NAMES.reduce<Record<string, string>>((acc, name) => {
    acc[lowerCollapse(name)] = name;
    return acc;
  }, {}),
);

// ---------------------------------------------------------------------------
// Known-typo seed table (Phase A finding: "Atomic Refracrtors" → "Atomic Refractors")
//
// Append as the owner identifies more from the unmatched-review queue.
// Entries here MUST map to a canonical name in CANONICAL_NAMES.
// ---------------------------------------------------------------------------
interface KnownTypoEntry {
  /** Raw input we expect to see (already lower-collapsed). */
  typoNormalized: string;
  /** Canonical name to return (must exist in CHROME_DRAFT_MULTIPLIERS). */
  canonical: string;
  /** Per-entry confidence — owners may want a typo to score 0.90 not 1.0. */
  confidence: number;
}

const KNOWN_TYPOS: readonly KnownTypoEntry[] = Object.freeze([
  // Beckett's well-known "Atomic Refracrtors" mis-spelling, seen in
  // 2022 Bowman Baseball checklist. Maps to "Atomic" in our canonical table
  // because color parallels in the multiplier table omit the trailing
  // " Refractor" suffix.
  {
    typoNormalized: "atomic refracrtors",
    canonical: "Atomic",
    confidence: 0.95,
  },
  {
    typoNormalized: "atomic refracrtor",
    canonical: "Atomic",
    confidence: 0.95,
  },
  // Common: plural "Refractors" of a canonical singular
  {
    typoNormalized: "refractors",
    canonical: "Refractor",
    confidence: 0.98,
  },
  // Common: "Superfractors" plural
  {
    typoNormalized: "superfractors",
    canonical: "Superfractor",
    confidence: 0.98,
  },
  // Common: "Printing Plates" plural
  {
    typoNormalized: "printing plates",
    canonical: "Printing Plate",
    confidence: 0.98,
  },
]);

const KNOWN_TYPO_INDEX: Readonly<Record<string, KnownTypoEntry>> = Object.freeze(
  KNOWN_TYPOS.reduce<Record<string, KnownTypoEntry>>((acc, entry) => {
    acc[entry.typoNormalized] = entry;
    return acc;
  }, {}),
);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NormalizationStrategy =
  | "exact"
  | "case-insensitive"
  | "levenshtein"
  | "known-typo"
  | "stripped-refractor"
  | "unmatched";

export interface NormalizationResult {
  /** Canonical parallel name, or `null` when unmatched. */
  canonical: string | null;
  /** Confidence in [0, 1]. 0 indicates `unmatched`. */
  confidence: number;
  /** The strategy that produced the match. */
  strategy: NormalizationStrategy;
  /** Exactly the input passed in — preserved for audit. */
  rawInput: string;
  /** Levenshtein distance when strategy === "levenshtein". */
  editDistance?: number;
}

// ---------------------------------------------------------------------------
// Core normalize()
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /**
   * Canonical brand label (e.g. "Bowman Chrome", "Topps Heritage"). When set,
   * the normalizer enforces brand-scoped canonical lookup: non-Bowman brands
   * have no curated table, so every parallel returns `unmatched`. When
   * omitted (legacy callers), behavior is unchanged — global Bowman lookup.
   */
  brand?: string;
}

export function normalizeParallelName(
  rawInput: string,
  opts: NormalizeOptions = {},
): NormalizationResult {
  const safeRaw = typeof rawInput === "string" ? rawInput : String(rawInput ?? "");
  const trimmed = safeRaw.trim();
  if (trimmed === "") {
    return {
      canonical: null,
      confidence: 0,
      strategy: "unmatched",
      rawInput: safeRaw,
    };
  }

  // Brand-scope gate: brands without a curated table never match. This is
  // the hard rule against cross-brand canonicalization from Phase A.3.
  if (!brandHasCanonicalTable(opts.brand)) {
    return {
      canonical: null,
      confidence: 0,
      strategy: "unmatched",
      rawInput: safeRaw,
    };
  }

  // 1. Exact match against canonical
  if (Object.prototype.hasOwnProperty.call(CHROME_DRAFT_MULTIPLIERS, trimmed)) {
    return {
      canonical: trimmed,
      confidence: 1.0,
      strategy: "exact",
      rawInput: safeRaw,
    };
  }

  // 2. Case-insensitive + whitespace-collapsed match
  const lc = lowerCollapse(trimmed);
  if (NORMALIZED_TO_CANONICAL[lc]) {
    return {
      canonical: NORMALIZED_TO_CANONICAL[lc]!,
      confidence: 0.95,
      strategy: "case-insensitive",
      rawInput: safeRaw,
    };
  }

  // 4. Known-typo lookup (we check before Levenshtein because owner-curated
  // typo entries carry intentional confidence values that shouldn't be
  // shadowed by Levenshtein's flat 0.85.)
  const typoHit = KNOWN_TYPO_INDEX[lc];
  if (typoHit) {
    return {
      canonical: typoHit.canonical,
      confidence: typoHit.confidence,
      strategy: "known-typo",
      rawInput: safeRaw,
    };
  }

  // 2b. Trailing-refractor strip: "Blue Refractor" -> "Blue".
  // The owner table omits " Refractor" on color parallels, so a raw input
  // like "Blue Refractor" needs the suffix removed before matching.
  const strippedRefractor = lc
    .replace(/\s+refractors?\s*$/i, "")
    .trim();
  if (strippedRefractor !== lc && strippedRefractor !== "") {
    const canonical = NORMALIZED_TO_CANONICAL[strippedRefractor];
    if (canonical) {
      return {
        canonical,
        confidence: 0.93,
        strategy: "stripped-refractor",
        rawInput: safeRaw,
      };
    }
  }

  // 3. Levenshtein ≤ 2 over the case-insensitive form
  const lev = closestLevenshtein(lc);
  if (lev && lev.distance <= 2) {
    return {
      canonical: lev.canonical,
      confidence: 0.85,
      strategy: "levenshtein",
      rawInput: safeRaw,
      editDistance: lev.distance,
    };
  }

  // 5. Unmatched
  return {
    canonical: null,
    confidence: 0,
    strategy: "unmatched",
    rawInput: safeRaw,
  };
}

// ---------------------------------------------------------------------------
// Unmatched accumulator — for the owner-review queue
// ---------------------------------------------------------------------------

export interface UnmatchedEntry {
  rawInput: string;
  /** Brand the raw name was seen under. "(unscoped)" for legacy callers. */
  brand: string;
  /** How many times the sweep saw this exact (brand, raw input) pair. */
  frequency: number;
  /** Up to 5 sample card identifiers (set / cardNumber / player) for review. */
  samples: string[];
}

export class UnmatchedParallelsAccumulator {
  // Keyed by `${brand}::${rawInput}` so the same parallel name in two brands
  // is kept separate (cross-brand isolation rule).
  private map = new Map<string, UnmatchedEntry>();

  record(rawInput: string, sampleId?: string, brand: string = "(unscoped)"): void {
    const trimmedRaw = rawInput.trim();
    if (trimmedRaw === "") return;
    const key = `${brand}::${trimmedRaw}`;
    let entry = this.map.get(key);
    if (!entry) {
      entry = { rawInput: trimmedRaw, brand, frequency: 0, samples: [] };
      this.map.set(key, entry);
    }
    entry.frequency += 1;
    if (sampleId && entry.samples.length < 5 && !entry.samples.includes(sampleId)) {
      entry.samples.push(sampleId);
    }
  }

  toJSON(): UnmatchedEntry[] {
    // Sorted by frequency desc, then alpha for determinism.
    return Array.from(this.map.values()).sort((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return a.rawInput.localeCompare(b.rawInput);
    });
  }

  size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function lowerCollapse(s: string): string {
  return s.toLowerCase().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
}

function closestLevenshtein(
  needle: string,
): { canonical: string; distance: number } | null {
  let best: { canonical: string; distance: number } | null = null;
  for (const canonical of CANONICAL_NAMES) {
    const hay = lowerCollapse(canonical);
    // Cheap length-gate: skip when impossible to be ≤ 2 by length alone.
    if (Math.abs(hay.length - needle.length) > 2) continue;
    const d = levenshtein(needle, hay, 2);
    if (d <= 2 && (best === null || d < best.distance)) {
      best = { canonical, distance: d };
      if (d === 0) break; // can't beat that
    }
  }
  return best;
}

/**
 * Classic Levenshtein with an early-exit `maxDistance` cap. Returns
 * `maxDistance + 1` if the true distance exceeds the cap — cheaper than
 * computing the full DP for clearly-distant strings.
 */
function levenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  // Two-row DP
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const ins = cur[j - 1]! + 1;
      const del = prev[j]! + 1;
      const sub = prev[j - 1]! + cost;
      cur[j] = Math.min(ins, del, sub);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

// ---------------------------------------------------------------------------
// Read-only accessors (for tests + diagnostics)
// ---------------------------------------------------------------------------

export function getCanonicalNames(): readonly string[] {
  return CANONICAL_NAMES;
}

export function getKnownTypos(): readonly KnownTypoEntry[] {
  return KNOWN_TYPOS;
}
