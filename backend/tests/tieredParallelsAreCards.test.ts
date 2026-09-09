/**
 * CF-A-FINEST-TIER-IS-THE-NUMBER / CF-A-GOLD-LABEL-CLASS-IS-THE-CARD
 * (Drew rulings 18-21, 2026-09-08).
 *
 * These guard the SHAPE of three hand-authored checklists against the source
 * that decided them, because each one was nearly minted at the wrong size.
 *
 * 1997 Finest was very nearly minted as tier x number = 1,050 rows. BCP says
 * the opposite in as many words: "there are not Bronze, Silver, and Gold
 * versions of every card in the set... There are no Common/Bronze or
 * Uncommon/Silver versions of card #342." The tier is a property of the
 * NUMBER, so the set is 350 rows and the range rule is the invariant.
 *
 * 2017 Gold Label is the mirror image: there the cross IS the card, because
 * BCP gives Class 1/2/3 Blue three different print runs (/150, /99, /50).
 *
 * 1996 Heavy Metal is a 10-card INSERT whose #2 is Barry Bonds while the base
 * set's #2 is Brady Anderson -- the whole reason holding 46f3dd96 prices off
 * the wrong player today.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

const DIR = path.join(__dirname, "..", "data", "checklists", "drew-rulings");
const readCsv = (f: string) => {
  const lines = fs.readFileSync(path.join(DIR, f), "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  return lines.slice(1).map((l) => {
    const cells = splitRow(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
};

const finestTier = (n: number): string => {
  if ((n >= 1 && n <= 100) || (n >= 176 && n <= 275)) return "Bronze";
  if ((n >= 101 && n <= 150) || (n >= 276 && n <= 325)) return "Silver";
  return "Gold";
};

describe("1997 Finest: the tier is the number, not a parallel axis", () => {
  const rows = readCsv("1997-topps-finest-baseball.csv");

  it("is 350 rows -- one per card, NOT 1,050 (tier x number)", () => {
    expect(rows.length).toBe(350);
    expect(new Set(rows.map((r) => r.cardNumber)).size).toBe(350);
  });

  it("gives every number exactly the tier its BCP range dictates", () => {
    for (const r of rows) {
      const n = Number(r.cardNumber);
      expect(r.parallel).toBe(`${finestTier(n)} Refractor`);
      expect(r.rarity).toBe(finestTier(n));
    }
  });

  it("covers 1-350 with no gaps and no card outside the set", () => {
    const nums = rows.map((r) => Number(r.cardNumber)).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[349]).toBe(350);
    expect(new Set(nums).size).toBe(350);
  });

  it("puts Griffey's two cards on their stated tiers (#238 Bronze, #342 Gold)", () => {
    const g = rows.filter((r) => /Griffey/.test(r.player));
    expect(g.find((r) => r.cardNumber === "238")!.parallel).toBe("Bronze Refractor");
    expect(g.find((r) => r.cardNumber === "342")!.parallel).toBe("Gold Refractor");
  });

  it("states no print run -- 1997 Finest predates serial numbering", () => {
    expect(rows.every((r) => r.printRun === "")).toBe(true);
  });
});

describe("2017 Gold Label: class x colour IS the card", () => {
  const rows = readCsv("2017-topps-gold-label-baseball.csv");

  it("is 1,500 rows: 100 players x 3 classes x 5 colours", () => {
    expect(rows.length).toBe(1500);
    expect(new Set(rows.map((r) => r.cardNumber)).size).toBe(100);
  });

  it("names the class on every single row -- a bare colour is ambiguous", () => {
    expect(rows.every((r) => /^Class [123]( |$)/.test(r.parallel))).toBe(true);
  });

  it("gives Blue and Red the per-class print runs BCP states", () => {
    const run = (cls: string, col: string) =>
      rows.find((r) => r.cardNumber === "1" && r.parallel === `Class ${cls} ${col}`)!.printRun;
    expect([run("1", "Blue"), run("2", "Blue"), run("3", "Blue")]).toEqual(["150", "99", "50"]);
    expect([run("1", "Red"), run("2", "Red"), run("3", "Red")]).toEqual(["75", "50", "25"]);
  });

  it("keeps Class N Blue distinct from Class M Blue -- the whole point", () => {
    const blues = rows.filter((r) => r.cardNumber === "86" && /Blue$/.test(r.parallel));
    expect(blues.map((b) => b.parallel).sort()).toEqual(["Class 1 Blue", "Class 2 Blue", "Class 3 Blue"]);
    expect(new Set(blues.map((b) => b.printRun)).size).toBe(3);
  });

  it("leaves Black unnumbered (BCP gives odds, not a run) and Gold at 1/1", () => {
    expect(rows.filter((r) => / Black$/.test(r.parallel)).every((r) => r.printRun === "")).toBe(true);
    expect(rows.filter((r) => / Gold$/.test(r.parallel)).every((r) => r.printRun === "1")).toBe(true);
  });
});

describe("1996 Metal Universe Heavy Metal: an insert, not a parallel", () => {
  const rows = readCsv("1996-metal-universe-heavy-metal-baseball.csv");

  it("is the 10-card insert BCP lists", () => {
    expect(rows.length).toBe(10);
    expect(rows.every((r) => r.category === "insert")).toBe(true);
  });

  it("puts Barry Bonds at #2 -- the base set's #2 is Brady Anderson", () => {
    expect(rows.find((r) => r.cardNumber === "2")!.player).toBe("Barry Bonds");
    expect(rows.some((r) => /Brady Anderson/.test(r.player))).toBe(false);
  });
});

describe("every ruling manifest cites the BCP page that decided it", () => {
  for (const f of [
    "1997-topps-finest-baseball",
    "2017-topps-gold-label-baseball",
    "1996-metal-universe-heavy-metal-baseball",
  ]) {
    it(`${f} carries an adjudicating source and a sourceUrl`, () => {
      const m = JSON.parse(fs.readFileSync(path.join(DIR, `${f}.manifest.json`), "utf8"));
      expect(m.sourceUrl).toMatch(/^https:\/\/baseballcardpedia\.com\//);
      // `cardpedia` is what makes catalogAuthorityOf classify this checklist.
      expect(m.source).toMatch(/cardpedia/);
      expect(m.rows).toBe(readCsv(`${f}.csv`).length);
      expect(m.sport).toBe("baseball");
    });
  }
});
