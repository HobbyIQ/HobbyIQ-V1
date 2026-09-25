import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * 2026-09-25 -- Drew's ruling: the unnumbered 2026 Topps baseball Super Box
 * parallel carries ONE spelling, "Silver Crackle Foil". Five non-canonical
 * spellings of the same unnumbered non-auto rung were measured under setKeys
 * topps / topps-series-1 / topps-series-2 / topps-update / topps-chrome:
 * "Silver Crackle Foil (Super Box exclusive)" (1,712), "Silver Crackleboard
 * Foil Board" / "Crackleboard Foil" (350+150=500), "Silver Crackle Foilboard"
 * (375), bare "Silver Crackle" (none found). Colour rungs are DISTINCT cards
 * and are outside this fold entirely.
 *
 * REVISED 2026-09-25 after PR #2427 review (REQUEST CHANGES): the original
 * single retire list was INVERTED -- it accepted DERIVED occupants
 * (catalog-explode-actuals-2026-08-12) as checklist-grade via a hand-rolled
 * source-prefix regex that never matched `^catalog-explode`. Every grade
 * decision is now made with the REAL catalogAuthorityOf, and the fold is
 * split into five files reflecting the correct apply order:
 *
 *   1. retire-derived-occupants.json   the DERIVED row at the canonical
 *                                      address is retired first (0 sales only)
 *   2. move-01/move-02.json            free destinations, run any time
 *   3. move-03-after-derived-retire    depends on (1) having landed
 *   4. retire-after-move.json          losing same-player duplicates, LAST
 *
 * These pins lean on the lane's own `classifyEntry` (never a
 * re-implementation), the real `computeHobbyIqCardId`, and the real
 * `catalogAuthorityOf` (never a source-prefix guess), so a list this suite
 * accepts is a list the lane can read and grade the same way it will.
 */

const DIR = path.join(process.cwd(), "data", "catalog-relocations");
const MOVE_FREE_FILES = ["2026-09-25-silver-crackle-foil-move-01.json", "2026-09-25-silver-crackle-foil-move-02.json"];
const MOVE_AFTER_DERIVED_FILE = "2026-09-25-silver-crackle-foil-move-03-after-derived-retire.json";
const ALL_MOVE_FILES = [...MOVE_FREE_FILES, MOVE_AFTER_DERIVED_FILE];
const RETIRE_DERIVED_FILE = "2026-09-25-silver-crackle-foil-retire-derived-occupants.json";
const RETIRE_AFTER_MOVE_FILE = "2026-09-25-silver-crackle-foil-retire-after-move.json";
const ALL_FILES = [...ALL_MOVE_FILES, RETIRE_DERIVED_FILE, RETIRE_AFTER_MOVE_FILE];

type Entry = { id: string; action: string; to?: string; reason?: string; evidence?: string; nameSuperset?: boolean; afterDerivedRetire?: boolean };
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

// The REAL identity function -- never a re-implementation.
const { computeHobbyIqCardId } = require_("../dist/services/portfolioiq/hobbyIqCardId.service.js") as {
  computeHobbyIqCardId: (c: Record<string, unknown>) => string;
};

