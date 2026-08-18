// CF-RESLUG-NO-DEMOTION (Drew, 2026-08-18).
//
// Reported as a pricing bug: a 1987 Topps Traded Tiffany Greg Maddux #70T
// PSA 10 — a ~$1,600 card — showed $245.
//
// The cause was a comp pool, not the math. `hiq:baseball:1987:topps:70t:base:no-auto`
// held 1,930 sales of THREE different products at once:
//
//   1,172 rows  "1987 Topps Traded Baseball"          PSA 10 median   $105
//     235 rows  "1987 Topps Traded Tiffany Baseball"  PSA 10 median $1,000
//     381 rows  "Topps"                               PSA 10 median   $134
//
// canonicalFmv's top rung is direct-comp (same cardId + grade), so it projected
// across that bimodal pool and landed in the middle. Meanwhile the correct
// topps-traded-tiffany pool held 31 rows. Across the container, ~147k rows sat
// on a bare `topps` key while their own setName named Update, Chrome, Traded or
// Tiffany.
//
// Two things are pinned here:
//   1. The three products resolve to three DISTINCT setKeys, so they can never
//      share a comp pool.
//   2. The parent ladder that the sweep's demotion guard consults still reports
//      topps-traded-tiffany -> topps-traded -> topps. isDemotion() walks that
//      chain; if the ladder flattened, the guard would silently stop guarding.

import { describe, it, expect } from "vitest";
import {
  computeHobbyIqCardId,
  deriveParentSetKey,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";

/** The exact vendor setName strings found on the mis-pooled rows. */
const REAL_SET_NAMES: ReadonlyArray<{ setName: string; expected: string }> = [
  { setName: "1987 Topps Traded Tiffany Baseball", expected: "topps-traded-tiffany" },
  { setName: "Topps Traded Tiffany", expected: "topps-traded-tiffany" },
  { setName: "1987 TOPPS TRADED TIFFANY", expected: "topps-traded-tiffany" },
  { setName: "1987 Topps Traded Baseball", expected: "topps-traded" },
  { setName: "Topps Traded", expected: "topps-traded" },
  { setName: "1987 Topps Tiffany Baseball", expected: "topps-tiffany" },
];

describe("CF-RESLUG-NO-DEMOTION — Traded / Tiffany / flagship never share a pool", () => {
  it("resolves each real vendor setName to its own setKey", () => {
    for (const { setName, expected } of REAL_SET_NAMES) {
      expect(resolveSetKeyForSlug("baseball", setName, 1987)).toBe(expected);
    }
  });

  it("gives the three 1987 #70T products three DISTINCT slugs", () => {
    const slugFor = (setKey: string) =>
      computeHobbyIqCardId({
        sport: "baseball", year: 1987, setKey,
        cardNumber: "70T", parallel: "Base", isAuto: false,
      });

    const tiffany = slugFor("1987 Topps Traded Tiffany Baseball");
    const traded = slugFor("1987 Topps Traded Baseball");
    const flagship = slugFor("Topps");

    expect(tiffany).toBe("hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto");
    expect(traded).toBe("hiq:baseball:1987:topps-traded:70t:base:no-auto");
    expect(new Set([tiffany, traded, flagship]).size).toBe(3);

    // The specific collapse that produced the $245: Tiffany must never land on
    // the bare flagship key.
    expect(tiffany).not.toBe(flagship);
  });

  it("keeps the parent ladder the demotion guard walks", () => {
    expect(deriveParentSetKey("topps-traded-tiffany")).toBe("topps-traded");
    expect(deriveParentSetKey("topps-traded")).toBe("topps");
    expect(deriveParentSetKey("topps")).toBeNull();
  });

  it("ANCESTOR = demotion; a different branch is not", () => {
    // Mirrors scripts/reslug-setkey-from-setname.cjs isDemotion().
    const isDemotion = (current: string, next: string): boolean => {
      const seen = new Set([current]);
      let p = deriveParentSetKey(current);
      while (p && !seen.has(p)) {
        if (p === next) return true;
        seen.add(p);
        p = deriveParentSetKey(p);
      }
      return false;
    };

    // The moves that must be refused — losing specificity.
    expect(isDemotion("topps-traded-tiffany", "topps-traded")).toBe(true);
    expect(isDemotion("topps-traded-tiffany", "topps")).toBe(true);
    expect(isDemotion("topps-chrome", "topps")).toBe(true);

    // The moves that must still be allowed — gaining specificity, or a genuine
    // cross-branch mis-file correction.
    expect(isDemotion("topps", "topps-traded-tiffany")).toBe(false);
    expect(isDemotion("topps", "fleer-update")).toBe(false);
    expect(isDemotion("topps-traded", "topps-traded-tiffany")).toBe(false);
  });
});
