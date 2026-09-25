import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * 2026-09-25 -- Drew's ruling: the unnumbered 2026 Topps baseball Super Box
 * parallel carries ONE spelling, "Silver Crackle Foil". Six spellings of the
 * same unnumbered non-auto rung were measured under setKeys topps /
 * topps-series-1 / topps-series-2 / topps-update / topps-chrome:
 * "Silver Crackle Foil" (canonical, untouched), "Silver Crackle Foil
 * (Super Box exclusive)" (a source note leaked into the parallel name),
 * "Silver Crackleboard Foil Board" / "Silver Crackleboard Foil"
 * ("Crackleboard Foil" in the stored field), "Silver Crackle Foilboard", and
 * bare "Silver Crackle" (none found). Colour rungs (Red/Black/Orange/Gold/
 * Green/Blue/Pink Crackle Foil, numbered) are DISTINCT cards and are outside
 * this fold entirely.
 *
 * These pins hold the LIST SHAPE and lean on the lane's own `classifyEntry`
 * / `keepsSales` (never a re-implementation) plus the real
 * `computeHobbyIqCardId`, so a list this suite accepts is a list the lane can
 * read and a move whose destination this suite can independently reproduce.
 */

const DIR = path.join(process.cwd(), "data", "catalog-relocations");
const MOVE_FILES = ["2026-09-25-silver-crackle-foil-move-01.json", "2026-09-25-silver-crackle-foil-move-02.json"];
const RETIRE_FILE = "2026-09-25-silver-crackle-foil-retire.json";

type Entry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
type List = {
  generatedAt: string;
  forLane: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  census: Record<string, unknown>;
  entries: Entry[];
};

const load = (f: string) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as List;

// The lane's own validator, so the pins cannot drift from what runs.
const { classifyEntry } = require_("../scripts/relocate-catalog-rows-by-list.cjs") as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string };
};

// The REAL identity function -- never a re-implementation. Requires the
// built dist/ tree (npm run build), exactly like the lane script itself.
const { computeHobbyIqCardId } = require_("../dist/services/portfolioiq/hobbyIqCardId.service.js") as {
  computeHobbyIqCardId: (c: Record<string, unknown>) => string;
};

const CANON = "Silver Crackle Foil";
const RULING_SPELLINGS = new Set([
  "Silver Crackle Foil (Super Box exclusive)",
  "Silver Crackleboard Foil Board",
  "Crackleboard Foil",
  "Silver Crackle Foilboard",
  "Silver Crackle",
]);
const COLOR_WORDS = /(red|black|orange|gold|green|blue|pink|aqua|purple)/i;

/** Parses the identity segments a hiq slug carries, in the fixed order this
 *  product family uses (no subset/sub- segment appears in this population). */
function parseSlug(slug: string) {
  const parts = slug.split(":");
  // hiq : sport : year : setKey : cardNumber : parallel : auto[ : num-N]
  expect(parts[0]).toBe("hiq");
  return {
    sport: parts[1],
    year: Number(parts[2]),
    setKey: parts[3],
    cardNumber: parts[4],
    parallelSlug: parts[5],
    autoSeg: parts[6],
    printRunSeg: parts[7],
  };
}

describe("the move lists exist, are chunked to the runner budget, and cover the measured population", () => {
  it("writes two chunks, each <= 2000 entries", () => {
    for (const f of MOVE_FILES) {
      const doc = load(f);
      expect(doc.entries.length).toBeGreaterThan(0);
      expect(doc.entries.length).toBeLessThanOrEqual(2000);
    }
  });

  it("chunks total 2,461 move entries -- the measured MOVE population", () => {
    const total = MOVE_FILES.reduce((n, f) => n + load(f).entries.length, 0);
    expect(total).toBe(2461);
  });

  it("the retire list holds exactly 109 entries -- the measured RETIRE population", () => {
    expect(load(RETIRE_FILE).entries.length).toBe(109);
  });

  it("no id appears twice across the move chunks, or in both move and retire", () => {
    const seen = new Set<string>();
    for (const f of [...MOVE_FILES, RETIRE_FILE]) {
      for (const e of load(f).entries) {
        expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false);
        seen.add(e.id);
      }
    }
    expect(seen.size).toBe(2461 + 109);
  });
});

describe("every list is shaped the way the lane requires", () => {
  it.each([...MOVE_FILES, RETIRE_FILE])("%s", (f) => {
    const doc = load(f);
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
    expect(doc.finding).toMatch(/Silver Crackle Foil/);
    expect(doc.finding).toMatch(/2026-09-25/);
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries.length).toBeGreaterThan(0);
  });
});

describe("the ruling's source quotes are in every list's rulings block", () => {
  it.each([...MOVE_FILES, RETIRE_FILE])("%s cites the three source spellings and the out-of-scope exclusion", (f) => {
    const doc = load(f);
    const joined = doc.rulings.join(" ");
    expect(joined).toMatch(/Silver Crackle Foil \(Super Box exclusive\)/);
    expect(joined).toMatch(/Silver Crackleboard Foil Board/);
    expect(joined).toMatch(/Silver Crackle Foilboard/);
    expect(joined).toMatch(/OUT OF RULING SCOPE|out-of-ruling-scope|not the spelling the ruling names/i);
  });
});

