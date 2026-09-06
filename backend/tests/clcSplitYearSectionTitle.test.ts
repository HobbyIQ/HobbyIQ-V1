/**
 * CF-A-SPLIT-YEAR-IS-STILL-A-YEAR (2026-09-06, run 33997480307).
 *
 * The clc cleanliness gate refused two soccer pages of that run for "N rows
 * whose parallel is a card line":
 *
 *   2020-21 topps chrome uefa champions league soccer   20 rows
 *   2020-21 topps stadium club chrome uefa soccer        6 rows
 *
 * The gate was right and the converter was wrong. A checklistcenter section
 * head states the product before the subset, and `plainTitle` removed the
 * product with two strips that BOTH assume a four-digit year followed by a
 * space:
 *
 *   a leading "four digits then whitespace" strip -- "2020-21 " has a hyphen,
 *     not whitespace, after the year, so nothing is removed;
 *   a "everything up to the first hyphen" strip -- that hyphen is now the one
 *     INSIDE "2020-21", so it removes "2020-" and leaves the product standing.
 *
 * so the season-spanning titles every hockey and soccer product carries came
 * out as "21 Topps Stadium Club Chrome UEFA - Base Rookie Image Variations",
 * which was then read as the subset's variation finish and emitted as the
 * PARALLEL of every card in it. "21 Topps ..." matches the gate's card-line
 * test `^\d+\s+[A-Za-z]` for the obvious reason: it begins with a number and a
 * word, exactly like "21 Curtis Jones".
 *
 * These pin the unit and the page. The fixture is trimmed verbatim from the
 * refused Stadium Club page.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(__filename);
const conv = require_(path.join(__dirname, "..", "scripts", "convertChecklistCenterToChecklistCsv.cjs"));
const { sectionTitleWithoutProduct, convertHtml } = conv;

/** The gate's own test, copied so a change to either side shows up here. */
const CARD_LINE = /^\d+[a-z]?\s+[A-Za-z]/;

const FIXTURE = path.join(__dirname, "fixtures", "clc", "2020-21-topps-stadium-club-chrome-uefa.split-year-variation.html");

describe("clc section titles: a split year is still a year", () => {
  it("strips a split-year product prefix, leaving only the subset", () => {
    expect(sectionTitleWithoutProduct("2020-21 Topps Stadium Club Chrome UEFA - Base Rookie Image Variations Set"))
      .toBe("Base Rookie Image Variations");
    expect(sectionTitleWithoutProduct("2020-21 Topps Chrome UEFA - Base Image Variations Set"))
      .toBe("Base Image Variations");
    expect(sectionTitleWithoutProduct("2021-22 Topps Chrome Bundesliga - Base Set")).toBe("Base");
  });

  it("still strips a four-digit year, the shape that always worked", () => {
    expect(sectionTitleWithoutProduct("2020 Topps Chrome - Base Image Variation Set")).toBe("Base Image Variation");
    expect(sectionTitleWithoutProduct("2024 Topps Series 1 - Base Set")).toBe("Base");
  });

  it("never leaves a leading number, which is what the gate refused", () => {
    for (const t of [
      "2020-21 Topps Stadium Club Chrome UEFA - Base Rookie Image Variations Set",
      "2020-21 Topps Chrome UEFA - Base Image Variations Set",
      "2021-22 Topps Chrome Bundesliga - Base Set",
      "2019-20 Upper Deck - Young Guns Set",
    ]) {
      expect(CARD_LINE.test(sectionTitleWithoutProduct(t))).toBe(false);
    }
  });

  it("keeps a hyphen that lives inside a token", () => {
    // " - " is the product/subset separator; a bare "-" is part of the word.
    expect(sectionTitleWithoutProduct("2020-21 Topps Chrome - Mini-Diamond Parallels"))
      .toBe("Mini-Diamond Parallels");
    // No separator at all: the title is already the subset, and keeps every word.
    expect(sectionTitleWithoutProduct("Base Image Variations")).toBe("Base Image Variations");
    expect(sectionTitleWithoutProduct("X-Fractor Autographs")).toBe("X-Fractor Autographs");
  });

  it("converts the refused page with no card line standing as a parallel", () => {
    const out = convertHtml(fs.readFileSync(FIXTURE, "utf8"), {
      productName: "2020-21 Topps Stadium Club Chrome UEFA Soccer",
      url: "https://www.checklistcenter.com/2020-21-topps-stadium-club-chrome-uefa-soccer-card-checklist/",
      year: 2020,
      sourceSlug: "2020-21-topps-stadium-club-chrome-uefa-soccer",
    });
    expect(out).not.toBeNull();
    const parallels = out.rows.map((r: string[]) => String(r[2] ?? ""));
    expect(parallels.filter((p: string) => CARD_LINE.test(p))).toEqual([]);

    // And the variation is NAMED, on the base card it varies -- not the page
    // title, and not blank (which would mint the plain card's own id).
    const variation = out.rows.filter((r: string[]) => /variation/i.test(String(r[2] ?? "")));
    expect(variation.length).toBeGreaterThan(0);
    expect([...new Set(variation.map((r: string[]) => r[2]))].sort())
      .toEqual(["Rookie Image Variation", "Rookie Image Variation SuperFractor"]);
    expect([...new Set(variation.map((r: string[]) => r[0]))]).toEqual(["base"]);
  });
});
