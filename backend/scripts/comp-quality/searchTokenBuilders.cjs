// CF-TOKEN-BUILDERS-SHARED (2026-08-22). The single definition of how a
// card_catalog row becomes searchTokens.
//
// WHY THIS IS ITS OWN MODULE. These functions used to live inside
// backfill-search-fields.cjs, which is a CLI with no exports. Anything else
// that needed to know what tokens a row SHOULD have — most importantly the
// coverage canary — had to keep a copy. A copy is exactly the wrong shape
// here: the canary exists to catch the backfill writing the wrong thing, and a
// canary carrying its own copy of the builder cannot notice the builder
// changing underneath it. Both sides now import the same code, so a drift in
// one is a drift in both and the comparison stays meaningful.
//
// See project_holding_field_normalizer_standard for the same principle applied
// to field cleaning: one implementation, pinned by tests, no second copy.

// Assemble the searchable text for a row.
//
// TWO ROW SHAPES. card_catalog holds rows written by different producers and
// they do not share field names:
//
//   cardsight rows : player, releaseName, number, parallels[].name, attributes[]
//   canonical rows : playerName, setKey, cardNumber, parallel, parallelSlug
//
// The original job was scoped `WHERE c.source = 'cardsight'`, so reading only
// the first shape was self-consistent — and also why every non-cardsight row
// in the catalog had no searchTokens for months, which is what forced
// catalogSearch's seven unindexed CONTAINS branches and the 20s+ scans.
//
// Read both. A row carrying neither shape produces no parts, and the caller
// REFUSES it rather than writing an empty token array — an empty array is
// defined-and-not-null, so it would satisfy a missing-only filter forever.
function buildSearchText(row) {
  const parts = [];
  // player
  if (row.player) parts.push(String(row.player));
  if (row.playerName && row.playerName !== row.player) parts.push(String(row.playerName));
  // product / set
  if (row.releaseName) parts.push(String(row.releaseName));
  if (row.setName && row.setName !== row.releaseName) parts.push(String(row.setName));
  if (row.setKey && row.setKey !== row.setName && row.setKey !== row.releaseName) {
    parts.push(String(row.setKey).replace(/-/g, " "));
  }
  // card number
  if (row.number) parts.push(String(row.number));
  if (row.cardNumber && row.cardNumber !== row.number) parts.push(String(row.cardNumber));
  if (row.year) parts.push(String(row.year));
  // parallels: array shape (cardsight) and scalar shape (canonical)
  if (Array.isArray(row.parallels)) {
    for (const p of row.parallels) if (p?.name) parts.push(String(p.name));
  }
  if (row.parallel && String(row.parallel).toLowerCase() !== "base") {
    parts.push(String(row.parallel));
  }
  if (row.parallelSlug && row.parallelSlug !== row.parallel) {
    parts.push(String(row.parallelSlug).replace(/-/g, " "));
  }
  if (Array.isArray(row.attributes)) {
    for (const a of row.attributes) if (a) parts.push(String(a));
  }
  return parts.join(" ").toLowerCase();
}

