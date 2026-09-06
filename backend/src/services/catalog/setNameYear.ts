/**
 * CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06, on hobby-iq.com,
 * search "2023 mike trout" -> the card page):
 *
 *   2023 2023 Topps Heritage Mike Trout #74PB-1
 *
 * The year twice, on the page that names the card.
 *
 * WHY IT HAPPENED, and why it is a wire defect and not a web one.
 *
 * The catalog stores a set name WITH its year, on purpose: canonicalCardName
 * .canonicalSetName keeps "2023 Topps Heritage" verbatim because that is the
 * publisher's own wording, and 83-99% of rows per product carry one. That is a
 * deliberate storage decision and this file does not argue with it.
 *
 * The defect is that the pricing wire then hands a CLIENT that year-prefixed
 * string in a field called `set`, next to a separate `year` field, and every
 * client that wants a title has to know to strip one before joining the other.
 * Four of them did not, in four different ways:
 *
 *   - apps/web CardPriceDetail.tsx  joined year + set raw            -> DOUBLED
 *   - apps/web catalogHitLabel.ts   had its own stripLeadingYear
 *   - apps/web format.ts            had a third copy of the same strip
 *   - backend unifiedSearch/dispatcher.ts  had a fourth
 *
 * Three of those four were written as bug fixes for THIS bug, on other
 * surfaces, in July and August. The search wire got normalized; the pricing
 * wire was built fresh in August with its own identity composer and never
 * picked the helper up. Two composers, one normalized — which is exactly why
 * /api/catalog/search renders correctly while the card page doubles.
 *
 * So the fix is not a fifth strip. It is to stop shipping the ambiguity: the
 * wire now carries `setName` (never a year) and `displayName` (composed once,
 * server-side), and a client that wants a title reads the title.
 *
 * `set` is KEPT, verbatim and year-prefixed, because five server-side callers
 * read it as the stored value — portfolioStore.service writes it into a
 * holding's setName, ebayListingSearch builds a query key from it — and
 * changing what it means would silently rewrite stored data from a display fix.
 * New field, old field untouched.
 */

/**
 * Strip a leading year from a set name — but ONLY when it is the year we are
 * about to print next to it.
 *
 * A DIFFERENT leading year stays. "2019 Bowman Draft" on a row whose year
 * field says 2020 renders "2020 2019 Bowman Draft", which looks wrong because
 * it IS wrong: the row disagrees with itself, and showing the disagreement is
 * how it gets found and fixed. Silently dropping the "2019" would launder a
 * data defect into a clean-looking label. That rule is inherited deliberately
 * from apps/web/src/lib/catalogHitLabel.ts, which argued it first.
 *
 * SPLIT YEARS are the shape none of the four earlier copies handled. Basketball
 * and hockey are season-dated: the catalog holds "2023-24 Panini Prizm" against
 * a `year` of 2023 (beckettUrlDiscovery.ts documents the season-dated product
 * naming). A four-digit-only strip leaves "2023 2023-24 Panini Prizm", which is
 * the same defect wearing a hyphen. So a leading "YYYY-YY" or "YYYY-YYYY" whose
 * FIRST year matches is stripped too — the season is the product's own wording
 * and the `year` field is the one we print.
 *
 * Idempotent: at most one leading year is removed, so a row that already
 * carries "2023 2023 Topps Heritage" (a real shape — the doubling has been
 * written into some stored names) comes back as "2023 Topps Heritage" and not
 * as "Topps Heritage". Stripping both would delete a year the reader needs.
 */
export function stripLeadingSetYear(
  setName: string | null | undefined,
  year: number | string | null | undefined,
): string {
  const set = String(setName ?? "").trim();
  if (!set) return "";

  const yearStr = String(year ?? "").trim();
  if (!/^\d{4}$/.test(yearStr)) return set;

  // "2023 ", "2023-24 ", "2023-2024 " — the season forms included.
  const leading = set.match(/^(\d{4})(?:-\d{2}(?:\d{2})?)?(\s+)/);
  if (!leading || leading[1] !== yearStr) return set;

  return set.slice(leading[0].length).trim();
}

/** The fields a card title is composed from. Structural on purpose: the
 *  pricing wire's identity and a catalog row may each add fields without
 *  touching this. */
export interface CardTitleInput {
  year?: number | string | null;
  /** The stored set name, year-prefixed or not — this helper handles both. */
  setName?: string | null;
  playerName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
}

/**
 * THE card title, composed once.
 *
 *   2023 Topps Heritage Mike Trout #74PB-1
 *   2024 Bowman Draft Theo Gillen #CPA-TG Blue Refractor Auto /150
 *
 * Field order matches what apps/web's CardPriceDetail already rendered
 * (year, set, player, #number, parallel, Auto, /run) so this replaces that
 * composition without moving a single word on a page that was already right.
 *
 * Every segment is omitted when absent rather than printed empty, and "Base"
 * is treated as no parallel — the absence of a parallel is what says base.
 */
export function composeCardTitle(input: CardTitleInput): string {
  const yearStr = String(input.year ?? "").trim();
  const set = stripLeadingSetYear(input.setName, input.year);
  const player = String(input.playerName ?? "").trim();
  const number = String(input.cardNumber ?? "").trim();

  const parallelRaw = String(input.parallel ?? "").trim();
  const parallel = parallelRaw && !/^base$/i.test(parallelRaw) ? parallelRaw : "";

  const run =
    typeof input.printRun === "number" && Number.isFinite(input.printRun) && input.printRun > 0
      ? `/${input.printRun}`
      : "";

  return [
    /^\d{4}$/.test(yearStr) ? yearStr : "",
    set,
    player,
    number ? `#${number}` : "",
    parallel,
    input.isAuto === true ? "Auto" : "",
    run,
  ]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" ");
}