// The REAL authority classifier -- never a source-prefix guess. This is the
// exact function whose absence caused the #2427 inversion.
const { catalogAuthorityOf } = require_("../dist/services/catalog/catalogAuthority.service.js") as {
  catalogAuthorityOf: (source: string | null | undefined) => "checklist" | "vendor" | "derived" | "unknown";
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

function parseSlug(slug: string) {
  const parts = slug.split(":");
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

function evidenceSource(evidence: string | undefined): string | null {
  const m = /source=([^,.\s]+(?:-[a-z0-9-]+)?)/.exec(evidence ?? "");
  return m ? m[1] : null;
}

describe("catalogAuthorityOf agrees with the finding on the two source classes this fold depends on", () => {
  it("classifies the DERIVED occupant sources as derived, never checklist", () => {
    expect(catalogAuthorityOf("catalog-explode-actuals-2026-08-12")).toBe("derived");
    expect(catalogAuthorityOf("ingest-auto-seed")).toBe("derived");
  });

  it("classifies the checklist-transcription sources as checklist, never derived", () => {
    expect(catalogAuthorityOf("checklistinsider-2026-08-27")).toBe("checklist");
    expect(catalogAuthorityOf("checklistcenter-2026-08-29")).toBe("checklist");
    expect(catalogAuthorityOf("baseballcardpedia-ladders-2026-08-28")).toBe("checklist");
  });
});

describe("the five files exist, are chunked to the runner budget, and cover the measured population", () => {
  it("move-01/move-02 are each <= 2000 entries and total 1,656", () => {
    let total = 0;
    for (const f of MOVE_FREE_FILES) {
      const doc = load(f);
      expect(doc.entries.length).toBeGreaterThan(0);
      expect(doc.entries.length).toBeLessThanOrEqual(2000);
      total += doc.entries.length;
    }
    expect(total).toBe(1656);
  });

  it("move-03-after-derived-retire holds exactly 68 entries", () => {
    expect(load(MOVE_AFTER_DERIVED_FILE).entries.length).toBe(68);
  });

  it("retire-derived-occupants holds exactly 68 entries -- one per move-03 entry's destination", () => {
    expect(load(RETIRE_DERIVED_FILE).entries.length).toBe(68);
  });

  it("retire-after-move holds exactly 825 entries (65 name-superset)", () => {
    const doc = load(RETIRE_AFTER_MOVE_FILE);
    expect(doc.entries.length).toBe(825);
    expect(doc.entries.filter((e) => e.nameSuperset).length).toBe(65);
  });
});

describe("no destination appears twice across ALL move files -- exactly one mover per address", () => {
  it("every move entry's `to` is unique across move-01, move-02, and move-03", () => {
    const seen = new Set<string>();
    let total = 0;
    for (const f of ALL_MOVE_FILES) {
      for (const e of load(f).entries) {
        expect(e.to, `${e.id} has no destination`).toBeTruthy();
        expect(seen.has(e.to!), `destination ${e.to} targeted by more than one mover (also ${e.id})`).toBe(false);
        seen.add(e.to!);
        total++;
      }
    }
    expect(total).toBe(1656 + 68);
    expect(seen.size).toBe(total);
  });

  it("no id appears twice across all five files", () => {
    const seen = new Set<string>();
    for (const f of ALL_FILES) {
      for (const e of load(f).entries) {
        expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false);
        seen.add(e.id);
      }
    }
    expect(seen.size).toBe(1656 + 68 + 68 + 825);
  });
});

describe("every list is shaped the way the lane requires, and states its apply order", () => {
  it.each(ALL_FILES)("%s", (f) => {
    const doc = load(f);
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
    // Every finding cites the 2026-09-25 ruling; not every file's finding
    // repeats the canonical spelling verbatim (retire-after-move's finding
    // describes the DEDUPE shape, not the fold itself).
    expect(doc.finding).toMatch(/2026-09-25/);
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries.length).toBeGreaterThan(0);
  });

  it("the two fold-specific files' findings name the canonical spelling", () => {
    for (const f of [...MOVE_FREE_FILES, MOVE_AFTER_DERIVED_FILE, RETIRE_DERIVED_FILE]) {
      expect(load(f).finding).toMatch(/Silver Crackle Foil/);
    }
  });

  it.each(ALL_FILES)("%s states its position in the apply sequence", (f) => {
    const doc = load(f);
    const joined = doc.rulings.join(" ");
    expect(joined).toMatch(/APPLY ORDER/);
  });

  it("retire-derived-occupants states it applies FIRST", () => {
    const joined = load(RETIRE_DERIVED_FILE).rulings.join(" ");
    expect(joined).toMatch(/APPLY ORDER:\s*1st/);
  });

  it("move-03-after-derived-retire states it depends on the derived retire", () => {
    const joined = load(MOVE_AFTER_DERIVED_FILE).rulings.join(" ");
    expect(joined).toMatch(/APPLY ORDER:\s*3rd/);
    expect(joined).toMatch(/retire-derived-occupants/);
  });

  it("retire-after-move states it applies LAST", () => {
    const joined = load(RETIRE_AFTER_MOVE_FILE).rulings.join(" ");
    expect(joined).toMatch(/APPLY ORDER:\s*LAST/);
  });
});

