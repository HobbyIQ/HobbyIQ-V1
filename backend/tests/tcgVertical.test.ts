// CF-TCG-HOLDING-GROUP (Drew, 2026-08-13: "let's just tag them as TCG and into
// a holding group").
//
// 7.7% of staging rows are TCG. They can never match a sports catalog, so they
// churned forever: failing promotion, filing checklist seeds for sets no sports
// checklist covers (the seed queue GREW 2,285 -> 2,754 while we drained it), and
// dragging measured catalog coverage down.
//
// The risk in this classifier is a FALSE POSITIVE — pulling a real sports sale
// out of the pool — so the title patterns are deliberately narrow.

import { describe, expect, it } from "vitest";
import { classifyTcg } from "../src/services/portfolioiq/tcgVertical.service.js";

describe("classifyTcg — vertical field is trusted first", () => {
  it("routes rows the pipeline already labelled as a TCG vertical", () => {
    // 1,194 of 1,532 TCG rows in the sample were already tagged correctly.
    for (const v of ["pokemon", "anime-tcg", "yugioh", "tcg-other", "mtg", "lorcana"]) {
      const c = classifyTcg({ sport: v, title: "whatever" });
      expect(c.isTcg, v).toBe(true);
      expect(c.reason).toBe("vertical-field");
      expect(c.vertical).toBe(v);
    }
  });

  it("is case-insensitive on the vertical", () => {
    expect(classifyTcg({ sport: "Pokemon" }).isTcg).toBe(true);
  });
});

describe("classifyTcg — catches the misfiled tail", () => {
  // ~0.6% of rows carry a SPORT while being obviously TCG. Real examples.
  const MISFILED: Array<[string, string]> = [
    ["hockey", "2025 Pokemon Phantasmal Flames Dawn Ultra Rare #118/094"],
    ["hockey", "2022 POKEMON SWORD & SHIELD BRILLIANT STARS #018 CHARIZARD VSTAR PSA 1"],
    ["anime-tcg", "2025 One Piece Anime 25th Monkey D. Luffy Secret Rare #EB02-061"],
  ];

  for (const [sport, title] of MISFILED) {
    it(`catches "${title.slice(0, 40)}…" filed as ${sport}`, () => {
      expect(classifyTcg({ sport, title }).isTcg).toBe(true);
    });
  }

  it("reads the SLUG too — setKey survives there when the title is terse", () => {
    // These computed baseball slugs are Pokemon sets wearing sports identity.
    expect(classifyTcg({ sport: "baseball", title: "", hobbyiqCardId: "hiq:baseball:2003:ex-sandstorm:87100:base:no-auto" }).isTcg).toBe(true);
    expect(classifyTcg({ sport: "baseball", title: "", hobbyiqCardId: "hiq:baseball:2020:swsh-sword-shield-promo-cards:swsh282:base:no-auto" }).isTcg).toBe(true);
    expect(classifyTcg({ sport: "baseball", title: "", hobbyiqCardId: "hiq:baseball:2011:call-of-legends:6295:base:no-auto" }).isTcg).toBe(true);
  });
});

describe("classifyTcg — must NOT pull real sports cards out of the pool", () => {
  // A false positive silently removes a legitimate sale from pricing, which is
  // worse than leaving a TCG row in the backlog. Every one of these is a real
  // sports title containing words that a sloppier matcher would trip on.
  const SPORTS: string[] = [
    "2026 Bowman Chrome Owen Carey #BCP-69 Speckle Refractor /299",
    "2024 Panini Prizm Silver #254 Victor Wembanyama",
    "1969 Topps Baseball #100 Base",
    "2025 Topps Chrome Shohei Ohtani Big Ticket Player Refractor",
    "2023 Panini Select Purple Ice #153 WNBA",
    // "Star" / "Magic" / "Dawn" appear in sports products too.
    "2024 Topps Stadium Club Magic Johnson Chrome",
    "2025 Bowman's Best Top Prospects Dawn Sanders",
    "2022 Panini Mosaic Stars Rookie",
  ];

  for (const title of SPORTS) {
    it(`leaves "${title.slice(0, 44)}…" alone`, () => {
      expect(classifyTcg({ sport: "baseball", title }).isTcg).toBe(false);
    });
  }

  it("does not classify on an empty row", () => {
    expect(classifyTcg({}).isTcg).toBe(false);
    expect(classifyTcg({ sport: "", title: "", hobbyiqCardId: "" }).isTcg).toBe(false);
  });
});

// CF-TCG-DETECTION-WIDEN + CF-TCG-ERA-PREFIX-COLLISION (Drew, 2026-08-14).
//
// #1035 gated the TCG POS/TOTAL card-number rule on this classifier, which
// turned a detection miss from cosmetic into costly: an undetected Pokemon
// title now yields cardNumber=null instead of a usable number. These pin the
// misses found in real blocked staging rows.
describe("TCG detection — widened coverage", () => {
  it("detects Japanese-market product by set code and product name", () => {
    // Was a MISS, and #1035 turned that miss into cardNumber=null.
    const r = classifyTcg({ title: "CGC 10 Terapagos ex 136/187 SV8a Terastal Fest ex Holo Japanese 2024" });
    expect(r.isTcg).toBe(true);
  });

  it("detects by character name when the set name collides with sports", () => {
    // "crystal guardians" is deliberately absent from POKEMON_SET_NAMES because
    // it collides; the character is unambiguous.
    expect(classifyTcg({ title: "Ivysaur - 035/100 - EX Crystal Guardians - Reverse Holofoil" }).isTcg).toBe(true);
    expect(classifyTcg({ title: "Umbreon VMAX 215/203 Evolving Skies Alt Art" }).isTcg).toBe(true);
  });

  it("still detects the era prefixes it always did", () => {
    expect(classifyTcg({ title: "Mewtwo - SV1 Scarlet Violet Base" }).isTcg).toBe(true);
    expect(classifyTcg({ title: "Gengar - XY Roaring Skies - Holofoil" }).isTcg).toBe(true);
    expect(classifyTcg({ hobbyiqCardId: "hiq:pokemon:2021:swsh-sword-shield-promo:1:base:no-auto" }).isTcg).toBe(true);
  });

  // ─── the collision that mattered ─────────────────────────────────────────
  it("does NOT classify a sports card numbered SV-NN as Pokemon", () => {
    // The haystack flattens hyphens, so "SV-12" became "sv 12" and matched the
    // bare "sv " era prefix. Every Topps Chrome Sapphire SV-NN card was being
    // classified as Pokemon — and after #1035 that also corrupts its card
    // number, because isTcg decides how the N/M token is read.
    expect(classifyTcg({ title: "2024 Topps Chrome Sapphire Edition Paul Skenes SV-12 Rookie" }).isTcg).toBe(false);
    expect(classifyTcg({ title: "2025 Topps Chrome Update Sapphire Jackson Merrill SV-3 SP" }).isTcg).toBe(false);
  });

  it("does not classify serial-numbered sports parallels as TCG", () => {
    const sports = [
      "2025-26 Fleer Ultra Outlining Macklin Celebrini OL 22/30 Color Match Sharks",
      "DON MATTINGLY 2026 DONRUSS ELITE 28 11/299 RED STATUS SP YANKEES!",
      "2025-26 Bowman Chrome AJ Dybantsa Aqua X-Fractor 1st Prospect 079/125",
      "1998 Fleer Tradition Ken Griffey Jr #198 Platinum Medallion /98",
      "2021 Bowman Platinum Base Set Wander Franco #12",
    ];
    for (const t of sports) expect(classifyTcg({ title: t }).isTcg).toBe(false);
  });
});
