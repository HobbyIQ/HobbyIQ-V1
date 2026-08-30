/**
 * D33 (Drew, 2026-08-30, "Find this card" on "2020 BOWMAN Bobby Witt Jr. Royals
 * #BD152 sp": "still a mess").
 *
 * The label is pinned here because the bug it replaces was a STRING-ESCAPE
 * defect that type-checks, lints, reads correct and never fires:
 * `new RegExp("^" + year + "\s+")` compiles to `^2020s+`. Nothing but a test
 * comparing the rendered text to the text Drew should see can catch that class
 * of bug — tsc cannot, and the component has no test at all.
 *
 * MUTATION CHECK: put `new RegExp("^" + String(hit.year) + "\s+")` back in
 * stripLeadingYear and the "exactly one 2020" assertions go red.
 */
import { describe, expect, it } from "vitest";
import { cardLabelOf, catalogHitLabel, playerLabelOf, setLabelOf } from "./catalogHitLabel";

/** The row Drew actually clicked on: a real 2020 Bowman Draft BD-152. */
const WITT = {
  year: 2020,
  setName: "2020 Bowman Draft Baseball",
  setKey: "bowman-draft",
  cardNumber: "BD-152",
  playerName: "Bobby Witt Jr.",
  parallel: "Blue Refractor",
  printRun: 150,
  isAuto: false,
};

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
    // Title-cased by the shared implementation (titleCaseSetKey): the picker
    // renders this to a user, and "bowman-draft" is a key, not a product name.
    // The rows lane originally asserted the raw key here; the two lanes are ONE
    // helper now, and the rendered spelling is the one that ships.
    expect(setLabelOf({ setKey: "bowman-draft", year: 2020 })).toBe("Bowman Draft");
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

describe("catalogHitLabel — the year appears exactly once", () => {
  it("pins the Witt shape: one year, the product, the number", () => {
    const l = catalogHitLabel(WITT);
    expect(l.line).toBe("2020 Bowman Draft Baseball #BD-152");
    expect(l.line.match(/2020/g)).toHaveLength(1);
    expect(l.player).toBe("Bobby Witt Jr.");
    expect(l.variant).toBe("Blue Refractor /150");
  });

  it("strips the year from every setName shape, not one", () => {
    // #1466 fixed "one shape"; the escape bug meant it fixed none. These are
    // the five spellings measured on this single card in prod.
    expect(catalogHitLabel({ ...WITT, setName: "2020 Bowman Draft" }).line)
      .toBe("2020 Bowman Draft #BD-152");
    expect(catalogHitLabel({ ...WITT, setName: "2020 Bowman Draft Baseball" }).line)
      .toBe("2020 Bowman Draft Baseball #BD-152");
    expect(catalogHitLabel({ ...WITT, setName: "2020 Bowman Draft 1st Edition Baseball" }).line)
      .toBe("2020 Bowman Draft 1st Edition Baseball #BD-152");
  });

  it("leaves a setName that carries no year alone (bccp rows)", () => {
    expect(catalogHitLabel({ ...WITT, setName: "Bowman Draft" }).line)
      .toBe("2020 Bowman Draft #BD-152");
  });

  it("keeps 1st Edition in the product — never inferred, never dropped", () => {
    const l = catalogHitLabel({ ...WITT, setName: "2020 Bowman Draft 1st Edition Baseball" });
    expect(l.product).toBe("Bowman Draft 1st Edition Baseball");
  });

  it("does NOT strip a DIFFERENT year — the row disagreeing with itself must show", () => {
    // A 2019 setName on a 2020 row is a data defect. Hiding it would launder
    // the defect; "2020 2019 Bowman Draft" is the honest reading.
    const l = catalogHitLabel({ ...WITT, year: 2020, setName: "2019 Bowman Draft" });
    expect(l.line).toBe("2020 2019 Bowman Draft #BD-152");
  });

  it("falls back to the setKey when a row carries no setName", () => {
    expect(catalogHitLabel({ ...WITT, setName: null }).line)
      .toBe("2020 Bowman Draft #BD-152");
    expect(catalogHitLabel({ ...WITT, setName: null, setKey: "bowman-draft-1st-edition" }).product)
      .toBe("Bowman Draft 1st Edition");
  });

  it("omits the year segment entirely when the row has no year", () => {
    expect(catalogHitLabel({ ...WITT, year: null, setName: "Bowman Draft" }).line)
      .toBe("Bowman Draft #BD-152");
  });
});

