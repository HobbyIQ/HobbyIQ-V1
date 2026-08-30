/**
 * CF-A-BACKSLASH-IN-A-STRING-IS-NOT-A-BACKSLASH (D33, Drew 2026-08-30).
 *
 * Drew searched "Find this card" for 2020 Bowman Draft BD-152 and said "still a
 * mess". Most of that mess is stored rows, repaired by the backend fleet -- but
 * two characters of it are here, and they were the loudest part:
 *
 *   the set line read "2020 2020 Bowman Draft Baseball #BD-152", because the
 *   year-strip regex was built by string concatenation and "\s" inside a normal
 *   JS string is the letter s, so it compiled to /^2020s+/ and matched nothing;
 *
 *   the player line read "Wade Bogg" for Wade Boggs, because /[s,;]+$/ is a
 *   character class holding the LETTER s. 2,452,238 catalog rows -- 12.4% of
 *   the catalog -- have a player name ending in "s".
 *
 * Both are display-only: the stored data was always right. Both are pinned here
 * with mutation checks, because a regex that silently does nothing is exactly
 * the kind of bug that passes a review twice.
 */
import { describe, expect, it } from "vitest";
import { cardLabelOf, playerLabelOf, setLabelOf } from "./catalogHitLabel";

describe("the year appears exactly once", () => {
  it("strips the year the checklist source wrote into setName", () => {
    expect(setLabelOf({ setName: "2020 Bowman Draft Baseball", year: 2020 })).toBe("Bowman Draft Baseball");
    expect(setLabelOf({ setName: "2025 Bowman Draft Baseball", year: 2025 })).toBe("Bowman Draft Baseball");
    expect(setLabelOf({ setName: "1999 Upper Deck", year: 1999 })).toBe("Upper Deck");
  });

  it("builds Drew's row with the year once, not twice", () => {
    expect(cardLabelOf({ setName: "2020 Bowman Draft Baseball", year: 2020, cardNumber: "BD-152" }))
      .toBe("2020 Bowman Draft Baseball #BD-152");
  });

  it("strips only a LEADING year, and only this row's year", () => {
    // A year in the middle is part of the name ("Topps 1952 Redux").
    expect(setLabelOf({ setName: "Topps 1952 Redux", year: 2021 })).toBe("Topps 1952 Redux");
    // A different year at the front is not this row's duplicate.
    expect(setLabelOf({ setName: "1952 Topps", year: 2021 })).toBe("1952 Topps");
  });

  it("strips at most one year, so '2020 2020 Bowman' still shows one", () => {
    expect(setLabelOf({ setName: "2020 2020 Bowman Draft", year: 2020 })).toBe("2020 Bowman Draft");
  });

  it("falls back to setKey, and survives a missing year", () => {
    expect(setLabelOf({ setKey: "bowman-draft", year: 2020 })).toBe("bowman-draft");
    expect(setLabelOf({ setName: "2020 Bowman Draft Baseball", year: null })).toBe("2020 Bowman Draft Baseball");
    expect(setLabelOf({})).toBe("");
  });

  it("MUTATION CHECK: the backslash-less regex never matched for ANY shape", () => {
    // #1466 as shipped. Reproduce it and show it does nothing at all -- the
    // brief's "stripped it for one shape only" was generous.
    const broken = (setName: string, year: number) =>
      setName.replace(new RegExp("^" + String(year) + "\s+"), "").trim();
    for (const [name, year] of [["2020 Bowman Draft Baseball", 2020], ["2025 Topps Chrome", 2025]] as Array<[string, number]>) {
      expect(broken(name, year)).toBe(name);                       // the bug
      expect(setLabelOf({ setName: name, year })).not.toBe(name);  // the fix
    }
  });
});

describe("a player name keeps its last letter", () => {
  it.each([
    "Wade Boggs",
    "Roger Maris",
    "Bobby Jones",
    "Chipper Jones",
    "Willie Mays",
    "Randy Johnson",
    "Ken Griffey Jr.",
    "Ronald Acuña Jr.",
    "Bobby Witt Jr.",
  ])("renders %j intact", (name) => {
    expect(playerLabelOf({ playerName: name })).toBe(name);
  });

  it("keeps a multi-player name whole, every name ending in s included", () => {
    expect(playerLabelOf({ playerName: "Chicago Cubs / Oakland Athletics" })).toBe("Chicago Cubs / Oakland Athletics");
    expect(playerLabelOf({ playerName: "Eddie Murray / Cal Ripken Jr." })).toBe("Eddie Murray / Cal Ripken Jr.");
  });

  it("still trims the trailing comma D15 was about, and nothing else", () => {
    expect(playerLabelOf({ playerName: "Max Williams," })).toBe("Max Williams");
    expect(playerLabelOf({ playerName: "Chase Utley " })).toBe("Chase Utley");
    expect(playerLabelOf({ playerName: "Cam Caminiti;" })).toBe("Cam Caminiti");
  });

  it("is empty-safe", () => {
    expect(playerLabelOf({ playerName: null })).toBe("");
    expect(playerLabelOf({ playerName: "" })).toBe("");
    expect(playerLabelOf({})).toBe("");
  });

  it("MUTATION CHECK: the letter-s class ate a real letter from 12.4% of the catalog", () => {
    const broken = (name: string) => name.replace(/[s,;]+$/, "").trim();
    expect(broken("Wade Boggs")).toBe("Wade Bogg");
    expect(broken("Roger Maris")).toBe("Roger Mari");
    expect(broken("Bobby Jones")).toBe("Bobby Jone");
    expect(broken("Max Williams,")).toBe("Max William");   // ate the comma AND the s
    // The fix keeps every one of them whole.
    for (const n of ["Wade Boggs", "Roger Maris", "Bobby Jones"]) {
      expect(playerLabelOf({ playerName: n })).toBe(n);
    }
    expect(playerLabelOf({ playerName: "Max Williams," })).toBe("Max Williams");
  });
});
