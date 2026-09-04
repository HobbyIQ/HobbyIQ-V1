// CF-THE-TITLE-OUTRANKS-THE-VENDOR-PLAYER (Drew, 2026-09-04).
//
// A sale of a 1987 Topps Traded Tiffany Greg Maddux, PSA 10, whose title says
// so in words, was filed at
//
//     hiq:baseball:1987:topps:player-todd-worrell:base:no-auto
//
// TCA had attributed the sale to Todd Worrell. Two defects met on that row and
// each one alone would have been survivable:
//
//   1. the cardNumber the title states (#70T) was not read, and the blank was
//      mistaken for "this card has no number" -- CF-UNPARSED-IS-NOT-UNNUMBERED
//      in hobbyIqCardId.service.ts closes that half;
//   2. the pseudo-number the first defect reached for was built from the
//      VENDOR's player, because the ingest wrote
//      `identity.playerName ?? guessPlayerFromTitle(title)` -- `??` means the
//      vendor's field wins whenever it is present, and it was present and
//      wrong.
//
// This module is the second half. It is the player-name sibling of
// titleOutranksVendorTag.ts, and it says the same thing that rule says about
// the parallel and CF-A-PRODUCT-QUALIFIER-IS-IDENTITY says about the product:
//
//   THE TITLE IS THE PRIMARY SOURCE. It is what the seller wrote about the
//   card in front of them. A vendor's structured attribution is a second
//   party's reading of that same title, and when the two disagree about WHO IS
//   ON THE CARD they are not two spellings of one answer -- they are two
//   different cards, and one of them is a mis-attribution.
//
// THREE OUTCOMES, AND THE THIRD IS THE POINT
//
//   agree      the two names are the same person once spelling, punctuation,
//              accents, suffixes and initials are folded. The vendor's fuller
//              spelling is kept -- "Ken Griffey Jr." over "Griffey".
//   title-wins the title names a player and the vendor names nobody, or the
//              vendor's name is a subset/abbreviation of the title's. The
//              title's reading stands.
//   irreconcilable
//              both name a player and they are different people. NEITHER is
//              adopted and the caller must treat the row's identity as
//              UNDERIVABLE. Absent beats wrong: a row keyed to the wrong
//              player pollutes that player's pool AND robs the right one, and
//              an unkeyed row can be re-derived tomorrow.
//
// WHY NOT "JUST TAKE THE TITLE"
//
// Because the title parse is not infallible either. A title naming two people
// ("Maddux Glavine Smoltz"), a team name read as a person, or a parse that
// grabbed the set name would silently re-key rows onto a different wrong
// player. When two independent readings disagree, the honest answer is that we
// do not know, and that is what `irreconcilable` encodes.

/** Fold a display name to its comparable core: lowercase, accents stripped,
 *  punctuation removed, generational suffixes dropped. */
export function playerNameKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")     // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")        // punctuation → space ("O'Neill" → "o neill")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokensOf = (key: string): string[] => key.split(" ").filter(Boolean);

/** The surname — the last token, which survives every abbreviation form we
 *  see ("G. Maddux", "Maddux, Greg", "Greg Maddux"). */
function surnameOf(key: string): string {
  const t = tokensOf(key);
  return t.length ? t[t.length - 1] : "";
}

/** Is `short` an abbreviation of `full`? Same surname, and every non-surname
 *  token of `short` is either a full token of `full` or its initial. */
function isAbbreviationOf(short: string, full: string): boolean {
  const s = tokensOf(short), f = tokensOf(full);
  if (!s.length || !f.length) return false;
  if (surnameOf(short) !== surnameOf(full)) return false;
  const fRest = f.slice(0, -1);
  for (const tok of s.slice(0, -1)) {
    const ok = fRest.some((ft) => ft === tok || (tok.length === 1 && ft.startsWith(tok)));
    if (!ok) return false;
  }
  return true;
}

export type PlayerDecision =
  | { player: string; outcome: "agree" | "title-wins" | "vendor-only" | "title-only"; vendorOverruled: boolean }
  | { player: null; outcome: "irreconcilable" | "neither"; vendorOverruled: boolean; vendorPlayer: string | null; titlePlayer: string | null };

/**
 * Reconcile the vendor's attributed player against the title's.
 *
 * Replaces `vendor ?? title`. The `??` was the bug: it never compared them.
 */
export function playerTheTitleAllows(
  vendorPlayer: string | null | undefined,
  titlePlayer: string | null | undefined,
): PlayerDecision {
  const v = String(vendorPlayer ?? "").trim();
  const t = String(titlePlayer ?? "").trim();
  const vk = playerNameKey(v), tk = playerNameKey(t);

  if (!vk && !tk) return { player: null, outcome: "neither", vendorOverruled: false, vendorPlayer: null, titlePlayer: null };
  if (!tk) return { player: v, outcome: "vendor-only", vendorOverruled: false };
  if (!vk) return { player: t, outcome: "title-only", vendorOverruled: false };

  // "O'Neill, Paul" and "Paul O Neill" are one person written two ways: the
  // vendor's surname-first form and the title's natural order. Same tokens,
  // different order, and a surname-anchored test cannot see it because each
  // side's LAST token is the other's first. Compare the token SETS before
  // anything order-dependent runs.
  const sortedKey = (k: string): string => tokensOf(k).slice().sort().join(" ");
  if (sortedKey(vk) === sortedKey(tk)) {
    return { player: v.length >= t.length ? v : t, outcome: "agree", vendorOverruled: false };
  }

  if (vk === tk) {
    // Same person. Keep the LONGER spelling — it carries more information
    // ("Ken Griffey Jr." over "Ken Griffey" once suffixes fold).
    return { player: v.length >= t.length ? v : t, outcome: "agree", vendorOverruled: false };
  }
  // One is an abbreviation of the other: still one person, and the fuller
  // spelling is the better answer whichever side supplied it.
  if (isAbbreviationOf(vk, tk)) return { player: t, outcome: "agree", vendorOverruled: false };
  if (isAbbreviationOf(tk, vk)) return { player: v, outcome: "agree", vendorOverruled: false };

  // Different surnames, or same surname with contradicting given names. Two
  // people. The title is the primary source, but a disagreement this loud is
  // not a spelling question — it is a mis-attribution on one side, and nothing
  // on the row says which. UNDERIVABLE.
  return { player: null, outcome: "irreconcilable", vendorOverruled: true, vendorPlayer: v, titlePlayer: t };
}