describe("catalogHitLabel — player names keep their letters", () => {
  it("does not eat the trailing s off a name (the /[s,;]+$/ bug)", () => {
    expect(catalogHitLabel({ ...WITT, playerName: "Max Williams" }).player).toBe("Max Williams");
  });

  it("leaves ', Jr.' alone — that is an ingest repair, not a display trick", () => {
    expect(catalogHitLabel({ ...WITT, playerName: "Bobby Witt, Jr." }).player).toBe("Bobby Witt, Jr.");
  });

  it("strips a genuinely trailing comma", () => {
    expect(catalogHitLabel({ ...WITT, playerName: "Angel Nunez," }).player).toBe("Angel Nunez");
    expect(catalogHitLabel({ ...WITT, playerName: "Angel Nunez ; " }).player).toBe("Angel Nunez");
  });

  it("never renders an empty name", () => {
    expect(catalogHitLabel({ ...WITT, playerName: null }).player).toBe("(unnamed)");
  });
});

describe("catalogHitLabel — the variant reads the way a collector says it", () => {
  it("joins the print run to the parallel", () => {
    expect(catalogHitLabel({ ...WITT, parallel: "Refractor", printRun: 499 }).variant)
      .toBe("Refractor /499");
  });

  it("is empty for a plain base card", () => {
    expect(catalogHitLabel({ ...WITT, parallel: "Base", printRun: null, isAuto: false }).variant).toBe("");
    expect(catalogHitLabel({ ...WITT, parallel: null, printRun: null, isAuto: false }).variant).toBe("");
  });

  it("shows Auto with the run when the base card is an autograph", () => {
    expect(catalogHitLabel({ ...WITT, parallel: "Base", printRun: 15, isAuto: true }).variant)
      .toBe("Auto /15");
  });

  it("shows parallel, Auto and run together", () => {
    expect(catalogHitLabel({ ...WITT, parallel: "Gold Refractor", printRun: 50, isAuto: true }).variant)
      .toBe("Gold Refractor · Auto /50");
  });

  it("keeps a 1/1 legible", () => {
    expect(catalogHitLabel({ ...WITT, parallel: "Black", printRun: 1, isAuto: false }).variant)
      .toBe("Black /1");
    // Its checklistcenter twin, where the 1/1 was swallowed into the name, is
    // shown as it is stored — D30 owns the repair, the picker does not hide it.
    expect(catalogHitLabel({ ...WITT, parallel: "Black 1", printRun: null, isAuto: false }).variant)
      .toBe("Black 1");
  });
});

describe("catalogHitLabel — sales and the checklist badge", () => {
  it("reads 'N sales · last DATE'", () => {
    expect(catalogHitLabel({ ...WITT, salesSummary: { count: 106, lastSaleAt: "2026-08-27T14:03:11Z" } }).sales)
      .toBe("106 sales · last 2026-08-27");
  });

  it("singularises one sale", () => {
    expect(catalogHitLabel({ ...WITT, salesSummary: { count: 1, lastSaleAt: "2026-08-27T14:03:11Z" } }).sales)
      .toBe("1 sale · last 2026-08-27");
  });

  it("says so when there are none", () => {
    expect(catalogHitLabel({ ...WITT, salesSummary: { count: 0, lastSaleAt: null } }).sales).toBe("no sales yet");
    expect(catalogHitLabel({ ...WITT, salesSummary: null }).sales).toBe("no sales yet");
  });

  it("splits the same three facts the picker stacks into two lines", () => {
    // The component renders saleCountText above lastSaleDay; both must agree
    // with the joined `sales` string, or the one-formatter claim is false.
    const l = catalogHitLabel({ ...WITT, salesSummary: { count: 106, lastSaleAt: "2026-08-27T14:03:11Z" } });
    expect(l.saleCount).toBe(106);
    expect(l.saleCountText).toBe("106 sales");
    expect(l.lastSaleDay).toBe("2026-08-27");
    expect(l.sales).toBe(`${l.saleCountText} · last ${l.lastSaleDay}`);

    const none = catalogHitLabel({ ...WITT, salesSummary: null });
    expect(none.saleCount).toBe(0);
    expect(none.lastSaleDay).toBe("");
    expect(none.saleCountText).toBe("no sales yet");
  });

  it("badges ONLY a checklist-authority row", () => {
    expect(catalogHitLabel({ ...WITT, authority: "checklist" }).checklist).toBe(true);
    for (const a of ["vendor", "derived", "unknown", null, undefined]) {
      expect(catalogHitLabel({ ...WITT, authority: a }).checklist).toBe(false);
    }
  });
});
