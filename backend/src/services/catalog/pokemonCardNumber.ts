/**
 * CF-THE-CHECKLIST-SPELLS-THE-NUMBER (Drew, 2026-09-04).
 *
 * THE DEFECT. A Pokemon sale title states its card number as POS/TOTAL --
 * "Journey Together 094/159", "Umbreon ex 161/131 SIR". `parseListingIdentity`
 * returns that verbatim ("094/159"), which is right: the number the seller
 * printed is the evidence. But `slugify` then strips the slash, so the SLUG
 * segment became the concatenation of two unrelated numbers:
 *
 *     094/159  ->  :094159:          161/131  ->  :161131:
 *
 * The catalog -- whose Pokemon rows come from tcgdex -- stores the POSITION
 * ONLY, in the checklist's own spelling:  `094`, `161`. So NO slug derived
 * from an English Pokemon title could ever land on its checklist row. Measured
 * over a 5,000-row sample of sold_comps (sport=pokemon, cardYear=2025) on
 * 2026-09-04: 3,607 rows derive a supported setKey, and only 2,289 (63.5%)
 * reach a checklist-backed catalog row.
 *
 * THE SECOND DEFECT, WHICH IS THE ONE THAT SPLITS POOLS. Sellers write the
 * position both padded and bare -- "094/159" and "94/159" are the same card --
 * and both spellings minted their own slug (`:94:` vs `:094:`). The catalog
 * carries the same split: tcgdex writes `004` while `ingest-auto-seed` (rows
 * minted from sales through this very derivation) wrote `4`. Measured in
 * card_catalog on 2026-09-04, numeric values stored under BOTH spellings:
 *
 *     sv10     98        swsh11   47        swsh10   33        swsh12   28
 *
 * That is one card, two rows, two pools, and a wrong FMV on both.
 *
 * THE RULE. For the pokemon vertical only:
 *   1. Drop the /TOTAL. The total is the SET's size, not the card's identity;
 *      it is already carried by the setKey segment. Keeping it made the
 *      segment a number that names no card.
 *   2. Pad the position to the width THIS SET'S CHECKLIST uses -- derived from
 *      the checklist rows for (setKey), never a constant. The eras genuinely
 *      differ and a constant would be wrong for half of them: tcgdex writes
 *      3-wide for every `sv*` and `swsh1x` set, but VERBATIM (1-, 2- and
 *      3-wide) for `sm*` and `xy*`, where `xy12` is dominantly 2-wide.
 *   3. Never touch a suffixed number. TG01/TG30, GG69, SV107 and promo codes
 *      are not positions and padding them would invent a card.
 *   4. BLANK MEANS UNKNOWN. A set with no checklist rows cannot say what its
 *      width is, so the number is left EXACTLY as stated and the guard reports
 *      it. Padding on a guess would mint an identity the checklist never
 *      published -- the failure this whole rule exists to end.
 *
 * WHY A WIDTH AND NOT "STRIP LEADING ZEROS". Stripping is a normalization the
 * checklist did not authorize: tcgdex's `004` IS the published spelling of that
 * card, and CF-CARDNUMBER-VERBATIM-FROM-THE-CHECKLIST says the checklist's
 * spelling is the canonical one. We move the SALE onto the checklist, never
 * the checklist onto the sale.
 */

/** A card number that is a bare position: digits only, nothing else. */
import type { Container } from "@azure/cosmos";

const BARE_POSITION_RE = /^\d+$/;

/** POS/TOTAL as a seller writes it, where BOTH halves are bare digits.
 *  `TG01/TG30` deliberately does NOT match -- a suffixed number keeps its
 *  spelling verbatim (rule 3). */
const POS_OVER_TOTAL_RE = /^(\d+)\s*\/\s*(\d+)$/;

/**
 * The width the checklist for one set spells its POSITIONS in.
 *
 * `null` when the question cannot be answered -- no checklist rows, or none
 * with a bare-position number. Null is the refusal that keeps rule 4 honest:
 * the caller must leave the number alone, not fall back to a default.
 *
 * THE WIDTH IS THE MAXIMUM, NOT THE MODE. A set whose checklist spells `004`
 * and `173` is 3-wide throughout -- the 3-wide rows are the ones that prove the
 * convention, because a 2-wide `99` in a 3-wide set cannot occur while a 1-wide
 * `4` in a VERBATIM set can. Taking the max reads `xy12` (1-, 2- and 3-wide,
 * genuinely verbatim) as 3-wide, which would be wrong -- so the width only
 * counts when the checklist is CONSISTENT: every position at or below the
 * width's own range is spelled at that width. See `checklistNumberWidth`.
 */
export function checklistNumberWidth(numbers: Iterable<string>): number | null {
  const positions: string[] = [];
  for (const raw of numbers) {
    const n = String(raw ?? "").trim();
    if (n && BARE_POSITION_RE.test(n)) positions.push(n);
  }
  if (!positions.length) return null;
  const widths = new Set(positions.map((p) => p.length));
  // A single width across every position IS the convention, whatever it is:
  // `sv09` is uniformly 3, an old set may be uniformly 2.
  if (widths.size === 1) return positions[0].length;
  // Mixed widths mean the checklist pads nothing -- it spells each number as
  // short as it is (`4`, `42`, `173`). That is a real convention too, and its
  // "width" is the identity: pad to nothing. Confirmed by the presence of a
  // number SHORTER than the longest whose value would have needed padding --
  // e.g. `4` alongside `173` in xy12. Verbatim is signalled by width 0.
  return 0;
}