describe("the ruling's source quotes and the #2427 inversion correction are in every list's rulings block", () => {
  it.each(ALL_FILES)("%s cites the three non-canonical spellings and the catalogAuthorityOf correction", (f) => {
    const doc = load(f);
    const joined = doc.rulings.join(" ");
    expect(joined).toMatch(/Silver Crackle Foil \(Super Box exclusive\)/);
    expect(joined).toMatch(/Silver Crackleboard Foil Board/);
    expect(joined).toMatch(/Silver Crackle Foilboard/);
    expect(joined).toMatch(/catalogAuthorityOf/);
    expect(joined).toMatch(/INVERTED|inversion/i);
  });
});

describe("classifyEntry (the lane's own function) accepts every entry", () => {
  it("every move entry (all three files) is a reslug the lane accepts", () => {
    for (const f of ALL_MOVE_FILES) {
      for (const e of load(f).entries) {
        const v = classifyEntry(e);
        expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
        expect(v.action).toBe("reslug");
        expect(e.to, `${e.id}: reslug with no destination`).toBeTruthy();
      }
    }
  });

  it("every retire entry (both files) is a retire the lane accepts, and names no destination", () => {
    for (const f of [RETIRE_DERIVED_FILE, RETIRE_AFTER_MOVE_FILE]) {
      for (const e of load(f).entries) {
        const v = classifyEntry(e);
        expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
        expect(v.action).toBe("retire");
        expect(e.to).toBeUndefined();
      }
    }
  });

  it("every entry carries a reason citing the 2026-09-25 ruling", () => {
    for (const f of ALL_FILES) {
      for (const e of load(f).entries) {
        expect(e.reason).toMatch(/Silver Crackle Foil|2026-09-25/);
        expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
      }
    }
  });
});

describe("every move changes ONLY the parallel to Silver Crackle Foil -- one axis", () => {
  for (const f of ALL_MOVE_FILES) {
    it(`${f}: id and to agree on sport/year/cardNumber/auto/printRun; setKey folds series-1/2 into topps`, () => {
      for (const e of load(f).entries) {
        const from = parseSlug(e.id);
        const to = parseSlug(e.to!);
        expect(to.sport).toBe(from.sport);
        expect(to.year).toBe(from.year);
        expect(to.cardNumber).toBe(from.cardNumber);
        expect(to.autoSeg).toBe(from.autoSeg);
        expect(to.printRunSeg).toBe(from.printRunSeg);
        expect(to.parallelSlug).not.toBe(from.parallelSlug);
        expect(to.parallelSlug).toBe("silver-crackle-foil");
        if (from.setKey === "topps-series-1" || from.setKey === "topps-series-2") {
          expect(to.setKey).toBe("topps");
        } else {
          expect(to.setKey).toBe(from.setKey);
        }
      }
    });
  }

  it("no entry's source parallel contains a colour word -- colour rungs are DISTINCT cards, never folded", () => {
    for (const f of ALL_FILES) {
      for (const e of load(f).entries) {
        const m = /parallel=(?:"([^"]*)"|(\S+))/.exec(e.evidence ?? "");
        expect(m, `no parallel captured in evidence for ${e.id}`).toBeTruthy();
        const parallel = (m![1] ?? m![2] ?? "").replace(/^"|"$/g, "");
        expect(COLOR_WORDS.test(parallel)).toBe(false);
      }
    }
  });
});

