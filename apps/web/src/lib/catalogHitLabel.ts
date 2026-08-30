/**
 * D33 (Drew, 2026-08-30, on "Find this card" for a 2020 Bowman Bobby Witt Jr.:
 * "still a mess"). The picker's own label code, extracted into a pure helper
 * so it can be pinned by a test.
 *
 * TWO STRING-ESCAPE BUGS LIVED IN THE INLINE VERSION, and both were invisible
 * because the code READ correct:
 *
 *   new RegExp("^" + String(h.year) + "\s+")
 *
 * Inside a double-quoted JS string `\s` is just the letter `s`, so the compiled
 * pattern was `^2020s+` — it matches "2020s…" and never "2020 Bowman Draft
 * Baseball". #1466 shipped a year-strip that has never once fired on a real
 * setName, and every checklist-sourced row rendered "2020 2020 Bowman Draft".
 * That is not a one-shape gap: the backend DELIBERATELY keeps a stored
 * year-prefixed setName verbatim (canonicalCardName.ts — it is the publisher's
 * own wording), and 83–99% of rows per product carry one, so the doubled year
 * was on nearly every row the picker has ever drawn.
 *
 *   .replace(/[s,;]+$/, "")
 *
 * A regex literal this time, but the same missing backslash: the character
 * class is the LETTER s, a comma and a semicolon, so it ate the trailing s off
 * "Max Williams" → "Max William" while leaving the ", Jr." it was written to
 * catch completely alone.
 *
 * The fix uses regex LITERALS throughout — the shape apps/web/src/lib/format.ts
 * already uses for the same year strip — because a literal cannot be silently
 * de-escaped by the surrounding quotes.
 *
 * WHAT THIS HELPER DOES NOT DO: fold twins. "Black 1" beside "Black /1",
 * "1st Edition Blue" filed under bowman-draft, and the rows whose "parallel" is
 * another card's number are all real rows in the catalog, and each is a data
 * repair owned by another lane (D30 spellings, D23 the product move, the bcp
 * Parallels-section parser). A picker that quietly hid them would hide exactly
 * the rows Drew needs to see. The job here is to make the RIGHT row obvious —
 * the checklist badge and the authority tiering do that — not to make the
 * wrong ones disappear.
 */

/** The subset of a CatalogSearchHit this label needs. Structural on purpose:
 *  the picker's hit type and the API's may add fields without touching this. */
export interface CatalogHitLabelInput {
  year?: number | null;
  setName?: string | null;
  setKey?: string | null;
  cardNumber?: string | null;
  playerName?: string | null;
  parallel?: string | null;
  printRun?: number | null;
  isAuto?: boolean | null;
  authority?: string | null;
  salesSummary?: { count?: number | null; lastSaleAt?: string | null } | null;
}

export interface CatalogHitLabel {
  /** Display name, never empty. */
  player: string;
  /** "2020 Bowman Draft Baseball #BD-152" — the year appears exactly once. */
  line: string;
  /** The product as the row's own setName spells it, year stripped:
   *  "Bowman Draft" vs "Bowman Draft 1st Edition". Never inferred client-side. */
  product: string;
  /** "Blue Refractor /150", "Auto /15", or "" for a plain base card. */
  variant: string;
  /** "106 sales · last 2026-08-27" | "1 sale · last …" | "no sales yet" */
  sales: string;
  /** The same three facts `sales` joins, for a caller that stacks them into
   *  two lines instead of one. Split out rather than re-derived in the
   *  component, because the inline copy is exactly where the escape bugs hid:
   *  one formatter, one test. */
  saleCount: number;
  /** "106 sales" | "1 sale" | "no sales yet" */
  saleCountText: string;
  /** "2026-08-27", or "" when nothing has sold. */
  lastSaleDay: string;
  /** True only for a checklist-authority row — the ✓ badge. */
  checklist: boolean;
}

/** "bowman-draft-1st-edition" → "Bowman Draft 1st Edition". Only ever reached
 *  when a row carries no setName at all (bccp rows, some vendor mirrors). */
