/**
 * CF-A-MAKER-LESS-CATCH-ALL-IS-NOT-A-PRODUCT (Drew, 2026-09-05).
 *
 * "Draft" and "Flagship" are not products. They are words a title uses ABOUT a
 * product, and a setKey minted from one names no card that anybody can buy.
 *
 * WHERE THEY COME FROM. Not from a vocabulary table -- neither word appears as
 * a destination in `knownSetKeyPatterns` or `bareAliasPatterns`. They arrive
 * through the FALL-THROUGH at the end of `normalizeSetKey`, which returns the
 * slugified text when nothing matched. The eBay title parser builds a setName
 * from `brand` + `insert` (`buildSetName`), and when a title states an INSERT
 * word with no BRAND word beside it:
 *
 *     buildSetName(null, "draft")  ->  "Draft"  ->  normalizeSetKey -> `draft`
 *
 * `flagship` reaches the same fall-through from the other direction -- the
 * sales-attested minters write the literal word when they can read an era but
 * no maker, which is why the stored rows spell their setName "1966 Flagship Ice
 * Hockey" and one of them parked the maker in the PLAYER field:
 *
 *     hiq:ice-hockey:1966:flagship:69:base:no-auto
 *       playerName: "TOPPS TED HARRIS"      <- the maker, read as a person
 *
 * That row is the whole argument in one line. The maker WAS in the title; the
 * parse put it somewhere it does not belong and then minted an identity out of
 * what was left. The card is a 1966 Topps, and `flagship` is where it went to
 * be unfindable.
 *
 * THE RULING. When the deriver can read only "Draft" or "Flagship" -- no maker
 * (Bowman / Topps / Panini / ...) -- the identity REFUSES. It parks:
 * identityUnverified, no pool, prices nothing, until a maker is read. Never
 * mint. This is CF-SLUG-REFUSE-FALLBACKS applied to the product word instead of
 * the sport or the card number: an ABSENT slug is strictly better than a WRONG
 * one, because a wrong pool is a wrong price, silently, forever.
 *
 * WHAT IS ON THE LIST, AND WHY THE LIST IS SHORT.
 *
 * Every key here was measured in card_catalog on 2026-09-05 and every one of
 * them came back with ZERO checklist-backed rows -- only `sales-attested`,
 * `ingest-auto-seed`, `ebay-browse`, `ebay-user-purchase` and `user-verified`.
 * A word that no checklist ever spells as a product name is not a product:
 *
 *     draft        6 rows    baseball 2021/2025
 *     flagship    61 rows    9 sports, 1954-2026
 *     chrome       8 rows    baseball/basketball
 *     prospects   16 rows    baseball 2006-2008
 *
 * DELIBERATELY ABSENT, and this is the point of the entry:
 *
 *   `select`   45,850 catalog rows, and a 400-row sample is 99% checklist
 *              sources (`baseballcardpedia*`), setNames "2021 Select",
 *              "2013 Select Baseball". Bare `select` is how a REAL product is
 *              spelled by the source that scraped its checklist. Refusing it
 *              would park 45,850 checklist-backed cards. It is also already
 *              excluded from the bare-alias tier for the opposite reason (the
 *              word appears in parallel language), so it reaches this key
 *              honestly.
 *
 *   `base`     Pokemon Base Set -- `hiq:pokemon:1999:base:16:...` Zapdos, from
 *              `pokemon-tcg-data-scraped`. A real set whose real name is the
 *              word. Refusing it would park the single most famous checklist in
 *              the hobby.
 *
 * Both are the reason this list is enumerated by MEASUREMENT rather than by
 * intuition about which words "sound generic". `chrome` sounds like a product
 * and is not one here; `base` sounds like a catch-all and is a product. The
 * count of checklist-backed rows decided each one
 * (feedback_count_by_source_not_row_count).
 *
 * ADDING A KEY HERE IS A RULING. It requires a measurement showing no
 * checklist-backed rows behind the key, never a suspicion that a word reads
 * generically. Removing one silently re-mints it -- pinned by
 * tests/makerlessCatchAll.test.ts, whose mutation check fails if the refusal is
 * taken out.
 *
 * Pure: no I/O, no Cosmos, no clock.
 */

/**
 * The maker-less catch-all keys. EXACT-TOKEN by construction: this set is
 * consulted with `has()`, never a prefix or substring test, because
 * `bowman-draft`, `topps-chrome` and `bowman-chrome-prospects` are all REAL
 * products whose keys contain one of these words. Only the bare word refuses.
 */
export const MAKERLESS_CATCH_ALL_KEYS: ReadonlySet<string> = new Set([
  "draft",
  "flagship",
  "chrome",
  "prospects",
]);

/** The named refusal reason, in the vocabulary `identityBacking` already uses
 *  for an identity we decline to price. */
export const MAKERLESS_CATCH_ALL = "setkey-makerless-catchall" as const;

/**
 * True when `setKey` is a bare maker-less catch-all and must not become an
 * identity.
 *
 * Exact-token: `draft` refuses, `bowman-draft` does not. The input is trimmed
 * and lower-cased because callers hold keys from mixed sources, but it is
 * never slugified here -- a caller holding a product NAME normalizes it first
 * (that is what `normalizeSetKey` is for) and hands this function a KEY.
 */
export function isMakerlessCatchAllSetKey(setKey: string | null | undefined): boolean {
  const s = String(setKey ?? "").trim().toLowerCase();
  return s !== "" && MAKERLESS_CATCH_ALL_KEYS.has(s);
}

/**
 * The operator-facing sentence for a parked row. Names the key, says what is
 * missing, and says what would resolve it -- so an acquisition queue reading
 * this knows the fix is "read a maker", not "try harder on this title".
 */
export function makerlessCatchAllMessage(setKey: string): string {
  return (
    `"${setKey}" names no maker (Bowman / Topps / Panini / ...) and so names no product — `
    + "parked as identityUnverified rather than minted, and prices nothing until a maker is read. "
    + "(CF-A-MAKER-LESS-CATCH-ALL-IS-NOT-A-PRODUCT)"
  );
}
