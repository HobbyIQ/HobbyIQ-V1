"use strict";
/**
 * auto-only-override.cjs -- Drew ruling R-0927d (2026-09-27 ~02:50Z).
 *
 * For AUTOGRAPH-ONLY inserts, a checklist-grade card_catalog row at the
 * `:no-auto` id is a minting error -- the checklistinsider layout (and its
 * siblings named in backend/data/auto-only-override-defective-sources.json)
 * mints autograph-only cards as isAuto=false. repoint-sales-isauto-flip.cjs's
 * `checklist-at-both` guard is correct in GENERAL (two attested checklist
 * rows really can be genuinely different cards), but for this narrow shape
 * the "ambiguity" is not real: the no-auto side's own cardNumber prefix is
 * ALREADY a registered auto-only insert, so there was never a base card to
 * disagree with.
 *
 * This module is the gate that turns that refusal into a MOVE, no-auto ->
 * auto ONLY, and ONLY when every one of ALL FOUR conditions holds. It is
 * consulted ADDITIVELY -- a miss on any one condition leaves the caller's
 * existing refused-checklist-at-both path completely unchanged. It is NEVER
 * consulted in the reverse (auto -> no-auto) direction; see
 * `direction !== "no-auto-to-auto"` short-circuit below.
 *
 * Evidence: DRAFT PR #2453 (`gh pr view 2453 --comments`), the census at
 * C:/tmp/unsigned_1949/RESULT.md -- 22 (setKey, prefix, year) groups /
 * 3,265 BOTH-checklist pairs in baseball, biggest three: bowman-chrome
 * CPA- 2024 (1,863 pairs), bowman-chrome CRA- 2024 (221), topps-chrome-
 * update-series CHRU- 2025 (192). Tonight's football/basketball extension
 * is being appended to the same PR.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFECTIVE_SOURCES_PATH = path.join(__dirname, "..", "..", "data", "auto-only-override-defective-sources.json");

let _cachedPrefixes = null;
function defectiveSourcePrefixes() {
  if (_cachedPrefixes) return _cachedPrefixes;
  const raw = JSON.parse(fs.readFileSync(DEFECTIVE_SOURCES_PATH, "utf8"));
  const entries = Array.isArray(raw.sources) ? raw.sources : [];
  _cachedPrefixes = entries
    .map((e) => String(e?.prefix ?? "").toLowerCase().trim())
    .filter(Boolean);
  return _cachedPrefixes;
}

/** Exposed for tests that want to assert the allowlist loaded, or to force a
 *  reload after a test mutates the on-disk file. Never called by the gate
 *  itself outside of `defectiveSourcePrefixes()`'s own cache. */
function _resetCacheForTests() { _cachedPrefixes = null; }

/** Gate 3 alone: is this catalog row's source one the census identified as
 *  the unsigned-minting layout? Prefix match, case-insensitive, mirrors the
 *  `-graded` suffix convention elsewhere in this codebase (a graded twin
 *  inherits its parent's provenance). */
function isKnownUnsignedMintingSource(source) {
  const s = String(source ?? "").toLowerCase().trim();
  if (!s) return false;
  return defectiveSourcePrefixes().some((prefix) => s.startsWith(prefix));
}

/**
 * Gate 2: is `cardNumber` an auto-only prefix for this (sport, year, setKey)?
 * ORs the SHARED global regex (mirrors hobbyIqCardId.service.ts's own
 * AUTO_ONLY_CARDNUMBER_PREFIX -- that const is not exported, so it is
 * mirrored here byte-for-byte with a comment tracing it back; a drift check
 * unit test pins the two stay equal) with the scoped table
 * (isScopedAutoOnlyPrefix, imported live from dist -- the ONE table, never
 * duplicated) OR the destination `:auto` checklist row's own category/section
 * saying autograph (an `auto-` categoried row, which the ingester already
 * stamps from the checklist's OWN card-number section -- never sale title
 * text, per feedback_isauto_boundary_is_cardnumber_not_text.md).
 */
