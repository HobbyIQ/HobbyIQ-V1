/**
 * CF-ONE-NAME-FORMAT-FOR-EVERY-CARD (Drew, 2026-08-24: "we want the SAME
 * consistent format FOR all of our catalog" / "going forward we want ALL
 * format for ALL cards").
 *
 * One string, built the same way for a 1949 Bowman common and a 2025 Gold
 * Refractor /50:
 *
 *   {year} {Brand} {Sport} {Subset} #{cardNumber} {Player} {Parallel} [/{printRun}]
 *
 *   1949 Bowman Baseball #77 Ernie Bonham Base
 *   1952 Topps Baseball #397 Forrest Main Base
 *   2025 Bowman Draft Chrome Prospect Autograph #CPA-EW Eli Willits Yellow Refractor /75
 *
 * THE SUBSET IS PART OF THE NAME (Drew: "the eli willits should have autograph
 * in it too, it is chrome prospect Autograph coming from CPA"). It is also the
 * dimension the slug has no segment for, which is why bowman-draft and
 * bowman-chrome fight over CPA cards and why paper Gold /50 collides with
 * chrome Gold Refractor /50 — three separate defects, one missing field.
 *
 * And it reads AUTOGRAPH, not Auto. The card number already encodes it; the
 * name should say it in full.
 *
 * Every segment is OMITTED when absent rather than printed empty, so a card
 * with no print run simply ends earlier and nothing is invented to fill a slot.
 *
 * This lives in src/ rather than in a repair script because the point is
 * "going forward": a name applied once by a backfill drifts the moment the
 * next ingest writes a row its own way, which is exactly how the catalog came
 * to hold "Base Set", "Bowman" and "1952 Bowman Baseball" as three formats for
 * the same idea.
 */

/**
 * Card-number prefix -> subset, transcribed from the table
 * parseTitleIdentity.service.ts has carried as a comment. It was documentation
 * that nothing could read; here it is data.
 *
 * Longest prefix wins, so BSPA does not match as BA and DPPA does not match as
 * PA. Only used when a row has no subsetName of its own — a stored value from
 * a checklist always beats a derivation.
 */
const CARD_PREFIX_SUBSET: ReadonlyArray<readonly [string, string]> = [
  ["APDCA", "Applied Pressure Autographs"],
  ["54FAV", "Bowman '54 Flag Variation Autographs"],
  ["BSPA", "Bowman Sterling Prospect Autographs"],
  ["DPPA", "Draft Picks & Prospects Autographs"],
  ["FFDA", "Franchise Futures Dual Autographs"],
  ["CUSA", "Chrome Update Series Autographs"],
  ["RODA", "Real One Dual Autographs"],
  ["ROTA", "Real One Triple Autographs"],
  ["CCAR", "Clubhouse Collection Autograph Relics"],
  ["B96A", "Bowman's Best Best of '96 Autographs"],
  ["CPA", "Chrome Prospect Autographs"],
  ["CDA", "Chrome Draft Pick Autographs"],
  ["CRA", "Chrome Rookie Autographs"],
  ["BPA", "Bowman Prospect Autographs"],
  ["BGA", "Bowman Glass Autographs"],
  ["MRA", "Mood Ring Autographs"],
  ["UAC", "Ultimate Autograph Book Card"],
  ["CBA", "Topps Chrome Black Autographs"],
  ["CCA", "Cosmic Chrome Autographs"],
  ["FSA", "Future Stars Autographs"],
  ["ROA", "Real One Autographs"],
  ["FAR", "Flashback Autograph Relics"],
  ["RA", "Topps Chrome Rookie Autographs"],
  ["BA", "Bowman's Best Autographs"],
  ["PA", "Paper Prospect Autographs"],
];

/** The subset a card number implies, or null when it implies none. */
export function subsetFromCardNumber(cardNumber: string | number | null | undefined): string | null {
  const cn = String(cardNumber ?? "").trim().toUpperCase();
  const m = cn.match(/^([A-Z0-9]+)-/);
  if (!m) return null;
  const pfx = m[1];
  for (const [p, name] of CARD_PREFIX_SUBSET) if (pfx === p) return name;
  return null;
}