describe("the real computeHobbyIqCardId reproduces every move's destination", () => {
  it("re-deriving from the id's own segments with parallel forced to Silver Crackle Foil lands on `to`", () => {
    for (const f of ALL_MOVE_FILES) {
      for (const e of load(f).entries) {
        const from = parseSlug(e.id);
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

describe("retire-derived-occupants: every twin IS derived by the real catalogAuthorityOf, never checklist", () => {
  it("every entry's recorded occupant source classifies as derived", () => {
    const doc = load(RETIRE_DERIVED_FILE);
    for (const e of doc.entries) {
      const src = evidenceSource(e.evidence);
      expect(src, `no source captured in evidence for ${e.id}`).toBeTruthy();
      expect(catalogAuthorityOf(src), `${e.id}: occupant source "${src}" is not derived`).toBe("derived");
    }
  });

  it("every entry confirms zero sold_comps sales by its exact id", () => {
    for (const e of load(RETIRE_DERIVED_FILE).entries) {
      expect(e.evidence).toMatch(/0 rows -- safe to delete/);
    }
  });
});

describe("retire-after-move: no entry's twin (the mover it waits on) is DERIVED", () => {
  it("every entry whose evidence names a mover has a mover id, never a derived twin", () => {
    const doc = load(RETIRE_AFTER_MOVE_FILE);
    // The retire-after-move shape never itself retires a DERIVED row -- that
    // is retire-derived-occupants' job. Every entry here retires a losing
    // CHECKLIST-grade duplicate, so its own recorded source must never
    // classify as derived by the real function.
    for (const e of doc.entries) {
      const src = evidenceSource(e.evidence);
      if (src) {
        expect(catalogAuthorityOf(src), `${e.id}: its OWN source "${src}" classifies as derived -- this shape must never retire a derived row`).not.toBe("derived");
      }
    }
  });
});

describe("every source parallel is one of the ruling's non-canonical spellings, never the canonical one itself", () => {
  // retire-derived-occupants.json is the one exception: its evidence records
  // the OCCUPANT's own parallel, which IS the canonical spelling -- the
  // occupant sits AT the canonical address and is being retired FROM it, not
  // moved onto it. Every other file's evidence names the SOURCE row's
  // non-canonical spelling.
  const SOURCE_SPELLING_FILES = ALL_FILES.filter((f) => f !== RETIRE_DERIVED_FILE);

  it.each(SOURCE_SPELLING_FILES)("%s", (f) => {
    for (const e of load(f).entries) {
      const m = /parallel=(?:"([^"]*)"|(\S+))/.exec(e.evidence ?? "");
      const parallel = (m?.[1] ?? m?.[2] ?? "").replace(/^"|"$/g, "").replace(/,$/, "");
      expect(parallel).not.toBe(CANON);
      expect(RULING_SPELLINGS.has(parallel), `${e.id}: "${parallel}" is not one of the ruling's named spellings`).toBe(true);
    }
  });

  it("retire-derived-occupants.json's evidence names the CANONICAL parallel -- the occupant sits at the destination itself", () => {
    for (const e of load(RETIRE_DERIVED_FILE).entries) {
      const m = /parallel=(?:"([^"]*)"|(\S+))/.exec(e.evidence ?? "");
      const parallel = (m?.[1] ?? m?.[2] ?? "").replace(/^"|"$/g, "").replace(/,$/, "");
      expect(parallel).toBe(CANON);
    }
  });
});

describe("counts reconcile against the census in the file headers", () => {
  it("all five files' entry counts sum to the measured 2,617 listed rows", () => {
    const total = ALL_FILES.reduce((n, f) => n + load(f).entries.length, 0);
    expect(total).toBe(1656 + 68 + 68 + 825);
    expect(total).toBe(2617);
  });
});
