"use strict";
/**
 * card-number-scope.cjs -- the pure card-number-SEGMENT extraction and
 * scope-match `rekey-product-setkey`'s CARD_NUMBER_SCOPE option needs
 * (CF-A-CARD-NUMBER-SUBSET-IS-NOT-A-WHOLE-PRODUCT, 2026-09-25).
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
 *
 * `rekey-product-setkey.cjs` has no `module.exports` -- it is a `main()`-only
 * ops script that builds a Cosmos client eagerly, so `require`-ing it in a
 * test executes that main() immediately and fails on a missing connection
 * string. Pulling the pure id-parsing piece out here (the SAME shape
 * `market-guard.cjs` and `name-agreement.cjs` already use for this script's
 * other pure decisions) is what makes a REAL unit test possible: call
 * `cardNumberSegmentOf` / `matchesCardNumberScope` with strings, assert on the
 * return value, no subprocess and no Cosmos.
 *
 * ── THE DEFECT THIS MODULE FIXES ─────────────────────────────────────────────
 *
 * The id shape is `hiq:sport:year:setKey[:sub-{slug}]:number:parallel:auto
 * [:num-N]` (hobbyIqCardId.service.ts's `parseHobbyIqCardId`, ~L3257-3274).
 * The `sub-` segment is OPTIONAL and sits right after setKey, told apart from
 * the card number by its `sub-` PREFIX -- never by counting, because an
 * 8-part id can be EITHER a subset row with no print run OR an ordinary row
 * with one. A caller that reads a literal `.split(":")[4]` gets the card
 * number for an ordinary row and the LITERAL STRING "sub-{slug}" for a subset
 * row -- silently: the mis-read value just fails every scope check like any
 * other out-of-scope card number, so the row is printed as an ordinary skip
 * and stranded at FROM with no error anywhere. Measured shape:
 *
 *   hiq:baseball:2026:bowman-chrome:sub-cards-that-never-were:bma-1:base:no-auto
 *                                    ^^^^^^^^^^^^^^^^^^^^^^^^^ index 4 (subset)
 *                                                              ^^^^^ index 5 (number)
 *
 * `cardNumberSegmentOf` reads the id the same way `parseHobbyIqCardId` does:
 * check index 4 for the `sub-` prefix, and only step to index 5 when it is
 * there. An ordinary id (no subset) is untouched -- index 4 stays the answer.
 *
 * ── SELF-CONTAINED ────────────────────────────────────────────────────────────
 *
 * No `require` of anything outside this file, including no dist/ and no
 * dependency on hobbyIqCardId.service.ts itself -- the same contract
 * `market-guard.cjs` and `name-agreement.cjs` state for themselves, so a
 * caller with no compiled tree can still load this. The id SHAPE is mirrored
 * here rather than imported; if `parseHobbyIqCardId`'s subset-segment rule
 * ever changes, this file's header comment is where a future reader finds out
 * it needs a matching edit.
 */

/**
 * The id's own cardNumber SEGMENT. `hiq:sport:year:setKey[:sub-{slug}]:
 * number:parallel:auto[:num-N]` -- index 4 is the card number UNLESS it
 * itself starts with `sub-`, in which case the subset segment sits there and
 * the card number is index 5. Returns "" for a malformed or empty id (never
 * throws), the same fail-safe shape isUntrustedSource/inCardNumberScope use
 * for a missing field elsewhere in this script.
 */
function cardNumberSegmentOf(id) {
  const parts = String(id ?? "").split(":");
  const seg4 = parts[4] ?? "";
  return seg4.startsWith("sub-") ? (parts[5] ?? "") : seg4;
}

/**
 * Does this id's OWN card-number segment fall inside `scopeList` -- a list of
 * already-lower-cased, already-trimmed prefixes or exact numbers (the shape
 * `CARD_NUMBER_SCOPE` in the caller already produces)? Prefix match
 * (`^<prefix>`) or exact, case-insensitive on the SEGMENT (scopeList is
 * assumed pre-folded; the id's own segment is folded here). An EMPTY
 * scopeList means "no scope was set" and this returns `true` for everything,
 * matching `rekey-product-setkey`'s own "no scope = today's behaviour" rule.
 */
function matchesCardNumberScope(id, scopeList) {
  if (!Array.isArray(scopeList) || scopeList.length === 0) return true;
  const n = cardNumberSegmentOf(id).trim().toLowerCase();
  if (!n) return false;
  return scopeList.some((p) => n === p || n.startsWith(p));
}

module.exports = { cardNumberSegmentOf, matchesCardNumberScope };
