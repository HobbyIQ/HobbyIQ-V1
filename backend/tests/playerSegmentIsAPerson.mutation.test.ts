// CF-A-PLAYER-SEGMENT-IS-A-PERSON -- the MUTATION gate.
//
// A green suite proves the code passes its tests. It does not prove the tests
// would catch the defect coming back. These tests break the fix ON PURPOSE, in
// the two exact ways the original defect was shaped, and assert the breakage is
// VISIBLE. If a mutation here goes green, the pin next door is decorative.
//
// The mutations are applied to a REIMPLEMENTATION of the module's decision
// points rather than by patching the real module, because the real one reads a
// 6MB corpus and caches it. Each mutant is the fix's own logic with exactly one
// rule removed, so what is measured is the rule, not the plumbing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";
import { playerSegmentIsAPerson } from "../src/services/compiq/playerSegmentIsAPerson.js";

// ---------------------------------------------------------------------------
// Mutation 1: ALLOW A FINISH TOKEN INSIDE A NAME  -> must be RED
// ---------------------------------------------------------------------------
describe("mutation: a finish token is allowed to stay inside the name", () => {
  /** The fix with rule (1) removed: no vocabulary strip, residue is the name. */
  function mutantNoStrip(residue: string): string | null {
    const toks = residue.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    return toks.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");
  }

  it("the mutant reproduces the stored corruption -- so the pin has something to catch", () => {
    // This is `player-kawhi-leonard-tie-dye` as it sits in the pool today.
    expect(mutantNoStrip("Kawhi Leonard Tie-Dye")).toBe("Kawhi Leonard Tie-dye");
  });

  it("the real module refuses what the mutant accepts", () => {
    const real = playerSegmentIsAPerson("Kawhi Leonard Tie-Dye", { year: 2024, setKey: "panini-select" });
    expect(real.player).toBe("Kawhi Leonard");
    expect(real.stripped).toContain("tie-dye");
    // The assertion that would go RED under the mutation.
    expect(real.player).not.toBe(mutantNoStrip("Kawhi Leonard Tie-Dye"));
  });

  it("end to end: no finish word survives into a parsed player name", () => {
    for (const [title, banned] of [
      ["2024 Panini Select Kawhi Leonard Tie-Dye Prizm #23 PSA 10", /tie|dye/i],
      ["1987 Topps Traded Tiffany Greg Maddux #70T PSA 10", /tiffany/i],
      ["COOPER FLAGG 2025-26 Topps Chrome X FRACTOR Rookie PSA 10", /fractor/i],
      ["LUKE KUECHLY 2017 Panini Unparalleled Purple 80/99 PSA 10", /unparalleled/i],
    ] as const) {
      expect(parseCardQuery(title).playerName ?? "").not.toMatch(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Mutation 2: TRUNCATE INSTEAD OF REFUSING  -> must be RED
// ---------------------------------------------------------------------------
describe("mutation: the ceiling cuts the name instead of refusing it", () => {
  /** The fix with rule (2) inverted: the ceiling is applied as `.slice()`.
   *  This is the ORIGINAL line, restored. */
  function mutantSlice(residue: string, ceiling = 4): string | null {
    const toks = residue.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
    return toks.slice(0, ceiling).map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ") || null;
  }

  it("the mutant reproduces the stored truncation exactly", () => {
    // `player-mega-box-elly-de`, character for character.
    expect(mutantSlice("Mega Box Elly De La Cruz")).toBe("Mega Box Elly De");
  });

  it("the real module returns the whole name where the mutant cuts it", () => {
    const real = playerSegmentIsAPerson("Mega Box Elly De La Cruz", { year: 2023, setKey: "topps-chrome" });
    expect(real.player).toBe("Elly De La Cruz");
    expect(real.player).not.toBe(mutantSlice("Mega Box Elly De La Cruz"));
  });

  it("an unbounded residue is refused, not trimmed to the ceiling", () => {
    const residue = "Berk Ross Campanella Brooklyn No";
    expect(mutantSlice(residue)).toBe("Berk Ross Campanella Brooklyn");  // what a cut would mint
    expect(playerSegmentIsAPerson(residue, {}).player).toBeNull();       // what we do instead
  });

  it("a name is never returned ending on a particle", () => {
    for (const residue of ["Mega Box Elly De La Cruz", "Jose De La Cruz Rodriguez Extra"]) {
      const out = playerSegmentIsAPerson(residue, {}).player;
      if (out !== null) expect(out).not.toMatch(/\s(de|la|van|von|mc|del)$/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Mutation 3: THE `.slice(0, 4)` IS GONE FROM THE PARSER  -> pinned by ABSENCE
// ---------------------------------------------------------------------------
describe("the truncating expression is absent from the parser", () => {
  it("cardQueryParser.ts no longer cuts the player residue to four words", () => {
    // Pinned by ABSENCE, the way unparsedIsNotUnnumbered.mutation.test.ts pins
    // the `vendor ?? title` it replaced: the defect was a specific expression,
    // and the guarantee is that the expression is not there. A future edit that
    // reintroduces `.slice(0, N).join(" ")` on the residue goes RED here.
    const src = readFileSync(join(__dirname, "..", "src", "services", "compiq", "cardQueryParser.ts"), "utf8");
    const playerBlock = src.slice(src.indexOf("--- PLAYER NAME ---"));
    expect(playerBlock).not.toMatch(/\.slice\(0,\s*\d+\)\s*\n?\s*\.join\(" "\)/);
    // and the replacement is wired in
    expect(playerBlock).toMatch(/playerSegmentIsAPerson\(/);
  });
});

// ---------------------------------------------------------------------------
// Mutation 4: THE CORPUS IS BUNDLED  -> a silent degrade is a RED
// ---------------------------------------------------------------------------
describe("the vocabulary ships with the build", () => {
  it("checklist-parallel-names.json is in the bundled-files list", () => {
    // playerSegmentIsAPerson degrades QUIETLY when the corpus is missing: it
    // falls back to the vintage hand list and stops stripping 36,699 checklist
    // parallels, which looks exactly like a working deploy. The copy step is
    // therefore load-bearing and is pinned here rather than discovered in prod.
    const copier = readFileSync(join(__dirname, "..", "scripts", "copy-static-data-to-dist.cjs"), "utf8");
    expect(copier).toMatch(/checklist-parallel-names\.json/);
  });
});
