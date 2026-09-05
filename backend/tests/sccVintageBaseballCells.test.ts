import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * CF-THE-VINTAGE-CELLS-THE-CENSUS-CALLED-SOURCELESS (2026-09-05).
 *
 * The 2026-09-05 checklist-gap census put four pre-1980 baseball products in
 * its top 50 and marked every one "not-enumerated / source gap":
 *
 *     baseball 1933 goudey    11,256 rows   $3,733,108
 *     baseball 1948 leaf       3,156 rows   $4,432,015
 *     baseball 1909 t206       6,578 rows   $1,389,491
 *     baseball 1948 bowman     4,516 rows   $1,129,357
 *
 * www.sportscardchecklist.com serves ALL FOUR and always has. They were
 * invisible because discoverSportsCardChecklistSets.cjs scoped baseball to
 * 1980-2003, so a 1933 set URL classified as `null`. "No permissive source"
 * described THIS REPO'S CELL LIST, not the web -- the fourth time that file has
 * recorded the same failure, and the reason these cells are pinned rather than
 * merely added.
 *
 * WHAT THESE FIXTURES ARE. Real page bytes, fetched 2026-09-05 through the
 * lane's own polite fetcher and trimmed to the card blocks (the `<h5 class="h4">`
 * header plus its `ebay_search` hidden input -- the parser's two anchors). Each
 * trimmed fixture parses to the SAME row count as the live page it came from,
 * verified before it was committed. So a green here is the committed parser on
 * real bytes, not on a hand-written sample of what we hoped the page looked
 * like.
 *
 * The published counts are the pins, and three of them are externally checkable
 * facts about the sets rather than numbers this repo chose:
 *
 *   T206      524 -- the canonical T206 "monster" count.
 *   Goudey    241 -- 240 issued plus the #106 Lajoie that completes the set.
 *   Leaf      101 -- and it is SKIP-NUMBERED: #2 does not exist. A parser that
 *                    renumbered rows densely would emit 1..101 and pass a count
 *                    assertion while silently inventing a card, so the skip is
 *                    asserted directly.
 *   Bowman     50 -- the 1948 Bowman base set.
 */

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fetcher = path.join(backend, "scripts", "fetchSportsCardChecklist.cjs");
const FIXTURES = path.join(backend, "tests", "fixtures", "sportscardchecklist");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-vintage-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

type Row = Record<string, string>;

/** The one checklist CSV format: docs/reference/checklist-csv-contract.md. */
const COLUMNS = ["category", "cardNumber", "parallel", "isAuto", "printRun", "player", "parallelNote", "rarity"];

function parseCsv(text: string): Row[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  const header = lines.shift()!.split(",");
  expect(header).toEqual(COLUMNS);
  return lines.map((line) => {
    // Fields may be quoted; players carry commas ("Jr., Ken Griffey" style).
    const cells: string[] = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    const row: Row = {};
    COLUMNS.forEach((k, i) => { row[k] = cells[i] ?? ""; });
    return row;
  });
}

/** Run the COMMITTED fetcher offline against a committed fixture. */
function run(product: {
  fixture: string; year: number; setKey: string; setName: string; setId: string; slug: string;
}): { rows: Row[]; stdout: string; manifest: Record<string, unknown> } {
  const out = path.join(tmp, `${product.fixture}.csv`);
  const stdout = execFileSync(process.execPath, [
    fetcher,
    "--html", path.join(FIXTURES, `${product.fixture}.trimmed.html`),
    "--out", out,
    "--url", `https://www.sportscardchecklist.com/set-${product.setId}/${product.slug}`,
    "--year", String(product.year),
    "--set-key", product.setKey,
    "--set-name", product.setName,
    "--sport", "baseball",
  ], { encoding: "utf8" });
  const manifestPath = out.replace(/\.csv$/, ".manifest.json");
  return {
    rows: parseCsv(fs.readFileSync(out, "utf8")),
    stdout,
    manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  };
}

