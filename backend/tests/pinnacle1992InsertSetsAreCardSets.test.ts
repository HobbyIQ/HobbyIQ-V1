/**
 * R30/R21 (2026-09-13): 1992 Pinnacle's six insert sets are their own card
 * sets, not subsets of flagship 1992 Pinnacle Baseball.
 *
 * THE INCIDENT. Universe driver APPLY run 34732777018 (baseball, SCC lane)
 * staged and ingested six 1992 Pinnacle insert products end to end:
 *
 *   Mickey Mantle (set-12625, 30 rows)     Rookie Idols (set-12621, 18 rows)
 *   Rookies       (set-12626, 30 rows)     Slugfest     (set-12622, 15 rows)
 *   Team 2000     (set-12624)              Team Pinnacle (set-12623)
 *
 * The CHILD'S OWN COUNT said every one wrote successfully ("csv rows read
 * 30" / "catalog rows written 30", etc. -- the extractor is not at fault and
 * this is not a source limitation; the host served ordinary numbered
 * checklist tables and the fetcher parsed every row). The driver's
 * verification read the product back at 0 of 0 for all six ("FAILED --
 * green ingest, 0 rows landed" x6). A direct, read-only Cosmos query
 * (card_catalog, year=1992, source=sportscardchecklist-2026-09-13, setName
 * containing "pinnacle") confirmed why: all 620 rows for the run's Pinnacle
 * entries carry `setName: "1992 Pinnacle Baseball"` and `setKey: "pinnacle"`
 * -- the FLAGSHIP's identity. The six inserts were silently merged onto the
 * base set at colliding card numbers, not lost.
 *
 * THE ROOT CAUSE. `computeHobbyIqCardId`'s `authoritativeSetKey: true` flag
 * claims (in its own doc comment) to keep an ingest's setKey verbatim, but
 * only skips the LATER chrome-prefix override -- `resolveSetKeyForSlug`
 * still runs `normalizeSetKey(setName)` FIRST, unconditionally, for every
 * mainstream sport. `normalizeSetKey("pinnacle-mickey-mantle")` fell through
 * to the unanchored `/pinnacle/` family regex (no table entry stopped it)
 * and collapsed to `pinnacle` -- exactly as an untrusted vendor guess would,
 * despite the checklist being ground truth. That promise-violation is a
 * separate, wider defect (15+ scripts pass authoritativeSetKey trusting the
 * same claim) and is intentionally NOT fixed here.
 *
 * THE FIX HERE. Register the six keys in productSetKeys.ts with `S()`
 * (spelled), not `P()`: a brand-new key with ZERO existing catalog rows has
 * no census entry for the reconciliation route to rule from (the way
 * `pinnacle-aficionado`, a `P()`, is already a fixed point only because it
 * already has rows and a standing verdict), so only a SPELLED product
 * answers `productSetKeyForName` ahead of the unanchored regex -- the same
 * shape `fleer-tiffany` / `fleer-glossy` used for the identical problem.
 */
import { describe, expect, it } from "vitest";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";

/** The exact slugs setKeyFor(entry) derives from each queue title, read
 *  directly from ingest-universe-driver.cjs -- not invented for this test. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setKeyFor } = require("../scripts/ingest-universe-driver.cjs");

const PINNACLE_1992_INSERTS: Array<[string, string]> = [
  ["1992 Pinnacle Mickey Mantle Baseball", "pinnacle-mickey-mantle"],
  ["1992 Pinnacle Rookie Idols Baseball", "pinnacle-rookie-idols"],
  ["1992 Pinnacle Rookies Baseball", "pinnacle-rookies"],
  ["1992 Pinnacle Slugfest Baseball", "pinnacle-slugfest"],
  ["1992 Pinnacle Team 2000 Baseball", "pinnacle-team-2000"],
  ["1992 Pinnacle Team Pinnacle Baseball", "pinnacle-team-pinnacle"],
];

describe("REPRODUCE: setKeyFor derives the same six keys the incident staged", () => {
  it.each(PINNACLE_1992_INSERTS)("%s -> %s", (setName, expectedKey) => {
    expect(setKeyFor({ lane: "sportscardchecklist", setName, year: 1992 })).toBe(expectedKey);
  });
});

describe("FIX: each insert key is registered and a normalizeSetKey fixed point", () => {
  it.each(PINNACLE_1992_INSERTS)("%s is registered and does not collapse to pinnacle", (_setName, key) => {
    expect(isProductSetKey(key)).toBe(true);
    expect(normalizeSetKey(key)).toBe(key);
    expect(normalizeSetKey(key)).not.toBe("pinnacle");
  });

  it("each insert's parent is flagship pinnacle, for pricing fallback only", () => {
    for (const [, key] of PINNACLE_1992_INSERTS) {
      expect(productParentOf(key)).toBe("pinnacle");
    }
  });

  it("bare 1993 Pinnacle Baseball is untouched -- still the flagship", () => {
    // Control: the flagship key itself must not have moved.
    expect(normalizeSetKey("pinnacle")).toBe("pinnacle");
  });
});

describe("FIX: an authoritative checklist ingest now lands each insert on its own key", () => {
  it.each(PINNACLE_1992_INSERTS)("%s writes a slug distinct from the flagship's", (_setName, key) => {
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1992, setKey: key,
      cardNumber: "1", parallel: "Base", isAuto: false, printRun: null,
      authoritativeSetKey: true,
    });
    expect(slug).toBe(`hiq:baseball:1992:${key}:1:base:no-auto`);
    // THE INCIDENT'S EXACT SHAPE: card #1 of an insert must not address the
    // same row as card #1 of the flagship.
    const flagshipSlug = computeHobbyIqCardId({
      sport: "baseball", year: 1992, setKey: "pinnacle",
      cardNumber: "1", parallel: "Base", isAuto: false, printRun: null,
      authoritativeSetKey: true,
    });
    expect(slug).not.toBe(flagshipSlug);
  });

  it("MUTATION: an unregistered sibling key still reproduces the incident", () => {
    // Proves the fix is the registration, not a lucky accident of
    // computeHobbyIqCardId: a key this table does NOT carry still collapses.
    const slug = computeHobbyIqCardId({
      sport: "baseball", year: 1992, setKey: "pinnacle-never-registered-insert",
      cardNumber: "1", parallel: "Base", isAuto: false, printRun: null,
      authoritativeSetKey: true,
    });
    expect(slug).toBe("hiq:baseball:1992:pinnacle:1:base:no-auto");
  });
});
