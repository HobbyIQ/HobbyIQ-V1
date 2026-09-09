/**
 * CF-A-CARD-LINE-IS-NOT-A-RUNG-IN-A-HEADING-EITHER (#2023, Drew 2026-09-09).
 *
 * baseballcardpedia's Parallels section is read by TWO loops: one over <h3>/<h4>
 * subsection headings, and one over <li> list items. Since D33 the <li> loop has
 * refused CARD LINES -- "BD 121 Spencer Torkelson" is a card, not a parallel --
 * but the HEADING loop never asked the same question.
 *
 * BCP builds a heading id by replacing spaces with underscores, so a subsection
 * whose heading is a card line arrives at the heading loop as an ordinary rung
 * name ("BDP175_Colby_Rasmus_AU_RC" -> "BDP175 Colby Rasmus AU RC") and became a
 * PARALLEL of every base card on the page. On 2005 Bowman Draft Picks &
 * Prospects that minted 682 live catalog rows whose `parallel` is another card
 * -- a Verlander BDP129 row whose parallel reads "BDP175 Colby Rasmus AU RC" --
 * and 57,803 such rows across 36 (year, setKey) pairs in total, measured
 * read-only 2026-09-09.
 *
 * These tests pin BOTH directions. A guard that merely rejected leading digits
 * would delete real rungs ("582 Montgomery Club", "20 in '20"), which is the
 * same class of defect pointed the other way, so the ACCEPT half is as
 * load-bearing as the REFUSE half.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseLadder, isCardLine } = require("../scripts/scrape-bcp-ladders.cjs");

/** A Parallels body whose only rung candidate is one <h3> heading. */
const headingBody = (heading: string): string =>
  `<h2 id="Parallels">x</h2><h3 id="${heading.replace(/ /g, "_")}">y</h3>` +
  `<p>serial-numbered to 50 copies</p>`;

const rungNames = (body: string): string[] =>
  parseLadder(body, new Set()).map((r: { name: string }) => r.name);

describe("a card line in a HEADING is refused as a rung", () => {
  it.each([
    // The 15 First-Year Player Autograph lines off the live 2005 Bowman Draft
    // page -- the rows the census counted.
    "BDP175 Colby Rasmus AU RC",
    "BDP166 Stephen Drew AU RC",
    "BDP172 Jacoby Ellsbury AU RC",
    "BDP178 Ryan Zimmerman AU RC",
    // The space and hyphen spellings the <li> loop already refuses.
    "BD 121 Spencer Torkelson",
    "BD-152 Bobby Witt",
    // Bare-numeric roster lines off the other affected products.
    "32 Sammy Sosa",
    "1 Chipper Jones",
    "139 Rafael Palmeiro 52",
  ])("refuses %s", (heading) => {
    expect(rungNames(headingBody(heading))).toEqual([]);
  });
});

describe("a real rung in a heading is still ACCEPTED", () => {
  it.each([
    // Ordinary finish rungs.
    "Gold Refractor",
    "Blue Refractor",
    "SuperFractor",
    "Printing Plates",
    "Sky Blue",
    "Players Choice",
    "Jumbos",
    // Number-led rungs that must survive: a year lead and a stop-word tail are
    // exactly what isCardLine's own arms exist to let through.
    "1990 Bowman",
    "582 Montgomery Club",
  ])("accepts %s", (heading) => {
    expect(rungNames(headingBody(heading))).toEqual([heading]);
  });
});

describe("the guard is the SAME predicate the <li> loop uses", () => {
  // If the two loops ever disagree about what a card line is, one of them is
  // minting the rows the other refuses. Pin the shared predicate directly.
  it("isCardLine agrees with the heading loop on every case above", () => {
    for (const line of ["BDP175 Colby Rasmus AU RC", "BD 121 Spencer Torkelson", "32 Sammy Sosa"]) {
      expect(isCardLine(line)).toBe(true);
      expect(rungNames(headingBody(line))).toEqual([]);
    }
    for (const rung of ["Gold Refractor", "1990 Bowman", "Sky Blue"]) {
      expect(isCardLine(rung)).toBe(false);
      expect(rungNames(headingBody(rung))).toEqual([rung]);
    }
  });
});

describe("the live 2005 Bowman Draft shape", () => {
  // The page nests <h3 id="Chrome"> under the Parallels <h2>, and the Chrome
  // scope nests <h4 id="First-Year_Player_Autographs"> whose body is 15 card
  // lines. The Chrome finish rungs are real and must survive; not one of the
  // autograph card lines may become a parallel.
  const body =
    `<h2 id="Parallels">p</h2>` +
    `<ul><li>Gold (serial-numbered to 50 copies)</li></ul>` +
    `<h3 id="Chrome">c</h3>` +
    `<ul><li>Refractor (serial-numbered to 500 copies)</li>` +
    `<li>Blue Refractor (serial-numbered to 150 copies)</li></ul>` +
    `<h4 id="BDP175_Colby_Rasmus_AU_RC">a</h4>` +
    `<h4 id="BDP166_Stephen_Drew_AU_RC">a</h4>`;

  it("keeps the finish rungs and drops every card line", () => {
    const names = rungNames(body);
    expect(names).toContain("Gold");
    expect(names).toContain("Refractor");
    expect(names).toContain("Blue Refractor");
    expect(names.some((n: string) => /^BDP\d/.test(n))).toBe(false);
  });
});

describe("CF-A-NAMED-SET-IS-NOT-A-CARD-LINE (the accept half, #2023)", () => {
  // "582 Montgomery Club" is a real <h3> parallel on the live 2024 Topps page
  // (the factory-set foilboard run) carrying 700 catalog rows the census
  // confirmed are NOT damage. It has a card line's exact shape -- a number then
  // two capitalised words -- and only its TAIL tells it apart: a card line ends
  // in a PERSON, a named set ends in a set/product noun. Without this arm the
  // heading guard deletes a real product.
  it.each([
    "582 Montgomery Club",
    "100 Card Set",
    "1 Chrome Edition",
    "50 Holiday Foilboard",
  ])("does not read %s as a card line", (name) => {
    expect(isCardLine(name)).toBe(false);
    expect(rungNames(headingBody(name))).toEqual([name]);
  });

  it("still reads a real card line as one when the tail is a PERSON", () => {
    // The mirror image: the set-tail vocabulary must not swallow a surname.
    for (const line of ["32 Sammy Sosa", "1 Chipper Jones", "BDP175 Colby Rasmus AU RC"]) {
      expect(isCardLine(line)).toBe(true);
    }
  });
});
