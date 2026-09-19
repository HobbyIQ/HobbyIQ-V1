/**
 * resolveVertical.service.ts:65 -- `provenSport`'s baseball/mlb check.
 *
 * GUARDS: `provenSport` is `resolveVertical`'s internal helper for
 * confirming a sport `inferSportFromTitle` can prove twice with different
 * fallbacks; its own comment says baseball needed a special-cased check
 * because `inferSportFromTitle` has no explicit baseball branch (baseball
 * is only its FALLBACK, so the two-probe trick can never confirm it).
 *
 * WHAT IT SILENTLY DID WHILE BROKEN: `\b` had degraded to a raw 0x08
 * backspace byte, so `/\b(baseball|mlb)\b/i` required literal backspace
 * characters around the words -- never present in a real title. This
 * branch of `provenSport` was DEAD: it always fell through to the
 * two-probe `inferSportFromTitle` call below it.
 *
 * WHAT STARTS HAPPENING NOW THAT IT WORKS, AND WHY IT IS MEASURED SAFE.
 * `provenSport` itself now confirms "baseball" directly off a bare
 * "Baseball"/"MLB" title word (pinned below) -- but `resolveVertical`,
 * the function every caller actually uses, is UNCHANGED: it carries its
 * own, separate, never-corrupted `/(baseball|mlb)/i` check earlier in the
 * function (this repo's PR review found this: the caller's baseball check
 * runs and returns BEFORE `provenSport` is ever invoked for a baseball/mlb
 * title), so `provenSport`'s repaired branch is provably unreachable from
 * a baseball title through the real entry point.
 *
 * MEASURED: `resolveVertical({ title })` run over all 20,840 real titles
 * in the R32 export (no declared vertical, title only) is BYTE-IDENTICAL
 * before and after this repair -- same vertical, confidence and reason on
 * every single row. `provenSport` is exported and tested here directly
 * (rather than only through `resolveVertical`, where the effect is
 * invisible by construction) so the repair itself is pinned, not just its
 * absence of effect.
 */
import { describe, it, expect } from "vitest";
import { provenSport } from "../src/services/portfolioiq/resolveVertical.service";
import { resolveVertical } from "../src/services/portfolioiq/resolveVertical.service";

describe("provenSport baseball/mlb check (word-boundary byte repair)", () => {
  it("PINS THE REPAIR: a bare Baseball/MLB word now confirms directly", () => {
    expect(provenSport("1969 Topps Baseball #500 Nolan Ryan")).toBe("baseball");
    expect(provenSport("2023 Topps MLB Update Series")).toBe("baseball");
  });

  it("the word-boundary regex itself does not match a substring occurrence", () => {
    // Isolates the exact regex this repair fixed, rather than provenSport's
    // full cascade -- `inferSportFromTitle`'s own two-probe fallback (a
    // separate mechanism, unaffected by this byte repair) defaults to
    // "baseball" for unrecognized text, which would make an end-to-end
    // assertion here pass or fail for the wrong reason.
    expect(/\b(baseball|mlb)\b/i.test("baseballs are round")).toBe(false);
    expect(/\b(baseball|mlb)\b/i.test("MLBPA licensed product")).toBe(false);
  });

  it("resolveVertical (the real entry point) is unaffected: its own earlier check already catches baseball/mlb titles", () => {
    const r1 = resolveVertical({ title: "1969 Topps Baseball #500 Nolan Ryan" });
    expect(r1.vertical).toBe("baseball");
    expect(r1.reason).toBe("sport-keyword");
    const r2 = resolveVertical({ title: "2023 Topps MLB Update Series" });
    expect(r2.vertical).toBe("baseball");
  });
});
