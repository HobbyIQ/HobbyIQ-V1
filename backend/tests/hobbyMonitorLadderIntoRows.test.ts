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

describe("a rung is a rung when the source names a parallel, not a person", () => {
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

  it("KEEPS an unnumbered rung that is not a player (CF-HM-VINTAGE-LADDER-DROPPED)", () => {
    // The rule used to demand scarcity, which is true of 2026 Bowman and false
    // of everything older. 2012/13 Panini Prizm publishes "Prizms", "Prizms
    // Green" and "Prizms Gold" with no print run anywhere on the page, and the
    // old rule ingested that release BASE-ONLY — 500 rows, no ladder.
    const r = classifyRung({ name: "Prizms Green", printRun: null, isOneOfOne: false, odds: null }, roster);
    expect(r.ok).toBe(true);
    expect(r.why).toBe("unnumbered");
    // ...and its print run stays BLANK. Unknown is never a guess.
    expect(runOf({ printRun: null, isOneOfOne: false })).toBe("");
  });

  it("still refuses an empty name, and a sentence past 60 chars", () => {
    expect(classifyRung({ name: "", printRun: null }, roster).ok).toBe(false);
    const long = classifyRung({ name: "x".repeat(61), printRun: null }, roster);
    expect(long.ok).toBe(false);
    expect(long.why).toBe("over-60-chars");
  });

  it("catches the ONE misfiled name measured across 34 pages of the lane", () => {
    // "Christy Mathewson - All 300 subjects" (2025 Topps T205) is 36 chars, so
    // the length check never sees it — foldName drops the " - ..." suffix and
    // the ROSTER check is what refuses it. This is the whole reason the roster
    // guard, and not the scarcity proxy, is the load-bearing one.
    const t205 = new Set([foldName("Christy Mathewson")]);
    const r = classifyRung({ name: "Christy Mathewson - All 300 subjects", printRun: null }, t205);
    expect(r.ok).toBe(false);
    expect(r.why).toBe("player-name");
  });

  it("a player name is refused even when the source priced it", () => {
    // ORDER CHANGED DELIBERATELY. Scarcity used to be checked first, so a
    // numbered entry was kept even if it was a person. The roster check is now
    // the load-bearing guard and runs first: a misfiled player carrying a print
    // run is exactly the exploded-spine row we must never mint.
    expect(classifyRung({ name: "Ethan Holliday", printRun: 25 }, roster).why).toBe("player-name");
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
