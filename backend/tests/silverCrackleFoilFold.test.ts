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

type Entry = {
  id: string; action: string; to?: string; reason?: string; evidence?: string;
  nameSuperset?: boolean; afterDerivedRetire?: boolean; salesAtRetireTime?: number;
  parallel?: string;
};
type HeldRow = { id: string; salesCount: number; evidence?: string };
type List = {
  generatedAt: string;
  forLane: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  census: Record<string, unknown>;
  entries: Entry[];
  checkedAt?: string;
  held?: HeldRow[];
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

  it("retire-after-move holds exactly 822 entries (65 name-superset) plus 3 held", () => {
    const doc = load(RETIRE_AFTER_MOVE_FILE);
    expect(doc.entries.length).toBe(822);
    expect(doc.entries.filter((e) => e.nameSuperset).length).toBe(65);
    expect(doc.held?.length).toBe(3);
  });
});

describe("PR #2427 re-review: 3 live sales-holders were pulled out of retire-after-move into a HELD section", () => {
  const EXPECTED_HELD: Record<string, number> = {
    "hiq:baseball:2026:topps:138:silver-crackle-foilboard:no-auto": 2,
    "hiq:baseball:2026:topps:200:silver-crackle-foilboard:no-auto": 1,
    "hiq:baseball:2026:topps:131:silver-crackle-foilboard:no-auto": 1,
  };

  it("the held section names exactly the three ids the live recheck found, with their sale counts", () => {
    const held = load(RETIRE_AFTER_MOVE_FILE).held ?? [];
    expect(held.length).toBe(3);
    for (const h of held) {
      expect(EXPECTED_HELD[h.id], `unexpected held id ${h.id}`).toBeDefined();
      expect(h.salesCount).toBe(EXPECTED_HELD[h.id]);
    }
    const heldIds = new Set(held.map((h) => h.id));
    for (const id of Object.keys(EXPECTED_HELD)) expect(heldIds.has(id)).toBe(true);
  });

  it("none of the three held ids appear anywhere in the retire-after-move entries list", () => {
    const doc = load(RETIRE_AFTER_MOVE_FILE);
    const entryIds = new Set(doc.entries.map((e) => e.id));
    for (const id of Object.keys(EXPECTED_HELD)) expect(entryIds.has(id)).toBe(false);
  });

  it("both retire files record the live-recheck timestamp", () => {
    expect(load(RETIRE_AFTER_MOVE_FILE).checkedAt).toBeTruthy();
    expect(load(RETIRE_DERIVED_FILE).checkedAt).toBeTruthy();
  });
});

