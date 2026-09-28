import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * Drew's ruling (2026-09-28 12:30Z): 2025 Topps Chrome baseball (setKey
 * topps-chrome) canonical rung names are "RayWave Refractor" (base) and
 * "<Color> RayWave Refractor" (compound RayWave, capital W) for Purple
 * /250, Aqua /199, Blue /150, Green /99, Gold /50, Orange /25, Black /10,
 * Red /5 -- verified against backend/data/checklists/hand-fetched/
 * parallels-2025-topps-chrome-baseball.json (baseballcardpedia, citing
 * Topps' own printed checklist).
 *
 * Read-only census of every hiq:baseball:2025:topps-chrome:* row whose
 * parallel matches /ray\s*wave/i (20,847 rows, 35 spellings, one of which
 * -- "...1 Per Value Blaster Box..." -- is a non-rung token held out as
 * needsRuling). Scope is PURE-NUMERIC cardNumbers only (the genuine base
 * set, 1-473): non-numeric cardNumbers are a documented, already-flagged
 * wrong-key/cross-product contamination (see the reslug list's own
 * rulings block) and a further 215 groups are cross-sport (NFL player
 * names) DERIVED-only rows with no checklist-grade evidence -- both held
 * out, never touched by these three lists.
 *
 * See the sidecar 2026-09-28-topps-chrome-2025-raywave-consolidation.md
 * for the full counts breakdown this file pins.
 */

const RELOCATIONS_DIR = path.join(process.cwd(), "data", "catalog-relocations");
const REPOINTS_DIR = path.join(process.cwd(), "data", "sales-repoints");

const RESLUG_FILE = "2026-09-28-topps-chrome-2025-raywave-reslug.json";
const RETIRE_FILE = "2026-09-28-topps-chrome-2025-raywave-retire.json";
const REPOINT_FILE = "2026-09-28-topps-chrome-2025-raywave-to-canonical.json";

type RelocEntry = {
  id: string; action: string; to?: string; parallel?: string;
  requireTwinId?: string; reason?: string; evidence?: string;
};
type RepointEntry = {
  fromId: string; toId: string; player?: string; cardNumber?: string;
  reason?: string; expectedSales?: number; allowCrossProduct?: boolean;
};
type RelocList = {
  generatedAt: string; forLane: string; reportOnlyUntil: string;
  finding: string; rulings: string[]; census: Record<string, unknown>;
  entries: RelocEntry[];
};
type RepointList = {
  generatedAt: string; forLane: string; reportOnlyUntil: string;
  finding: string; rulings: string[]; census: Record<string, unknown>;
  entries: RepointEntry[];
};

const loadReloc = (dir: string, f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as RelocList;
const loadRepoint = (dir: string, f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as RepointList;

// The lanes' own validators -- never a re-implementation.
const relocLane = require_(path.join(process.cwd(), "scripts", "relocate-catalog-rows-by-list.cjs")) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string; to?: string; requireTwinId?: string | null };
};
const repointLane = require_(path.join(process.cwd(), "scripts", "repoint-sales-by-list.cjs")) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string };
};
const { computeHobbyIqCardId } = require_(path.join(process.cwd(), "dist", "services", "portfolioiq", "hobbyIqCardId.service.js")) as {
  computeHobbyIqCardId: (c: Record<string, unknown>) => string;
};
const { catalogAuthorityOf } = require_(path.join(process.cwd(), "dist", "services", "catalog", "catalogAuthority.service.js")) as {
  catalogAuthorityOf: (source: string | null | undefined) => "checklist" | "vendor" | "derived" | "unknown";
};

const CANON_TEXT: Record<string, string> = {
  Base: "RayWave Refractor", Purple: "Purple RayWave Refractor", Aqua: "Aqua RayWave Refractor",
  Blue: "Blue RayWave Refractor", Green: "Green RayWave Refractor", Gold: "Gold RayWave Refractor",
  Orange: "Orange RayWave Refractor", Black: "Black RayWave Refractor", Red: "Red RayWave Refractor",
};
const EXPECTED_PR: Record<string, number> = {
  Base: 7800, Purple: 250, Aqua: 199, Blue: 150, Green: 99, Gold: 50, Orange: 25, Black: 10, Red: 5,
};

function parseSlug(slug: string) {
  const parts = slug.split(":");
  expect(parts[0]).toBe("hiq");
  return {
    sport: parts[1], year: Number(parts[2]), setKey: parts[3], cardNumber: parts[4],
    parallelSlug: parts[5], autoSeg: parts[6], printRunSeg: parts[7],
  };
}

function colourFromSlug(parallelSlug: string): string {
  for (const c of Object.keys(CANON_TEXT)) {
    if (c === "Base") continue;
    if (parallelSlug.startsWith(c.toLowerCase())) return c;
  }
  return "Base";
}

