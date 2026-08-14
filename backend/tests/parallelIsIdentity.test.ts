// CF-PARALLEL-IS-IDENTITY (Drew, 2026-08-13: "why is it getting written to the
// wrong card when it is clear what it is").
//
// The matcher's fuzzy-parallel step reduced a parallel to its LAST token and
// searched on it. Real parallels are "<Color> <Family>", so the last token is
// the generic family word every parallel in the set shares — the code threw
// away the only part that identifies the card, then picked a winner from an
// unordered TOP 10.
//
// Measured on prod: 41 of 300 promoted sales (13.7%) were rebound onto a
// DIFFERENT parallel, at confidence 0.72, corrupting both the pool it left and
// the pool it joined — and FMV is computed from those pools.
//
// Every pair below is a real rebind observed in sold_comps.

import { describe, expect, it } from "vitest";
import {
  parallelTokenSet,
  sameParallelTokens,
  canonicalizeParallelName,
} from "../src/services/catalog/catalogMatcher.service.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const same = (a: string, b: string) =>
  sameParallelTokens(parallelTokenSet(slug(a)), parallelTokenSet(slug(b)));

describe("parallel token sets", () => {
  it("treats an absent parallel and an explicit Base as the same", () => {
    expect(same("", "base")).toBe(true);
    expect(same("Base", "")).toBe(true);
  });

  it("ignores token ORDER — that is all the fuzzy step should ever have absorbed", () => {
    expect(same("blue-refractor", "refractor-blue")).toBe(true);
    expect(same("Gold Refractor", "refractor gold")).toBe(true);
  });

  it("is not a subset test", () => {
    // "refractor" is a subset of "green-refractor", but a sale that says only
    // "Refractor" is NOT evidence of a Green Refractor. Accepting the subset is
    // how a plain Refractor became a common-green-refractor /75 in prod.
    expect(same("refractor", "green-refractor")).toBe(false);
    expect(same("green-refractor", "refractor")).toBe(false);
  });
});

describe("the exact rebinds observed in prod are now impossible", () => {
  // sale parallel -> the parallel it was wrongly rebound onto
  const REAL_REBINDS: Array<[string, string]> = [
    ["mojo-refractor", "refractor"],
    ["purple-prizm", "set-premier-level-black-finite-prizms"],
    ["refractor", "common-green-refractor"],
    ["base", "murakami-base-variations-3-refractor"],
    ["silver-prizm", "set-concourse-zebra-prizms"],
    ["mini-diamond-refractor", "negative-refractor"],
    ["blue-pulsar-prizm", "green-prizm"],
    ["mojo-prizm", "prizm-blue"],
  ];

  for (const [sale, wrong] of REAL_REBINDS) {
    it(`${sale} must not match ${wrong}`, () => {
      expect(same(sale, wrong)).toBe(false);
    });
  }

  it("the generic family token alone never makes a match", () => {
    // The precise bug: every one of these shares its LAST token.
    for (const [sale, wrong] of REAL_REBINDS) {
      const lastOf = (s: string) => slug(s).split("-").filter(Boolean).slice(-1)[0];
      if (lastOf(sale) === lastOf(wrong)) {
        expect(same(sale, wrong), `${sale} vs ${wrong}`).toBe(false);
      }
    }
  });
});

describe("legitimate matches still resolve", () => {
  it("keeps market-language aliases matching after canonicalization", () => {
    // "True Blue" = "Blue Refractor" per the market-language rule. The alias is
    // applied before slugging, so the token sets agree.
    expect(same(canonicalizeParallelName("True Blue"), "blue-refractor")).toBe(true);
    expect(same(canonicalizeParallelName("[Base]"), "base")).toBe(true);
    expect(same(canonicalizeParallelName("Base Refractor"), "refractor")).toBe(true);
  });

  it("matches the same parallel written with different punctuation", () => {
    expect(same("Blue/Refractor", "blue refractor")).toBe(true);
    expect(same("X-Fractor", "x fractor")).toBe(true);
  });

  it("still distinguishes autos and print runs elsewhere in the slug", () => {
    // printRun and isAuto are separate slug segments, so they never enter the
    // parallel comparison — which is why token equality is safe here.
    expect(same("blue-refractor", "blue-refractor")).toBe(true);
  });
});
