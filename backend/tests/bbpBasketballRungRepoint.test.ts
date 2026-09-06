/**
 * The 1997-98 Topps Stadium Club Bowman's Best Preview (basketball) list.
 *
 * CF-A-QUALIFIED-REFRACTOR-IS-NOT-A-REFRACTOR (#1846, af7cb34). The reader now
 * spells Atomic Refractor as its own rung. These 80 catalog rows were minted
 * 2026-09-04, two days BEFORE that landed, so they carry the pre-fix shape: the
 * word "Atomic" pushed into `subsetName` and the rung collapsed onto plain
 * "Refractor". This file pins what the committed relocation list may say about
 * the POOL, and what the fixture proves about the CATALOG the list describes.
 *
 * WHY A FIXTURE AND NOT A LIVE READ. The list names 30 sold_comps rows by id
 * and 60 catalog addresses by slug. A test that re-queried Cosmos would pass or
 * fail on prod's mood; the fixture is the read-only capture the list was built
 * from, so a future edit to the list that stops agreeing with the catalog it
 * claims to repair fails HERE, in review, rather than in a dispatch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const listPath = join(__dirname, "..", "data", "pool-relocations", "2026-09-06-bbp-basketball-rung-repoint.json");
const fixturePath = join(__dirname, "fixtures", "bbp-basketball", "card-catalog-1997-tsc-bbp.json");

interface Entry {
  id: string;
  fromCardId: string;
  price?: number;
  evidence?: string;
  toCardId?: string;
  repointHobbyiqCardId?: string;
}
interface ListDoc {
  generatedAt: string;
  forLane: string;
  rulings: string[];
  census: Record<string, unknown> & { checklistCards: number };
  catalogPlan: Record<string, unknown>;
  excluded: Array<{ id: string; why: string }>;
  entries: Entry[];
}
interface FixtureRow {
  id: string;
  setName: string;
  cardNumber: string;
  parallel: string | null;
  subsetName: string | null;
  subsetInId: boolean;
  source: string;
}

const list = JSON.parse(readFileSync(listPath, "utf8")) as ListDoc;
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { rows: FixtureRow[] };
const catalogIds = new Set(fixture.rows.map((r) => r.id));

/** The address an entry sends its row to, whichever shape it uses. */
const targetOf = (e: Entry): string => String(e.toCardId ?? e.repointHobbyiqCardId ?? "");

const PRODUCT = "hiq:basketball:1997:topps-stadium-club:";
const SLUG_RE = /^hiq:basketball:1997:topps-stadium-club:bbp(\d{1,2}):(base|refractor|atomic-refractor):no-auto$/;

