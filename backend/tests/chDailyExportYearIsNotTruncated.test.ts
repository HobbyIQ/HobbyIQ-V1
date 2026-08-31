/**
 * CF-A-THREE-DIGIT-YEAR-IS-A-TRUNCATED-ONE (2026-08-31).
 *
 * 2,980 sold_comps rows carry a 3-digit cardYear -- 201:1234, 197:947,
 * 198:458, 202:163, 199:143, 200:35 -- every one the real year with its last
 * digit gone. The value arrives truncated FROM THE VENDOR (all other fields on
 * the row are intact, so it is not a column shift), consistently per card_id.
 * `card_set` is the evidence that survives, and these tests pin the guard that
 * reconciles against it.
 *
 * The important half of this file is what the guard REFUSES: it corrects one
 * exact signature and leaves everything else alone. A guard that rewrote any
 * 3-digit year to whatever year the set name mentioned would be a worse bug
 * than the one it fixes.
 */
import { describe, expect, it } from "vitest";
import { coerceRow, reconcileYear } from "../src/services/compiq/cardhedgeDailyExport.client";

describe("reconcileYear repairs the truncation signature", () => {
  it.each([
    // The real rows, measured 2026-08-31.
    [201, "2016 Panini Donruss Football", 2016],
    [197, "1978 Kellogg's 3-D Super Stars Baseball", 1978],
    [201, "2017 Topps Heritage Minor League Baseball", 2017],
    [199, "1996 Skybox Impact Rookies Football", 1996],
    [198, "1986 Topps Baseball", 1986],
    [202, "2021 Panini Prizm Basketball", 2021],
    [200, "2005 Bowman Chrome Baseball", 2005],
  ])("year %i with set %j becomes %i", (stored, cardSet, expected) => {
    expect(reconcileYear(stored, cardSet)).toBe(expected);
  });
});

describe("what the guard refuses to touch", () => {
  it("leaves a healthy 4-digit year alone even when card_set disagrees", () => {
    // Which of two sources is right is a DIFFERENT question. Answering it here
    // would let a set-name typo overwrite good data.
    expect(reconcileYear(2016, "2017 Topps Baseball")).toBe(2016);
    expect(reconcileYear(1978, "1978 Topps Baseball")).toBe(1978);
  });

  it("leaves a 3-digit year alone when the set name states no year", () => {
    expect(reconcileYear(201, "Panini Donruss Football")).toBe(201);
    expect(reconcileYear(197, "")).toBe(197);
  });

  it("leaves a 3-digit year alone when it is NOT a prefix of the stated year", () => {
    // 198 is not a prefix of 2016 -- this row's defect is something else, and
    // guessing would file it under a year nothing supports.
    expect(reconcileYear(198, "2016 Panini Donruss Football")).toBe(198);
    expect(reconcileYear(201, "1978 Kellogg's Baseball")).toBe(201);
  });

  it("does not invent a year from a print run or a card number in the set name", () => {
    // "3-D" and "/499" are not years, and the year pattern only matches
    // 18xx/19xx/20xx on a word boundary.
    expect(reconcileYear(499, "Kellogg's 3-D Super Stars Baseball")).toBe(499);
    expect(reconcileYear(150, "Topps Chrome Refractor /150")).toBe(150);
  });

  it("leaves 0 (the unparseable fallback) alone rather than filling it in", () => {
    // Blank means unknown. A row whose year did not parse must not acquire one
    // from the set name here -- that is the ingest's own decision to make.
    expect(reconcileYear(0, "2016 Panini Donruss Football")).toBe(0);
  });
});

describe("coerceRow applies the guard on the real row shape", () => {
  const row = (over: Record<string, string>) => ({
    price_history_id: "ph-1",
    card_id: "1692924429400x291191114313498600",
    source: "ebay",
    description: "",
    price: "12.00",
    listing_url: "",
    image_url: "",
    pop: "0",
    sale_date: "2026-07-21T02:55:00+00:00",
    sale_type: "sold",
    card_description: "",
    number: "372",
    player: "Jared Goff",
    grade: "Raw",
    grader: "Raw",
    group: "Football",
    card_set: "2016 Panini Donruss Football",
    card_set_type: "Panini Donruss Football",
    variant: "Base",
    year: "201",
    created_at: "",
    updated_at: "",
    ...over,
  });

  it("the truncated year is repaired end to end", () => {
    expect(coerceRow(row({})).year).toBe(2016);
  });

  it("a healthy row is untouched, and nothing else on it moves", () => {
    const out = coerceRow(row({ year: "2016" }));
    expect(out.year).toBe(2016);
    expect(out.card_set).toBe("2016 Panini Donruss Football");
    expect(out.number).toBe("372");
    expect(out.player).toBe("Jared Goff");
    expect(out.group).toBe("Football");
  });

  it("MUTATION CHECK: passing year straight through reopens the defect", () => {
    // If `year: toInt(record.year)` came back, this row would import as 201.
    // That is exactly the 2,980-row population this PR repairs.
    const naive = Number.parseInt(row({}).year, 10);
    expect(naive).toBe(201);
    expect(coerceRow(row({})).year).not.toBe(naive);
  });
});
