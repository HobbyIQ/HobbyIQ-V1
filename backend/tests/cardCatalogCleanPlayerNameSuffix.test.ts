/**
 * CF-ONE-PLAYER-IS-NOT-TWO-PLAYERS (D33, Drew 2026-08-30, "still a mess" on
 * 2020 Bowman Draft BD-152).
 *
 * On that one card the picker showed THREE spellings of one player: "Bobby
 * Witt", "Bobby Witt, Jr." and "Bobby Witt Jr.". baseballcardpedia writes the
 * generational suffix with a comma before it, and D15's cleanPlayerName trimmed
 * a trailing run of [,;whitespace] -- end-anchored, so it could never see this
 * one: the trailing character of "Bobby Witt, Jr." is the ".". Measured
 * read-only 2026-08-30: 158,567 catalog rows, and for every top name the clean
 * spelling ALREADY coexists (Bobby Witt Jr. 33,367 rows; Ken Griffey Jr.
 * 24,441) -- which is precisely why the picker renders one player as two.
 *
 * This is a SCOPE EXTENSION of D15, not a reversal of it. D15 deliberately left
 * embedded commas alone because no "Last, First" row was found, and that stays
 * true: only a comma followed by a KNOWN generational suffix is touched. Its
 * pins are re-asserted here so the extension cannot quietly break them.
 */