describe("the fixture is the catalog this list claims to repair", () => {
  it("captures exactly the 80 rows the 2026-09-04 ingest wrote", () => {
    expect(fixture.rows).toHaveLength(80);
    expect(new Set(fixture.rows.map((r) => r.source))).toEqual(new Set(["sportscardchecklist-2026-09-04"]));
  });

  it("holds 20 base, 20 plain-Refractor-page and 40 Atomic-page rows", () => {
    const byName = new Map<string, number>();
    for (const r of fixture.rows) byName.set(r.setName, (byName.get(r.setName) ?? 0) + 1);
    expect(byName.get("1997-98 Topps Stadium Club Bowmans Best Preview Basketball")).toBe(20);
    expect(byName.get("1997-98 Topps Stadium Club Bowmans Best Preview Refractors Basketball")).toBe(20);
    expect(byName.get("1997-98 Topps Stadium Club Bowmans Best Preview Atomic Refractors Basketball")).toBe(40);
  });

  it("THE DEFECT: the Atomic page minted its 20 cards on TWO slugs each", () => {
    const atomic = fixture.rows.filter((r) => r.setName.includes("Atomic Refractors"));
    const bare = atomic.filter((r) => !r.id.includes(":sub-"));
    const subset = atomic.filter((r) => r.id.includes(":sub-bowmans-best-preview-atomic:"));
    expect(bare).toHaveLength(20);
    expect(subset).toHaveLength(20);
    // One card, two rows: the same 20 numbers on both halves.
    expect(new Set(bare.map((r) => r.cardNumber))).toEqual(new Set(subset.map((r) => r.cardNumber)));
    // ...and the bare half SQUATS the plain-Refractor slug space, which is the
    // collision that makes this more than cosmetic.
    for (const r of bare) expect(r.id).toMatch(/:bbp\d{1,2}:refractor:no-auto$/);
  });

  it("THE CAUSE: 'Atomic' was filed as a subset instead of the parallel", () => {
    const atomic = fixture.rows.filter((r) => r.setName.includes("Atomic Refractors"));
    // Every Atomic row says parallel "Refractor" -- the rung was lost -- and the
    // discarded qualifier sits in subsetName. That is defect 1 from #1846.
    for (const r of atomic) {
      expect(r.parallel).toBe("Refractor");
      expect(r.subsetName).toBe("Bowmans Best Preview Atomic");
    }
    // Not one row already spells the rung the reader now derives.
    expect(fixture.rows.some((r) => r.id.includes(":atomic-refractor:"))).toBe(false);
  });

  it("NO SUBSET CLASH: no BBP number appears under a second subset", () => {
    // The `sub-` segment exists for a cardNumber that clashes ACROSS subsets.
    // Here the three setNames are ONE subset at THREE rungs, so the segment is
    // a defect rather than an identity -- which is why the end state drops it.
    const subsetsPerNumber = new Map<string, Set<string>>();
    for (const r of fixture.rows) {
      const base = r.setName.replace(/ (Atomic )?Refractors /, " ");
      if (!subsetsPerNumber.has(r.cardNumber)) subsetsPerNumber.set(r.cardNumber, new Set());
      subsetsPerNumber.get(r.cardNumber)!.add(base);
    }
    expect(subsetsPerNumber.size).toBe(20);
    for (const [, names] of subsetsPerNumber) expect(names.size).toBe(1);
  });
});

describe("the list's shape", () => {
  it("names this lane and carries its rulings", () => {
    expect(list.forLane).toBe("relocate-pool-rows-by-list.cjs");
    expect(list.rulings.length).toBeGreaterThanOrEqual(5);
    expect(list.entries.length).toBeGreaterThan(0);
  });

  it("every entry names exactly ONE shape, which is what the lane requires", () => {
    // The lane refuses an entry naming two shapes; a list that shipped one
    // would fail at dispatch time instead of here.
    for (const e of list.entries) {
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId ? "relocate" : null,
        e.repointHobbyiqCardId ? "repoint" : null,
      ].filter(Boolean);
      expect(shapes).toHaveLength(1);
    }
  });

  it("every entry carries an id, a from-address, and its own evidence", () => {
    for (const e of list.entries) {
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.fromCardId.length).toBeGreaterThan(0);
      expect(String(e.evidence ?? "").length).toBeGreaterThan(40);
      // The evidence quotes the title the rung was read from, so a reviewer can
      // check the call without opening Cosmos.
      expect(e.evidence).toContain("Title:");
    }
  });

  it("NO from == to: an entry that moves nothing is a list defect", () => {
    for (const e of list.entries) {
      const to = targetOf(e);
      expect(to).not.toBe(e.fromCardId);
      if (e.repointHobbyiqCardId) expect(e.repointHobbyiqCardId).not.toBe(e.fromCardId);
    }
  });

  it("no row id is named twice", () => {
    const ids = list.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every to-address is a legal rung of THIS product", () => {
  it("is a well-formed 1997 basketball Stadium Club BBP slug", () => {
    for (const e of list.entries) {
      const to = targetOf(e);
      expect(to.startsWith(PRODUCT)).toBe(true);
      expect(to).toMatch(SLUG_RE);
    }
  });

  it("carries NO `sub-` segment -- the segment is the defect, not the fix", () => {
    for (const e of list.entries) expect(targetOf(e)).not.toContain(":sub-");
  });

  it("stays inside the checklist's BBP1-BBP20 numbering", () => {
    for (const e of list.entries) {
      const n = Number(SLUG_RE.exec(targetOf(e))![1]);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(list.census.checklistCards);
    }
  });

  it("the Atomic rung is spelled `:atomic-refractor:`, per #1846", () => {
    const atomic = list.entries.filter((e) => targetOf(e).includes(":atomic-refractor:"));
    expect(atomic.length).toBeGreaterThan(0);
    for (const e of atomic) {
      // A title that says Atomic must not land on the plain Refractor rung --
      // that pooling is the LOSS #1846 named.
      expect(String(e.evidence)).toMatch(/atomic/i);
      expect(targetOf(e)).not.toMatch(/:refractor:no-auto$/);
    }
  });

  it("a title naming Atomic NEVER lands on plain `:refractor:`", () => {
    for (const e of list.entries) {
      const titleIsAtomic = /\batomic\b/i.test(String(e.evidence).split("Title:")[1] ?? "");
      if (titleIsAtomic) expect(targetOf(e)).toContain(":atomic-refractor:");
    }
  });
});