/**
 * Normalize a Pokemon card number onto the spelling its checklist uses.
 *
 * `width` comes from `checklistNumberWidth` over that set's checklist rows:
 * a positive number pads to it, `0` means the checklist spells positions
 * verbatim (strip padding), and `null` means the set has no checklist and the
 * number is returned EXACTLY as given.
 *
 * Suffixed numbers (TG01, GG69, SV107, promo codes) are returned verbatim in
 * every case -- they are not positions.
 */
export function normalizePokemonCardNumber(
  cardNumber: string | null | undefined,
  width: number | null,
): string {
  const raw = String(cardNumber ?? "").trim();
  if (!raw) return raw;

  // Rule 1: the /TOTAL is the set's size, not the card's identity. Only a
  // BOTH-HALVES-NUMERIC form is a position over a total; `TG01/TG30` is a
  // suffixed number written with a slash and keeps its whole spelling.
  const overTotal = POS_OVER_TOTAL_RE.exec(raw);
  const position = overTotal ? overTotal[1] : raw;

  // Rule 3: not a bare position -> verbatim, always.
  if (!BARE_POSITION_RE.test(position)) return raw;

  // Rule 4: no checklist -> the number is left exactly as stated. Note this
  // still drops a /TOTAL when one was written, because the total is never part
  // of the identity in ANY set -- what is refused here is the PADDING, which is
  // the only part a checklist has to authorize.
  if (width === null) return position;

  // width 0 = the checklist spells positions verbatim: strip padding.
  if (width === 0) return String(Number(position));

  // Rule 2: pad to the checklist's width. A position already LONGER than the
  // width (a secret rare numbered above the set total, `238` in a 3-wide set)
  // is returned as-is -- padStart is a no-op there, which is the right answer.
  return position.padStart(width, "0");
}

/**
 * The checklist width for one (year, setKey), read from card_catalog and
 * cached for the process.
 *
 * ONE QUERY PER SET, NOT PER ROW. A width lookup on every sale would be a
 * per-row query over the catalog, which is not a lookup, it is an outage
 * (CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH). The answer is a
 * property of the SET and cannot change between two rows of the same set.
 *
 * ONLY CHECKLIST-BACKED ROWS ARE ASKED, and that is the whole point. The
 * catalog also holds `ingest-auto-seed` rows minted from sales through the
 * very derivation this fix repairs -- they carry the WRONG spelling (`4` where
 * tcgdex says `004`), and including them makes a uniformly-3-wide set look
 * mixed. Measured on 2026-09-04, reading all sources instead of checklist-only
 * corrupts the width of exactly the sets that have a split pool: sv08-5, sv10,
 * sv03-5, swsh10, swsh11 and swsh12 all read 3 from the checklist and 0 (i.e.
 * "verbatim, pad nothing") from the full row set. Asking the dirty rows what
 * the clean spelling is would have entrenched the split it is here to close.
 *
 * FAILS TO NULL. No container, no rows, a read error: null, and the caller
 * leaves the number exactly as stated. Absence is not evidence of a width.
 */
const widthCache = new Map<string, number | null>();

export function _resetPokemonWidthCacheForTests(): void {
  widthCache.clear();
}

export async function pokemonChecklistNumberWidth(
  year: number | null | undefined,
  setKey: string | null | undefined,
  opts: {
    container?: Container | null;
    canAdjudicate?: (source: string | null | undefined) => boolean;
  } = {},
): Promise<number | null> {
  const key = String(setKey ?? "").trim();
  if (!key) return null;
  const y = Number(year);
  const cacheKey = `${Number.isFinite(y) ? y : ""}|${key}`;
  if (widthCache.has(cacheKey)) return widthCache.get(cacheKey) ?? null;

  let width: number | null = null;
  try {
    const container = opts.container
      ?? (await import("./catalogIdentityResolver.js"))._catalogContainerForPokemonWidth();
    const adjudicates = opts.canAdjudicate
      ?? (await import("./catalogAuthority.service.js")).canAdjudicate;
    if (container) {
      const params: Array<{ name: string; value: string | number }> = [
        { name: "@s", value: "pokemon" }, { name: "@k", value: key },
      ];
      let sql = "SELECT c.cardNumber, c.source FROM c WHERE c.sport = @s AND c.setKey = @k";
      if (Number.isFinite(y) && y > 0) { sql += " AND c.cardYear = @y"; params.push({ name: "@y", value: y }); }
      const { resources } = await container.items
        .query<{ cardNumber?: unknown; source?: unknown }>({ query: sql, parameters: params }, { maxItemCount: -1 })
        .fetchAll();
      const numbers = resources
        .filter((r) => adjudicates(String(r?.source ?? "")))
        .map((r) => String(r?.cardNumber ?? ""));
      width = checklistNumberWidth(numbers);
    }
  } catch {
    width = null;
  }
  widthCache.set(cacheKey, width);
  return width;
}