describe("every retire entry carries salesAtRetireTime: 0 -- the live pre-commit recheck", () => {
  it("every retire-after-move entry has salesAtRetireTime === 0", () => {
    for (const e of load(RETIRE_AFTER_MOVE_FILE).entries) {
      expect(e.salesAtRetireTime, `${e.id} missing salesAtRetireTime`).toBe(0);
    }
  });

  it("every retire-derived-occupants entry has salesAtRetireTime === 0", () => {
    for (const e of load(RETIRE_DERIVED_FILE).entries) {
      expect(e.salesAtRetireTime, `${e.id} missing salesAtRetireTime`).toBe(0);
    }
  });

  it("no held row is hiding as a live salesAtRetireTime:0 entry -- the field is truly 0, not just present", () => {
    for (const f of [RETIRE_DERIVED_FILE, RETIRE_AFTER_MOVE_FILE]) {
      for (const e of load(f).entries) {
        expect(typeof e.salesAtRetireTime).toBe("number");
        expect(e.salesAtRetireTime).toBe(0);
      }
    }
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
    expect(seen.size).toBe(1656 + 68 + 68 + 822);
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

  /**
   * CF-A-RESLUG-THAT-CHANGES-THE-RUNG-CARRIES-THE-RUNG'S-TEXT (2026-09-26).
   *
   * The defect this fold shipped WITH: crossProductFields() asked
   * moveCatalogRow for a setKey change but never for a parallel change, so
   * buildIncoming's `merged = { ...stripSlugBoundFields(oldRow), ...changedFields }`
   * carried each row's OLD parallel text onto its new canonical id -- 1,500
   * move-01 rows landed with the RIGHT id and the WRONG `parallel` field
   * (confirmed 30/30 sampled on prod). Every entry in every move file changes
   * the parallel SEGMENT (asserted above: `to.parallelSlug` is always
   * "silver-crackle-foil" and always differs from `from.parallelSlug`), so
   * every entry must now carry the human-form text the fixed lane requires.
   *
   * move-01.json ITSELF IS EXCLUDED HERE, deliberately: it already APPLIED
   * (run 36204682368) before this fix existed, so its own file is frozen as
   * the historical record of what actually ran -- the 1,500 rows it wrote are
   * healed going FORWARD by 2026-09-26-silver-crackle-foil-heal-parallel-
   * text.json (see the heal-list describe block below), never by rewriting
   * the list that already ran. move-02 and move-03, not yet applied, are
   * updated in place instead and are covered here.
   */
  it("every move-02/move-03 entry whose rung segment changes carries the human-form parallel text", () => {
    for (const f of [MOVE_FREE_FILES[1], MOVE_AFTER_DERIVED_FILE]) {
      for (const e of load(f).entries) {
        const from = parseSlug(e.id);
        const to = parseSlug(e.to!);
        // Every entry in these files changes the rung (pinned above); the
        // guard is written generally so a future entry that did NOT change
        // the rung would correctly be exempt rather than silently required.
        if (from.parallelSlug === to.parallelSlug) continue;
        expect(e.parallel, `${e.id} changes the rung but carries no "parallel" text`).toBe(CANON);
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
  it("all five files' entry counts sum to the measured 2,614 listed rows (2,617 minus the 3 held)", () => {
    const total = ALL_FILES.reduce((n, f) => n + load(f).entries.length, 0);
    expect(total).toBe(1656 + 68 + 68 + 822);
    expect(total).toBe(2614);
  });

  it("the stale '36 groups' claim is corrected to 35 groups / 65 entries in retire-after-move's finding", () => {
    const doc = load(RETIRE_AFTER_MOVE_FILE);
    expect(doc.finding).toMatch(/35 of them pure name-superset/);
    expect(doc.finding).not.toMatch(/36 of them/);
  });
});

// ── the heal list for move-01's already-written rows ────────────────────────

/**
 * CF-A-RESLUG-THAT-CHANGES-THE-RUNG-CARRIES-THE-RUNG'S-TEXT, the heal half
 * (2026-09-26). move-01.json's own APPLY (run 36204682368) landed before the
 * lane fix existed, so its 1,500 rows carry the RIGHT id and the WRONG
 * `parallel` text (confirmed 30/30 sampled on prod). This list heals them in
 * place through the new `patchFields` action -- id unchanged, verified
 * canonical, parallel (and its derived/search fields) rewritten.
 */
const HEAL_FILE = "2026-09-26-silver-crackle-foil-heal-parallel-text.json";

describe("the heal list covers exactly move-01's 1,500 destinations", () => {
  const heal = load(HEAL_FILE);
  const move01 = load(MOVE_FREE_FILES[0]);

  it("holds exactly 1,500 entries, every one patchFields with no destination", () => {
    expect(heal.entries).toHaveLength(1500);
    for (const e of heal.entries) {
      expect(e.action).toBe("patchFields");
      expect(e.to).toBeUndefined();
      expect(e.parallel).toBe(CANON);
    }
  });

  it("its ids are EXACTLY move-01's `to` ids, no more and no fewer", () => {
    const healIds = new Set(heal.entries.map((e) => e.id));
    const move01Tos = new Set(move01.entries.map((e) => e.to));
    expect(healIds.size).toBe(1500);
    expect(move01Tos.size).toBe(1500);
    for (const id of move01Tos) expect(healIds.has(id), `${id} missing from heal list`).toBe(true);
    for (const id of healIds) expect(move01Tos.has(id), `${id} not a move-01 destination`).toBe(true);
  });

  it("names this lane, states its ruling and cites the offending run", () => {
    expect(heal.forLane).toBe("relocate-catalog-rows-by-list");
    expect(heal.reportOnlyUntil).toMatch(/no apply is authorized/i);
    expect(JSON.stringify(heal.rulings)).toMatch(/36204682368/);
    expect(JSON.stringify(heal.rulings)).toMatch(/crossProductFields/);
    expect(heal.checkedAt).toBeTruthy();
  });

  it("every entry passes the lane's own validation", () => {
    for (const e of heal.entries) {
      const v = classifyEntry(e);
      expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
      expect(v.action).toBe("patchFields");
    }
  });

  it("every entry's id already computes from itself with the new parallel text", () => {
    for (const e of heal.entries) {
      const p = parseSlug(e.id);
      const recomputed = computeHobbyIqCardId({
        sport: p.sport, year: p.year, setKey: p.setKey, cardNumber: p.cardNumber,
        parallel: e.parallel!, isAuto: p.autoSeg === "auto",
        printRun: p.printRunSeg ? Number(p.printRunSeg.replace(/^num-/, "")) : null,
      });
      expect(recomputed).toBe(e.id);
    }
  });

  it("no duplicate ids", () => {
    const ids = heal.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
