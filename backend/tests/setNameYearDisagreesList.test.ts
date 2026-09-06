import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE setName-YEAR DISAGREEMENT CENSUS AND LIST (#1904, 2026-09-06).
 *
 * 145,758 card_catalog rows carry a setName whose leading 4-digit (or split)
 * year disagrees with the row's own year/cardYear. The census's whole job was
 * to find out whether that is ONE defect. It is not, and the pins below encode
 * the split because the size of this list depends on it.
 *
 *   THE SLUG IS NEVER WRONG IN THE BIG CLASS. Over all 144,822 hit rows with a
 *   parseable hiq slug, the slug's year segment equals the row's own `year`
 *   144,822 times and equals the setName's leading year 0 times. Where the
 *   slug, the field and the pool address all agree, there is no split pool and
 *   a relocation lane has nothing to move -- which is why a 145,758-row finding
 *   yields a 17-entry list.
 *
 *   CLASS (a), 76,414 rows, IS NOT A DEFECT. "2024/25 Topps Chrome Basketball"
 *   at year 2025 is a split-season label (#1852, CF-A-SPLIT-YEAR-IS-STILL-A-
 *   YEAR). 75,896 sit on the second season year and 0 on the first, so the
 *   convention is consistent and the product's cards stay in one pool.
 *
 *   CLASS (d), retro/heritage design-year labels, IS EMPTY -- and that is the
 *   expected result, not a gap. Heritage carries the PRODUCT year in setName,
 *   so it never disagrees and never enters the census. A pin asserts the
 *   homage vocabulary appears in no entry, so a later widening that swept
 *   Heritage in would turn this red.
 *
 *   CLASS (c), 69,325 rows, IS DEFERRED because a blanket fix is unsafe. Of
 *   1,000 stratified point-reads, 574 have a row at the setName year and 120 of
 *   those hold a DIFFERENT PLAYER. One in five rows would land on another
 *   card's address.
 *
 *   CLASS (b), 19 rows, IS THE ONLY RELOCATION: a TRUNCATED year segment
 *   ("198" is not a year). One of the 18 distinct ids is excluded because its
 *   destination holds Tim Horton and the row is Cole Caufield -- an occupied
 *   address is a collision to report, never to route around.
 */

const listPath = path.join(
  process.cwd(),
  "data",
  "catalog-relocations",
  "2026-09-06-setname-year-disagrees.json",
);
const list = JSON.parse(readFileSync(listPath, "utf8"));

type Entry = { id: string; action: string; to?: string; reason?: string };
const entries = list.entries as Entry[];
const segs = (slug: string) => slug.split(":");
const yearOf = (slug: string) => segs(slug)[2];

describe("the setName-year disagreement list (#1904)", () => {
  it("is report-only and names the catalog lane it is for", () => {
    expect(list.forLane).toBe("relocate-catalog-rows-by-list");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
    expect(list.provenance.readOnly).toBe(true);
    expect(String(list.provenance.writes)).toMatch(/none/i);
  });

  it("every entry is a RESLUG with an id, a destination and a reason", () => {
    // This lane's `retire` is a DELETE, so a list that carries none should say
    // so structurally rather than in prose: nothing here removes a row.
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.id).toMatch(/^hiq:/);
      expect(e.action).toBe("reslug");
      expect(e.to).toMatch(/^hiq:/);
      expect(e.to).not.toBe(e.id);
      expect(String(e.reason ?? "")).not.toBe("");
    }
    expect(entries.every((e) => e.action !== "retire")).toBe(true);
  });

  it("MOVES ONLY THE YEAR SEGMENT -- every other segment is carried verbatim", () => {
    // The whole safety argument for the destination: no identity is invented,
    // because sport, setKey, cardNumber, parallel, auto and grade are copied.
    for (const e of entries) {
      const a = segs(e.id);
      const b = segs(e.to!);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        if (i === 2) continue;
        expect(b[i]).toBe(a[i]);
      }
    }
  });

  it("the SOURCE year is truncated (1-3 digits) and the DESTINATION is a real 4-digit year", () => {
    // This is what separates class (b) from class (c). A 3-digit year segment
    // has no rival reading: it is not a year any product was issued in.
    for (const e of entries) {
      expect(yearOf(e.id)).toMatch(/^\d{1,3}$/);
      expect(yearOf(e.to!)).toMatch(/^\d{4}$/);
      const y = Number(yearOf(e.to!));
      expect(y).toBeGreaterThanOrEqual(1860);
      expect(y).toBeLessThanOrEqual(2035);
      // the destination year is the truncated one with its lost digit restored
      expect(String(y).startsWith(yearOf(e.id))).toBe(true);
    }
  });

  it("the destination year is the year the row's own setName states", () => {
    for (const e of entries) {
      const stated = (String(e.reason ?? "").match(/setName states "(\d{4})/) ?? [])[1];
      expect(stated).toBeTruthy();
      expect(stated).toBe(yearOf(e.to!));
    }
  });

  it("no two entries collide, and no destination is another entry's source", () => {
    // A chained address (A -> B while B -> C) would make the apply order
    // load-bearing. This list has no such chain, and that is pinned.
    const ids = entries.map((e) => e.id);
    const tos = entries.map((e) => e.to!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tos).size).toBe(tos.length);
    expect(tos.filter((t) => ids.includes(t))).toEqual([]);
  });

  it("MUTATION -- a different-player destination is EXCLUDED, never an entry", () => {
    // Treating an occupied address as a fold is the mistake this guard exists
    // to prevent. Moving the hockey row into `entries` turns this red.
    expect(Array.isArray(list.excluded)).toBe(true);
    expect(list.excluded.length).toBe(1);
    const x = list.excluded[0];
    expect(x.id).toBe("hiq:hockey:202:upper-deck:1:base:no-auto");
    expect(x.player).toBe("Cole Caufield");
    expect(x.occupiedBy).toBe("Tim Horton");
    expect(String(x.why)).toMatch(/collision to report, never to route around/i);
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain(x.id);
  });

  it("MUTATION -- no entry is a retro/homage product", () => {
    // Class (d) is empty by measurement. A widening that swept Heritage or
    // Archives into the list would put a homage word in a reason or a setKey.
    const homage =
      /\b(heritage|archives|tribute|reprint|retro|buyback|commemorative|gypsy.?queen|allen.?ginter)\b/i;
    for (const e of entries) {
      expect(homage.test(segs(e.id)[3] ?? "")).toBe(false);
      const stated = (String(e.reason ?? "").match(/setName states "([^"]*)"/) ?? [])[1] ?? "";
      expect(stated).not.toBe("");
      expect(homage.test(stated)).toBe(false);
    }
    expect(list.census.byClass["d-retro-design-year"]).toBe(0);
  });

  it("pins the census, and the class counts account for every hit", () => {
    const c = list.census;
    expect(c.hits).toBe(145758);
    const k = c.byClass;
    expect(k["a-split-season-not-a-defect"]).toBe(76414);
    expect(k["b-slug-year-wrong-truncated"]).toBe(19);
    expect(k["c-setname-label-wrong-deferred"]).toBe(69325);
    expect(k["d-retro-design-year"]).toBe(0);
    // Four classes, no remainder: a row the census did not classify is a row
    // nobody decided about.
    const total = Object.values(k).reduce((a: number, b) => a + Number(b), 0);
    expect(total).toBe(c.hits);
  });

  it("pins the measurement that makes this list small: the slug is never wrong", () => {
    const c = list.census;
    expect(c.slugYearEqualsRowYear).toBe(144822);
    expect(c.slugYearEqualsSetNameYear).toBe(0);
    expect(c.slugsParsed).toBe(c.slugYearEqualsRowYear);
    // Split-season rows sit on ONE end consistently -- the second season year.
    expect(c.splitSeasonOnSecondYear).toBe(75896);
    expect(c.splitSeasonOnFirstYear).toBe(0);
  });

  it("reconciles with the number #1904 reported, rather than silently disagreeing", () => {
    // The ticket said 55,514 and this census found 145,758 hits. That is not a
    // contradiction: the ticket counted the PLAIN leading-year shape, which
    // this scan measures at 55,964. Stating the bridge keeps a future reader
    // from treating one of the two numbers as wrong.
    const r = list.census.reconciliationWith1904;
    expect(r.ticketFigure).toBe(55514);
    expect(r.nonSplitHitsMeasuredHere).toBe(55964);
    expect(Math.abs(r.nonSplitHitsMeasuredHere - r.ticketFigure)).toBeLessThan(1000);
    expect(String(r.note)).toMatch(/drift/i);
  });

  it("pins the class-(c) sample that justifies DEFERRING it", () => {
    const s = list.census.classCSample;
    expect(s.sampled).toBe(1000);
    expect(s.distinctProducts).toBe(44);
    expect(s.twinExists).toBe(574);
    // The load-bearing number: one in five destinations is another card.
    expect(s.twinDifferentPlayer).toBeGreaterThan(100);
    expect(s.twinSamePlayer + s.twinDifferentPlayer).toBeLessThanOrEqual(s.twinExists);
    expect(String(s.note)).toMatch(/stratified/i);
  });

  it("the deferred note plans a FIELD patch through patchCatalogRowFields, never a raw patch", () => {
    const d = list.deferred;
    expect(d.rows).toBe(69325);
    expect(d.plan.primitive).toBe("patchCatalogRowFields");
    expect(String(d.plan.neverARawPatch)).toMatch(/#1614/);
    expect(String(d.plan.whichFieldMoves)).toMatch(/setName/);
    // A field patch must not touch the address -- that is moveCatalogRow's job,
    // and patchCatalogRowFields refuses id/cardId/hobbyiqCardId by design.
    expect(String(d.plan.neverARawPatch)).toMatch(/id\/cardId\/hobbyiqCardId/);
    expect(String(d.plan.openQuestionForDrew)).toMatch(/authoritative/i);
    expect(Array.isArray(d.plan.whatWouldBeNeededFirst)).toBe(true);
    expect(d.plan.whatWouldBeNeededFirst.length).toBeGreaterThanOrEqual(3);
  });

  it("names the upstream cause and does not claim fixing it moves a stored row", () => {
    const u = list.deferred.causeUpstream;
    expect(u.file).toBe("backend/data/ingest-universe.json");
    expect(u.entriesWithDisagreeingYear).toBe(38);
    expect(String(u.mechanism)).toMatch(/PUBLICATION year/i);
    expect(String(u.note)).toMatch(/does not move a single stored row/i);
  });

  it("reports an EMPTY pool list as a measurement, counted two ways", () => {
    // An empty file would read as an oversight. The count is the finding.
    expect(list.poolList.entries).toBe(0);
    expect(list.census.truncated.salesResidentOnWrongYearSlugs).toBe(0);
    expect(list.census.truncated.salesByHobbyiqCardId).toBe(0);
    expect(String(list.poolList.why)).toMatch(/measured, not skipped/i);
  });

  it("every entry's destination was point-read, and the counts reconcile", () => {
    const t = list.census.truncated;
    expect(t.distinctIds).toBe(18);
    expect(t.pointRead).toBe(t.distinctIds);
    // vacant + same-card + different-card must account for every id, or one of
    // the four numbers is stale.
    expect(
      t.destinationsVacant + t.destinationsOccupiedSameCard + t.destinationsOccupiedDifferentCard,
    ).toBe(t.distinctIds);
    // and the one different-card destination is the one excluded row.
    expect(t.destinationsOccupiedDifferentCard).toBe(list.excluded.length);
    expect(entries.length).toBe(t.distinctIds - t.destinationsOccupiedDifferentCard);
  });
});
