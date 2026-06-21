// CF-DECOUPLE-2 (2026-06-21): cardsightSetName → BowmanFamilySubset normalizer.
//
// Shared infrastructure: consumed by compiqEstimate's 3 mechanism1 + 2
// Build B call sites to replace the hardcoded `"Chrome Prospect Autographs"`
// subset; also intended for adoption by the multiplier-calibration engine
// (CF-CAT-ENGINE), which currently runs scope-by-scope with the subset
// passed in externally.
//
// Design discipline: **null for ambiguous or unmappable**, per the
// CF-DECOUPLE-2 spec. Don't guess. Null falls through honestly to the
// existing fallback chain (observed → base_auto_floor → honest null),
// same null-safe pattern as CF-DECOUPLE's product classifier.
//
// Mapping evidence: setName values observed across the 2026 Bowman corpus
// (33 sets in the release) + CF-PROD-RECON's cross-product probe. Clean
// 1:1 maps are added explicitly; the long tail (Bowman Sterling, Bowman
// Scouts Top 100, Anime, Mojo sister sets, etc.) returns null.

import type { BowmanFamilySubset } from "./chromeDraftMultipliers.js";

/**
 * Direct map from observed Cardsight setName strings to the engine's
 * BowmanFamilySubset enum. Lowercase keys for case-insensitive matching.
 *
 * Empty value means "intentionally ambiguous" — caller treats null.
 */
const DIRECT_MAP: Record<string, BowmanFamilySubset | null> = {
  // Plural/singular: Cardsight uses plural "Prospects", engine table uses
  // singular "Prospect". The mismatch was explicitly flagged out-of-CF-X
  // scope in chromeDraftMultipliers.ts:485-488 — this is the right home
  // for the fix.
  "chrome prospects autographs": "Chrome Prospect Autographs",
  "chrome rookie autographs": "Chrome Rookie Autographs",
  "chrome prospects": "Chrome Prospects",
  "chrome base": "Chrome Base",
  "paper prospects": "Paper Prospects",
  "paper base": "Paper Base",
  "paper base + paper prospects": "Paper Base + Paper Prospects",
  "inserts": "Inserts",
  "invicta inserts": "Invicta Inserts",
  "image variation ssp": "Image Variation SSP",
  "bowman ascensions / afl relics": "Bowman Ascensions / AFL Relics",

  // Ambiguous: "Base Set" maps to different curated subsets depending on
  // the release context (Bowman Chrome → Chrome Base; Bowman flagship →
  // Paper Base+Prospects). We don't have release context here — return
  // null and let the lookup miss honestly.
  "base set": null,
};

/**
 * Normalize a Cardsight setName to a BowmanFamilySubset, or null when
 * the mapping is ambiguous (e.g. "Base Set") or unmappable (no curated
 * row exists — e.g. "Bowman Sterling", "Anime", parallel sister sets).
 *
 * Null is the safe failure mode: the curated table lookup returns null →
 * mechanism1/Build B skip → existing observed/base_auto_floor/honest-null
 * cascade handles the holding. Never produces a wrong-subset match.
 */
export function normalizeCardsightSetName(
  setName: string | null | undefined,
): BowmanFamilySubset | null {
  if (setName === null || setName === undefined) return null;
  const trimmed = String(setName).trim();
  if (trimmed.length === 0) return null;
  // Look up via lowercased key. The map's value can be `null` (intentional
  // ambiguous marker) — that's still a "we know about this setName, we
  // just refuse to map it" — distinct from `undefined` ("we've never seen
  // this setName"). Both return null to the caller; the distinction is
  // for the audit comment below.
  const key = trimmed.toLowerCase();
  if (key in DIRECT_MAP) {
    return DIRECT_MAP[key] ?? null;
  }
  // Unknown setName: not in DIRECT_MAP. Return null — same honest fall-through.
  return null;
}