describe("the catalog plan the list reports", () => {
  it("ends at exactly 3 rows per card -- 60 for 20 cards", () => {
    const plan = list.catalogPlan as Record<string, any>;
    expect(list.census.checklistCards).toBe(20);
    expect(plan.keep.count).toBe(20);
    expect(plan.retireAsAlias.count).toBe(20);
    const reslugged = plan.reslug.reduce((a: number, r: any) => a + r.count, 0);
    expect(reslugged).toBe(40);
    // 20 kept + 40 re-slugged = 60 live rows; the other 20 are retired aliases.
    expect(plan.keep.count + reslugged).toBe(60);
    expect(plan.keep.count + reslugged + plan.retireAsAlias.count).toBe(fixture.rows.length);
  });

  it("every from-slug the plan re-slugs EXISTS in the catalog fixture", () => {
    const plan = list.catalogPlan as Record<string, any>;
    for (const r of plan.reslug) {
      for (let n = 1; n <= 20; n++) {
        const from = String(r.from).replace("<n>", String(n));
        expect(catalogIds.has(from)).toBe(true);
      }
    }
    for (let n = 1; n <= 20; n++) {
      expect(catalogIds.has(`${PRODUCT}bbp${n}:base:no-auto`)).toBe(true);
      // the alias row the plan retires
      expect(catalogIds.has(`${PRODUCT}bbp${n}:refractor:no-auto`)).toBe(true);
    }
  });

  it("every to-slug the plan re-slugs is a legal rung and is NOT already taken", () => {
    const plan = list.catalogPlan as Record<string, any>;
    for (const r of plan.reslug) {
      for (let n = 1; n <= 20; n++) {
        const to = String(r.to).replace("<n>", String(n));
        expect(to).toMatch(SLUG_RE);
        expect(to).not.toContain(":sub-");
      }
    }
    // The Atomic rung is genuinely vacant today, so those 20 moves land clean.
    for (let n = 1; n <= 20; n++) {
      expect(catalogIds.has(`${PRODUCT}bbp${n}:atomic-refractor:no-auto`)).toBe(false);
    }
  });

  it("ORDERING IS LOAD-BEARING: the Refractor target is occupied until the retire lands", () => {
    // The plain-Refractor rows move to `:bbp<n>:refractor:`, which the Atomic
    // ALIAS row currently squats. Moving first would collide with a live row,
    // so the plan says so in as many words rather than leaving it to the runner.
    const plan = list.catalogPlan as Record<string, any>;
    const refractorMove = plan.reslug.find((r: any) => String(r.to).includes(":refractor:no-auto"));
    expect(refractorMove).toBeDefined();
    expect(String(refractorMove.why)).toMatch(/OCCUPIED|retire MUST land before/i);
  });

  it("names moveCatalogRow, because patchCatalogRowFields refuses an id change", () => {
    const plan = list.catalogPlan as Record<string, any>;
    expect(String(plan.writeHelper)).toContain("moveCatalogRow");
    expect(String(plan.writeHelper)).toMatch(/patchCatalogRowFields/);
  });
});

describe("what the list deliberately leaves alone", () => {
  it("EXCLUDES the football edition rather than dragging it onto this roster", () => {
    const football = list.excluded.filter((x) => /football/i.test(x.why));
    expect(football.length).toBeGreaterThan(0);
    // ...and no entry sends a row to a football slug.
    for (const e of list.entries) expect(targetOf(e)).not.toContain(":football:");
  });

  it("every excluded row says WHY, and none is also an entry", () => {
    const entryIds = new Set(list.entries.map((e) => e.id));
    for (const x of list.excluded) {
      expect(String(x.why).length).toBeGreaterThan(10);
      expect(entryIds.has(x.id)).toBe(false);
    }
  });
});
