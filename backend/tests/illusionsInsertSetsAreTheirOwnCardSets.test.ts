/**
 * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-CARD-SET, 2024 Panini Illusions Football
 * (R60 + R38, Drew).
 *
 * THE FILE WAS REFUSED WHOLE, and that is the measurement this test defends.
 * Before these registrations the committed checklistinsider package reported:
 *
 *     files REFUSED, id integrity 1 (10,871 rows)
 *     would ingest 0 rows
 *     10,871 rows would have landed on 8,653 distinct ids
 *
 * -- 2,218 rows short of a distinct address each, because five named insert
 * sets were folding onto the flagship `panini-illusions` and colliding with
 * the base checklist's own numbering. The ingester names the unit of refusal
 * as the FILE, never half a product, so nothing at all ingested until every
 * one of the five existed.
 *
 * After registration the same package reports `REFUSED 0` and all 10,871 rows
 * on 10,871 distinct ids.
 *
 * -- WHY `S` AND NOT `P` -----------------------------------------------------
 *
 * Only a SPELLED product answers productSetKeyForName, the leg of
 * normalizeSetKey that runs BEFORE the unanchored brand patterns. Declared
 * with `P` these keys still collapse onto `panini-illusions` -- the same trap
 * Haunted Hoops documents. Pinned below by asking the function rather than
 * reading the table.
 *
 * -- THE SIGNED SIBLING IS A DIFFERENT CARD SET ------------------------------
 *
 * `Illusionists` (unsigned) and `Illusionists Autographs` are not a card and
 * its rung: they are two card sets, numbered separately. Same for
 * Mystique / Immortalized / Rookie Reflections -- those three unsigned roots
 * carry no stated parallel of their own and remain the product's own card,
 * unregistered, deliberately.
 *
 * R67 (2026-09-19) SUPERSEDES R60's UNSIGNED-ILLUSIONISTS EXCLUSION. This
 * comment used to claim `Illusionists` (unsigned) "carries a blank parallel"
 * and should stay on the product key for that reason. It does not: the
 * staged data shows `insert-illusionists` rows carrying their OWN stated
 * parallel ("Illusionist"), and a real same-number/different-player fact
 * against base (base #1 is Kyler Murray, Illusionists #1 is Caleb Williams).
 * R67's own rule -- a named insert set is its own product key -- reaches this
 * exactly like every other insert in the file, so `panini-illusions-
 * illusionists` is now registered alongside its signed sibling. See
 * illusionsR67InsertKeysAreFixedPoints.test.ts for the rest of R67's
 * Illusions registrations.
 */
import { describe, expect, it } from "vitest";

import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

/** The five the ingester's guard named, with the rows each would take. */
const RULED: ReadonlyArray<readonly [string, number]> = [
  ["panini-illusions-trophy-collection", 2300],
  ["panini-illusions-mystique-autographs", 270],
  ["panini-illusions-immortalized-jersey-autographs", 197],
  ["panini-illusions-rookie-reflections-dual-patch-autographs", 81],
  ["panini-illusions-illusionists-autographs", 34],
];

describe("2024 Panini Illusions — the five named insert sets", () => {
  it("every ruled key is a normalizeSetKey FIXED POINT", () => {
    for (const [key] of RULED) {
      expect(normalizeSetKey(key, "football"), `${key} did not survive`).toBe(key);
    }
  });

  it("re-spelling is idempotent — a second pass moves nothing", () => {
    for (const [key] of RULED) {
      const once = normalizeSetKey(key, "football");
      expect(normalizeSetKey(once, "football")).toBe(once);
    }
  });

  it("the product NAME resolves to the insert key, not the flagship", () => {
    // The productSetKeyForName leg: this is what `S` buys and `P` does not.
    expect(normalizeSetKey("2024 Panini Illusions Trophy Collection", "football"))
      .toBe("panini-illusions-trophy-collection");
    expect(normalizeSetKey("2024 Panini Illusions Illusionists Autographs", "football"))
      .toBe("panini-illusions-illusionists-autographs");
  });

  // ── MUTATION CHECKS ────────────────────────────────────────────────────────
  //
  // A specialization key that swallows its flagship is the SAME defect in the
  // opposite direction, and it is the one these anchored rules could plausibly
  // cause. Every one of these must be unmoved.

  it("MUTATION: the flagship still answers itself", () => {
    expect(normalizeSetKey("panini-illusions", "football")).toBe("panini-illusions");
    expect(normalizeSetKey("2024 Panini Illusions", "football")).toBe("panini-illusions");
    expect(normalizeSetKey("2024 Panini Illusions Football", "football")).toBe("panini-illusions");
  });

  it("MUTATION: neighbouring Panini products are untouched", () => {
    for (const key of [
      "panini-prizm", "panini-select", "panini-phoenix", "panini-obsidian",
      "panini-mosaic", "panini-zenith", "panini-absolute", "panini-chronicles",
      "panini-national-treasures", "panini-immaculate", "panini-flawless",
    ]) {
      expect(normalizeSetKey(key, "football"), `${key} moved`).toBe(key);
    }
  });

  it("MUTATION: a bare insert word never claims the product key", () => {
    // "Trophy Collection" is a name several products borrow. The rules are
    // anchored on the FULL product-qualified key, never the loose words, so a
    // bare spelling must not resolve to the Illusions insert.
    expect(normalizeSetKey("trophy-collection", "football")).not.toBe("panini-illusions-trophy-collection");
    expect(normalizeSetKey("autographs", "football")).not.toBe("panini-illusions-illusionists-autographs");
  });

  it("MUTATION: the OTHER three unsigned roots (no stated parallel of their own) stay on the product key", () => {
    // Mystique / Immortalized Jersey / Rookie Reflections Dual Patch carry no
    // stated parallel column of their own on the unsigned side, so the
    // unsigned rows remain the product's own card, unregistered.
    // `panini-illusions-illusionists` is EXCLUDED from this check: R67
    // (2026-09-19) supersedes the R60 exclusion for it specifically, since
    // its unsigned rows DO carry their own stated parallel ("Illusionist")
    // and a real same-number/different-player fact against base. See
    // illusionsR67InsertKeysAreFixedPoints.test.ts for that registration.
    const ruled = new Set(RULED.map(([k]) => k));
    expect(ruled.has("panini-illusions-mystique")).toBe(false);
    expect(ruled.has("panini-illusions-immortalized-jersey")).toBe(false);
    expect(ruled.has("panini-illusions-rookie-reflections-dual-patch")).toBe(false);
  });

  it("R67 (2026-09-19): panini-illusions-illusionists (unsigned) is NOW registered, superseding R60's exclusion", () => {
    expect(normalizeSetKey("panini-illusions-illusionists", "football")).toBe("panini-illusions-illusionists");
  });

  it("no ruled key is a prefix of another — the derived-root trap", () => {
    // A shorter key whose spelling prefixes a longer one can claim the longer
    // one's rows when the rules are read in the wrong order.
    for (const [a] of RULED) {
      for (const [b] of RULED) {
        if (a === b) continue;
        expect(b.startsWith(`${a}-`), `${a} is a prefix of ${b}`).toBe(false);
      }
    }
  });

  it("no ruled key is another's singular/plural twin", () => {
    const all = new Set(RULED.map(([k]) => k));
    for (const k of all) {
      const singular = k.replace(/s$/, "");
      if (singular !== k) expect(all.has(singular), `${k} twins ${singular}`).toBe(false);
    }
  });
});