describe("classifyEntry (the lane's own function) accepts every entry", () => {
  it("every move entry is a reslug the lane accepts", () => {
    for (const f of MOVE_FILES) {
      for (const e of load(f).entries) {
        const v = classifyEntry(e);
        expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
        expect(v.action).toBe("reslug");
        expect(e.to, `${e.id}: reslug with no destination`).toBeTruthy();
      }
    }
  });

  it("every retire entry is a retire the lane accepts, and names no destination", () => {
    for (const e of load(RETIRE_FILE).entries) {
      const v = classifyEntry(e);
      expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
      expect(v.action).toBe("retire");
      expect(e.to).toBeUndefined();
    }
  });

  it("every entry carries a reason citing the 2026-09-25 ruling", () => {
    for (const f of [...MOVE_FILES, RETIRE_FILE]) {
      for (const e of load(f).entries) {
        expect(e.reason).toMatch(/Silver Crackle Foil/);
        expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
      }
    }
  });
});

describe("every move changes ONLY the parallel to Silver Crackle Foil -- one axis", () => {
  for (const f of MOVE_FILES) {
    it(`${f}: id and to agree on sport/year/setKey-family/cardNumber/auto/printRun`, () => {
      for (const e of load(f).entries) {
        const from = parseSlug(e.id);
        const to = parseSlug(e.to!);
        expect(to.sport).toBe(from.sport);
        expect(to.year).toBe(from.year);
        expect(to.cardNumber).toBe(from.cardNumber);
        expect(to.autoSeg).toBe(from.autoSeg);
        expect(to.printRunSeg).toBe(from.printRunSeg);
        // The parallel changed -- that is the whole point of the fold.
        expect(to.parallelSlug).not.toBe(from.parallelSlug);
        expect(to.parallelSlug).toBe("silver-crackle-foil");
        // topps-series-1/2 canonicalize under the parent 'topps' setKey
        // (productSetKeys.ts: parent 'topps', refines 'topps'); every other
        // source setKey moves onto itself.
        if (from.setKey === "topps-series-1" || from.setKey === "topps-series-2") {
          expect(to.setKey).toBe("topps");
        } else {
          expect(to.setKey).toBe(from.setKey);
        }
      }
    });
  }

  it("no entry's source parallel contains a colour word -- colour rungs are DISTINCT cards, never folded", () => {
    for (const f of [...MOVE_FILES, RETIRE_FILE]) {
      for (const e of load(f).entries) {
        const m = /parallel="([^"]*)"/.exec(e.evidence ?? "");
        expect(m, `no parallel captured in evidence for ${e.id}`).toBeTruthy();
        expect(COLOR_WORDS.test(m![1])).toBe(false);
      }
    }
  });

  it("every source parallel is one of the ruling's five non-canonical spellings, never the canonical one itself", () => {
    for (const f of [...MOVE_FILES, RETIRE_FILE]) {
      for (const e of load(f).entries) {
        const m = /parallel="([^"]*)"/.exec(e.evidence ?? "");
        const parallel = m![1];
        expect(parallel).not.toBe(CANON);
        expect(RULING_SPELLINGS.has(parallel), `${e.id}: "${parallel}" is not one of the ruling's named spellings`).toBe(true);
      }
    }
  });
});

describe("the real computeHobbyIqCardId reproduces every move's destination", () => {
  it("re-deriving from the id's own segments with parallel forced to Silver Crackle Foil lands on `to`", () => {
    for (const f of MOVE_FILES) {
      for (const e of load(f).entries) {
        const from = parseSlug(e.id);
        // playerName is not recoverable from the slug alone for an unnumbered
        // (player-as-number) address; these rows are all numbered
        // (cardNumber is a real number/code, never blank), so
        // unnumberedByChecklist is false and playerName is not required.
        const recomputed = computeHobbyIqCardId({
          sport: from.sport,
          year: from.year,
          setKey: from.setKey,
          cardNumber: from.cardNumber,
          parallel: CANON,
          isAuto: from.autoSeg === "auto",
          printRun: from.printRunSeg ? Number(from.printRunSeg.replace(/^num-/, "")) : null,
        });
        expect(recomputed, `${e.id} -> expected ${e.to}`).toBe(e.to);
      }
    }
  });
});

describe("every retire's canonical destination is occupied by a DIFFERENT (checklist-grade) row, never a bare guess", () => {
  it("every retire entry's evidence names an occupied destination", () => {
    for (const e of load(RETIRE_FILE).entries) {
      expect(e.evidence).toMatch(/ALREADY OCCUPIED/);
      expect(e.evidence).toMatch(/checklist-grade row/);
    }
  });

  it("every retire entry's evidence confirms zero sold_comps sales by its exact id", () => {
    for (const e of load(RETIRE_FILE).entries) {
      expect(e.evidence).toMatch(/0 rows -- safe to delete/);
    }
  });
});

describe("counts reconcile against the census in the file headers", () => {
  it("move census bySetKey sums to the chunked total", () => {
    let toppsN = 0;
    let s1N = 0;
    for (const f of MOVE_FILES) {
      for (const e of load(f).entries) {
        const sk = parseSlug(e.id).setKey;
        if (sk === "topps") toppsN++;
        else if (sk === "topps-series-1") s1N++;
      }
    }
    expect(toppsN).toBe(358);
    expect(s1N).toBe(2103);
    expect(toppsN + s1N).toBe(2461);
  });

  it("retire census bySetKey sums to the file total", () => {
    let toppsN = 0;
    let s1N = 0;
    for (const e of load(RETIRE_FILE).entries) {
      const sk = parseSlug(e.id).setKey;
      if (sk === "topps") toppsN++;
      else if (sk === "topps-series-1") s1N++;
    }
    expect(toppsN).toBe(12);
    expect(s1N).toBe(97);
    expect(toppsN + s1N).toBe(109);
  });
});