function titleCaseSetKey(setKey: string): string {
  return setKey
    .split("-")
    .filter(Boolean)
    .map((w) => (/^\d+(st|nd|rd|th)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Strip a leading 4-digit year from a product name — but ONLY when it is the
 * same year we are about to prefix.
 *
 * A DIFFERENT leading year is left in place deliberately. "2019 Bowman Draft"
 * on a row whose year field says 2020 renders "2020 2019 Bowman Draft", which
 * looks wrong because it IS wrong: the row disagrees with itself, and showing
 * the disagreement is how it gets found and fixed. Silently dropping the "2019"
 * would launder a data defect into a clean-looking label.
 */
function stripLeadingYear(setLabel: string, year: number | null | undefined): string {
  if (!year) return setLabel;
  const leading = setLabel.match(/^(\d{4})\s+/);
  if (!leading || leading[1] !== String(year)) return setLabel;
  return setLabel.slice(leading[0].length);
}

export function catalogHitLabel(hit: CatalogHitLabelInput): CatalogHitLabel {
  const year = typeof hit.year === "number" && Number.isFinite(hit.year) ? hit.year : null;

  const rawSet = String(hit.setName ?? "").trim();
  const fallbackSet = rawSet ? "" : titleCaseSetKey(String(hit.setKey ?? "").trim());
  const product = stripLeadingYear(rawSet || fallbackSet, year).trim();

  // Trailing whitespace/comma/semicolon only — `\s`, with the backslash the
  // original was missing, so the "s" of "Williams" survives. ", Jr." is NOT
  // touched here: the comma is interior, and normalising "Bobby Witt, Jr." is
  // an ingest-side repair (cleanPlayerName), not a display trick.
  const player = String(hit.playerName ?? "").replace(/[\s,;]+$/, "").trim();

  const line = [
    year !== null ? String(year) : null,
    product || null,
    hit.cardNumber ? `#${hit.cardNumber}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  // The print run belongs to the parallel it qualifies, so "Blue Refractor" and
  // "/150" read as ONE token — Drew asked for "Refractor /499", not
  // "Refractor · /499", because a card's name is how a collector says it.
  const parallel = String(hit.parallel ?? "").trim();
  const namedParallel = parallel && parallel.toLowerCase() !== "base" ? parallel : "";
  const auto = hit.isAuto === true ? "Auto" : "";
  const head = [namedParallel, auto].filter(Boolean).join(" · ");
  const run = typeof hit.printRun === "number" && hit.printRun > 0 ? `/${hit.printRun}` : "";
  const variant = [head, run].filter(Boolean).join(" ");

  const count = Math.max(0, Number(hit.salesSummary?.count ?? 0) || 0);
  const lastDay = hit.salesSummary?.lastSaleAt ? String(hit.salesSummary.lastSaleAt).slice(0, 10) : "";
  const saleCountText = count === 0 ? "no sales yet" : `${count} sale${count === 1 ? "" : "s"}`;
  const sales = count === 0 ? saleCountText : `${saleCountText}${lastDay ? ` · last ${lastDay}` : ""}`;

  return {
    player: player || "(unnamed)",
    line,
    product,
    variant,
    sales,
    saleCount: count,
    saleCountText,
    lastSaleDay: lastDay,
    checklist: hit.authority === "checklist",
  };
}

/**
 * The three narrow helpers the D33 rows lane extracted alongside the object
 * form above. They are the SAME rules, re-expressed on catalogHitLabel so
 * there is one implementation of the year strip and one of the name trim --
 * two copies is exactly how the missing backslash survived #1466 in the first
 * place. Kept exported because they are the surface the rows lane's pins drive
 * directly, and because a caller that needs only one line should not have to
 * build the whole label.
 */

/** The year, once. The checklist sources write it into setName ("2025 Bowman
 *  Draft Baseball") and the row prints it in front, so one of the two goes.
 *  Only THIS row's leading year strips: "1952 Topps" on a 2021 row is the row
 *  disagreeing with itself, and showing that is how it gets fixed. */
export function setLabelOf(hit: Pick<CatalogHitLabelInput, "setName" | "setKey" | "year">): string {
  return catalogHitLabel(hit).product;
}

/** A trailing run of whitespace / commas / semicolons is not part of a name.
 *  Every other character is -- including a final "s". Unlike the object form
 *  this returns "" rather than "(unnamed)" for an empty row: it is a field,
 *  not a rendered line. */
export function playerLabelOf(hit: Pick<CatalogHitLabelInput, "playerName">): string {
  return String(hit.playerName ?? "").replace(/[\s,;]+$/, "").trim();
}

/** "2020 Bowman Draft Baseball #BD-152" -- the year exactly once. */
export function cardLabelOf(hit: CatalogHitLabelInput): string {
  return catalogHitLabel(hit).line;
}
