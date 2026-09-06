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

/**
 * TWO PRODUCTS NOW, and the split is the point.
 *
 * `STORED_PRODUCT` is where the CATALOG rows this fixture captured actually
 * sit -- the host they were minted into. `TARGET_PRODUCT` is where the sales
 * are sent, and since Drew's 2026-09-06 ruling that is the insert's OWN key:
 * Bowman's Best Preview is its own product, in both sports it was packed out
 * in, so the Stadium Club host is provenance and not identity.
 *
 * The two were the same string when this list was written, which is exactly
 * why they have to be named apart now: a single constant would have silently
 * moved the fixture assertions along with the target ones.
 */
const STORED_PRODUCT = "hiq:basketball:1997:topps-stadium-club:";
const TARGET_PRODUCT = "hiq:basketball:1997:bowmans-best-preview:";
const SLUG_RE = /^hiq:basketball:1997:bowmans-best-preview:bbp(\d{1,2}):(base|refractor|atomic-refractor):no-auto$/;

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
      expect(to.startsWith(TARGET_PRODUCT)).toBe(true);
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

describe("the catalog plan is SUPERSEDED, and says so rather than going quiet", () => {
  /**
   * When this list was written no catalog lane read a list, so the catalog
   * half was REPORTED here as a plan for a follow-up to execute. Both halves
   * of that plan are obsolete now, for two independent reasons, and the block
   * is kept as a POINTER rather than deleted -- a reader who lands on this
   * file has to be sent to the list that is actually run, not left following
   * a shape that no longer matches prod.
   */
  it("points at the committed catalog list that owns the write", () => {
    const plan = list.catalogPlan as Record<string, any>;
    expect(String(plan.supersededBy)).toBe(
      "data/catalog-relocations/2026-09-06-bbp-preview-basketball.json",
    );
    // The lane exists now (#1858), which is the first reason the plan is dead.
    expect(String(plan.note)).toMatch(/relocate-catalog-rows-by-list/);
  });

  it("states BOTH reasons it is dead -- the shape and the destination", () => {
    const plan = list.catalogPlan as Record<string, any>;
    const why = JSON.stringify(plan.supersededWhy);
    // (1) THE SHAPE. The 40 `sub-` rows the plan named are gone, so its
    //     retire half -- which existed only to vacate addresses for its own
    //     reslug half -- has nothing left to do.
    expect(why).toMatch(/sub-.{0,40}rows it names are GONE|are GONE/i);
    // (2) THE DESTINATION. Drew's ruling moved every row off the host key,
    //     including the 20 base rows the plan said to KEEP.
    expect(why).toMatch(/bowmans-best-preview/);
    expect(why).toMatch(/KEEP/);
  });

  it("keeps the one claim that is still true: moveCatalogRow, never a patch", () => {
    // patchCatalogRowFields hard-refuses id/cardId/hobbyiqCardId (UNPATCHABLE)
    // because changing where a row lives is a move -- and the committed lane
    // uses moveCatalogRow for exactly that reason.
    const why = JSON.stringify((list.catalogPlan as Record<string, any>).supersededWhy);
    expect(why).toContain("moveCatalogRow");
    expect(why).toMatch(/patchCatalogRowFields/);
  });

  it("THE END STATE IS THE RULED KEY, and the fixture still shows where it started", () => {
    const plan = list.catalogPlan as Record<string, any>;
    expect(String(plan.endState)).toMatch(/bowmans-best-preview/);
    expect(String(plan.endState)).toMatch(/ZERO BBP rows left on topps-stadium-club/i);
    // The FIXTURE is a photograph of the 2026-09-04 ingest and is unchanged:
    // it is what the rows looked like when they were minted, which is still
    // the evidence for why they move. 20 cards, 80 rows.
    expect(list.census.checklistCards).toBe(20);
    expect(fixture.rows).toHaveLength(80);
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
