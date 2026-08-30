/**
 * CF-A-CARD-NUMBER-IS-NOT-A-RUNG (D33, Drew 2026-08-30, "still a mess" on
 * 2020 Bowman Draft BD-152).
 *
 * The Parallels section of a baseballcardpedia set page contains CARD LISTS as
 * well as rungs, and the scraper had two defences against reading a card line
 * as a parallel. Both were NUMBER-PREFIX-BLIND, so both missed the spelling the
 * page actually uses:
 *
 *   CARD_NUM.test(name.split(" ")[0])   -- "BD 121 Spencer Torkelson" splits to
 *                                          "BD", which is not a card number
 *   playerNames.has(foldName(name))     -- the roster set holds "spencer
 *                                          torkelson" (parseCards' player field
 *                                          is the name AFTER the number), so it
 *                                          never equals "bd 121 spencer
 *                                          torkelson"
 *
 * The result was 47,267 catalog rows whose "parallel" is another card
 * (baseballcardpedia 28,776 + baseballcardpedia-graded 18,491, 2,234 distinct
 * cards), measured read-only 2026-08-30.
 *
 * These tests pin BOTH halves and, critically, pin the rungs that must still be
 * ACCEPTED -- a guard that rejects "Sky Blue" because it starts with a short
 * word would be the same class of bug pointed the other way.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { leadingCardNumber, foldRoster, foldName, parseLadder } = require("../scripts/scrape-bcp-ladders.cjs");

/** The guard as parseLadder applies it: the original first-token test OR the new one. */
const CARD_NUM = /^([A-Z]{0,4}-?\d+[a-z]?|[A-Z0-9]{1,6}-[A-Z0-9]{1,6})$/i;
const rejectsAsCardLine = (name: string): boolean =>
  CARD_NUM.test(name.split(" ")[0]) || Boolean(leadingCardNumber(name));

describe("a card line is refused as a rung, in BOTH of the page's spellings", () => {
  it.each([
    // The space form -- what baseballcardpedia actually writes, and the one
    // the old guard could not see.
    "BD 121 Spencer Torkelson",
    "Bd 152 Bobby Witt, Jr.",
    "BDC 152 Bobby Witt",
    "BCP 66 Jesus Made",
    "BP 41 Eric Brown",
    "BD 107 Zac Veen",
    "BD 154 Adley Rutschman",
    // The hyphen form, already handled -- pinned so the fix cannot regress it.
    "BD-121 Spencer Torkelson",
    "BDC-152 Bobby Witt",
    // Bare numeric base-set lines.
    "1 Juan Soto",
    "107 Zac Veen",
  ])("refuses %j", (line) => {
    expect(rejectsAsCardLine(line)).toBe(true);
  });

  it.each([
    // Real rungs of the 2020 Bowman Draft ladders, paper and chrome.
    "Gold Refractor",
    "Blue Wave",
    "Sky Blue",
    "Padparadscha",
    "SuperFractor",
    "Printing Plates",
    "Sapphire Edition",
    "Black",
    "Red Refractor",
    "1st Edition Blue",
    "Aqua Sapphire",
    "Orange",
    "Green Refractor",
    "Gold Wave",
    "Black Wave",
    "Royal Blue",
    "Sparkle Refractor",
    "Chrome",
  ])("still accepts the real rung %j", (rung) => {
    expect(rejectsAsCardLine(rung)).toBe(false);
  });

  it("requires digits after the alpha prefix, so a two-word colour is not a number", () => {
    // "Sky" is a 3-letter token like "BD" -- what separates them is the digits.
    expect(leadingCardNumber("Sky Blue")).toBe("");
    expect(leadingCardNumber("BD 121 Spencer Torkelson")).toBe("BD 121");
  });

  it("MUTATION CHECK: the old first-token-only guard lets every space form back in", () => {
    // Reverting to `CARD_NUM.test(name.split(" ")[0])` alone must reopen the
    // hole, or these tests would pass without the fix doing anything.
    const oldGuard = (name: string) => CARD_NUM.test(name.split(" ")[0]);
    for (const line of ["BD 121 Spencer Torkelson", "Bd 152 Bobby Witt, Jr.", "BDC 152 Bobby Witt", "BCP 66 Jesus Made"]) {
      expect(oldGuard(line)).toBe(false);          // the bug, reproduced
      expect(rejectsAsCardLine(line)).toBe(true);  // the fix, closing it
    }
  });
});

describe("the roster set is number-blind", () => {
  it("folds a numbered card line onto the base list's bare player name", () => {
    // parseCards puts "Spencer Torkelson" in the roster set; the candidate
    // arrives numbered. They must meet.
    expect(foldRoster("BD 121 Spencer Torkelson")).toBe(foldName("Spencer Torkelson"));
    expect(foldRoster("BD-121 Spencer Torkelson")).toBe(foldName("Spencer Torkelson"));
    expect(foldRoster("Bd 152 Bobby Witt, Jr.")).toBe(foldName("Bobby Witt, Jr."));
  });

  it("leaves an un-numbered rung name alone, so a rung is never folded to a roster key", () => {
    expect(foldRoster("Gold Refractor")).toBe("gold refractor");
    expect(foldRoster("Sky Blue")).toBe("sky blue");
  });

  it("parseLadder refuses the numbered roster line and counts it", () => {
    const roster = new Set<string>([foldName("Spencer Torkelson")]);
    const body = "<li>BD 121 Spencer Torkelson</li><li>Gold Refractor (numbered to 50 copies)</li>";
    const rungs = parseLadder(body, roster);
    expect(rungs.map((r: { name: string }) => r.name)).toEqual(["Gold Refractor"]);
    // The card line was refused by the card-line guard before the roster set
    // saw it, which is the cheaper of the two defences; either way it is gone.
    expect(rungs.some((r: { name: string }) => /spencer/i.test(r.name))).toBe(false);
  });

  it("MUTATION CHECK: the un-stripped fold never matches a numbered roster line", () => {
    // foldName alone -- the pre-fix roster comparison -- cannot see it.
    expect(foldName("BD 121 Spencer Torkelson")).not.toBe(foldName("Spencer Torkelson"));
    expect(foldRoster("BD 121 Spencer Torkelson")).toBe(foldName("Spencer Torkelson"));
  });
});

describe("parseLadder end to end on the shape that minted the 47,267 rows", () => {
  it("reads a Parallels section that mixes rungs with the page's card list", () => {
    const body = [
      "<li>Sky Blue (numbered to 499 copies)</li>",
      "<li>Gold (numbered to 50 copies)</li>",
      "<li>BD 121 Spencer Torkelson</li>",
      "<li>BD 152 Bobby Witt, Jr.</li>",
      "<li>BD 154 Adley Rutschman</li>",
      "<li>Orange (numbered to 25 copies)</li>",
    ].join("");
    const rungs = parseLadder(body, new Set<string>());
    expect(rungs.map((r: { name: string }) => r.name).sort()).toEqual(["Gold", "Orange", "Sky Blue"]);
    expect(rungs.map((r: { printRun: number | null }) => r.printRun).sort((a: number, b: number) => a - b)).toEqual([25, 50, 499]);
  });
});
