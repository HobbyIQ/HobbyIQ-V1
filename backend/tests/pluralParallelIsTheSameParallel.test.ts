/**
 * CF-A-LADDER-HEADING-IS-PLURAL (2026-08-31, LANE 3: ingest 1993 Topps Finest
 * baseball from baseballcardpedia).
 *
 * A checklist SECTION HEADING is written plural because it heads a list of
 * cards -- "Refractors", "Gold Refractors", "Printing Plates" -- while the
 * parallel that ONE card carries is singular. Both spellings name the same
 * physical parallel, so both must reach one slug or the comp pool splits.
 *
 * 1993 Finest is the case that forced it: the page's ladder is not a list of
 * <li> rungs at all, it is two <h3> scopes ("Jumbos", "Refractors"), so the
 * rung name IS the heading -- plural. Staged as-is it slugs `refractors` and
 * strands 199 cards beside the existing 705-row `refractor` pool.
 *
 * WHY THIS IS A CLOSED VOCABULARY AND NOT A TRAILING-S STRIP. Measured over
 * data/checklist-parallel-names.json (36,699 checklist-sourced names, 20,309
 * distinct): 584 end in a bare -s, but only the ones whose LAST word is a
 * parallel head-noun are safe to fold. The corpus itself says why a general
 * rule would be wrong -- these are parallel NAMES that merely end in s, and
 * whose singular is a DIFFERENT card:
 *
 *   Canvas (6,957)      "Canva" is also in the corpus (1,000) -- a typo row,
 *                       and exactly the pool a blind strip would merge into
 *   Stars (1,944)       vs Star (2,974)
 *   Rockets (200)       vs Rocket (1,900)
 *   Crystals, Wedges, Spokes, Fireworks, Stars & Stripes, Hieroglyphs
 *
 * The fold is therefore keyed to a closed list of finish/format head-nouns.
 * Blast radius over the same corpus: 490 distinct names change slug, every one
 * of them landing on a refractor / prizm / plate / wave / die-cut /
 * superfractor / autograph singular. None of the names above moves.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeParallel } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseCards, parseScopedLadders, section } = require("../scripts/scrape-bcp-ladders.cjs");

describe("a plural ladder heading names the singular parallel", () => {
  it.each([
    ["Refractors", "refractor"],
    ["Refractor", "refractor"],
    ["Gold Refractors", "gold-refractor"],
    ["Atomic Refractors", "atomic-refractor"],
    ["Superfractors", "superfractor"],
    ["Gold Prizms", "gold-prizm"],
    ["Printing Plates", "printing-plate"],
    ["Green Waves", "green-wave"],
    ["Base Autographs", "base-autograph"],
    ["Status Die-Cuts", "status-die-cut"],
    // The 1993 Finest page's other scope.
    ["Jumbos", "jumbo"],
    ["Jumbo", "jumbo"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeParallel(input)).toBe(expected);
  });

  it("both spellings of one parallel reach ONE slug -- the point of the fix", () => {
    expect(normalizeParallel("Refractors")).toBe(normalizeParallel("Refractor"));
    expect(normalizeParallel("Gold Refractors")).toBe(normalizeParallel("Gold Refractor"));
  });
});

/**
 * The other half of the guard. A guard that folded every trailing s would be
 * the same class of bug pointed the other way -- so pin the names that must
 * SURVIVE, each one a real parallel from the checklist corpus whose singular
 * is a different card.
 */
describe("a parallel whose NAME is plural is not damaged", () => {
  it.each([
    ["Canvas", "canvas"],
    ["Stars", "stars"],
    ["Rockets", "rockets"],
    ["Crystals", "crystals"],
    ["Wedges", "wedges"],
    ["Spokes", "spokes"],
    ["Fireworks", "fireworks"],
    ["Hieroglyphs", "hieroglyphs"],
    ["Exclusives", "exclusives"],
    ["Footballs", "footballs"],
    ["Circles", "circles"],
    ["Webs", "webs"],
    ["75 Years of Topps", "75-years-of-topps"],
  ])("%s stays %s", (input, expected) => {
    expect(normalizeParallel(input)).toBe(expected);
  });

  it("Canvas does not become the corpus's rival 'canva' spelling", () => {
    expect(normalizeParallel("Canvas")).toBe("canvas");
    expect(normalizeParallel("Canvas")).not.toBe("canva");
  });
});

/**
 * The committed emission path over the real page, so what is pinned is what
 * the scraper actually stages -- not a reimplementation of it.
 */
