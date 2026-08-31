/**
 * LANE 4 (c) -- the decision surface of repair-truncated-card-year.
 *
 * 2,980 sold_comps rows carry a 3-digit cardYear (201:1234, 197:947, 198:458,
 * 202:163, 199:143, 200:35), each the real year with its last digit dropped.
 * The repair reconciles against setName / title, which state the year.
 *
 * The load-bearing half of these tests is the refusals. A pass that rewrote a
 * year on weak evidence would file real sales under a card that never existed,
 * and 2,980 wrong rows would become 2,980 differently-wrong rows.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require("../scripts/repair-truncated-card-year.cjs");

describe("trueYearFrom recovers the dropped digit from evidence on the row", () => {
  it.each([
    [201, "2016 Panini Donruss Football", "", 2016],
    [197, "1978 Kellogg's 3-D Super Stars Baseball", "", 1978],
    [199, "1996 Skybox Impact Rookies Football", "", 1996],
    [202, "2021 Panini Prizm Basketball", "", 2021],
    [200, "2005 Bowman Chrome Baseball", "", 2005],
  ])("cardYear %i with setName %j -> %i", (stored, setName, title, expected) => {
    expect(R.trueYearFrom(stored, setName, title)?.year).toBe(expected);
  });

  it("falls back to the sale title when setName is blank", () => {
    const hit = R.trueYearFrom(201, "", "2016 Donruss #372 Jared Goff RC Rams Rookie Card - Raw");
    expect(hit?.year).toBe(2016);
    expect(hit?.via).toBe("title");
  });

  it("prefers setName over the title when both state a year", () => {
    const hit = R.trueYearFrom(201, "2017 Topps Heritage Minor League Baseball", "2016 something else");
    expect(hit?.year).toBe(2017);
    expect(hit?.via).toBe("setName");
  });
});

describe("what the repair refuses", () => {
  it("refuses when the text states a year that is NOT this row's prefix", () => {
    // 1978 does not restore 201. Rewriting to it would invent a card.
    expect(R.trueYearFrom(201, "1978 Kellogg's Baseball", "")).toBeNull();
  });

  it("refuses when the text states NO year", () => {
    expect(R.trueYearFrom(201, "Panini Donruss Football", "")).toBeNull();
    expect(R.trueYearFrom(197, "", "")).toBeNull();
  });

  it("refuses AMBIGUITY -- two candidate years both matching the prefix", () => {
    // "1996 ... 1997" both restore 199. Evidence that points two ways is not
    // evidence; a coin flip here files the sale under the wrong card.
    expect(R.trueYearFrom(199, "", "1996 Skybox / 1997 reprint Ray Lewis")).toBeNull();
  });

  it("leaves a healthy 4-digit year completely alone", () => {
    expect(R.trueYearFrom(2016, "2016 Panini Donruss Football", "")).toBeNull();
    expect(R.trueYearFrom(1978, "1978 Topps Baseball", "")).toBeNull();
  });

  it("does not treat a print run or card number as a year", () => {
    expect(R.trueYearFrom(499, "Topps Chrome Refractor /499", "")).toBeNull();
    expect(R.trueYearFrom(150, "Bowman Chrome #150", "")).toBeNull();
  });

  it("does not accept a year outside the plausible card range", () => {
    // 2150 and 1750 are not card years; the pattern is 18xx/19xx/20xx.
    expect(R.trueYearFrom(215, "2150 Future Set", "")).toBeNull();
    expect(R.trueYearFrom(175, "1750 Antique", "")).toBeNull();
  });
});

describe("rekeySlug moves the year segment only", () => {
  it("swaps the year in place and preserves the rest of the identity", () => {
    expect(R.rekeySlug("hiq:football:201:donruss:372:base:no-auto", 201, 2016))
      .toBe("hiq:football:2016:donruss:372:base:no-auto");
    expect(R.rekeySlug("hiq:basketball:201:panini-immaculate:ss-jwt:base:auto", 201, 2019))
      .toBe("hiq:basketball:2019:panini-immaculate:ss-jwt:base:auto");
  });

  it("returns null for a row whose slug carries no year segment -- that row is a PATCH", () => {
    expect(R.rekeySlug(null, 201, 2016)).toBeNull();
    expect(R.rekeySlug("", 201, 2016)).toBeNull();
  });

  it("only rewrites the YEAR position, never a matching segment elsewhere", () => {
    // A card number that happens to equal the truncated year must not move.
    expect(R.rekeySlug("hiq:football:2016:donruss:201:base:no-auto", 201, 2016)).toBeNull();
  });

  it("refuses a slug whose year position does not hold the stored year", () => {
    expect(R.rekeySlug("hiq:football:1978:donruss:372:base:no-auto", 201, 2016)).toBeNull();
  });
});

describe("the scoped query names its source", () => {
  it("binds source as a parameter and bounds the year range", () => {
    const spec = R.querySpec();
    expect(spec.parameters.map((p: { name: string }) => p.name)).toEqual(["@src"]);
    expect(spec.query).toContain("c.cardYear >= 100");
    expect(spec.query).toContain("c.cardYear <= 999");
    expect(spec.query).toContain("c.source = @src");
  });
});

describe("reconcile partitions every row examined", () => {
  it("balances on the measured population", () => {
    const r = R.reconcile("j", { candidates: 2980, written: 2980, skipped: 0, failed: 0, notReached: 0 });
    expect(r.balances).toBe(true);
    expect(r.intended).toBe(2980);
  });

  it("does not balance when rows go unaccounted for", () => {
    expect(R.reconcile("j", { candidates: 2980, written: 2523, skipped: 0, failed: 0 }).balances).toBe(false);
  });
});
