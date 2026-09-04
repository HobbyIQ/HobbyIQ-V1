/**
 * CF-TRADED-TIFFANY-IS-CHECKLIST-BACKED (Drew, 2026-09-04: "Find it, this is
 * why it's important to get checklists").
 *
 * Topps Traded Tiffany ran EIGHT years, 1984-1991, 132 cards every year. Before
 * this acquisition the catalog held no real checklist for any of them -- only
 * `derived-from-base-checklist-2026-08-23` synthetic rows and `ingest-auto-seed`
 * rows minted from whatever happened to sell. The measured consequence: the raw
 * row for Greg Maddux's 1987 Traded Tiffany rookie
 * (`hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto`) did not exist, and
 * 313 Tiffany Maddux sales sat in the FLAGSHIP `topps` pool pricing an ordinary
 * base card. A checklist is the only artifact that can contradict a sale.
 *
 * SEVEN YEARS FROM sportscardchecklist.com, ONE FROM baseballcardpedia.
 * 1984-1990 each have their own set page (the site spells the product "Topps
 * Tiffany Traded" -- word order reversed from ours). 1991 is the ONLY year that
 * source serves no Traded Tiffany page for; baseballcardpedia's 1991 Topps
 * Traded page documents the parallel in its own words ("For the eighth, and
 * final, year, Topps issued a 'high-end' Tiffany version") and carries the
 * 132-card list.
 *
 * WHY THE PARALLEL COLUMN IS BLANK, AND WHY THAT IS THE WHOLE POINT.
 * Tiffany is carried by the setKey `topps-traded-tiffany`, not by the parallel
 * column. computeHobbyIqCardId reads a blank parallel as the plain card and
 * emits `...:70t:base:no-auto` -- EXACTLY the slug the misfiled sales need.
 * Writing the word "Tiffany" into the column instead emits `...:70t:tiffany:...`,
 * a different address that those sales would never reach, and double-encodes
 * Tiffany into both the set and the rung. Both are asserted below, because this
 * is the single decision the whole acquisition turns on. It matches the ruling
 * already applied to 1987 `topps-tiffany` (Drew, 2026-09-01).
 *
 * TWO MUTATIONS ARE PINNED, per the acceptance criteria:
 *
 *   1. PARALLEL BLANK -> RED. Fill the parallel column with "Tiffany" and the
 *      slug assertion goes red: the row moves off `:base:` and the Maddux sales
 *      are stranded again. This is a mutation the ROW COUNT cannot see.
 *   2. SETKEY COLLAPSE -> RED. Collapse `topps-traded-tiffany` to `topps-traded`
 *      or `topps` -- the exact fall-through CF-CATALOG-TRADED-TIFFANY exists to
 *      prevent -- and the fixed-point assertion goes red. That collapse is what
 *      put Traded rookies in the flagship pool in the first place.
 *
 * Counts are asserted EXACTLY (132) because every failure this lane suffers
 * shows up as a wrong count rather than an exception, and the per-column
 * assertions catch the ones that leave the count alone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildRows, parseSetUrl } = require("../scripts/fetchSportsCardChecklist.cjs");

const SCC_FIX = join(__dirname, "fixtures", "sportscardchecklist");
const STAGED = join(__dirname, "..", "data", "checklists", "scraped");

const SET_KEY = "topps-traded-tiffany";
const YEARS = [1984, 1985, 1986, 1987, 1988, 1989, 1990, 1991] as const;

interface Row {
  category: string; cardNumber: string; parallel: string; isAuto: string;
  printRun: string; player: string; subset: string;
}

/**
 * Split a canonical CSV line, honouring quoted fields — character by character,
 * the same way ingest-checklist-csv-to-catalog.cjs does it. A regex that filters
 * alternate matches silently DROPS empty cells and shifts every later column
 * left, which reads the parallel column as isAuto and loses the player entirely.
 * The staged files are mostly empty cells, so that shift is the default case.
 */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A staged CSV, parsed back exactly as the ingester reads it. */
