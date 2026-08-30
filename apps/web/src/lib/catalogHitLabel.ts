/**
 * The two label strings a "Find this card" result row shows: the set line and
 * the player line. Pure, so the picker's display rules are pinned by something
 * that exits 0/1.
 *
 * CF-A-BACKSLASH-IN-A-STRING-IS-NOT-A-BACKSLASH (D33, Drew 2026-08-30, "still
 * a mess" on 2020 Bowman Draft BD-152). Both of these lived inline in
 * CatalogPickerModal, and both regexes arrived in #1466 having lost their
 * escape:
 *
 *   new RegExp("^" + String(h.year) + "\s+")   -- in a normal JS string "\s"
 *     is just the letter s, so the pattern compiled to /^2020s+/ and the
 *     doubled year NEVER stripped. Not "for one shape only": for no shape.
 *
 *   .replace(/[s,;]+$/, "")                    -- a character class holding the
 *     LETTER s, so it ate the last letter of every player name ending in one.
 *     "Wade Boggs" rendered "Wade Bogg", "Roger Maris" "Roger Mari" -- 2.45M
 *     rows, 12.4% of the catalog. Display only; the stored names were fine.
 *
 * Living here they are testable, and the year strip is built from a literal
 * regex rather than string concatenation, so no escape can be lost to a string
 * again.
 */

export interface CatalogHitLabelInput {
  setName?: string | null;
  setKey?: string | null;
  year?: number | null;
  cardNumber?: string | null;
  playerName?: string | null;
}

/** The year, once. The checklist sources write it into setName ("2025 Bowman
 *  Draft Baseball") and the row prints it in front, so one of the two goes. */
export function setLabelOf(hit: Pick<CatalogHitLabelInput, "setName" | "setKey" | "year">): string {
  const raw = String(hit.setName || hit.setKey || "");
  if (!hit.year) return raw.trim();
  return raw.replace(new RegExp(`^${hit.year}\\s+`), "").trim();
}

/** A trailing run of whitespace / commas / semicolons is not part of a name.
 *  Every other character is -- including a final "s". */
export function playerLabelOf(hit: Pick<CatalogHitLabelInput, "playerName">): string {
  return String(hit.playerName || "").replace(/[\s,;]+$/, "").trim();
}

/** "2020 Bowman Draft Baseball #BD-152" -- the year exactly once. */
export function cardLabelOf(hit: CatalogHitLabelInput): string {
  return [
    hit.year ? String(hit.year) : null,
    setLabelOf(hit) || null,
    hit.cardNumber ? `#${hit.cardNumber}` : null,
  ].filter(Boolean).join(" ");
}
