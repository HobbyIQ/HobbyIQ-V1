/**
 * CF-KEYMAN-IS-THE-VINTAGE-SOURCE (Drew, 2026-08-26).
 *
 * keymancollectibles is the first AUTOMATED vintage checklist source we have —
 * everything else is modern-only, and Beckett is one XLSX at a time.
 *
 * This parser failed three separate ways before it worked, and every one of
 * them reported as "the source published nothing" rather than "we read it
 * wrong":
 *
 *   1. the link filter matched card IMAGES in the same directory
 *   2. the checklist is a TABLE — number and player are separate <td> cells,
 *      so stripping tags to lines split every row in half
 *   3. the cells are not even adjacent: a tick-box column and a spacer column
 *      sit between the number and the name
 *
 * A scraper that yields zero rows looks exactly like a site with no checklist.
 * These pin the real markup so that silence has to be real.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cells, rowsFromCells, IS_NUM } = require("../scripts/scrape-keymancollectibles.cjs");

/** The real 1952 Topps row markup, reduced. Note the checkbox and spacer cells. */
const ROW_HTML = `
<table border="0" cellpadding="0" cellspacing="0" width="750">
  <tr>
    <td width="30"><p align="right"><font face="Verdana" size="2">1</font></td>
    <td width="20"><p align="center"><input type="checkbox" value="ON"></td>
    <td width="300"><font face="Verdana" size="2"> Andy Pafko</font></td>
    <td width="50"></td>
    <td width="31"><p align="right"><font face="Verdana" size="2">41</font></td>
    <td width="20"><p align="center"><input type="checkbox" value="ON"></td>
    <td width="300"><font face="Verdana" size="2"> Bob Wellman</font></td>
    <td width="50"></td>
  </tr>
  <tr>
    <td width="30"><p align="right"><font face="Verdana" size="2">2</font></td>
    <td width="20"><p align="center"><input type="checkbox" value="ON"></td>
    <td width="300"><font face="Verdana" size="2"> Pete Runnels RC</font></td>
    <td width="50"></td>
    <td width="31"><p align="right"><font face="Verdana" size="2">20</font></td>
    <td width="20"><p align="center"><input type="checkbox" value="ON"></td>
    <td width="300"><font face="Verdana" size="2"> Billy Loes RC SP</font></td>
    <td width="50"></td>
  </tr>
</table>`;

describe("the checklist is a table, not lines of text", () => {
  it("pulls the cells out in document order", () => {
    const c = cells(ROW_HTML);
    expect(c.slice(0, 4)).toEqual(["1", "", "Andy Pafko", ""]);
  });

  it("pairs a number with its player across the blank cells between them", () => {
    // The bug: demanding cells[i+1] finds the tick-box cell, matches nothing,
    // and reports the page as empty.
    const rows = rowsFromCells(cells(ROW_HTML));
    expect(rows).toHaveLength(4);
    expect(rows.map((r: { cardNumber: string }) => r.cardNumber)).toEqual(["1", "41", "2", "20"]);
  });

  it("reads both columns of a two-column layout", () => {
    const rows = rowsFromCells(cells(ROW_HTML));
    const byNum = Object.fromEntries(rows.map((r: { cardNumber: string; player: string }) => [r.cardNumber, r.player]));
    expect(byNum["1"]).toBe("Andy Pafko");
    expect(byNum["41"]).toBe("Bob Wellman");
  });
});

describe("site flags belong on the row, not in the player's name", () => {
  it("strips RC and SP so the slug is not pete-runnels-rc", () => {
    const rows = rowsFromCells(cells(ROW_HTML));
    const byNum = Object.fromEntries(rows.map((r: { cardNumber: string; player: string }) => [r.cardNumber, r.player]));
    expect(byNum["2"]).toBe("Pete Runnels");
    expect(byNum["20"]).toBe("Billy Loes");
  });

  it("keeps rookie as a flag rather than discarding it", () => {
    const rows = rowsFromCells(cells(ROW_HTML));
    const two = rows.find((r: { cardNumber: string }) => r.cardNumber === "2");
    expect(two.isRookie).toBe(true);
    const one = rows.find((r: { cardNumber: string }) => r.cardNumber === "1");
    expect(one.isRookie).toBe(false);
  });
});

describe("what counts as a card number", () => {
  it("accepts plain and suffixed numbers", () => {
    expect(IS_NUM("1")).toBe(true);
    expect(IS_NUM("407")).toBe(true);
    expect(IS_NUM("311a")).toBe(true);
  });

  it("rejects prose, so page furniture cannot become a card", () => {
    for (const s of ["Cards", "1-80", "KeyManCollectibles.com", ""]) {
      expect(IS_NUM(s), `${s} should not be a card number`).toBe(false);
    }
  });

  it("does not pair two numbers together", () => {
    // "Cards 1-80" style layout cells must not produce a card called "80".
    const rows = rowsFromCells(["1", "", "41", "", "Andy Pafko", ""]);
    expect(rows.every((r: { player: string }) => /[A-Za-z]/.test(r.player))).toBe(true);
  });
});