describe("the reslug list exists, is shaped correctly, and holds exactly 300 entries", () => {
  const doc = loadReloc(RELOCATIONS_DIR, RESLUG_FILE);

  it("forLane / reportOnlyUntil / finding are stated", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
    expect(doc.finding).toMatch(/RayWave/);
    expect(doc.entries.length).toBe(300);
  });

  it("every entry cites Drew's 09-28 ruling text", () => {
    const joined = JSON.stringify(doc.rulings);
    expect(joined).toMatch(/Drew 09-28: 'RayWave' compound is canonical/);
  });

  it("states the apply order (1st, before the repoint and retire lists)", () => {
    const joined = doc.rulings.join(" ");
    expect(joined).toMatch(/APPLY ORDER/);
    expect(joined).toMatch(/1st/);
  });

  it("every entry passes the lane's own classifyEntry as a reslug with a destination and canonical parallel text", () => {
    for (const e of doc.entries) {
      const v = relocLane.classifyEntry(e);
      expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
      expect(v.action).toBe("reslug");
      expect(e.to).toBeTruthy();
      const colour = colourFromSlug(parseSlug(e.to!).parallelSlug.replace(/-num-\d+$/, ""));
      expect(e.parallel).toBe(CANON_TEXT[colour]);
    }
  });

  it("the real computeHobbyIqCardId reproduces every destination from the entry's own parallel text", () => {
    for (const e of doc.entries) {
      const from = parseSlug(e.id);
      const to = parseSlug(e.to!);
      const recomputed = computeHobbyIqCardId({
        sport: from.sport, year: from.year, setKey: from.setKey, cardNumber: from.cardNumber,
        parallel: e.parallel, isAuto: to.autoSeg === "auto",
        printRun: to.printRunSeg ? Number(to.printRunSeg.replace(/^num-/, "")) : null,
      });
      expect(recomputed, `${e.id} -> expected ${e.to}`).toBe(e.to);
    }
  });

  it("every entry changes ONLY the parallel segment -- sport/year/setKey/cardNumber/isAuto agree", () => {
    for (const e of doc.entries) {
      const from = parseSlug(e.id);
      const to = parseSlug(e.to!);
      expect(to.sport).toBe(from.sport);
      expect(to.year).toBe(from.year);
      expect(to.setKey).toBe(from.setKey);
      expect(to.setKey).toBe("topps-chrome");
      expect(to.cardNumber).toBe(from.cardNumber);
      expect(to.autoSeg).toBe(from.autoSeg);
      expect(/^[0-9]+$/.test(to.cardNumber)).toBe(true);
    }
  });

  it("no duplicate id or destination", () => {
    const ids = doc.entries.map((e) => e.id);
    const tos = doc.entries.map((e) => e.to);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it("every entry's source row (evidence) is checklist-grade", () => {
    for (const e of doc.entries) {
      const m = /source=([^\s]+)/.exec(e.evidence ?? "");
      expect(m, `no source captured for ${e.id}`).toBeTruthy();
      expect(catalogAuthorityOf(m![1]), `${e.id}: source ${m![1]} is not checklist-grade`).toBe("checklist");
    }
  });
});

describe("the repoint-sales list exists, is shaped correctly, and holds 989 entries moving 1,888 sales", () => {
  const doc = loadRepoint(REPOINTS_DIR, REPOINT_FILE);

  it("forLane / reportOnlyUntil / finding are stated", () => {
    expect(doc.forLane).toBe("repoint-sales-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
    expect(doc.entries.length).toBe(989);
  });

  it("total expectedSales across all entries is 1,888", () => {
    const total = doc.entries.reduce((n, e) => n + (e.expectedSales ?? 0), 0);
    expect(total).toBe(1888);
  });

  it("states the apply order (after reslug, before retire)", () => {
    const joined = doc.rulings.join(" ");
    expect(joined).toMatch(/ORDER OF OPERATIONS/);
    expect(joined).toMatch(/raywave-reslug\.json/);
    expect(joined).toMatch(/raywave-retire\.json/);
  });

  it("every entry passes the lane's own classifyEntry", () => {
    for (const e of doc.entries) {
      const v = repointLane.classifyEntry(e);
      expect(v.ok, `${e.fromId}: ${v.why}`).toBeTruthy();
    }
  });

  it("no entry needs allowCrossProduct -- every move stays within the same cardNumber/setKey", () => {
    for (const e of doc.entries) {
      expect(e.allowCrossProduct).toBeFalsy();
      const from = parseSlug(e.fromId);
      const to = parseSlug(e.toId);
      expect(to.setKey).toBe(from.setKey);
      expect(to.cardNumber).toBe(from.cardNumber);
      expect(to.sport).toBe(from.sport);
      expect(to.year).toBe(from.year);
    }
  });

  it("no duplicate fromId", () => {
    const ids = doc.entries.map((e) => e.fromId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every expectedSales is a positive integer", () => {
    for (const e of doc.entries) {
      expect(Number.isInteger(e.expectedSales)).toBe(true);
      expect(e.expectedSales as number).toBeGreaterThan(0);
    }
  });
});

describe("the retire list exists, is shaped correctly, and holds exactly 5,492 entries", () => {
  const doc = loadReloc(RELOCATIONS_DIR, RETIRE_FILE);

  it("forLane / reportOnlyUntil / finding are stated", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
    expect(doc.entries.length).toBe(5492);
  });

  it("states the apply order (LAST, after reslug and repoint)", () => {
    const joined = doc.rulings.join(" ");
    expect(joined).toMatch(/ORDER OF OPERATIONS/);
    expect(joined).toMatch(/LAST/);
    expect(joined).toMatch(/raywave-reslug\.json/);
    expect(joined).toMatch(/raywave-to-canonical\.json/);
  });

  it("every entry passes the lane's own classifyEntry as a retire with requireTwinId, no destination", () => {
    for (const e of doc.entries) {
      const v = relocLane.classifyEntry(e);
      expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
      expect(v.action).toBe("retire");
      expect(e.to).toBeUndefined();
      expect(e.requireTwinId).toBeTruthy();
    }
  });

  it("no duplicate id", () => {
    const ids = doc.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every id is a pure-numeric cardNumber under topps-chrome (2025, baseball)", () => {
    for (const e of doc.entries) {
      const p = parseSlug(e.id);
      expect(p.sport).toBe("baseball");
      expect(p.year).toBe(2025);
      expect(p.setKey).toBe("topps-chrome");
      expect(/^[0-9]+$/.test(p.cardNumber)).toBe(true);
    }
  });

  it("requireTwinId is never the entry's own id and always a well-formed hiq slug", () => {
    for (const e of doc.entries) {
      expect(e.requireTwinId).not.toBe(e.id);
      expect(e.requireTwinId!.startsWith("hiq:")).toBe(true);
    }
  });
});

describe("cross-file set arithmetic -- no retire of a row still holding sales after the repoint", () => {
  const reslug = loadReloc(RELOCATIONS_DIR, RESLUG_FILE);
  const repoint = loadRepoint(REPOINTS_DIR, REPOINT_FILE);
  const retire = loadReloc(RELOCATIONS_DIR, RETIRE_FILE);

  it("no id appears as both a reslug source and a retire id", () => {
    const reslugIds = new Set(reslug.entries.map((e) => e.id));
    const retireIds = new Set(retire.entries.map((e) => e.id));
    for (const id of reslugIds) expect(retireIds.has(id)).toBe(false);
  });

  it("every repoint fromId also appears in the retire list -- every sale-bearing row is retired, never left dangling", () => {
    const retireIds = new Set(retire.entries.map((e) => e.id));
    for (const e of repoint.entries) {
      expect(retireIds.has(e.fromId), `${e.fromId} is repointed but never retired`).toBe(true);
    }
  });

  it("every repoint toId equals the matching retire entry's requireTwinId for the same fromId -- the sale and the row agree on where they end up", () => {
    const retireTwinById = new Map(retire.entries.map((e) => [e.id, e.requireTwinId]));
    for (const e of repoint.entries) {
      expect(retireTwinById.get(e.fromId)).toBe(e.toId);
    }
  });

  it("no reslug destination is ever itself retired", () => {
    const reslugTos = new Set(reslug.entries.map((e) => e.to));
    const retireIds = new Set(retire.entries.map((e) => e.id));
    for (const to of reslugTos) expect(retireIds.has(to as string)).toBe(false);
  });

  it("rowsWithSalesAtCensusTime in the retire list's own census matches the repoint list's entry count", () => {
    expect((retire.census as { rowsWithSalesAtCensusTime: number }).rowsWithSalesAtCensusTime).toBe(989);
    expect(repoint.entries.length).toBe(989);
  });
});

describe("needsRuling population is measured and cited, never silently dropped", () => {
  it("the reslug list's census accounts for every group: canonical + reslug + needsRuling = parent groups", () => {
    const doc = loadReloc(RELOCATIONS_DIR, RESLUG_FILE);
    const c = doc.census as {
      parentGroups: number; groupsAlreadyAtCanonicalAddress: number;
      groupsRequiringReslug: number; groupsHeldAsNeedsRuling: number;
    };
    expect(c.groupsAlreadyAtCanonicalAddress + c.groupsRequiringReslug + c.groupsHeldAsNeedsRuling).toBe(c.parentGroups);
    expect(c.parentGroups).toBe(2915);
    expect(c.groupsHeldAsNeedsRuling).toBe(215);
  });

  it("the reslug list's rulings name the wrong-key contamination this fold excludes", () => {
    const doc = loadReloc(RELOCATIONS_DIR, RESLUG_FILE);
    const joined = doc.rulings.join(" ");
    expect(joined).toMatch(/topps-chrome-update-series/);
    expect(joined).toMatch(/pure-numeric/i);
  });
});
