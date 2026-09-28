// CF-RAYWAVE-IS-THE-SPELLING (Drew ruling, 2026-09-28 12:30Z).
//
// The canonical parallel spelling is the compound "RayWave" -- "<Color>
// RayWave Refractor" / "RayWave Refractor" -- exactly as Topps prints it
// (variationVocabulary.ts:182 FINISH_SPELLING.raywave = "RayWave" already
// said so) and exactly as every sampled sale title reads (see
// C:/tmp/raywave_1430/REPORT.md: 20/20 sampled sold_comps titles read
// "RayWave Refractor" compound; "Ray Wave" two-word form never appears in
// a sold title).
//
// Before this fix, two normalizers on the write/parse path emitted the
// two-word "Ray Wave" instead:
//   - parallelCanonicalizer.service.ts (canonicalizeParallel) -- the
//     sold_comps persistence-time canonicalizer (soldCompsStore.service.ts).
//   - parseTitleIdentity.service.ts (parseListingIdentity / extractParallel)
//     -- the eBay-import title parser.
// A third parser on an adjacent path, ebayTitleParser.service.ts
// (parseListingTitle), already emitted the compound "RayWave" -- it is the
// reference this fix aligns the other two onto, not the reverse.
//
// SLUG IMPACT: none. hobbyIqCardId.service.ts's normalizeParallel() already
// folds BOTH spellings to the one slug `ray-wave` (see the compound-variant
// unification regex at hobbyIqCardId.service.ts:2287 and the pinned tests
// in hobbyIqCardId.test.ts "Ray Wave === Raywave"). This fix only changes
// the DISPLAY string; every derived id, sold_comps address and FMV pool
// stays exactly where it already was.

import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { canonicalizeParallel } from "../src/services/portfolioiq/parallelCanonicalizer.service.js";
import { parseListingTitle } from "../src/services/portfolioiq/ebayTitleParser.service.js";
import { normalizeParallel } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// Every input spelling the market/vendors use, base rung (no colour).
const BASE_SPELLINGS = ["Ray Wave", "Raywave", "RayWave", "RAYWAVE", "ray-wave", "ray wave"];

describe("parallelCanonicalizer.service: canonicalizeParallel emits the compound RayWave", () => {
  for (const spelling of BASE_SPELLINGS) {
    it(`"${spelling}" -> display "RayWave"`, () => {
      expect(canonicalizeParallel(spelling)?.display).toBe("RayWave");
    });
    it(`"${spelling} Refractor" -> display "RayWave Refractor"`, () => {
      expect(canonicalizeParallel(`${spelling} Refractor`)?.display).toBe("RayWave Refractor");
    });
  }

  it("colour-qualified: 'Purple Ray Wave Refractor' -> 'Purple RayWave Refractor'", () => {
    expect(canonicalizeParallel("Purple Ray Wave Refractor")?.display).toBe("Purple RayWave Refractor");
  });
  it("colour-qualified compound input: 'Purple RayWave Refractor' unchanged", () => {
    expect(canonicalizeParallel("Purple RayWave Refractor")?.display).toBe("Purple RayWave Refractor");
  });
  it("colour-qualified, all-caps market spelling: 'BLUE RAYWAVE REFRACTOR'", () => {
    expect(canonicalizeParallel("BLUE RAYWAVE REFRACTOR")?.display).toBe("Blue RayWave Refractor");
  });
  it("slug-shape input: 'blue-ray-wave-refractor' -> 'Blue RayWave Refractor'", () => {
    expect(canonicalizeParallel("blue-ray-wave-refractor")?.display).toBe("Blue RayWave Refractor");
  });
  it("slug-shape compound input: 'blue-raywave-refractor' -> 'Blue RayWave Refractor'", () => {
    expect(canonicalizeParallel("blue-raywave-refractor")?.display).toBe("Blue RayWave Refractor");
  });

  it("slug output is identical across every input spelling (ray-wave, unaffected by this fix)", () => {
    const slugs = new Set(BASE_SPELLINGS.map((s) => canonicalizeParallel(`${s} Refractor`)?.slug));
    expect(slugs.size).toBe(1);
    expect(slugs.has("ray-wave-refractor")).toBe(true);
  });
});

