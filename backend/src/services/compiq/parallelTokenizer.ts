// Vendor-neutral string utilities relocated out of the (now-deleted)
// cardsight.mapper.ts during the Cardsight removal arc (Phase 3 Wave 3).
//
// These helpers have no dependency on any catalog/pricing vendor — they are
// pure string normalization used across the CompIQ pricing pipeline
// (parallelTitleMatch, gradedPriceProjection, psa.grader, compiqEstimate).
// They were physically moved here unchanged so the cardsight.* files could be
// deleted without losing this shared behavior.

// ---------------------------------------------------------------------------
// Player-name normalization
// ---------------------------------------------------------------------------
//
// iOS card-scan path concatenates set / parallel / status tokens into the
// playerName field for some holdings. Server-side read-path normalization
// strips known contamination patterns before catalog lookup. Stored data is
// preserved unchanged.
//
// Multi-stage strategy:
//   1. Strip known set/status prefix tokens (longest match first)
//   2. Strip explicit suffix tokens (longest match first)
//   3. Strip generic CHR PROS / CHR PROSPECT suffix patterns via regex
//   4. Hygiene: collapse whitespace, trim

const PLAYERNAME_PREFIX_TOKENS = [
  // Longer multi-token prefixes must come BEFORE their shorter
  // overlapping prefixes so longest match wins.
  "CHROME PROSPECT AUTOGRAPHS",
  "TRADED TIFFANY",
  "PROSPECT AUTOGRAPHS",
  "TRADED",
  "TIFFANY",
];

const PLAYERNAME_SUFFIX_TOKENS = [
  // Longer suffixes first.
  "WAL-MART BORDER",
  "TIFFANY",
];

// Generic suffix: any "CHR PROS ..." or "CHR PROSPECT ..." through end
// of string. Matches the parallel-code suffixes that vary in spacing /
// dashes ("CHR PROS - MINI DIA", "CHR PROSPECT AU- SHIM", etc.) without
// requiring an entry per code.
const PLAYERNAME_GENERIC_CODE_SUFFIX = /\bCHR\s+PROS(?:PECT)?\b.*$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePlayerName(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name).trim();
  if (!s) return "";

  // Stage 1 — strip known prefix tokens (longest first via list order).
  for (const prefix of PLAYERNAME_PREFIX_TOKENS) {
    const re = new RegExp(`^${escapeRegExp(prefix).replace(/\\\s\+/g, "\\s+")}\\s+`, "i");
    if (re.test(s)) {
      s = s.replace(re, "").trim();
      break;
    }
  }

  // Stage 2 — strip explicit suffix tokens (longest first).
  for (const suffix of PLAYERNAME_SUFFIX_TOKENS) {
    const re = new RegExp(`\\s+${escapeRegExp(suffix).replace(/\\\s\+/g, "\\s+")}\\s*$`, "i");
    if (re.test(s)) {
      s = s.replace(re, "").trim();
      break;
    }
  }

  // Stage 3 — strip generic CHR PROS / CHR PROSPECT suffix patterns.
  s = s.replace(PLAYERNAME_GENERIC_CODE_SUFFIX, "").trim();

  // Stage 4 — hygiene.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

// ---------------------------------------------------------------------------
// Parallel tokenization
// ---------------------------------------------------------------------------
//
// Many parallel finishes are catalogued under BOTH singular and plural names —
// "Refractor" AND "Refractors", etc. The two spellings get distinct ids, so
// sales of the same physical parallel split across two identities. Singularize
// parallel-vocabulary nouns when tokenizing. Stripping is gated by this set so
// non-vocab plurals (player names ending in -s, set-name plurals, etc.) stay
// untouched.
export const PARALLEL_SINGULAR_TOKENS: ReadonlySet<string> = new Set([
  "refractor",
  "fractor", // matches "superfractor" siblings (X-Fractor handled via xfractor below)
  "xfractor", // CF-X3: canonicalized X-Fractor token, plural-tolerant ("X-fractors")
  "wave",
  "shimmer",
  "speckle",
  "diamond",
  "raywave",
  "reptilian",
  "lava",
  "atomic",
  "mojo",
  "pulsar",
  "padparadscha",
  "sapphire",
  "prizm",
]);

function singularize(token: string): string {
  if (token.length < 4 || !token.endsWith("s")) return token;
  const singular = token.slice(0, -1);
  return PARALLEL_SINGULAR_TOKENS.has(singular) ? singular : token;
}

// Single source of truth for parallel tokenization shared between
// resolver-time and comp-fetch-time consumers. Both must see the same
// wrapper-strip behavior so a matched parallel resolves identical tokens at
// filter time.
//
// - Strips parenthesized wrappers ("Limited Edition (Tiffany)" → ["tiffany"]).
// - Singularizes parallel-vocabulary nouns ("Refractors" → "refractor").
// - Canonicalizes the X-Fractor family ("X-Fractor"/"Xfractor"/"x fractor"
//   → "xfractor"), word-boundary anchored so "Lex-Fractor"-shaped strings are
//   untouched.
export function tokenizeParallel(name: string): string[] {
  const wrapped = name.match(/\(([^)]+)\)/);
  const stripped = (wrapped ? wrapped[1] : name).replace(/\bx[-\s]?fractor\b/gi, "xfractor");
  return stripped
    .split(/[\s\-/]+/)
    .map((t) => singularize(t.toLowerCase()))
    .filter((t) => t.length > 0);
}