// Tokenize searchText into unique alphanumeric tokens for ARRAY_CONTAINS
// lookups. Mirrors canonicalCardSearch's tokenize() (kept simple + sync).
// Also includes card-number fragments (e.g. "cpa-eha" → also "cpa" + "eha")
// so users typing either half of a hyphenated card number hit the row.
// CF-TOKEN-FOLD-TO-MATCH-SEARCHER (2026-08-22). Emit the tokens the SEARCHER
// will actually look up, not just the ones this text happens to contain.
//
// catalogSearch tokenizes a user's query with
//     .replace(/[^\w\s-]/g, " ")
// so apostrophes and diacritics become separators there, while this builder
// split on /[^a-z0-9-]+/ and stored the raw form. The two disagreed, and an
// ARRAY_CONTAINS lookup is exact — so the disagreement is a miss:
//
//   "Shaquille O'Neal"  stored o'neal   | user types neal   -> no match
//   "Sergio Aguero"     stored agüero   | user types aguero -> no match
//                       builder wanted ag/ero, which is not aguero either,
//                       so NEITHER form could find that card by surname.
//
// Found 2026-08-22 by the staleness canary on its first real run — the check
// that could not previously fail.
//
// Emit every form rather than picking one. Extra tokens are cheap and
// explicitly harmless (classifyRowTokens treats extras as fine); a missing
// one is a card the user cannot find.
function foldToAscii(s) {
  return String(s)
    .normalize("NFKD")
    // Strip Unicode combining marks. NFKD has already split "ü" into "u" plus
    // a combining diaeresis, so removing the marks leaves plain ASCII.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function buildSearchTokens(searchText) {
  if (!searchText) return [];
  const seen = new Set();
  const out = [];
  const push = (t) => {
    if (t && t.length >= 2 && t.length <= 30 && !seen.has(t)) { seen.add(t); out.push(t); }
  };
  // Split on whitespace + non-alphanum, keeping hyphenated tokens whole
  // AND their halves so both "cpa-eha" and "cpa" match.
  const lowered = String(searchText).toLowerCase();
  const rawTokens = lowered.split(/[^a-z0-9-]+/).filter(Boolean);
  for (const raw of rawTokens) {
    // Emit the full token (may contain hyphen, e.g. "cpa-eha", "o-pee-chee")
    push(raw);
    // Also emit hyphen-split fragments so partial-cardNumber queries hit
    if (raw.includes("-")) for (const frag of raw.split("-")) push(frag);
  }

  // The searcher's own view of this text. Its tokenizer turns any non-[\w\s-]
  // character into a SEPARATOR, so "o'neal" becomes "neal" there. Without this
  // pass those tokens exist only on the query side and can never match.
  for (const t of lowered.replace(/[^\w\s-]/g, " ").split(/\s+/)) {
    push(t.trim());
    if (t.includes("-")) for (const frag of t.split("-")) push(frag.trim());
  }

  // ASCII-folded forms, because users type "aguero", not "agüero".
  for (const t of foldToAscii(lowered).replace(/[^\w\s-]/g, " ").split(/\s+/)) {
    push(t.trim());
    if (t.includes("-")) for (const frag of t.split("-")) push(frag.trim());
  }

  return out;
}

/**
 * Is this row's stored searchTokens array consistent with what the CURRENT
 * builders would produce for it?
 *
 * This is the question the coverage canary could not previously ask. A row
 * written by an older builder is NON-EMPTY — so a missing-tokens count calls
 * it covered — while lacking the canonical fields the searcher relies on. It
 * then misses every indexed arm and falls through to the unindexed scans, at
 * full cost, invisibly.
 *
 * Returns one of: "empty" | "stale" | "ok".
 *
 * Deliberately asymmetric: EXTRA stored tokens are fine. Rows legitimately
 * accumulate tokens from sources this builder does not model, and treating
 * those as stale would make the canary cry wolf on every such row. Only
 * MISSING tokens matter, because a token the builder wants and the row lacks
 * is precisely a lookup that will not hit the index.
 */
function classifyRowTokens(row) {
  const have = new Set((Array.isArray(row.searchTokens) ? row.searchTokens : []).map(String));
  if (have.size === 0) return "empty";
  const want = buildSearchTokens(buildSearchText(row));
  // A row the builders cannot describe at all is not evidence of staleness —
  // there is nothing to compare against.
  if (want.length === 0) return "ok";
  return want.some((t) => !have.has(t)) ? "stale" : "ok";
}

/** Fields classifyRowTokens needs. Kept here so every caller's SELECT stays
 *  in step with the builders — a projection missing `parallel` would make
 *  every parallel row look stale. */
const TOKEN_SOURCE_FIELDS = [
  "c.id", "c.playerName", "c.player", "c.setKey", "c.setName", "c.releaseName",
  "c.cardNumber", "c.number", "c.year", "c.parallel", "c.parallelSlug",
  "c.parallels", "c.attributes", "c.searchTokens",
];

module.exports = {
  buildSearchText,
  buildSearchTokens,
  classifyRowTokens,
  TOKEN_SOURCE_FIELDS,
};