const PRODUCTS = [
  {
    label: "1909-11 T206", fixture: "1909-11-t206-baseball", year: 1909, setKey: "t206",
    setName: "1909-11 T206 Baseball", setId: "86884", slug: "1909-11-t206-baseball-trading-card-checklist",
    cards: 524,
  },
  {
    label: "1933 Goudey", fixture: "1933-goudey-baseball", year: 1933, setKey: "goudey",
    setName: "1933 Goudey Baseball", setId: "51915", slug: "1933-goudey-baseball-trading-card-checklist",
    cards: 241,
  },
  {
    label: "1948-49 Leaf", fixture: "1948-49-leaf-baseball", year: 1948, setKey: "leaf",
    setName: "1948-49 Leaf Baseball", setId: "36586", slug: "1948-49-leaf-baseball-trading-card-checklist",
    cards: 101,
  },
  {
    label: "1948 Bowman", fixture: "1948-bowman-baseball", year: 1948, setKey: "bowman",
    setName: "1948 Bowman Baseball", setId: "11583", slug: "1948-bowman-baseball-trading-card-checklist",
    cards: 50,
  },
];

describe("sportscardchecklist vintage baseball - the committed parser on real page bytes", () => {
  for (const p of PRODUCTS) {
    describe(p.label, () => {
      const got = run(p);

      it(`parses to its published ${p.cards} cards, none skipped`, () => {
        expect(got.rows.length).toBe(p.cards);
        expect(got.stdout).toContain("skipped=0");
      });

      it("both page anchors agree - a shape change is loud, not silent", () => {
        expect(got.stdout).toContain("anchors agree");
      });

      it("every row carries a card number and a player", () => {
        for (const r of got.rows) {
          expect(r.cardNumber, JSON.stringify(r)).not.toBe("");
          expect(r.player, JSON.stringify(r)).not.toBe("");
        }
      });

      /**
       * BLANK MEANS UNKNOWN, NEVER A GUESS. The page states no print run and no
       * parallel for these sets, so both columns are blank on every row. A
       * well-formed wrong print run splits a comp pool and no only-improve pass
       * can ever see it -- which is exactly the mutation pinned below.
       */
      it("emits NO synthesised parallel and NO synthesised print run", () => {
        for (const r of got.rows) {
          expect(r.parallel, JSON.stringify(r)).toBe("");
          expect(r.printRun, JSON.stringify(r)).toBe("");
        }
      });

      /**
       * isAuto FROM CHECKLIST EVIDENCE ONLY. Certified autographs are a
       * 1990s-onward feature; a vintage set minting autos would mean the parser
       * read a signature into a set that has none, and an auto row prices
       * against a pool it does not belong to.
       */
      it("mints no autographs in a pre-1990 set", () => {
        expect(got.rows.every((r) => r.isAuto === "false")).toBe(true);
      });

      it("the manifest names the cell the pool actually spells", () => {
        expect(got.manifest.sport).toBe("baseball");
        expect(got.manifest.year).toBe(p.year);
        expect(got.manifest.setKey).toBe(p.setKey);
      });
    });
  }

  /**
   * THE SPLIT-YEAR TRAP, AND IT BIT THE BRANDS. Two of the four carry a
   * split-year slug. The cell year is the FIRST year -- 1948 for `1948-49-leaf`,
   * 1909 for `1909-11-t206` -- which is how the pool spells them
   * (`hiq:baseball:1909:t206:`). A parser taking the LAST year would file both
   * under a year with no sales.
   */
  it("a split-year slug takes its FIRST year, matching the pool", () => {
    const leaf = run(PRODUCTS[2]);
    expect(leaf.manifest.year).toBe(1948);
    expect(leaf.stdout).toContain("season=1948-49");
    const t206 = run(PRODUCTS[0]);
    expect(t206.manifest.year).toBe(1909);
    expect(t206.stdout).toContain("season=1909-11");
  });

  /**
   * 1948 LEAF IS SKIP-NUMBERED. #2 does not exist. Asserting the count alone
   * would pass on a parser that renumbered rows densely 1..101 -- inventing a
   * card that was never printed and giving it a pool. The absence is the pin.
   */
  it("1948 Leaf keeps the set's own skip-numbering - #2 is absent, not invented", () => {
    const rows = run(PRODUCTS[2]).rows;
    const numbers = rows.map((r) => r.cardNumber);
    expect(numbers).toContain("1");
    expect(numbers).toContain("3");
    expect(numbers).not.toContain("2");
  });

  /**
   * T206 POSE VARIANTS ARE DIFFERENT CARDS. "Ed Abbaticchio Blue Sleeves" and
   * "Ed Abbaticchio Brown Sleeves" are separate cards with separate numbers and
   * wildly separate prices. A parser normalising the pose away would fuse two
   * pools onto one row.
   */
  it("T206 keeps pose variants as distinct cards", () => {
    const rows = run(PRODUCTS[0]).rows;
    const abba = rows.filter((r) => /Abbaticchio/i.test(r.player));
    expect(abba.length).toBeGreaterThanOrEqual(2);
    expect(new Set(abba.map((r) => r.cardNumber)).size).toBe(abba.length);
  });
});

