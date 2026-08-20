// CF-VERTICAL-NOT-SPORT (Drew, 2026-08-13: "so maybe calling it sport is
// wrong?").
//
// inferSportFromTitle defaulted to "baseball", so anything it could not
// identify silently became a baseball card — that is how a Pokemon EX Sandstorm
// became hiq:baseball:2003:ex-sandstorm:87100. The old function could not tell
// you "this IS baseball" apart from "I have no idea", and those are very
// different claims.
//
// resolveVertical returns both the answer AND whether it is confident.

import { describe, expect, it } from "vitest";
import { resolveVertical } from "../src/services/portfolioiq/resolveVertical.service.js";

describe("resolveVertical — TCG is checked first", () => {
  it("resolves Pokemon from a title with no sport keyword", () => {
    // The exact failure mode: no sport word anywhere, so the old path defaulted.
    const r = resolveVertical({ title: "2022 POKEMON SWORD & SHIELD BRILLIANT STARS #018 CHARIZARD VSTAR" });
    expect(r.vertical).toBe("pokemon");
    expect(r.confident).toBe(true);
    expect(r.reason).toBe("tcg-detector");
  });

  it("overrides a WRONG declared sport when the title is unmistakably TCG", () => {
    // Real row: a Charizard filed as hockey.
    const r = resolveVertical({ declared: "hockey", title: "2022 POKEMON SWORD & SHIELD BRILLIANT STARS #018 CHARIZARD VSTAR PSA 1" });
    expect(r.vertical).toBe("pokemon");
  });

  it("resolves TCG from the SLUG when the title is terse", () => {
    const r = resolveVertical({ title: "", hobbyiqCardId: "hiq:baseball:2003:ex-sandstorm:87100:base:no-auto" });
    expect(r.vertical).toBe("pokemon");
    expect(r.confident).toBe(true);
  });
});

describe("resolveVertical — real sports still resolve", () => {
  it("reads a sport keyword from the title", () => {
    const r = resolveVertical({ title: "2024 Panini Prizm Football #232 Caleb Williams" });
    expect(r.vertical).toBe("football");
    expect(r.confident).toBe(true);
    expect(r.reason).toBe("sport-keyword");
  });

  it("trusts a declared vertical", () => {
    const r = resolveVertical({ declared: "basketball", title: "2024 Panini Prizm #254" });
    expect(r.vertical).toBe("basketball");
    expect(r.reason).toBe("explicit");
  });
});

describe("resolveVertical — the honest default", () => {
  it("still returns a usable vertical so nothing breaks", () => {
    // Non-breaking: callers that need a string keep getting one.
    const r = resolveVertical({ title: "2019 some completely unidentifiable card" });
    expect(r.vertical).toBe("baseball");
  });

  it("but reports that it GUESSED — this is the whole point", () => {
    // The old signature could not express this, which is why 93.6% of
    // card_catalog is sport=baseball.
    const r = resolveVertical({ title: "2019 some completely unidentifiable card" });
    expect(r.confident).toBe(false);
    expect(r.reason).toBe("defaulted");
  });

  it("lets the caller own the fallback rather than hardcoding baseball", () => {
    const r = resolveVertical({ title: "unidentifiable", fallback: "unknown" });
    expect(r.vertical).toBe("unknown");
    expect(r.confident).toBe(false);
  });

  it("distinguishes a real baseball card from a defaulted one", () => {
    const real = resolveVertical({ title: "1969 Topps Baseball #100 Mickey Mantle" });
    const guess = resolveVertical({ title: "2019 unidentifiable thing" });
    expect(real.vertical).toBe(guess.vertical);        // same answer...
    expect(real.confident).toBe(true);
    expect(guess.confident).toBe(false);               // ...different claim
  });
});
