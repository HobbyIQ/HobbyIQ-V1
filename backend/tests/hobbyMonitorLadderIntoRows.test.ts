/**
 * CF-HM-LADDER-INTO-ROWS (2026-08-30). hobbymonitor states a print run ONCE
 * per subset, on the ladder — numberDenominator is null on all 1,165 of 2026
 * Bowman's card objects. The fetcher used to park that ladder in a sidecar,
 * so every print run in the release was lost at ingest.
 *
 * The join is per subset, on the (cardSet, cardType) pair the source itself
 * scopes a ladder with — NOT the product-wide cross-product rejected on
 * 2026-08-11.
 *
 * THE GUARD THIS FILE EXISTS FOR: 53 of 2026 Bowman's 218 "parallels" are
 * PLAYER NAMES misfiled into the parallels[] of five hit subsets. Minting
 * those would put "Ethan Holliday" in the parallel column — the exploded-
 * spine shape (a cards x players cross-join) that cost 11.49M rows.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { classifyRung, foldName, runOf, noteOf } = require_("../scripts/fetchHobbyMonitorChecklist.cjs");

const roster = new Set(["ethanholliday", "freddiefreeman", "juliorodriguez", "jaccaglianone"]);

describe("a rung is a rung only when the source priced its scarcity", () => {
  it("accepts rungs carrying a printRun, a 1/1 flag, or odds", () => {
    expect(classifyRung({ name: "Refractor", printRun: 499 }, roster).ok).toBe(true);
    expect(classifyRung({ name: "SuperFractor", printRun: null, isOneOfOne: true }, roster).ok).toBe(true);
    // The Bowman Logo Pattern is a REAL rung with no print run — it is priced
    // by pack odds alone, and dropping it would lose the card behind Drew's
    // BP-18 holding.
    expect(classifyRung({ name: "Bowman Logo Pattern", printRun: null, isOneOfOne: false, odds: "1:699 Hobby" }, roster).ok).toBe(true);
  });

  it("REFUSES a player name misfiled into a hit subset's parallels[]", () => {
    const r = classifyRung({ name: "Ethan Holliday", printRun: null, isOneOfOne: false, odds: null }, roster);
    expect(r.ok).toBe(false);
    expect(r.why).toBe("player-name");
  });

  it("refuses a player name carrying its team suffix, and folds accents", () => {
    expect(classifyRung({ name: "Freddie Freeman - Los Angeles Dodgers", printRun: null }, roster).why).toBe("player-name");
    expect(classifyRung({ name: "Julio Rodríguez - Seattle Mariners", printRun: null }, roster).why).toBe("player-name");
  });

  it("refuses any scarcity-less entry even when it is not on the roster", () => {
    // Blank is never a rung, and an unpriced unknown is not one either: the
    // source prices every real parallel it publishes.
    expect(classifyRung({ name: "", printRun: null }, roster).ok).toBe(false);
    expect(classifyRung({ name: "Some Unpriced Thing", printRun: null }, roster).why).toBe("no-scarcity");
  });

  it("a scarcity-bearing entry is kept even if it collides with a name", () => {
    // The scarcity signal is checked FIRST — a real rung is never dropped for
    // resembling a player.
    expect(classifyRung({ name: "Ethan Holliday", printRun: 25 }, roster).ok).toBe(true);
  });
});

describe("the print run and the footnote each land in their own column", () => {
  it("reads isOneOfOne as /1 and a printRun as itself", () => {
    expect(runOf({ printRun: 499 })).toBe(499);
    expect(runOf({ printRun: null, isOneOfOne: true })).toBe(1);
    expect(runOf({ printRun: null, isOneOfOne: false })).toBe("");
  });

  it("keeps pack odds as a note, never inside the parallel name", () => {
    expect(noteOf({ odds: "1:200 Hobby;  1:50 Jumbo" })).toBe("1:200 Hobby; 1:50 Jumbo");
    expect(noteOf({ odds: null })).toBe("");
  });

  it("folds a name to its player, dropping team and accents", () => {
    expect(foldName("Julio Rodríguez - Seattle Mariners")).toBe("juliorodriguez");
    expect(foldName("Jac Caglianone")).toBe("jaccaglianone");
  });
});
