import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * #2041 follow-up -- THE HEAVY METAL ABSORBED-ROWS FOLD LIST (measured by
 * read 2026-09-11/12).
 *
 * 1996 Fleer Metal Universe "Heavy Metal" is a 10-card named insert (#1
 * Albert Belle ... #10 Matt Williams). Until #2041 lands, `normalizeSetKey`
 * collapses `metal-universe-heavy-metal` to `metal-universe`, so nothing
 * ever minted under its own key -- 18 rows across five numbers (#1, #2, #6,
 * #8, #10) instead carry the Heavy Metal player's name at the BASE
 * metal-universe address of a different player. #2041's PR comments hold the
 * 5-number/18-row table this list is built from.
 *
 * THE SHAPE, AND WHY IT IS NOT 18 ENTRIES. 17 of the 18 are graded children
 * (`${parentSlug}:${tier}`) of the CORRECT base-player parent row -- point-
 * read 2026-09-12 confirms all five plain (`:base:no-auto`, no grade tier)
 * parent rows are the checklist-backed base player, not the Heavy Metal one.
 * moveCatalogRow refuses a graded child given its own entry onto a plain
 * card address ("a graded child cannot move onto a card address" -- #2041's
 * own comment names this the 53-failure mode on REPORT run 34356734615), and
 * reslugging one there would also drop its grade. So this list carries ONLY
 * the one card-level (non-graded) row -- the `ssp` parallel minted by
 * `ingest-auto-seed` -- and lists the 17 graded children in `excluded`
 * instead of `entries`.
 *
 * These pins hold the LIST SHAPE and run the lane's OWN validators
 * (classifyEntry, keepsSales, idSetKey/crossProductFields) rather than a copy
 * of them, so a list this suite accepts is a list the lane can read.
 */

const FILE = "2026-09-12-metal-universe-heavy-metal-absorbed-rows.json";
const DIR = path.join(process.cwd(), "data", "catalog-relocations");

type Entry = { id: string; action: string; to?: string; reason?: string; evidence?: string; keepSales?: boolean };
type List = {
  generatedAt: string;
  forLane: string;
  reportOnlyUntil: string;
  keepSales?: boolean;
  finding: string;
  rulings: string[];
  excluded: Array<{ note: string; ids: string[] }>;
  census: Record<string, unknown>;
  entries: Entry[];
};

const doc = JSON.parse(readFileSync(path.join(DIR, FILE), "utf8")) as List;

const { classifyEntry, keepsSales, idSetKey, crossProductFields } = require_(
  "../scripts/relocate-catalog-rows-by-list.cjs",
) as {
  classifyEntry: (e: unknown) => { ok: boolean; action?: string; to?: string; why?: string };
  keepsSales: (entry: unknown, doc: unknown) => boolean;
  idSetKey: (slug: string) => string;
  crossProductFields: (id: string, to: string) => { setKey?: string };
};

const HM_NAME: Record<number, string> = {
  1: "Albert Belle",
  2: "Barry Bonds",
  6: "Mike Piazza",
  8: "Frank Thomas",
  10: "Matt Williams",
};

describe("the file is shaped the way relocate-catalog-rows-by-list requires", () => {
  it("names the lane and holds the APPLY-ONLY-AFTER-#2041 gate in reportOnlyUntil", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/APPLY ONLY AFTER #2041/);
    expect(doc.reportOnlyUntil).toMatch(/merged AND deployed AND the Heavy Metal rows are ingested/);
    expect(doc.reportOnlyUntil).toMatch(/metal-universe-heavy-metal:N exists/);
    expect(doc.reportOnlyUntil).toMatch(/refused\/occupied until then/);
  });

  it("states, in the header, that graded children get no entries and why", () => {
    const allText = JSON.stringify(doc.rulings);
    expect(allText).toMatch(/NO ENTRIES FOR GRADED CHILDREN/);
    expect(allText).toMatch(/drop.{0,20}grade|DROP THE GRADE/i);
    expect(allText).toMatch(/follow/i);
  });

  it("carries keepSales: true at the file level", () => {
    expect(doc.keepSales).toBe(true);
  });

  it("is non-empty and Array-shaped", () => {
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries.length).toBeGreaterThan(0);
  });
});

