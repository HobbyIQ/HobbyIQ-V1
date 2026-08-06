/**
 * CF-PARALLEL-CANONICAL (Drew, 2026-08-06).
 *
 * Single source of truth for the display + slug forms of a parallel
 * name. Every write path into sold_comps / catalog runs input parallels
 * through this so we stop fragmenting the pool across "Blue Refractor"
 * vs "blue-refractor" vs "BLUE REFRACTOR" vs "[Base]" vs "base" etc.
 *
 * Contract:
 *   canonicalizeParallel("Blue Refractor")            → { display: "Blue Refractor",            slug: "blue-refractor" }
 *   canonicalizeParallel("blue-refractor")            → { display: "Blue Refractor",            slug: "blue-refractor" }
 *   canonicalizeParallel("[Base]")                    → { display: "Base",                      slug: "base" }
 *   canonicalizeParallel("Blue Mini-Diamond Refractor")→ { display: "Blue Mini-Diamond Refractor",slug: "blue-mini-diamond-refractor" }
 *   canonicalizeParallel("Gold X-Fractor")            → { display: "Gold X-Fractor",            slug: "gold-x-fractor" }
 *   canonicalizeParallel("Black and White")           → { display: "Black and White",           slug: "black-and-white" }
 *   canonicalizeParallel("Raywave")                   → { display: "Ray Wave",                  slug: "ray-wave" }
 *   canonicalizeParallel("Xfractor")                  → { display: "X-Fractor",                 slug: "x-fractor" }
 *   canonicalizeParallel("Mega Refractor")            → { display: "Mojo Refractor",            slug: "mojo-refractor" }
 *
 * Rules:
 *   1. Strip surrounding brackets and collapse whitespace.
 *   2. Apply INPUT_ALIASES (Raywave→Ray Wave, Xfractor→X-Fractor,
 *      Mega Refractor→Mojo Refractor) — collapses the "same-parallel,
 *      different market vocab" fragmentation.
 *   3. Title Case each space-separated word, PRESERVING meaningful
 *      punctuation:
 *       - internal "-" (hyphen) stays: "Mini-Diamond" → "Mini-Diamond"
 *       - "/" stays: "White / Green Refractor" → "White / Green Refractor"
 *       - "'" stays: "Artist's Proof" → "Artist's Proof"
 *       - "&" stays as-is
 *   4. Stop-words after position 0 lowercase: "and", "or", "of", "the",
 *      "a", "an", "in", "on".
 *   5. Slug derived from the canonical display via the existing
 *      normalizeParallel() (which knows the alias vocab), so
 *      hobbyiqCardId slugs stay identical to their prior form.
 */

import { normalizeParallel } from "./hobbyIqCardId.service.js";

export interface CanonicalParallel {
  display: string;   // canonical display form ("Blue Refractor")
  slug: string;      // canonical slug form ("blue-refractor")
}

const STOP_WORDS = new Set(["and", "or", "of", "the", "a", "an", "in", "on"]);

// Aliases applied to the DISPLAY form (post-trim, pre-title-case). Slug
// normalization handles these too, so applying here keeps display + slug
// in lockstep. The prefix normalizer emits a space when the captured
// prefix is a hyphen — this turns "blue-x-fractor" (slug form) into
// "blue X-Fractor" so downstream space-splitting sees two segments and
// the X-Fractor internal hyphen survives.
const INPUT_ALIASES: Array<[RegExp, (m: string, prefix: string) => string]> = [
  // "Raywave" / "RayWave" → "Ray Wave"
  [/(^|[-\s])raywave\b/gi, (_m, p) => normalizePrefix(p) + "Ray Wave"],
  // "Xfractor" / "XFractor" (no hyphen) → "X-Fractor"
  [/(^|[-\s])xfractor\b/gi, (_m, p) => normalizePrefix(p) + "X-Fractor"],
  // "x-fractor" (already hyphenated) → "X-Fractor"
  [/(^|[-\s])x-fractor\b/gi, (_m, p) => normalizePrefix(p) + "X-Fractor"],
  // "Mega Refractor" → "Mojo Refractor"
  [/(^|[-\s])mega\s+refractor\b/gi, (_m, p) => normalizePrefix(p) + "Mojo Refractor"],
];

