// R-PENDING (Drew, ruling round of 2026-09-15): DONRUSS OPTIC INSERT SETS.
//
// card_catalog holds 2023-2025 Donruss Optic insert sets as PARALLELS of the
// base product — `parallel: "Passing Grade Ice"` on a donruss-optic row —
// because the pre-#2112 ingester ignored insert sets. The vocabulary corpus
// inherited the shape because it is built from the catalog. A named insert is a
// distinct CARD SET (R38/R48), so the name belongs on the setKey axis.
//
// REGISTRATION IS WHAT MAKES THEM ADDRESSABLE, and that is the property this
// file pins. normalizeSetKey rewrites ANY key containing the segment `optic`
// to bare `donruss-optic` (bareAliasPatterns), and the ingest guard refuses a
// key that is not a normalizeSetKey fixed point — so before registration every
// proposed key collapsed onto the base product and no Optic insert file could
// ever be ingested. productSetKeyForName answers BEFORE those patterns, so
// registering the key is precisely what makes it survive.

import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf, productFamilyOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

// The 53 headings measured read-only from card_catalog on 2026-09-15, over
// football 2023/2024/2025 and basketball 2023/2024.
const OPTIC_INSERTS = [
  "alter-ego", "best-tuddys", "blazers", "captain-in-charge", "chain-reaction",
  "diamond-hands", "dominators-signatures", "donruss-threads", "downtown",
  "downtown-duos", "downtown-legends", "duos", "elite-dominators",
  "express-lane", "fast-break-signatures", "first-year-fresh",
  "hidden-potential", "international-downtown", "legends", "light-it-up",
  "lights-out", "my-house", "mythical", "net-marvels", "opti-graphs",
  "opti-graphs-choice", "optic-update-i-rated-rookies-rps-autographs",
  "optical-illusions", "passing-grade", "phazes", "play-action", "raining-3s",
  "red-hot-rookies", "retro-series", "retro-series-signatures", "rising-suns",
  "rookie-dominators-signatures", "rookie-dual-signatures", "rookie-kings",
  "rookie-phenoms", "rookie-primary-colors", "rookie-recruits",
  "rps-autographs", "signature-series", "slammy", "splash", "sunday-kings",
  "super-bowl-downtown", "the-elite-series-signatures", "the-rookies",
  "uptowns", "white-hot-rookies", "winner-stays",
];

describe("Donruss Optic insert keys", () => {
  it("registers every measured insert heading", () => {
    expect(OPTIC_INSERTS.length).toBe(53);
    const missing = OPTIC_INSERTS.filter((sub) => !isProductSetKey(`donruss-optic-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT — the whole point of registering", () => {
    // Without registration these collapse to `donruss-optic` and the ingest
    // guard refuses the file. This is the assertion that would catch a
    // regression in the ordering inside normalizeSetKey.
    const collapsed = OPTIC_INSERTS
      .map((sub) => `donruss-optic-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under the Optic product and prices in its family", () => {
    for (const sub of OPTIC_INSERTS) {
      const key = `donruss-optic-${sub}`;
      expect(productParentOf(key), `${key} must nest under donruss-optic`).toBe("donruss-optic");
      expect(productFamilyOf(key), `${key} prices in the Optic family`).toBe("donruss-optic");
    }
  });

  it("the base product is UNCHANGED, and its aliases still collapse onto it", () => {
    // D31 (Drew 2026-08-31): donruss-optic is ONE product, and panini-optic /
    // panini-donruss-optic are spellings of it. Registering inserts must not
    // disturb that.
    expect(isProductSetKey("donruss-optic")).toBe(true);
    expect(normalizeSetKey("donruss-optic")).toBe("donruss-optic");
    expect(normalizeSetKey("panini-optic")).toBe("donruss-optic");
    expect(normalizeSetKey("panini-donruss-optic")).toBe("donruss-optic");
  });

  it("an UNREGISTERED optic key still collapses — registration is the gate", () => {
    // The mechanism, stated as a test: it is the registry that rescues a key
    // from the bare-alias pattern, not the spelling.
    expect(isProductSetKey("donruss-optic-nonesuch")).toBe(false);
    expect(normalizeSetKey("donruss-optic-nonesuch")).toBe("donruss-optic");
  });

  it("does NOT register the three headings that are not card sets", () => {
    // "RPS" is a fragment of "RPS Autographs" (32 rows); "Variation" is a card
    // attribute, not a set (13 rows); "2015 Retro" has six colour children in
    // the corpus but NO checklist-backed catalog rows, so it cannot be shown to
    // be an insert. Absent beats wrong.
    expect(isProductSetKey("donruss-optic-rps")).toBe(false);
    expect(isProductSetKey("donruss-optic-variation")).toBe(false);
    expect(isProductSetKey("donruss-optic-2015-retro")).toBe(false);
  });
});