function staged(year: number): Row[] {
  const text = readFileSync(join(STAGED, `${year}-topps-traded-tiffany-baseball.csv`), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(1).map((l) => {
    const c = splitCsv(l);
    const cell = (i: number) => c[i] ?? "";
    return {
      category: cell(0), cardNumber: cell(1), parallel: cell(2), isAuto: cell(3),
      printRun: cell(4), player: cell(5), subset: "",
    };
  });
}

describe("Topps Traded Tiffany 1984-1991 — every year is checklist-backed", () => {
  for (const year of YEARS) {
    describe(`${year} Topps Traded Tiffany`, () => {
      const rows = staged(year);

      it("holds EXACTLY the published 132-card set", () => {
        expect(rows.length).toBe(132);
      });

      it("runs 1T..132T — verbatim card numbers, unique, no # prefix", () => {
        expect(rows[0].cardNumber).toBe("1T");
        expect(rows[rows.length - 1].cardNumber).toBe("132T");
        expect(new Set(rows.map((r) => r.cardNumber)).size).toBe(132);
        expect(rows.every((r) => !r.cardNumber.startsWith("#"))).toBe(true);
        // The T suffix IS the card number here; stripping it collides every row
        // with the flagship set's plain numbers.
        expect(rows.every((r) => /^\d{1,3}T$/.test(r.cardNumber))).toBe(true);
      });

      it("every row names a player and the set closes on its checklist card", () => {
        expect(rows.every((r) => r.player.trim().length > 0)).toBe(true);
        expect(rows[rows.length - 1].player).toMatch(/^Checklist/);
      });

      // MUTATION 1. Blank means plain. The word "Base" is forbidden outright by
      // docs/reference/checklist-csv-contract.md, and any non-blank value here
      // moves the row off the `:base:` slug the misfiled sales need.
      it("parallel is BLANK on every row — never 'Base', never 'Tiffany'", () => {
        expect(rows.every((r) => r.parallel === "")).toBe(true);
        expect(rows.some((r) => /^base$/i.test(r.parallel))).toBe(false);
        expect(rows.some((r) => /tiffany/i.test(r.parallel))).toBe(false);
      });

      // printRun is serial-only truth. Tiffany states a factory-SET production
      // figure, never a per-card serial, so the column stays blank.
      it("printRun is blank on every row — a set production figure is not a serial", () => {
        expect(rows.every((r) => r.printRun === "")).toBe(true);
      });

      it("isAuto is false — certified autos are a 1990s-onward feature", () => {
        expect(rows.every((r) => r.isAuto === "false")).toBe(true);
      });

      // MUTATION 2. Collapse the setKey and this goes red. `topps-traded-tiffany`
      // must survive normalizeSetKey untouched, or rows land under a key the
      // catalog never queries (#1614, checklist-ingest-leaves-rows-unfindable).
      it("setKey is a normalizeSetKey FIXED POINT, and never collapses to topps", () => {
        expect(normalizeSetKey(SET_KEY)).toBe(SET_KEY);
        expect(normalizeSetKey(normalizeSetKey(SET_KEY))).toBe(SET_KEY);
        expect(normalizeSetKey(`${year} Topps Traded Tiffany`)).toBe(SET_KEY);
        expect(normalizeSetKey(SET_KEY)).not.toBe("topps");
        expect(normalizeSetKey(SET_KEY)).not.toBe("topps-traded");
        expect(normalizeSetKey(SET_KEY)).not.toBe("topps-tiffany");
      });

      it("every row mints a distinct :base: slug under the Tiffany set", () => {
        const slugs = rows.map((r) => computeHobbyIqCardId({
          sport: "baseball", year, setKey: SET_KEY,
          cardNumber: r.cardNumber,
          parallel: r.parallel || "Base",
          isAuto: r.isAuto === "true",
          printRun: r.printRun ? Number(r.printRun) : null,
        }));
        expect(new Set(slugs).size).toBe(132);
        expect(slugs.every((s) => s.startsWith(`hiq:baseball:${year}:${SET_KEY}:`))).toBe(true);
        expect(slugs.every((s) => s.endsWith(":base:no-auto"))).toBe(true);
      });

      it("the manifest names this exact product and its source URL", () => {
        const m = JSON.parse(readFileSync(join(STAGED, `${year}-topps-traded-tiffany-baseball.manifest.json`), "utf8"));
        expect(m.year).toBe(year);
        expect(m.sport).toBe("baseball");
        expect(m.setKey).toBe(SET_KEY);
        expect(m.rowCount).toBe(132);
        expect(m.sourceUrl).toMatch(/^https:\/\//);
        expect(m.setName).toBe(`${year} Topps Traded Tiffany`);
      });
    });
  }
});

describe("the cards Drew named, and the one he warned against inventing", () => {
  it("Greg Maddux is 70T in 1987 — the row that did not exist", () => {
    const maddux = staged(1987).filter((r) => /Maddux/i.test(r.player));
    expect(maddux).toHaveLength(1);
    expect(maddux[0].cardNumber).toBe("70T");
    expect(maddux[0].parallel).toBe("");
    expect(computeHobbyIqCardId({
      sport: "baseball", year: 1987, setKey: SET_KEY, cardNumber: "70T",
      parallel: maddux[0].parallel || "Base", isAuto: false, printRun: null,
    })).toBe("hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto");
  });

  it("Barry Bonds is 11T in 1986", () => {
    const bonds = staged(1986).filter((r) => /^Barry Bonds$/i.test(r.player));
    expect(bonds).toHaveLength(1);
    expect(bonds[0].cardNumber).toBe("11T");
    expect(computeHobbyIqCardId({
      sport: "baseball", year: 1986, setKey: SET_KEY, cardNumber: "11T",
      parallel: bonds[0].parallel || "Base", isAuto: false, printRun: null,
    })).toBe("hiq:baseball:1986:topps-traded-tiffany:11t:base:no-auto");
  });

  // Drew: "McGwire 1985 401 is NOT Traded (don't invent)". McGwire's 1985 card
  // is #401 of the FLAGSHIP set. A Traded row for him would be a fabrication,
  // and the absence is asserted so no future pass quietly adds one.
  it("Mark McGwire appears in NO Traded Tiffany year — 1985 #401 is flagship", () => {
    for (const year of YEARS) {
      expect(staged(year).filter((r) => /McGwire/i.test(r.player))).toHaveLength(0);
    }
  });
});

describe("the scraped pages themselves — parser pins, not just staged bytes", () => {
  // The staged CSV and the live page are pinned SEPARATELY. A test that only
  // read the CSV would stay green if the parser broke and someone re-staged a
  // wrong file; these read the trimmed fixtures through the real parser.
  const SCC = [
    { year: 1984, fixture: "1984-topps-traded-tiffany", setId: "137096", first: "Willie Aikens" },
    { year: 1986, fixture: "1986-topps-traded-tiffany", setId: "133291", first: "Andy Allanson" },
    { year: 1987, fixture: "1987-topps-traded-tiffany", setId: "137204", first: "Bill Almon" },
  ] as const;

  for (const s of SCC) {
    it(`${s.year}: the page parses to 132 cards and both anchors agree`, () => {
      const html = readFileSync(join(SCC_FIX, `${s.fixture}.trimmed.html`), "utf8");
      const { rows, stats } = buildRows(html, {});
      expect(rows.length).toBe(132);
      expect(stats.headers).toBe(132);
      expect(stats.hiddenRows).toBe(132);
      expect(stats.anchorMismatch).toBe(false);
      expect(stats.skipped).toBe(0);
      expect(rows[0].cardNumber).toBe("1T");
      expect(rows[0].player).toBe(s.first);
      expect(rows[131].cardNumber).toBe("132T");
      // The parser must not invent a rung from a slug that merely says Tiffany.
      expect(rows.every((r: Row) => r.parallel === "")).toBe(true);
    });

    it(`${s.year}: the set URL parses as single-year baseball`, () => {
      const url = `https://www.sportscardchecklist.com/set-${s.setId}/${s.year}-topps-tiffany-traded-baseball-trading-card-checklist`;
      const p = parseSetUrl(url);
      expect(p).not.toBeNull();
      expect(p.year).toBe(s.year);
      expect(p.year2).toBeNull();
      expect(p.sport).toBe("baseball");
      expect(p.setId).toBe(s.setId);
    });
  }

  it("1991 comes from baseballcardpedia, which documents the Tiffany parallel", () => {
    const html = readFileSync(join(__dirname, "fixtures", "baseballcardpedia", "1991-topps-traded.trimmed.html"), "utf8");
    const items = html.match(/<li>\s*\d{1,3}T\s+[^<]+<\/li>/g) ?? [];
    expect(items).toHaveLength(132);
    // The page's OWN words are why 1991 is a Tiffany product and not a guess.
    expect(html).toMatch(/eighth, and final, year/);
    expect(html).toMatch(/Tiffany version/);
  });
});
