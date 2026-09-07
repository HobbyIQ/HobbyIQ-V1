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
  it("names NO vertical when nothing identified one", () => {
    // CF-NO-DEFAULT-SPORT (#1924 follow-up, 2026-09-07). This test used to
    // assert `"baseball"`, on the reasoning that "callers that need a string
    // keep getting one". The #1924 census priced that convenience: `sport` is
    // the first segment of the slug, the slug is `cardId`, and `cardId` is the
    // sold_comps partition key -- so the free string was a GUESSED ADDRESS,
    // and baseball is the origin of 82.9% of the 94,275 sport-mismatched pool
    // rows. A caller that needs a vertical it cannot prove must now say so
    // and park, not receive a default dressed as an answer.
    const r = resolveVertical({ title: "2019 some completely unidentifiable card" });
    expect(r.vertical).toBe("");
    expect(r.vertical).not.toBe("baseball");
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
    // The two used to give the SAME answer with different `confident` flags --
    // which is exactly why the difference was so easy to throw away at a call
    // site. Now they differ in the answer too: proven baseball, or nothing.
    expect(real.vertical).toBe("baseball");
    expect(real.confident).toBe(true);
    expect(guess.vertical).toBe("");
    expect(guess.confident).toBe(false);
    expect(real.vertical).not.toBe(guess.vertical);
  });
});
