/**
 * CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06, on hobby-iq.com,
 * search "2023 mike trout" -> the card page):
 *
 *   2023 2023 Topps Heritage Mike Trout #74PB-1
 *
 * The card page's title composer, extracted out of CardPriceDetail's render
 * closure so it can be pinned by a test. It was unreachable from a test while
 * it lived inline, which is exactly how it stayed wrong through three separate
 * fixes of this same bug on three other surfaces.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: the backend now composes the title once
 * (backend/src/services/catalog/setNameYear.ts -> cardIdentity.displayName).
 * When that field is present it wins outright, and nothing here re-derives it.
 * Everything below the first branch is the fallback for a slug-only URL or an
 * older backend, and it is the only place a title is still assembled from parts.
 */

export interface CardIdentityLike {
  year?: number | null;
  /** The catalog's stored set name — year-prefixed on most rows. */
  set?: string | null;
  /** The year-free product name. Preferred over `set`. */
  setName?: string | null;
  /** The whole title, composed server-side. Preferred over everything. */
  displayName?: string | null;
  player?: string | null;
  number?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
}

/** "bowman-draft" -> "Bowman Draft". Slug segments only; never a stored name. */
function pretty(v: string | undefined | null): string {
  return String(v || "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Drop a leading year from a set name, but ONLY when it is the year we are
 * about to print beside it.
 *
 * Seasons count: basketball and hockey are season-dated products, so the
 * catalog holds "2023-24 Panini Prizm" against a `year` of 2023, and a
 * four-digit-only strip would leave "2023 2023-24 Panini Prizm" — the same
 * defect wearing a hyphen.
 *
 * A DIFFERENT leading year is left alone on purpose. "2019 Bowman Draft" on a
 * 2020 row renders "2020 2019 Bowman Draft", which looks wrong because it IS
 * wrong: the row disagrees with itself, and showing the disagreement is how it
 * gets found. Hiding it would launder a data defect into a clean label.
 *
 * At most ONE year is removed, so an already-doubled stored name comes back
 * showing the year once rather than not at all.
 */
export function stripLeadingSetYear(setName: string | null | undefined, year: string): string {
  const s = String(setName ?? "").trim();
  if (!s || !/^\d{4}$/.test(year)) return s;
  const leading = s.match(/^(\d{4})(?:-\d{2}(?:\d{2})?)?(\s+)/);
  return leading && leading[1] === year ? s.slice(leading[0].length).trim() : s;
}

/**
 * The card page title.
 *
 * `cardsightCardId` is the route param; when it is a hiq: slug it supplies the
 * fallback fields — and the print run, which lives ONLY in the slug
 * (CF-SLUG-TITLE-KEEPS-THE-PARALLEL, 2026-08-22: a title that cannot say which
 * of a card's 65 parallels it is, on a page quoting $729 for one of them).
 *
 * Returns null when there is nothing to name the card with, so the caller's
 * existing fallback chain still runs.
 */
export function cardIdentityTitle(
  id: CardIdentityLike | null | undefined,
  cardsightCardId: string,
): string | null {
  const sp = String(cardsightCardId).split(":");
  const isHiq = sp[0] === "hiq" && sp.length >= 5;
  if (!id && !isHiq) return null;

  // ONE composer. When the wire has already named the card, that name wins.
  const composed = String(id?.displayName ?? "").trim();
  if (composed) return composed;

  const year = id?.year != null ? String(id.year) : isHiq ? sp[2] : "";
  // Prefer the year-free `setName`; `set` is the stored, year-prefixed value
  // and is only reached against a backend older than this wire, so it is
  // stripped defensively on the server's own rule.
  const setRaw = id?.setName ?? id?.set ?? (isHiq ? pretty(sp[3]) : "");
  const set = stripLeadingSetYear(setRaw, year);
  const player = id?.player ?? "";
  const number = id?.number ?? (isHiq ? String(sp[4] ?? "").toUpperCase() : "");

  // "Base" adds nothing a reader wants — the absence of a parallel says it.
  const parallelRaw = id?.parallel ?? (isHiq ? pretty(sp[5]) : "");
  const parallel = parallelRaw && !/^base$/i.test(parallelRaw) ? parallelRaw : "";
  const isAuto = id?.isAuto ?? (isHiq ? sp[6] === "auto" : false);
  const printRun = isHiq && /^num-\d+$/.test(String(sp[7] ?? "")) ? `/${String(sp[7]).slice(4)}` : "";

  const parts = [year, set, player, number ? `#${number}` : "", parallel, isAuto ? "Auto" : "", printRun]
    .map((x) => String(x).trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}
