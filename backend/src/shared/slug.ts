// CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4 execution pack): shared
// slug + deterministic ID helpers for reference-catalog document keys.
//
// slug() is the canonical repr for productKey / cardSetKey / parallelKey
// used across all reference-catalog documents. Stable + reversible-adjacent
// (lowercase, alnum + hyphens); a slug value written today must parse the
// same value if the source string doesn't change.
//
// sha1Id() produces the deterministic Cosmos document id — same inputs
// always upsert the same document, so re-runs are idempotent.

import { createHash } from "node:crypto";

/**
 * Convert a display string to a URL-safe stable slug.
 *
 * Rules:
 *   - lowercase
 *   - Unicode diacritics stripped (NFKD → strip combining marks)
 *   - non-alnum characters become hyphens
 *   - runs of hyphens collapse to a single hyphen
 *   - leading / trailing hyphens trimmed
 *   - empty input → empty string (caller decides how to handle)
 *
 * Examples:
 *   slug("Bowman Chrome")             → "bowman-chrome"
 *   slug("Bowman's Best")             → "bowmans-best"
 *   slug("Chrome Prospect Autographs") → "chrome-prospect-autographs"
 *   slug("Blue X-Fractor /150 Auto")  → "blue-x-fractor-150-auto"
 *   slug("Padparadscha Sapphire")     → "padparadscha-sapphire"
 */
export function slug(input: string | null | undefined): string {
  if (input === null || input === undefined) return "";
  const s = String(input);
  return s
    .normalize("NFKD")
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Apostrophes / quotes are stripped (word-joining) rather than hyphenated,
    // so "Bowman's Best" → "bowmans-best" not "bowman-s-best".
    .replace(/['’‘"`]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic Cosmos document id — sha1 of a delimiter-joined key tuple.
 * Same tuple always produces the same id; re-runs of the ingest script
 * upsert-in-place instead of appending duplicates.
 *
 * Uses "|" as the field delimiter (never appears in slugs which are
 * alnum + hyphens only) so the sha1 pre-image is unambiguous.
 */
export function sha1Id(...parts: Array<string | number | null | undefined>): string {
  const preimage = parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|");
  return createHash("sha1").update(preimage).digest("hex");
}