export interface CanonicalNameInput {
  year?: number | string | null;
  setName?: string | null;
  setKey?: string | null;
  sport?: string | null;
  cardNumber?: string | number | null;
  playerName?: string | null;
  parallel?: string | null;
  printRun?: number | string | null;
  subsetName?: string | null;
}

/** Title-cases a slug or loose phrase. Two-letter lowercase words become
 *  initialisms ("cfl" -> "CFL"), which is how the existing catalog reads. */
export function titleCaseWords(s: string | null | undefined): string {
  return String(s ?? "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 && /^[a-z]+$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * The product name, normalised — NOT merely defaulted.
 *
 * A stored setName is kept verbatim only when it already starts with the
 * year, because that is the publisher's own wording and beats anything
 * derived. Otherwise the year is prepended and the sport appended, so
 * "Bowman" becomes "1951 Bowman Baseball" rather than staying a third format.
 * A bare "Base Set" is a placeholder, not a product, and is rebuilt from the
 * setKey.
 */
export function canonicalSetName(input: CanonicalNameInput): string {
  const year = String(input.year ?? "").trim();
  const existing = String(input.setName ?? "").trim();
  const sport = titleCaseWords(input.sport);
  const withSport = (bits: string[]): string => {
    const joined = bits.filter(Boolean).join(" ");
    // String containment, not a regex. A `\b` inside a template literal is a
    // BACKSPACE character, not a word boundary — that bug has now appeared four
    // times in one day, in three different files. Comparison cannot be mangled.
    if (sport && !joined.toLowerCase().split(/[^a-z0-9]+/).includes(sport.toLowerCase())) {
      return `${joined} ${sport}`.trim();
    }
    return joined;
  };
  if (existing && year && existing.startsWith(year)) return existing;
  if (existing && !/^base set$/i.test(existing)) return withSport([year, existing]);
  return withSport([year, titleCaseWords(input.setKey)]);
}

/** The one display string for any card, in any year. */
export function canonicalCardName(input: CanonicalNameInput): string {
  const parts: string[] = [canonicalSetName(input)];

  // ONLY-IMPROVE, not stored-always-wins (Drew, 2026-08-24: "the eli willits
  // should have autograph in it too, it is chrome prospect Autograph coming
  // from CPA").
  //
  // Preferring the stored value unconditionally produced
  //   "2025 Bowman Draft Baseball Autographs #CPA-EW ..."
  // because the checklist stored the vaguer "Autographs" while the card number
  // says Chrome Prospect Autographs. A checklist usually knows better, but not
  // when it is strictly less specific than what the card number states.
  //
  // So take the richer of the two: if one contains the other, the longer wins.
  // If they disagree outright, the stored value still wins — that is a real
  // disagreement, not a missing detail, and the checklist is the authority.
  //
  // "Base Set" is dropped entirely. Every non-insert card is in the base set,
  // so it adds a word and no information ("1952 Topps Baseball Base Set #311").
  const storedSubset = String(input.subsetName ?? "").trim();
  const derivedSubset = subsetFromCardNumber(input.cardNumber) ?? "";
  let subset = storedSubset || derivedSubset;
  if (storedSubset && derivedSubset) {
    const a = storedSubset.toLowerCase();
    const b = derivedSubset.toLowerCase();
    if (b.includes(a) && b.length > a.length) subset = derivedSubset;
  }
  if (/^base set$/i.test(subset)) subset = "";
  if (subset && !parts[0].toLowerCase().includes(subset.toLowerCase())) {
    parts.push(subset);
  }

  const cardNumber = String(input.cardNumber ?? "").trim();
  if (cardNumber) parts.push(`#${cardNumber.toUpperCase()}`);

  const player = String(input.playerName ?? "").trim();
  if (player) parts.push(player);

  const parallel = titleCaseWords(input.parallel);
  if (parallel) parts.push(parallel);

  // Only when there IS one (Drew: "the /50 if it is there").
  const run = Number(input.printRun);
  if (Number.isFinite(run) && run > 0) parts.push(`/${run}`);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}
