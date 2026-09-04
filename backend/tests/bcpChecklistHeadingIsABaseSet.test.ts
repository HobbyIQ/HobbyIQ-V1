import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * CF-THE-CHECKLIST-HEADING-IS-A-BASE-SET (2026-09-04).
 *
 * Backfill Runner 33852199385 verdicted six 1990 pages "bcp scrape produced no
 * CSV". #1729 classified that message as a PARSER GAP rather than an empty
 * page, on the evidence that the rows were visibly on the pages. This is the
 * gap itself.
 *
 * Every BCP page carries an `<h1 id="Checklist">`. On a page with parallels the
 * cards live one level down, under an `<h2 id="Base_Set">`, which is the only
 * heading `parseCards` was ever given:
 *
 *   1990_Baseball_Wit    <h1 Checklist> <h2 Base_Set> 109 cards   <- read
 *   1990_Bazooka         <h1 Checklist> 22 cards                  <- missed
 *
 * The 1990 boxed and retail sets have no parallels, so they have no `Base_Set`
 * subheading and their cards sit directly under the h1. Nothing was wrong with
 * `parseCards` -- it parses both bodies identically. Only the slice was absent.
 *
 * Measured over the lane (40 base-only entries sampled across every decade,
 * fetched live 2026-09-04, zero fetch errors): 26 carry `Base_Set` and were
 * already read; **14 of 40 (35%)** are h1-Checklist-only. Against the 1,873
 * base-only bcp entries that is on the order of 650 pages this unlocks.
 *
 * The ordering is the safety property, and the last two pins hold it:
 * `Base_Set` is tried first and wins wherever it exists, so every page that
 * parsed before parses identically. Only a page that yielded ZERO base cards
 * consults the fallback -- exactly the population that used to be refused.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
// `baseCards` is THE function the page loop calls, not a re-implementation of
// it: a pin that recreated the Base_Set-then-Checklist precedence in this file
// would still pass with the fallback deleted from the scraper.
const { section, parseCards, checklistSection, baseCards: baseCardsFor } = require_(
  path.join(backend, "scripts", "scrape-bcp-ladders.cjs"),
);

const fixture = (n: string) =>
  fs.readFileSync(path.join(backend, "tests", "fixtures", "bcp", `${n}.trimmed.html`), "utf8");

// ── PIN 1: the four pages the incident refused now read ──────────────────────

describe("bcp — a page whose cards sit under the h1 Checklist heading is read", () => {
  // Card counts verified against the live pages on 2026-09-04.
  const cases: Array<[string, number]> = [
    ["1990-bazooka", 22],
    ["1990-fleer-award-winners", 44],
    ["1990-donruss-learning-series", 55],
    ["1990-fleer-baseball-all-stars", 44],
  ];

  for (const [name, count] of cases) {
    it(`${name}: has NO Base_Set heading, and its cards are found anyway`, () => {
      const html = fixture(name);
      // The precondition -- this is why the page was refused.
      expect(html).not.toMatch(/<h2 id="Base_Set"/);
      expect(html).toMatch(/<h1 id="Checklist"/);
      expect(parseCards(section(html, "Base_Set", 2))).toHaveLength(0);

      const { cards, viaChecklistHeading } = baseCardsFor(html);
      expect(viaChecklistHeading).toBe(true);
      expect(cards).toHaveLength(count);
    });
  }

  it("the rows carry the same contract as any other base card", () => {
    // A recovered card is a CARD -- same shape, or the rows cannot be staged.
    const { cards } = baseCardsFor(fixture("1990-bazooka"));
    for (const c of cards) {
      // { num, player } -- the same pair parseCards returns for a Base_Set body.
      expect(Object.keys(c).sort()).toEqual(["num", "player"]);
      expect(String(c.num)).toMatch(/^\d+$/);
      expect(typeof c.player).toBe("string");
      expect(String(c.player).length).toBeGreaterThan(2);
    }
    // The numbering is the page's own, complete and in order.
    expect(cards.map((c: any) => c.num)).toEqual(
      Array.from({ length: 22 }, (_, i) => String(i + 1)),
    );
    // Spot-check the two ends of the real checklist.
    expect(String(cards[0].player)).toMatch(/Kevin Mitchell/);
    expect(String(cards[cards.length - 1].player)).toMatch(/Jim Abbott/);
  });

  it("the page chrome is not swallowed into the checklist body", () => {
    // The same failure #1571 fixed for scoped ladders: a slice that runs past
    // the content picks up the category footer's <li> links as cards.
    for (const [name] of cases) {
      const body = checklistSection(fixture(name));
      expect(body).not.toMatch(/id="catlinks"/);
      expect(body).not.toMatch(/class="printfooter"/);
    }
  });
});

// ── PIN 2: Base_Set still wins — no page that parsed before changes ──────────

describe("bcp — the h1 fallback never displaces a Base_Set heading", () => {
  it("1990_Baseball_Wit is unchanged: read from Base_Set, not from the fallback", () => {
    // The control. This page HAS both headings, and it is the one page of the
    // six the incident classified correctly (`empty`, a real base set with no
    // ladder). It must keep reading from Base_Set.
    const html = fixture("1990-baseball-wit");
    expect(html).toMatch(/<h2 id="Base_Set"/);
    const { cards, viaChecklistHeading } = baseCardsFor(html);
    expect(viaChecklistHeading).toBe(false);
    expect(cards).toHaveLength(109);
  });

  it("every laddered fixture still reads its base from Base_Set", () => {
    // The goldens' own pages. If any of these started reading through the
    // fallback, the staged CSVs could change -- so none of them may.
    const laddered = [
      "1993-finest", "1997-finest", "1998-spx-finite", "1999-black-diamond",
      "2005-topps-chrome", "2011-topps-chrome", "2020-bowman", "2020-bowman-draft",
      "2021-topps-chrome",
    ];
    for (const name of laddered) {
      const html = fixture(name);
      const { cards, viaChecklistHeading } = baseCardsFor(html);
      expect(viaChecklistHeading).toBe(false);
      expect(cards.length).toBeGreaterThan(0);
    }
  });

  it("the fallback returns nothing when there is no Checklist heading at all", () => {
    // A missing page, or one whose layout we genuinely do not understand, must
    // still yield zero -- the `failed` verdict stays available for a real gap.
    expect(parseCards(checklistSection("<div>no headings here</div>"))).toHaveLength(0);
    expect(checklistSection("")).toBe("");
  });
});