// Mirrors backend/src/services/portfolioiq/hobbyIqCardId.service.ts's
// AUTO_ONLY_CARDNUMBER_PREFIX byte-for-byte. That const is not exported (it is
// module-private, consulted only inside computeHobbyIqCardId), so this is a
// deliberate, tracked duplicate rather than an import -- a mutation/drift
// test (autoOnlyOverride.test.ts) pins this string equal to the source file's
// own regex literal so a future edit to one side cannot silently drift from
// the other.
const AUTO_ONLY_CARDNUMBER_PREFIX = /^(cpa|bcpa|bdcpa|cda|tcpa|cra|bspa|bpa|bda)(?:-|\d)/i;

function isAutoOnlyPrefix(cardNumber, scope, isScopedAutoOnlyPrefix, destRowCategory) {
  const cn = String(cardNumber ?? "");
  if (AUTO_ONLY_CARDNUMBER_PREFIX.test(cn)) return true;
  if (typeof isScopedAutoOnlyPrefix === "function" && isScopedAutoOnlyPrefix(cn, scope)) return true;
  // The destination (:auto) checklist row's own category/section: an
  // `auto-...` category is the ingester's stamp of the CHECKLIST'S OWN
  // card-number section, never sale-title text (the doctrine boundary --
  // feedback_isauto_boundary_is_cardnumber_not_text.md). A category is not
  // ALWAYS present on every row shape, so this is consulted only as a
  // fallback when the two prefix tables above miss.
  if (typeof destRowCategory === "string" && destRowCategory.toLowerCase().startsWith("auto-")) return true;
  return false;
}

/**
 * THE GATE. Returns `{ move: boolean, reason: string }`. `move: true` means
 * every one of the four R-0927d conditions held and the caller should MOVE
 * no-auto -> auto instead of refusing. Every other outcome is `move: false`
 * with a `reason` naming which condition failed, for the counter/report line.
 *
 * @param {object} args
 * @param {"no-auto-to-auto"} args.direction -- REQUIRED, must be exactly this
 *   literal. Any other value (including the reverse "auto-to-no-auto") is an
 *   automatic, unconditional refusal -- this override NEVER reverses.
 * @param {string} args.cardNumber -- the sale/current row's cardNumber.
 * @param {object} args.scope -- { sport, year, setKey } for the scoped table.
 * @param {string} args.noAutoSource -- the :no-auto catalog row's own `source`.
 * @param {string} args.saleName -- the sale's own playerName.
 * @param {string} args.autoRowName -- the :auto catalog row's own playerName.
 * @param {string} [args.autoRowCategory] -- the :auto row's own category, if
 *   the caller has it (used only as gate 2's fallback).
 * @param {(cardNumber: string, scope: object) => boolean} args.isScopedAutoOnlyPrefix
 *   -- injected so this module carries no import of its own (matches the
 *   rest of this lane's dist-injection convention); pass the REAL function
 *   loaded from dist/services/portfolioiq/scopedAutoOnlyPrefixes.js.
 * @param {(a: string, b: string) => boolean} args.namesAgree -- injected;
 *   pass the REAL namesAgree from lib/name-agreement.cjs.
 */
function autoOnlyOverride(args) {
  const {
    direction, cardNumber, scope, noAutoSource, saleName, autoRowName,
    autoRowCategory, isScopedAutoOnlyPrefix, namesAgree,
  } = args || {};

  // NEVER REVERSE. This is checked first and unconditionally -- no other
  // condition can compensate for the wrong direction.
  if (direction !== "no-auto-to-auto") {
    return { move: false, reason: "wrong-direction" };
  }

  // Gate 2: cardNumber prefix is auto-only for this (sport, year, setKey).
  if (!isAutoOnlyPrefix(cardNumber, scope, isScopedAutoOnlyPrefix, autoRowCategory)) {
    return { move: false, reason: "not-auto-only-prefix" };
  }

  // Gate 3: the :no-auto row's source is a known unsigned-minting layout.
  if (!isKnownUnsignedMintingSource(noAutoSource)) {
    return { move: false, reason: "source-not-in-allowlist" };
  }

  // Gate 4: the sale and the :auto row's player agree.
  if (typeof namesAgree !== "function" || !namesAgree(saleName, autoRowName)) {
    return { move: false, reason: "name-disagrees" };
  }

  return { move: true, reason: "auto-only-override" };
}

module.exports = {
  autoOnlyOverride, isAutoOnlyPrefix, isKnownUnsignedMintingSource,
  defectiveSourcePrefixes, AUTO_ONLY_CARDNUMBER_PREFIX,
  _resetCacheForTests, DEFECTIVE_SOURCES_PATH,
};
