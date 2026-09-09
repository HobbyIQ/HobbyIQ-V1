/**
 * 2005 Bowman Chrome Draft Picks & Prospects — the CHROME half is its own
 * product, and the checklist that proves it now exists.
 *
 * Drew's holding bba3b7ad (PSA 10 BDP129 Justin Verlander) re-derived
 * AGREE-UNBACKED: "no checklist row transcribes this card". The catalog held
 * BDP129 only on the PAPER key (`bowman-draft-picks-and-prospects`, source
 * baseballcardpedia-ladders-2026-09-04), and Bowman and Bowman Chrome are
 * DIFFERENT cards — pricing a Chrome Verlander off the paper pool is the
 * defect, not the fix.
 *
 * WHY THE LADDERS LANE NEVER MINTED IT. baseballcardpedia publishes the Chrome
 * set as an `<h3 id="Chrome">` subsection UNDER the paper page's
 * `<h2 id="Parallels">`, not as its own page. scrape-bcp-ladders reads
 * Parallels rungs as parallels OF THE PAPER BASE SET and stops at Inserts, so
 * the refractor ladder landed on the paper key and the fifteen Chrome-only
 * autograph CARD LINES were read as parallel NAMES. The live catalog still
 * carries the proof:
 *
 *     hiq:baseball:2005:bowman-draft-picks-and-prospects:bdp129:bdp175-colby-rasmus-au-rc:no-auto
 *
 * a Verlander row whose "parallel" is Colby Rasmus's card. That is why this
 * product came in as a hand-authored ruling CSV rather than through that lane.
 *
 * THE KEY IS NOT NEW. `bowman-chrome-draft-picks-and-prospects` is already a
 * productSetKeys entry and already the spelling the catalog uses for this
 * product in 2002/2007/2008/2013. This suite pins that the vocabulary keeps
 * routing to it — and, just as load-bearing, that the neighbouring Bowman keys
 * it sits between are NOT swallowed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service";
import { isProductSetKey, productFamilyOf, productParentOf } from "../src/services/catalog/productSetKeys";

const n = normalizeSetKey as (s: string) => string;
const KEY = "bowman-chrome-draft-picks-and-prospects";
const DIR = join(__dirname, "..", "data", "checklists", "drew-rulings");
const STEM = "cardpedia-2005-bowman-chrome-draft-picks-and-prospects-baseball";

const manifest = JSON.parse(readFileSync(join(DIR, `${STEM}.manifest.json`), "utf8"));
const csv = readFileSync(join(DIR, `${STEM}.csv`), "utf8").trim().split("\n");
const header = csv[0];
const rows = csv.slice(1).map((l) => {
  const [category, cardNumber, parallel, isAuto, printRun, player, rarity] = l.split(",");
  return { category, cardNumber, parallel, isAuto, printRun, player, rarity };
});

const slug = (cardNumber: string, parallel: string, isAuto: boolean, printRun: number | null, setKey = KEY) =>
  computeHobbyIqCardId({ sport: "baseball", year: 2005, setKey, cardNumber, parallel, isAuto, printRun } as never);

describe("the setKey is the EXISTING convention, never a new spelling", () => {
  it("is a normalizeSetKey fixed point", () => {
    expect(n(KEY)).toBe(KEY);
  });

  // It was already a product the table names — this PR mints rows for it, it
  // does not invent the key. Its family is bowman-chrome (so the ladder walk
  // reaches the chrome siblings) while its PARENT is the paper Draft product
  // it is the chrome half of.
  it("is a product the table already knows, in the bowman-chrome family", () => {
    expect(isProductSetKey(KEY)).toBe(true);
    expect(productFamilyOf(KEY)).toBe("bowman-chrome");
    expect(productParentOf(KEY)).toBe("bowman-draft-picks-and-prospects");
  });

  it.each([
    "Bowman Chrome Draft Picks & Prospects",
    "Bowman Chrome Draft Picks and Prospects",
    "2005 Bowman Chrome Draft Picks & Prospects",
    "Bowman Chrome Draft Picks",
    "bowman-chrome-draft-picks-prospects",
  ])("%s maps to the chrome draft key", (s) => {
    expect(n(s)).toBe(KEY);
  });

  // The holding that started this: its stored setName IS the full spelling, so
  // the re-derive reaches the new rows with no normalizer change at all.
  it("the holding's own setName already resolves here", () => {
    expect(n("2005 Bowman Chrome Draft Picks & Prospects")).toBe(KEY);
  });

  // ORDERING IS LOAD-BEARING. These neighbours must survive untouched.
  it.each([
    ["Bowman Draft Picks & Prospects", "bowman-draft-picks-and-prospects"],
    ["2005 Bowman Draft Picks & Prospects", "bowman-draft-picks-and-prospects"],
    ["Bowman Chrome", "bowman-chrome"],
    ["Bowman Chrome Sapphire", "bowman-chrome-sapphire"],
    ["Bowman Draft", "bowman-draft"],
    ["Bowman Draft 1st Edition", "bowman-draft-1st-edition"],
  ])("%s still resolves to %s", (input, want) => {
    expect(n(input)).toBe(want);
  });

  // CF-MATCH-THE-CATALOG stands. The bare "Bowman Chrome Draft" / "Bowman
  // Draft Chrome" spelling is the MODERN chrome half of Bowman Draft (BDC-,
  // BD-, CDA- numbering) and stays on bowman-draft, where its checklist is.
  // Measured 2026-09-09: 31,617 pool rows carry "bowman chrome draft" in their
  // title and they are 2011/2016/2018-2026 product, not this 2005 one — so
  // retargeting that rule at this product would move ~16,309 checklist-backed
  // rows off their own key to fix one.
  it.each(["Bowman Chrome Draft", "Bowman Draft Chrome", "2020 Bowman Chrome Draft"])(
    "%s is the modern draft-chrome and stays on bowman-draft",
    (s) => { expect(n(s)).toBe("bowman-draft"); },
  );
});

describe("the ruling CSV transcribes BCP, and nothing more", () => {
  it("the manifest names the product and a checklist-class source", () => {
    expect(manifest.setKey).toBe(KEY);
    expect(manifest.year).toBe(2005);
    expect(manifest.sport).toBe("baseball");
    expect(catalogAuthorityOf(manifest.source)).toBe("checklist");
    expect(manifest.sourceUrl).toContain("baseballcardpedia.com");
  });

  it("the manifest row count is the CSV's own", () => {
    expect(rows.length).toBe(manifest.rows);
  });

  it("carries the columns the ingester reads", () => {
    expect(header).toBe("category,cardNumber,parallel,isAuto,printRun,player,rarity");
  });

  // BCP: a "165-card set" — Prospects BDP1-30, Draft Picks BDP31-120, Futures
  // Game BDP121-165 — plus fifteen First-Year Player Autographs BDP166-BDP180
  // that are "only available in the Chrome set".
  it("holds exactly the 165 base numbers and the 15 autograph numbers", () => {
    const base = new Set(rows.filter((r) => r.category === "base").map((r) => r.cardNumber));
    const auto = new Set(rows.filter((r) => r.category === "first-year-player-autographs").map((r) => r.cardNumber));
    expect(base.size).toBe(165);
    expect(auto.size).toBe(15);
    for (let i = 1; i <= 165; i++) expect(base.has(`BDP${i}`)).toBe(true);
    for (let i = 166; i <= 180; i++) expect(auto.has(`BDP${i}`)).toBe(true);
    // Disjoint: an autograph number is never also a base card.
    for (const a of auto) expect(base.has(a)).toBe(false);
  });

  // The ladder, verbatim from BCP's Chrome subsection.
  it("gives every base card the seven-rung chrome ladder", () => {
    const want = [
      ["Base", ""], ["Refractor", ""], ["X-Fractor", "250"], ["Blue Refractor", "150"],
      ["Gold Refractor", "50"], ["Red Refractor", "1"], ["SuperFractor", "1"],
    ];
    expect(rows.filter((r) => r.cardNumber === "BDP129").map((r) => [r.parallel, r.printRun])).toEqual(want);
    // and it is the same ladder for all 165, not just the one we care about
    for (const num of ["BDP1", "BDP30", "BDP120", "BDP165"]) {
      expect(rows.filter((r) => r.cardNumber === num).map((r) => [r.parallel, r.printRun])).toEqual(want);
    }
  });

  // BCP distinguishes the autograph Refractor: "Refractor (Un-numbered;
  // Autographs: serial-numbered to 500 copies)". No plain Base rung — these
  // fifteen exist only as refractors.
  it("the autographs carry the /500 Refractor and no Base rung", () => {
    const got = rows.filter((r) => r.cardNumber === "BDP175");
    expect(got.map((r) => [r.parallel, r.printRun])).toEqual([
      ["Refractor", "500"], ["X-Fractor", "250"], ["Blue Refractor", "150"],
      ["Gold Refractor", "50"], ["Red Refractor", "1"], ["SuperFractor", "1"],
    ]);
    expect(got.some((r) => r.parallel === "Base")).toBe(false);
  });

  // feedback_isauto_boundary_is_cardnumber_not_text: the CHECKLIST decides,
  // never the "AU" token that happens to sit in the player string.
  it("isAuto follows the section, not the player text", () => {
    for (const r of rows) {
      expect(r.isAuto).toBe(r.category === "first-year-player-autographs" ? "true" : "false");
    }
    // BDP165 "Nelson Cruz RC" carries a rookie token and is NOT an auto.
    expect(rows.filter((r) => r.cardNumber === "BDP165").every((r) => r.isAuto === "false")).toBe(true);
  });

  // No synthetic rows: BCP names four Printing Plates per card but no plate
  // colour, and blank means unknown, never guessed.
  it("mints no Printing Plate rows", () => {
    expect(rows.some((r) => /printing|plate/i.test(r.parallel))).toBe(false);
  });

  it("leaves no blank player and no BCP footnote asterisk in a name", () => {
    for (const r of rows) {
      expect(r.player.trim()).not.toBe("");
      expect(r.player).not.toContain("*");
    }
  });

  // CF-A-PLAYER-IS-NOT-A-RUNG. The paper key's live damage is a Verlander row
  // whose parallel is "BDP175 Colby Rasmus AU RC"; nothing like it here.
  it("never puts a card line in the parallel column", () => {
    for (const r of rows) expect(r.parallel).not.toMatch(/^BDP\d/i);
  });
});

describe("the rows land where the holding re-derives", () => {
  it("BDP129 base mints the slug holding bba3b7ad needs", () => {
    expect(slug("BDP129", "Base", false, null)).toBe(`hiq:baseball:2005:${KEY}:bdp129:base:no-auto`);
  });

  it("is a DIFFERENT address from the paper card it was pricing off", () => {
    expect(slug("BDP129", "Base", false, null))
      .not.toBe(slug("BDP129", "Base", false, null, "bowman-draft-picks-and-prospects"));
  });

  it("the numbered rungs carry their print run into the slug", () => {
    expect(slug("BDP129", "Gold Refractor", false, 50))
      .toBe(`hiq:baseball:2005:${KEY}:bdp129:gold-refractor:no-auto:num-50`);
  });

  it("an autograph rung is signed in its own slug", () => {
    expect(slug("BDP175", "Refractor", true, 500))
      .toBe(`hiq:baseball:2005:${KEY}:bdp175:refractor:auto:num-500`);
  });

  // One card, one row, one pool: a duplicate address is a split pool.
  it("every CSV row mints a distinct address", () => {
    const ids = rows.map((r) => slug(r.cardNumber, r.parallel, r.isAuto === "true", r.printRun ? Number(r.printRun) : null));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