describe("1993 Finest stages as the checklist reads", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "bcp", "1993-finest.trimmed.html"),
    "utf8",
  );
  const cards = parseCards(section(html, "Base_Set", 2));
  const scopes = parseScopedLadders(section(html, "Parallels", 2), {
    html,
    setName: "Finest",
    setKey: "finest",
    playerNames: new Set(cards.map((c: { player: string }) => c.player)),
    qualify: null,
  });

  it("the base set is 199 cards and #99 is Jose Canseco", () => {
    expect(cards).toHaveLength(199);
    expect(cards.find((c: { num: string }) => c.num === "99")).toEqual({
      num: "99",
      player: "Jose Canseco",
    });
  });

  it("the page's two scopes are Jumbos and Refractors, one rung each", () => {
    const named = scopes.filter((s: { title: string | null }) => s.title);
    expect(named.map((s: { title: string }) => s.title)).toEqual(["Jumbos", "Refractors"]);
    for (const s of named) expect(s.rungs.map((r: { name: string }) => r.name)).toHaveLength(1);
  });

  it("the Refractors rung slugs to the EXISTING refractor pool, not a new one", () => {
    const refr = scopes.find((s: { title: string | null }) => s.title === "Refractors");
    expect(normalizeParallel(refr.rungs[0].name)).toBe("refractor");
  });

  /**
   * CF-THE-FOOTER-IS-NOT-THE-LAST-SECTION (2026-08-31). The LAST section of a
   * page has no following heading, so the slice ran to end-of-document and
   * swallowed the MediaWiki category footer -- a <ul> of <li> links. On this
   * page that put <li>Topps</li> and <li>1993</li> inside the "Refractors"
   * scope; "1993" was refused for its leading digit but "Topps" read as a
   * RUNG, and a rung expands over every base card. 199 phantom "Topps"
   * parallel rows, from the page's own footer.
   */
  it("the category footer is not read as a rung", () => {
    expect(html).toContain("catlinks");
    const refr = scopes.find((s: { title: string | null }) => s.title === "Refractors");
    const names = refr.rungs.map((r: { name: string }) => r.name);
    expect(names).not.toContain("Topps");
    expect(names).toEqual(["Refractors"]);
  });

  it("printRun stays blank -- the page states a BELIEVED figure, never a serial", () => {
    for (const s of scopes) for (const r of s.rungs) expect(r.printRun ?? "").toBe("");
  });
});

/**
 * CF-A-HEADING-RUNG-IS-SCOPED-TOO (2026-08-31) — the third defect's guard,
 * which nothing else pinned.
 *
 * Mutation-tested during adversarial review: reverting the fix (passing
 * cardRange=null for a heading rung, as the code did before) left EVERY
 * existing suite green while the Jumbos scope silently went back to spanning
 * all 199 base cards instead of its stated 33. That is the exploded-spine
 * signature #1571 exists to stop, so it gets its own pin.
 *
 * The page states the scope without ever writing the word "cards":
 *   "reproductions of 33 players from that set's All-Star subset (84-116)"
 * and 116-84+1 == 33, so the stated count corroborates the span.
 */
describe("a heading rung carries its own card range", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "bcp", "1993-finest.trimmed.html"),
    "utf8",
  );
  const cards = parseCards(section(html, "Base_Set", 2));
  const scopes = parseScopedLadders(section(html, "Parallels", 2), {
    html,
    setName: "Finest",
    setKey: "finest",
    playerNames: new Set(cards.map((c: { player: string }) => c.player)),
    qualify: null,
  });

  it("Jumbos are scoped to the All-Star subset 84-116, not the whole set", () => {
    const jumbos = scopes.find((s: { title: string | null }) => s.title === "Jumbos");
    expect(jumbos.rungs[0].cardRange).toEqual([[84, 116]]);
    // 33 cards wide -- the count the page states alongside the span.
    const [[lo, hi]] = jumbos.rungs[0].cardRange;
    expect(hi - lo + 1).toBe(33);
  });

  it("Refractors stay set-wide -- a null range is still the correct read there", () => {
    const refr = scopes.find((s: { title: string | null }) => s.title === "Refractors");
    expect(refr.rungs[0].cardRange).toBeNull();
  });
});

/**
 * The subset-parenthetical read must REFUSE when the stated count disagrees
 * with the span's width -- otherwise a mis-stated page silently narrows or
 * widens a parallel. Pinned through the committed parser, not a copy.
 */
describe("parseCardRange refuses a subset span the stated count contradicts", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseCardRange } = require("../scripts/scrape-bcp-ladders.cjs");
  const real = "feature reproductions of 33 players from that set's All-Star subset (84-116).";

  it("reads the real page's span", () => {
    expect(parseCardRange(real)).toEqual([[84, 116]]);
  });

  it.each([
    ["count disagrees with width", real.replace("33 players", "12 players")],
    ["span narrower than the count", real.replace("(84-116)", "(84-115)")],
    ["span reversed", real.replace("(84-116)", "(116-84)")],
  ])("refuses when %s", (_label, text) => {
    expect(parseCardRange(text)).toBeNull();
  });
});
