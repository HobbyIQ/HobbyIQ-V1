import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { baseCards, classifyUnreadableBody, SHAPE_NOTE, section, checklistSection } =
  require(path.join(__dirname, "..", "scripts", "scrape-bcp-ladders.cjs"));

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, "fixtures", "bcp", n), "utf8");

/**
 * CF-A-CHECKLIST-WITHOUT-CARD-NUMBERS-IS-NOT-A-PARSER-GAP (2026-09-04).
 *
 * All four pages are REAL, fetched live from baseballcardpedia on 2026-09-04
 * and trimmed to the Checklist span the parser reads. All four were verdicted
 *
 *   FAILED — bcp page carries a checklist our parser does not read
 *            (no Base_Set heading) — a parser gap, not an empty page
 *
 * and 62 control docs carried that message. #1732/#1738/#1762 each closed a
 * REAL layout gap behind it. This population is not one: the wiki publishes
 * these pages with NO CARD NUMBERS, and the catalog keys a card by its
 * cardNumber. There is nothing here a parser could read, only numbers we
 * would have to invent.
 */
describe("bcp — a checklist with no card numbers", () => {
  it("1999 Team Best Autographs: 70 bare player names, and NOT one card", () => {
    const html = fixture("1999-team-best-autographs.unnumbered-roster.html");
    // The rows really are on the page -- this is not a fetch or a heading
    // problem -- and every one of them is a name with no number in front.
    expect(checklistSection(html)).toMatch(/Rick Ankiel/);
    expect(baseCards(html).cards).toEqual([]);

    const shape = classifyUnreadableBody(html);
    expect(shape).toEqual({ shape: "unnumbered-roster", lines: 70 });
  });

  it("2013 Bowman Blue Sapphire: a Base_Set heading IS found, and still has no numbers", () => {
    const html = fixture("2013-bowman-blue-sapphire.unnumbered-roster.html");
    // Distinct from #1732/#1738: the heading is not the problem here. The h2
    // slice is found and read; the lines inside it carry no card number.
    expect(section(html, "Base_Set", 2).length).toBeGreaterThan(3000);
    expect(baseCards(html).cards).toEqual([]);
    expect(classifyUnreadableBody(html)).toEqual({ shape: "unnumbered-roster", lines: 64 });
  });

  it("2010 SP Authentic: a full heading tree with no checklist under it is a STUB", () => {
    const html = fixture("2010-sp-authentic.stub.html");
    // Base_Set, Parallels, Inserts and eight h3s all exist...
    expect(section(html, "Base_Set", 2)).toMatch(/Future_Watch/);
    // ...and there is not a single list item anywhere in the checklist body.
    expect(checklistSection(html)).not.toMatch(/<li>/);
    expect(classifyUnreadableBody(html)).toEqual({ shape: "stub", lines: 0 });
  });

  it("2004-05 Speed Stick: a one-card promo page is not a set", () => {
    const html = fixture("2004-05-speed-stick.single-card.html");
    // The sole line is "Alex Rodriguez 100" -- a name and a print run, with no
    // card number anywhere, so it is a promo page rather than a checklist.
    expect(classifyUnreadableBody(html)).toEqual({ shape: "single-card", lines: 1 });
  });

  // ── the safety property ───────────────────────────────────────────────────
  //
  // The classifier decides whether a page is OUR defect or the source's
  // silence. If it can fire on a page that parses, it can bury a real gap.

  it("a page whose h2 Base_Set slice is EMPTY but which parses 515 cards is not a stub", () => {
    // THE trap, and the reason classifyUnreadableBody asks baseCards first.
    // 2016 Topps Sapphire has an h2 Base_Set heading holding 798 chars and
    // ZERO <li>; all 515 of its cards come from the h1 Checklist fallback. A
    // classifier that chose its own slice would see an empty Base_Set and
    // report "stub" for a page we read perfectly, burying 515 real cards.
    const html = fixture("2016-topps-sapphire.base-set-heading-is-empty.html");
    expect(section(html, "Base_Set", 2).length).toBeGreaterThan(700);
    expect([...section(html, "Base_Set", 2).matchAll(/<li>/g)]).toHaveLength(0);
    expect(baseCards(html).cards.length).toBe(515);
    expect(classifyUnreadableBody(html)).toBe(null);
  });

  it("NEVER contradicts a successful parse — every page that parses classifies null", () => {
    // 2016 Topps Sapphire is the trap this rule exists for: its h2 Base_Set
    // slice holds 798 chars and ZERO <li> (the 515 cards come from the h1
    // Checklist fallback), so a classifier that picked its own slice would
    // call a perfectly readable page a stub.
    for (const f of ["2005-topps-chrome.trimmed.html", "2011-topps-chrome.trimmed.html",
      "2022-topps-chrome.trimmed.html", "2009-bowman-chrome.demoted-heading.html",
      "2004-bowmans-best.initials-numbers.html", "1990-bazooka.trimmed.html",
      "2016-topps-sapphire.base-set-heading-is-empty.html"]) {
      const html = fixture(f);
      expect(baseCards(html).cards.length).toBeGreaterThan(0);
      expect(classifyUnreadableBody(html)).toBe(null);
    }
  });

  it("a numbered line anywhere means it is a PARSER GAP, and stays one", () => {
    // A line with a card number is positive evidence the page DOES number its
    // cards, so whatever stopped us reading them is ours to fix. Every real
    // numbering style must refuse, not just the bare-digit one.
    for (const numbered of ["1 Juan Soto", "24 Ken Griffey", "US150 Mike Trout", "BD-72 Juan Soto"]) {
      const body = "<h1 id=\"Checklist\">x</h1>"
        + ["Mike Trout", "Aaron Judge", numbered].map((n) => `<li>${n}</li>`).join("");
      expect(classifyUnreadableBody(body)).toBe(null);
    }
  });

  it("a line that is not a person name refuses too", () => {
    // An unrecognised layout must keep the parser-gap verdict, not become
    // "the source has nothing".
    const body = "<h1 id=\"Checklist\">x</h1>"
      + ["Mike Trout", "Gold Refractor /50", "Aaron Judge"].map((n) => `<li>${n}</li>`).join("");
    expect(classifyUnreadableBody(body)).toBe(null);
  });

  it("each shape has its OWN wording, so a control doc says which", () => {
    // The driver matches these three strings. One catch-all would map an
    // unclassified shape to EMPTY by accident.
    const notes = Object.values(SHAPE_NOTE) as string[];
    expect(new Set(notes).size).toBe(3);
    expect(SHAPE_NOTE["unnumbered-roster"]).toMatch(/UNNUMBERED ROSTER/);
    expect(SHAPE_NOTE["stub"]).toMatch(/STUB/);
    expect(SHAPE_NOTE["single-card"]).toMatch(/SINGLE-CARD/);
  });
});