describe("parseTitleIdentity.service: parseListingIdentity emits the compound RayWave from a title", () => {
  it("bare, two-word title spelling -> compound display", () => {
    expect(parseListingIdentity("Owen Carey Ray Wave Refractor #BCP-99").parallel).toBe("RayWave Refractor");
  });
  it("bare, compound title spelling -> unchanged", () => {
    expect(parseListingIdentity("Owen Carey RayWave Refractor #BCP-99").parallel).toBe("RayWave Refractor");
  });
  it("colour + two-word spelling -> colour + compound", () => {
    expect(parseListingIdentity("Owen Carey Blue Ray Wave Refractor").parallel).toBe("Blue RayWave Refractor");
  });
  it("colour + compound spelling -> unchanged", () => {
    expect(parseListingIdentity("Owen Carey Blue RayWave Refractor").parallel).toBe("Blue RayWave Refractor");
  });
  it("colour + hyphenated spelling -> colour + compound", () => {
    expect(parseListingIdentity("Owen Carey Blue Ray-Wave Refractor").parallel).toBe("Blue RayWave Refractor");
  });
  it("2025 Topps Chrome sample title (compound market spelling, as sold)", () => {
    expect(parseListingIdentity("James Wood #132 RayWave Refractor").parallel).toBe("RayWave Refractor");
  });
  it("2025 Topps Chrome sample title, colour + compound (as sold)", () => {
    expect(parseListingIdentity("Mason Miller #142 Gold RayWave Refractor /50").parallel).toBe("Gold RayWave Refractor");
  });
});

describe("ebayTitleParser.service: parseListingTitle already emits the compound RayWave (the reference)", () => {
  it("bare compound", () => {
    expect(parseListingTitle("2025 Topps Chrome RayWave Refractor #150").parallel).toBe("RayWave Refractor");
  });
  it("colour + two-word spelling still resolves to compound", () => {
    expect(parseListingTitle("2025 Bowman Chrome Blue Ray Wave Refractor #BCP-1").parallel).toBe("Blue RayWave Refractor");
  });
});

describe("cross-module agreement: all three normalizers answer the same display string for the same input", () => {
  // Each case: a title fragment plausible on both a parseTitleIdentity- and
  // an ebayTitleParser-shaped title, plus the raw parallel text
  // canonicalizeParallel would see off a vendor feed for the same card.
  const AGREEMENT_CASES: Array<{ title: string; rawParallel: string; want: string }> = [
    { title: "Owen Carey RayWave Refractor #BCP-99", rawParallel: "RayWave Refractor", want: "RayWave Refractor" },
    { title: "Owen Carey Ray Wave Refractor #BCP-99", rawParallel: "Ray Wave Refractor", want: "RayWave Refractor" },
    { title: "Owen Carey Blue RayWave Refractor #BCP-99", rawParallel: "Blue RayWave Refractor", want: "Blue RayWave Refractor" },
    { title: "Owen Carey Blue Ray Wave Refractor #BCP-99", rawParallel: "Blue Raywave Refractor", want: "Blue RayWave Refractor" },
    { title: "Mason Miller Gold RayWave Refractor /50", rawParallel: "Gold Ray-Wave Refractor", want: "Gold RayWave Refractor" },
  ];

  for (const c of AGREEMENT_CASES) {
    it(`"${c.title}" / "${c.rawParallel}" -> all three say "${c.want}"`, () => {
      expect(parseListingIdentity(c.title).parallel).toBe(c.want);
      expect(parseListingTitle(c.title).parallel).toBe(c.want);
      expect(canonicalizeParallel(c.rawParallel)?.display).toBe(c.want);
    });
  }

  it("and the slug agrees too, independent of which spelling produced the display", () => {
    for (const c of AGREEMENT_CASES) {
      const fromParseTitleIdentity = normalizeParallel(parseListingIdentity(c.title).parallel);
      const fromCanonicalizer = canonicalizeParallel(c.rawParallel)?.slug;
      expect(fromParseTitleIdentity).toBe(fromCanonicalizer);
    }
  });
});

// Bowman Chrome carries the same finish (2022/2023/2025 bowman-chrome per
// parallelLadders.ts) -- confirm the fix is spelling-only and does not
// regress the Bowman Chrome lane's own RayWave rungs.
describe("Bowman Chrome RayWave is unaffected (same compound spelling, different product)", () => {
  it("2022 Bowman Chrome Blue RayWave Refractor /150 title parses unchanged", () => {
    const p = parseListingIdentity("2022 Bowman Chrome Drake Baldwin Blue RayWave Refractor Auto /150");
    expect(p.parallel).toBe("Blue RayWave Refractor");
  });
  it("2025 Bowman Chrome Purple RayWave Refractor title parses unchanged (ebayTitleParser)", () => {
    expect(parseListingTitle("2025 Bowman Chrome Purple RayWave Refractor #BCP-1").parallel).toBe("Purple RayWave Refractor");
  });
});