/** If the captured prefix is a hyphen, emit a space instead so
 *  slug-shape inputs ("blue-x-fractor") get split cleanly by downstream
 *  space-based segmentation. Leaves start-of-string and pre-existing
 *  space alone. */
function normalizePrefix(p: string): string {
  if (p === "-") return " ";
  return p;
}

function titleCaseWord(w: string): string {
  if (!w) return w;
  // Preserve strings that are already all-caps AND short (acronyms like
  // "USA", "RC", "SP"). Anything longer than 3 chars gets normalized so
  // "REFRACTOR" doesn't stay all-caps.
  if (/^[A-Z]{2,3}$/.test(w)) return w;
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
}

/** Title-case a single space-separated segment while preserving internal
 *  meaningful punctuation ("-", "'", "/", "&"). Splits on separators
 *  and title-cases each sub-part. Post-apostrophe short suffixes
 *  ("Mother's" → "Mother's", not "Mother'S") stay lowercase. */
function titleCaseSegment(segment: string): string {
  // Fast path — no internal separators
  if (!/[-'/&]/.test(segment)) return titleCaseWord(segment);
  const parts = segment.split(/([-'/&])/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Separator kept as-is.
    if (part.length === 1 && /[-'/&]/.test(part)) {
      out.push(part);
      continue;
    }
    // If the previous separator was an apostrophe AND this part is a
    // short letter-only suffix ("s", "d", "ll", "ve", "re", "t"), keep
    // it lowercase — "Mother's" vs the wrong "Mother'S".
    const prevSep = i > 0 ? parts[i - 1] : "";
    if (prevSep === "'" && /^[a-z]{1,3}$/i.test(part)) {
      out.push(part.toLowerCase());
    } else {
      out.push(titleCaseWord(part));
    }
  }
  return out.join("");
}

export function canonicalizeParallel(
  input: string | null | undefined,
): CanonicalParallel | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Strip surrounding brackets ("[Base]" → "Base").
  let s = raw.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!s) return null;

  // Collapse runs of whitespace to single spaces + normalize non-ASCII whitespace.
  s = s.replace(/\s+/g, " ");

  // Apply market-vocab aliases FIRST so hyphenated compound aliases
  // ("blue-x-fractor" → "blue X-Fractor") survive the slug-format
  // rewrite below.
  for (const [pattern, fn] of INPUT_ALIASES) {
    s = s.replace(pattern, fn);
  }

  // Slug-format input detection: all lowercase with hyphens, no spaces
  // ("blue-refractor", "green-shimmer-refractor"). In that shape, "-"
  // is a WORD SEPARATOR not internal punctuation — convert to spaces
  // BEFORE title-casing so we emit "Blue Refractor" not "Blue-Refractor".
  // Mixed-case inputs keep hyphens as internal punctuation
  // ("Mini-Diamond" → "Mini-Diamond").
  if (/^[a-z0-9-]+$/.test(s) && s.includes("-")) {
    s = s.replace(/-/g, " ");
  }

  // Title-case each space-separated segment, respecting stop-words after
  // position 0 and preserving internal "-", "'", "/", "&".
  const segments = s.split(" ");
  const display = segments
    .map((seg, i) => {
      if (!seg) return seg;
      if (i > 0 && STOP_WORDS.has(seg.toLowerCase())) return seg.toLowerCase();
      return titleCaseSegment(seg);
    })
    .join(" ");

  // Slug derived from the canonical display via the existing normalizer,
  // which handles the same alias vocab plus produces the kebab-slug used
  // by hobbyiqCardId. Falls back to "base" for empty/none inputs.
  const slug = normalizeParallel(display);
  return { display, slug };
}