describe("no entry is a graded child", () => {
  it("no entry id or destination carries a grade-tier segment", () => {
    // A graded id is `${parentSlug}:${tier}` -- one extra colon-segment past
    // the 7-9 part hiq slug grammar, and it never round-trips through
    // idSetKey/crossProductFields the way a plain card id does. The
    // authoritative check: the lane's own parser rejects it as a card id.
    for (const e of doc.entries) {
      expect(e.id.split(":").length).toBeLessThanOrEqual(9);
      expect(e.to?.split(":").length).toBeLessThanOrEqual(9);
    }
  });

  it("count-pinned: exactly 1 entry, exactly 17 excluded graded children", () => {
    expect(doc.entries.length).toBe(1);
    expect(doc.excluded).toHaveLength(1);
    expect(doc.excluded[0].ids).toHaveLength(17);
  });

  it("every excluded id is a graded child (STARTSWITH a :base:no-auto card address, IS_DEFINED tier)", () => {
    // Mirrors isGradedChildOf's own rule: id = `${parentSlug}:${tier}`, tier
    // is one segment and never a print-run segment.
    for (const id of doc.excluded[0].ids) {
      const m = /^(hiq:baseball:1996:metal-universe:\d+:base:no-auto):([a-z0-9-]+)$/.exec(id);
      expect(m, `not a graded-child id: ${id}`).toBeTruthy();
      expect(m![2]).not.toMatch(/^num-/);
    }
  });

  it("no excluded id appears in entries, and no entry id appears in excluded", () => {
    const excludedSet = new Set(doc.excluded[0].ids);
    for (const e of doc.entries) expect(excludedSet.has(e.id)).toBe(false);
    const entrySet = new Set(doc.entries.map((e) => e.id));
    for (const id of doc.excluded[0].ids) expect(entrySet.has(id)).toBe(false);
  });
});

describe("the five Heavy Metal numbers each match the right name, in the excluded census", () => {
  it("every excluded graded child's number maps to a name #2041's table names", () => {
    for (const id of doc.excluded[0].ids) {
      const num = Number(/:(\d+):base:no-auto:/.exec(id)?.[1]);
      expect(HM_NAME[num], `number ${num} is not one of the five HM numbers`).toBeTruthy();
    }
  });

  it("by-number counts match #2041's table: 1->3, 2->5(of6,1 is the entry), 6->5, 8->2, 10->2", () => {
    const byNumber = (n: number) =>
      doc.excluded[0].ids.filter((id) => id.startsWith(`hiq:baseball:1996:metal-universe:${n}:base:no-auto:`)).length;
    expect(byNumber(1)).toBe(3);
    expect(byNumber(2)).toBe(5); // 6 total for #2, 1 of which (the ssp row) is the entry, not a graded child
    expect(byNumber(6)).toBe(5);
    expect(byNumber(8)).toBe(2);
    expect(byNumber(10)).toBe(2);
    // 3 + 5 + 5 + 2 + 2 = 17
    expect(byNumber(1) + byNumber(2) + byNumber(6) + byNumber(8) + byNumber(10)).toBe(17);
  });
});

describe("the one entry is the ungraded Barry Bonds SSP row, reslugged correctly", () => {
  const entry = doc.entries[0];

  it("classifyEntry accepts it as a reslug with a reason", () => {
    const v = classifyEntry(entry);
    expect(v.ok, v.why).toBeTruthy();
    expect(v.action).toBe("reslug");
    expect(v.to).toBe("hiq:baseball:1996:metal-universe-heavy-metal:2:ssp:no-auto");
  });

  it("id is the base-address SSP row; destination is the Heavy Metal address, same number, same parallel", () => {
    expect(entry.id).toBe("hiq:baseball:1996:metal-universe:2:ssp:no-auto");
    expect(entry.to).toBe("hiq:baseball:1996:metal-universe-heavy-metal:2:ssp:no-auto");
  });

  it("carries the Heavy Metal player's name (Barry Bonds, #2) in its evidence, and names the base occupant it was absorbed onto (Brady Anderson)", () => {
    expect(entry.evidence).toMatch(/Barry Bonds/);
    expect(entry.evidence).toMatch(/Brady Anderson/);
    expect(entry.reason).toMatch(/Barry Bonds/);
  });

  it("names the checklist row #2041's ingest will mint", () => {
    expect(entry.evidence).toMatch(/metal-universe-heavy-metal:2:base:no-auto/);
  });

  it("is a cross-product move: idSetKey differs and crossProductFields supplies the new setKey", () => {
    expect(idSetKey(entry.id)).toBe("metal-universe");
    expect(idSetKey(entry.to!)).toBe("metal-universe-heavy-metal");
    expect(crossProductFields(entry.id, entry.to!)).toEqual({ setKey: "metal-universe-heavy-metal" });
  });

  it("keepsSales resolves true for this entry (file-level keepSales: true, uncontested by the entry)", () => {
    expect(keepsSales(entry, doc)).toBe(true);
  });

  it("evidence states the sale count measured on BOTH cardId and hobbyiqCardId", () => {
    // #2041's own comment: count sales on cardId OR hobbyiqCardId, since a
    // cardId-only query saw 0 of the one real sale here.
    expect(entry.evidence).toMatch(/byCardId=0/);
    expect(entry.evidence).toMatch(/byHobbyiqCardId=1/);
    expect(entry.evidence).toMatch(/byEither=1/);
  });
});

describe("the header states the apply gate names the exact precondition", () => {
  it("rulings mention both #2041 shipping and the checklist ingest as preconditions", () => {
    const allText = JSON.stringify(doc.rulings) + doc.reportOnlyUntil;
    expect(allText).toMatch(/#2041/);
    expect(allText).toMatch(/ingest/i);
    expect(allText).toMatch(/10 rows|Heavy Metal checklist/);
  });
});