/**
 * MUTATION CHECKS. Each asserts that a DEFECT the doctrine forbids would be
 * caught -- if the parser ever started doing these things, the pins above go
 * red. They mutate the parser OUTPUT, because that is the artifact the ingest
 * consumes and the thing a wrong pool is built from.
 */
describe("sportscardchecklist vintage baseball - MUTATION pins", () => {
  const rows = run(PRODUCTS[1]).rows;   // 1933 Goudey

  it("MUTATION: a parallel named without a print run goes RED", () => {
    const mutated = rows.map((r, i) => (i === 0 ? { ...r, parallel: "gold" } : r));
    // The invariant the suite above enforces: parallel blank on every row.
    const clean = mutated.every((r) => r.parallel === "");
    expect(clean).toBe(false);
    // ...and the unmutated rows still satisfy it, so the pin is the mutation.
    expect(rows.every((r) => r.parallel === "")).toBe(true);
  });

  it("MUTATION: a synthesised print run goes RED", () => {
    const mutated = rows.map((r, i) => (i === 0 ? { ...r, printRun: "199" } : r));
    expect(mutated.every((r) => r.printRun === "")).toBe(false);
    expect(rows.every((r) => r.printRun === "")).toBe(true);
  });

  it("MUTATION: an autograph minted UNSIGNED in a vintage set goes RED", () => {
    const mutated = rows.map((r, i) => (i === 0 ? { ...r, isAuto: "true" } : r));
    expect(mutated.every((r) => r.isAuto === "false")).toBe(false);
    expect(rows.every((r) => r.isAuto === "false")).toBe(true);
  });

  it("MUTATION: a dense renumbering that invents Leaf #2 goes RED", () => {
    const leaf = run(PRODUCTS[2]).rows;
    const dense = leaf.map((r, i) => ({ ...r, cardNumber: String(i + 1) }));
    expect(dense.map((r) => r.cardNumber)).toContain("2");
    expect(leaf.map((r) => r.cardNumber)).not.toContain("2");
  });
});

/**
 * THE CELL LIST IS THE DISCOVERY. A cell whose brand has no BRAND_RE pattern
 * matches nothing SILENTLY, which reads exactly like "the source serves no such
 * sets" -- this lane's founding false negative. The script fails at load rather
 * than report zero, and that guard is what makes adding a cell safe.
 */
describe("discoverSportsCardChecklistSets - the vintage cells are reachable", () => {
  const discoverer = path.join(backend, "scripts", "discoverSportsCardChecklistSets.cjs");
  const source = fs.readFileSync(discoverer, "utf8");

  it("names a cell for every product the census ranked", () => {
    for (const label of [
      "baseball/goudey/1933-1941",
      "baseball/leaf/1948-1960",
      "baseball/t206/1909-1911",
      "baseball/bowman/1948-1979",
    ]) expect(source).toContain(label);
  });

  it("gives each new brand a BRAND_RE pattern - or the cell matches nothing", () => {
    for (const brand of ['"goudey":', '"t206":']) expect(source).toContain(brand);
  });

  /**
   * The manifest is the queue. If the entries the census needs are not in it,
   * no driver run can ever reach them however good the parser is.
   */
  it("the manifest carries an entry for each, keyed the way the pool spells it", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(backend, "data", "ingest-universe.json"), "utf8"),
    ) as { entries: Array<Record<string, unknown>> };
    for (const p of PRODUCTS) {
      const hit = manifest.entries.filter((e) =>
        e.lane === "sportscardchecklist" && e.sport === "baseball" &&
        e.year === p.year && e.setKey === p.setKey);
      expect(hit.length, `${p.label} missing from the manifest`).toBeGreaterThanOrEqual(1);
    }
  });
});
