import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { baseCards, section, checklistSection } = require(path.join(__dirname, "..", "scripts", "scrape-bcp-ladders.cjs"));

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, "fixtures", "bcp", n), "utf8");

/**
 * Both pages are REAL, fetched from baseballcardpedia on 2026-09-04, trimmed to
 * the Checklist..Parallels span the parser reads. Both were verdicted
 *
 *   FAILED — bcp page carries a checklist our parser does not read
 *            (no Base_Set heading) — a parser gap, not an empty page
 *
 * in backfill run 33869931267, and together with one other failure they were
 * the 3-streak that aborted the bcp lane with 93 of 119 entries unattempted.
 * They are TWO DIFFERENT defects that produced one message.
 */
describe("bcp — the layouts #1732 did not reach", () => {
  it("2009 Bowman Chrome: Checklist is an h2 and Base_Set an h3", () => {
    const html = fixture("2009-bowman-chrome.demoted-heading.html");
    // The page shape, stated: the whole page is demoted one level, so neither
    // the h2 Base_Set slice nor the h1 Checklist fallback finds anything.
    expect(section(html, "Base_Set", 2)).toBe("");
    expect(checklistSection(html)).toBe("");
    // ...and the h3 slice is where the cards actually are.
    expect(section(html, "Base_Set", 3).length).toBeGreaterThan(10000);

    const { cards, viaDemotedHeading } = baseCards(html);
    expect(cards.length).toBe(353);
    expect(viaDemotedHeading).toBe(true);
    expect(cards[0]).toEqual({ num: "1", player: "David Wright" });
  });

  it("2004 Bowman's Best: the heading is found, but every card is numbered by INITIALS", () => {
    const html = fixture("2004-bowmans-best.initials-numbers.html");
    // This one is NOT a heading defect -- the standard h2 slice works.
    expect(section(html, "Base_Set", 2).length).toBeGreaterThan(3000);
    // The cards are "AER Alex Rodriguez", "AL Anthony Lerew RC": no digit and
    // no internal hyphen, so CARD_NUM rejected all 106 lines.
    const { cards } = baseCards(html);
    expect(cards.length).toBe(106);
    expect(cards[0]).toEqual({ num: "AER", player: "Alex Rodriguez" });
    // The RC tail is a rookie flag, not part of the name.
    expect(cards.find((c: any) => c.num === "AL")).toEqual({ num: "AL", player: "Anthony Lerew" });
    // A MONONYM IS A PLAYER. "IS Ichiro" is one line of this set, and demanding
    // two name tokens of every line threw away the other 105 cards.
    expect(cards.find((c: any) => c.num === "IS")).toEqual({ num: "IS", player: "Ichiro" });
  });

  it("the initials pass is a LAST RESORT — a normal page never reaches it", () => {
    // 2009 Bowman Chrome parses through the ordinary numeric path, so its cards
    // carry digits and none of them came from the initials fallback.
    const { cards } = baseCards(fixture("2009-bowman-chrome.demoted-heading.html"));
    expect(cards.every((c: any) => /\d/.test(c.num))).toBe(true);
  });

  it("a body of ordinary names is NOT read as an initials-numbered set", () => {
    // The guard that keeps the fallback safe: a roster with no card numbers has
    // repeating leading tokens and non-initials shapes, and must stay empty.
    const body = ["Mike Trout", "Mike Piazza", "Shohei Ohtani", "Aaron Judge",
      "Juan Soto", "Ronald Acuna", "Bobby Witt", "Adley Rutschman", "Gunnar Henderson"]
      .map((n) => `<li>${n}</li>`).join("");
    expect(baseCards(body).cards).toEqual([]);
  });

  it("a short list cannot trip the initials pass", () => {
    // Fewer than 8 candidates is not evidence of a numbering scheme.
    const body = ["AB Mike Trout", "CD Aaron Judge", "EF Juan Soto"]
      .map((n) => `<li>${n}</li>`).join("");
    expect(baseCards(body).cards).toEqual([]);
  });

  it("repeated leading tokens are names, not card numbers", () => {
    // A card number identifies a card, so the tokens are distinct. Ten lines
    // all starting "AB" are not a checklist.
    const body = Array.from({ length: 10 }, (_, i) => `<li>AB Player Number${i}</li>`).join("");
    expect(baseCards(body).cards).toEqual([]);
  });
});