import { describe, expect, it } from "vitest";
import { cleanPlayerName, deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service";

describe("the comma before a generational suffix is punctuation, not a name boundary", () => {
  it.each([
    ["Bobby Witt, Jr.", "Bobby Witt Jr."],
    ["Ken Griffey, Jr.", "Ken Griffey Jr."],
    ["Cal Ripken, Jr.", "Cal Ripken Jr."],
    ["Ronald Acuña, Jr.", "Ronald Acuña Jr."],
    ["Vladimir Guerrero, Jr.", "Vladimir Guerrero Jr."],
    ["Lance McCullers, Jr.", "Lance McCullers Jr."],
    ["Fernando Tatis, Jr.", "Fernando Tatis Jr."],
    // Without the period, as some sources write it.
    ["Cal Ripken, Jr", "Cal Ripken Jr"],
    // The other suffixes the data carries.
    ["Ken Smith, Sr.", "Ken Smith Sr."],
    ["Bob Jones, II", "Bob Jones II"],
    ["Bob Jones, III", "Bob Jones III"],
    ["Bob Jones, IV", "Bob Jones IV"],
    ["Bob Jones, V", "Bob Jones V"],
  ])("%j -> %j", (raw, want) => {
    expect(cleanPlayerName(raw)).toBe(want);
  });

  it("is idempotent -- the clean spelling is a fixed point", () => {
    for (const n of ["Bobby Witt Jr.", "Ken Griffey Jr.", "Ronald Acuña Jr.", "Bob Jones III"]) {
      expect(cleanPlayerName(n)).toBe(n);
      expect(cleanPlayerName(cleanPlayerName(n))).toBe(n);
    }
  });

  it("converges: the two spellings of one player become ONE string", () => {
    // This is the whole point. Two rows, two spellings, one player -- and after
    // the repair the picker has one entry, not two.
    expect(cleanPlayerName("Bobby Witt, Jr.")).toBe(cleanPlayerName("Bobby Witt Jr."));
    expect(cleanPlayerName("Ken Griffey, Jr.")).toBe(cleanPlayerName("Ken Griffey Jr."));
  });
});

describe("a multi-player name keeps every player", () => {
  it.each([
    ["Eddie Murray / Cal Ripken, Jr.", "Eddie Murray / Cal Ripken Jr."],
    ["Derek Jeter / Mike Trout / Ken Griffey, Jr.", "Derek Jeter / Mike Trout / Ken Griffey Jr."],
    ["Luis Robert, Jr. / Ronald Acuña, Jr.", "Luis Robert Jr. / Ronald Acuña Jr."],
    ["Ronald Acuña, Jr. / Dale Murphy / Chipper Jones", "Ronald Acuña Jr. / Dale Murphy / Chipper Jones"],
    ["George Brett / Bobby Witt, Jr.", "George Brett / Bobby Witt Jr."],
  ])("%j -> %j -- never split on the comma", (raw, want) => {
    expect(cleanPlayerName(raw)).toBe(want);
    expect(cleanPlayerName(raw).split(" / ")).toHaveLength(raw.split(" / ").length);
  });
});

describe("what this still refuses to touch", () => {
  it("leaves a 'Last, First' row exactly as it is -- reordering a name invents an identity", () => {
    // D15's pin. No such row was found in the data, and if one appears it is
    // not this defect.
    expect(cleanPlayerName("O'Neil, Tyler")).toBe("O'Neil, Tyler");
    expect(cleanPlayerName("Griffey, Ken")).toBe("Griffey, Ken");
  });

  it("a comma followed by a name that merely STARTS like a suffix is untouched", () => {
    // ", Ivan" starts with "IV"; ", Vance" starts with "V"; ", Sroka" with "Sr".
    // Without a boundary these would each lose their comma AND be mangled.
    expect(cleanPlayerName("Smith, Ivan")).toBe("Smith, Ivan");
    expect(cleanPlayerName("Jones, Vance")).toBe("Jones, Vance");
    expect(cleanPlayerName("Brown, Sroka")).toBe("Brown, Sroka");
    expect(cleanPlayerName("Davis, Iii")).toBe("Davis Iii");   // this one IS the suffix, lower-cased
  });

  it("keeps D15's trailing-comma behaviour intact", () => {
    expect(cleanPlayerName("Max Williams,")).toBe("Max Williams");
    expect(cleanPlayerName("Chase Utley ")).toBe("Chase Utley");
    expect(cleanPlayerName("Cam Caminiti;")).toBe("Cam Caminiti");
    expect(cleanPlayerName("Miguel Sime Jr.,")).toBe("Miguel Sime Jr.");
    expect(cleanPlayerName("Ethan Petry, ")).toBe("Ethan Petry");
    expect(cleanPlayerName("Moisés Chace,")).toBe("Moisés Chace");
  });

  it("is null-safe and leaves an already-clean name alone", () => {
    expect(cleanPlayerName(null)).toBe("");
    expect(cleanPlayerName(undefined)).toBe("");
    expect(cleanPlayerName("Shohei Ohtani")).toBe("Shohei Ohtani");
    expect(cleanPlayerName("Bo Bichette / Vladimir Guerrero Jr.")).toBe("Bo Bichette / Vladimir Guerrero Jr.");
  });

  it("MUTATION CHECK: the D15 end-anchored trim alone cannot fix any of these", () => {
    // If the extension were reverted, every one of these would come back as the
    // comma spelling -- and the picker would still show one player as two.
    const d15Only = (s: string) => s.trim().replace(/[\s,;]+$/, "");
    for (const raw of ["Bobby Witt, Jr.", "Ken Griffey, Jr.", "Eddie Murray / Cal Ripken, Jr."]) {
      expect(d15Only(raw)).toBe(raw);              // the bug, reproduced
      expect(cleanPlayerName(raw)).not.toBe(raw);  // the fix, closing it
    }
  });
});

describe("the root cause closes at the ingest, not only in the repair script", () => {
  it("deriveCatalogEntry applies it, so no future ingest can write the comma spelling", () => {
    const e = deriveCatalogEntry({
      sport: "baseball", year: 2020, setKey: "bowman-draft", setName: "2020 Bowman Draft",
      cardNumber: "BD-152", playerName: "Bobby Witt, Jr.", parallel: "Blue", printRun: 150,
      source: "baseballcardpedia",
    } as Parameters<typeof deriveCatalogEntry>[0]);
    expect(e.playerName).toBe("Bobby Witt Jr.");
  });
});
