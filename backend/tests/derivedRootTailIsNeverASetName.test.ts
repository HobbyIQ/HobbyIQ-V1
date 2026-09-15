// CF-A-DERIVED-ROOT-TAIL-IS-NEVER-A-SET-NAME (2026-09-15).
//
// rungFoldingFor may derive a root no file states, so that Spectra's fourteen
// "Dual Patch Autographs <colour>" files land on one card set. Its gates ask
// whether the siblings COULD be one set: rosters agree, tails differ, signing
// matches. None of them can ask whether the tail is a COLOUR, and that is the
// question that decides it.
//
// Measured on 2020-21 Panini Mosaic: "Rookie Private Signings Association
// Version" and "Rookie Private Signings Icon Version" are two different card
// sets. They agree on their roster (one card, #12 Tyrese Haliburton), their
// tails differ, and both are unsigned — so every gate passed and the fold
// derived `rookie-private-signings`, reading each SET'S NAME as a parallel.
// Both then collapsed to one subset slug, subsetsToSeparate saw a single slug
// and separated nothing, and the rows landed on the base product where card 12
// Gold collided with card 12 Gold. The guard refused the whole 14,186-row file.
//
// The tell is that A RUNG HAS NO RUNGS OF ITS OWN: the source prints
// "Association Version Gold" and "... Platinum", so Association Version is a
// root that CARRIES colours, not a colour.

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const IS = require_("../scripts/lib/insert-set-key.cjs");

type Row = {
  category: string; cardNumber: string; parallel: string;
  isAuto: string; printRun: string; player: string;
};
const row = (o: Partial<Row>): Row => ({
  category: "", cardNumber: "1", parallel: "", isAuto: "false",
  printRun: "", player: "Someone", ...o,
});

describe("a derived root's tail is never a set name", () => {
  it("refuses the fold when a sibling carries rungs of its own, and says why", () => {
    // Exactly the Mosaic shape: two sets sharing a two-word prefix, each with
    // its own Gold/Platinum. Icon Version prints no bare tier, as in the source.
    const rows = [
      row({ category: "rookie-private-signings-association-version", cardNumber: "12", player: "Tyrese Haliburton" }),
      row({ category: "rookie-private-signings-association-version", cardNumber: "12", parallel: "Gold", printRun: "/10", player: "Tyrese Haliburton" }),
      row({ category: "rookie-private-signings-association-version", cardNumber: "12", parallel: "Platinum", printRun: "/1", player: "Tyrese Haliburton" }),
      row({ category: "rookie-private-signings-icon-version", cardNumber: "12", parallel: "Gold", printRun: "/10", player: "Tyrese Haliburton" }),
      row({ category: "rookie-private-signings-icon-version", cardNumber: "12", parallel: "Platinum", printRun: "/1", player: "Tyrese Haliburton" }),
    ];
    const fold = IS.rungFoldingFor(rows);

    // Neither set is folded onto a root the source never prints.
    expect([...fold.keys()].filter((k: string) => /private-signings/.test(k))).toEqual([]);

    // And the refusal is NAMED, with the evidence that decided it.
    const refused = fold.refusedRoots;
    expect(refused).toBeTruthy();
    const rec = refused.get("rookie-private-signings");
    expect(rec).toBeTruthy();
    expect(rec.reason).toBe("derived-root-tail-is-a-set-name");
    expect(rec.siblings).toContain("rookie-private-signings-association-version");
    expect(rec.siblings).toContain("rookie-private-signings-icon-version");
    // The evidence is WHAT THE CELL NEVER PRINTS: this product states "Gold"
    // and "Platinum" as parallels, but neither version name, so neither tail
    // is a finish.
    expect(new Set(rec.unstatedTails)).toEqual(new Set(["association-version", "icon-version"]));
  });

  it("MUTATION: the colour-sibling fold from #2195 must still fold", () => {
    // The guard must not cost the folds it exists beside. Spectra's shape:
    // several colour siblings, NO uncoloured tier, no sibling carrying rungs of
    // its own — every tail is a leaf finish, so the root is still derived.
    const players = ["Zion Williamson", "Ja Morant", "RJ Barrett"];
    const rows = ["gold", "meta", "neon-pink"].flatMap((colour) =>
      players.map((p, i) => row({
        category: `dual-patch-autographs-${colour}`,
        cardNumber: String(i + 1), player: p, isAuto: "true",
      })));
    const fold = IS.rungFoldingFor(rows);

    for (const colour of ["gold", "meta", "neon-pink"]) {
      const rec = fold.get(`dual-patch-autographs-${colour}`);
      expect(rec, `${colour} must still fold`).toBeTruthy();
      expect(rec.root).toBe("dual-patch-autographs");
    }
    expect(fold.refusedRoots.get("dual-patch-autographs")).toBeUndefined();
  });

  it("a cell with NO stated parallels is left alone — absent evidence decides nothing", () => {
    // cardboardconnection ships one file per rung with the colour folded into
    // the manifest and the parallel column BLANK. Such a cell states no finish
    // vocabulary at all, so there is nothing to test a tail against and the
    // rule must not fire: that is the Spectra shape, and refusing it would
    // split one card set fourteen ways.
    const rows = [
      row({ category: "rookie-private-signings-association-version", cardNumber: "12", player: "Tyrese Haliburton" }),
      row({ category: "rookie-private-signings-icon-version", cardNumber: "12", player: "Tyrese Haliburton" }),
    ];
    const fold = IS.rungFoldingFor(rows);
    expect(fold.refusedRoots.get("rookie-private-signings")).toBeUndefined();
  });
});
