import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * #2023 -- THE BCP CARD-LINE-AS-PARALLEL LISTS (measured read-only 2026-09-09).
 *
 * baseballcardpedia nests card rosters inside the Parallels section as
 * <h3>/<h4> SUBSECTIONS. The ladder reader's heading loop never asked whether a
 * heading was a card line -- its <li> loop has since D33 -- so a heading id like
 * "BDP175_Colby_Rasmus_AU_RC" detagged to "BDP175 Colby Rasmus AU RC" and became
 * a PARALLEL of every base card on the page.
 *
 * The census walked all 5,086,415 baseballcardpedia-sourced catalog rows and
 * found 57,803 whose `parallel` is another card, across 36 (year, setKey) pairs.
 * Sales were counted PER PARTITION against sold_comps: the whole population
 * carries ONE sale. Every row is from the LEGACY baseballcardpedia /
 * baseballcardpedia-graded scrapes -- ZERO from any baseballcardpedia-ladders-*
 * source -- so the reader fix in this PR closes the hole rather than chasing it.
 *
 * These pins hold the LIST SHAPE, and they run the lane's OWN validator rather
 * than a copy of it, so a list that this suite accepts is a list the lane can
 * read. A number edited without re-measuring fails here rather than in an apply.
 */

const DIR = path.join(process.cwd(), "data", "catalog-relocations");
const PREFIX = "2026-09-09-bcp-card-lines-are-not-parallels-";
const BOWMAN_2005 = "2026-09-09-bowman-draft-2005-card-lines-are-not-parallels.json";

const files = readdirSync(DIR).filter((f) => f.startsWith(PREFIX) || f === BOWMAN_2005);
const load = (f: string) => JSON.parse(readFileSync(path.join(DIR, f), "utf8"));

type Entry = { id: string; action: string; to?: string; reason?: string; evidence?: string; keepSales?: boolean };
type List = { generatedAt: string; forLane: string; reportOnlyUntil: string; finding: string; entries: Entry[] };

// The lane's own validator, so the pins cannot drift from what runs.
const { classifyEntry, keepsSales } = require_("../scripts/relocate-catalog-rows-by-list.cjs");

describe("the lists exist and cover the measured population", () => {
  it("writes one list per product, chunked to the runner budget", () => {
    expect(files.length).toBe(49);
  });

  it("names 57,803 entries in total -- the measured census count", () => {
    const total = files.reduce((n, f) => n + (load(f) as List).entries.length, 0);
    expect(total).toBe(57803);
  });

  it("the 2005 Bowman Draft list holds exactly the 682 rows the finding names", () => {
    const doc = load(BOWMAN_2005) as List;
    expect(doc.entries.length).toBe(682);
    // Every one is on the PAPER key -- the Chrome rows #2022 mints are a
    // different setKey and are not in scope here.
    for (const e of doc.entries) {
      expect(e.id).toContain(":2005:bowman-draft-picks-and-prospects:");
    }
  });

  it("no entry appears in two lists", () => {
    const seen = new Set<string>();
    for (const f of files) for (const e of (load(f) as List).entries) {
      expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false);
      seen.add(e.id);
    }
    expect(seen.size).toBe(57803);
  });
});

describe("every list is shaped the way the lane requires", () => {
  it.each(files)("%s", (f) => {
    const doc = load(f) as List;
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
    expect(doc.finding).toMatch(/CF-A-CARD-LINE-IS-NOT-A-RUNG-IN-A-HEADING-EITHER/);
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries.length).toBeGreaterThan(0);
    // The measured 1.826 s/row apply cost against a 150-minute ceiling is what
    // sizes a list; an oversized one is killed mid-apply with no marker.
    expect(doc.entries.length).toBeLessThanOrEqual(2000);
  });
});

describe("every entry is a retire the lane accepts, and keeps its sales", () => {
  it("classifyEntry accepts all 57,803 entries as retires", () => {
    for (const f of files) for (const e of (load(f) as List).entries) {
      const v = classifyEntry(e);
      expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
      expect(v.action).toBe("retire");
      // A retire must never name a destination -- there is no correct address
      // for a row whose parallel is another card, and guessing one is what
      // "one card, one row, one pool" forbids.
      expect(e.to).toBeUndefined();
    }
  });

  it("keepsSales is true for every entry, so the rematch re-places them", () => {
    for (const f of files) {
      const doc = load(f) as List;
      for (const e of doc.entries) expect(keepsSales(doc, e)).toBe(true);
    }
  });

  it("every entry carries a reason and dated, row-specific evidence", () => {
    for (const f of files) for (const e of (load(f) as List).entries) {
      expect(e.reason).toMatch(/CF-A-CARD-LINE-IS-NOT-A-RUNG-IN-A-HEADING-EITHER/);
      expect(e.evidence).toMatch(/source=baseballcardpedia/);
      expect(e.evidence).toMatch(/Sales on this row: \d+/);
      expect(e.evidence).toMatch(/2026-09-09/);
    }
  });
});

describe("the retired rows really are card lines, by the parser's own predicate", () => {
  // The list and the reader must agree about what a card line IS. If they ever
  // disagree, one of them is wrong about 57,803 rows.
  const { isCardLine } = require_("../scripts/scrape-bcp-ladders.cjs");

  it("every entry's evidence names a parallel isCardLine refuses", () => {
    for (const f of files) for (const e of (load(f) as List).entries) {
      const m = /parallel=("(?:[^"\\]|\\.)*")/.exec(e.evidence ?? "");
      expect(m, `no parallel in evidence for ${e.id}`).toBeTruthy();
      expect(isCardLine(JSON.parse(m![1]))).toBe(true);
    }
  });

  it("does not retire a NAMED SET that merely leads with a number", () => {
    // "582 Montgomery Club" is a real 2024 Topps parallel with 700 live rows.
    // It must never appear in these lists.
    for (const f of files) for (const e of (load(f) as List).entries) {
      expect(e.evidence).not.toMatch(/Montgomery Club/);
    }
  });
});
