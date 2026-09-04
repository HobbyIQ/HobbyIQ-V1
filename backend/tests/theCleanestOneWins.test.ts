/**
 * CF-THE-CLEANEST-ONE-WINS (Drew, 2026-08-26: "the cleanest one wins").
 *
 * `upsertCatalogEntry` decided a merge on CONFIDENCE alone. That lets the wrong
 * row win exactly where it matters most:
 *
 *   ingest-auto-seed  writes at 0.85 and is DERIVED — built from the sales
 *                     themselves, so a mis-slugged comp seeds a catalog row
 *                     and that row then confirms the comp
 *   a checklist row   transcribes the manufacturer's own list, and would LOSE
 *                     to that 0.85 on any lower confidence
 *
 * Measured on 2026 Bowman Chrome Mega Box: 944 of its catalog rows came from
 * ingest-auto-seed against 614 from a checklist. Ingesting clean checklists on
 * top of that is pointless if the derived row survives the merge — a checklist
 * is the only artifact that can CONTRADICT a sale.
 *
 * catalogAuthority already declared the ordering and stated that derived rows
 * "must never outvote a checklist". It was simply never enforced on the write
 * path. These pin the ordering itself.
 */
import { describe, expect, it } from "vitest";
import { authorityRank, catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

describe("authority ordering, which the merge now follows", () => {
  it("ranks a checklist above a vendor above a derived row", () => {
    expect(authorityRank("beckett-checklist")).toBeGreaterThan(authorityRank("cardhedge"));
    expect(authorityRank("cardhedge")).toBeGreaterThan(authorityRank("ingest-auto-seed"));
  });

  it("puts the sales-derived sources in the derived class", () => {
    // These are the ones that make the catalog judge itself.
    for (const s of ["ingest-auto-seed", "sold-comps-stub", "catalog-explode-actuals"]) {
      expect(catalogAuthorityOf(s), `${s} must be derived`).toBe("derived");
    }
  });

  it("CLOSED: sales-attested is declared DERIVED, and ranks with its siblings", () => {
    // This case was written as a GAP: sales-attested is a sales-derived source
    // (attest-unnumbered-by-player builds rows from corroborated comps) that
    // catalogAuthority did not name, so it landed at rank 0 instead of the
    // derived class. The pin said so on the record, and said that declaring it
    // later would be "a deliberate change with a failing test".
    //
    // #1733 made exactly that change. Its ruling: a source's CLASS is decided
    // by what produced the row, not by a word in its name — a derived row is
    // not promoted by the word "checklist" and an attested one is not demoted
    // by the word "attested". `sales-attested` is a derived row, so it is
    // DERIVED, rank 1, alongside `ingest-auto-seed` rather than below it.
    //
    // The safety property the GAP relied on is unchanged and is re-pinned
    // below: derived still loses to a checklist, so an attested row still
    // cannot outvote a printed one.
    expect(catalogAuthorityOf("sales-attested")).toBe("derived");
    expect(authorityRank("sales-attested")).toBe(authorityRank("ingest-auto-seed"));
    expect(authorityRank("sales-attested")).toBeLessThan(authorityRank("beckett-checklist"));
  });

  it("puts the scraped checklists in the checklist class", () => {
    for (const s of ["beckett-scraped-2026-08-26", "beckett-checklist", "checklistcenter"]) {
      expect(catalogAuthorityOf(s), `${s} must be a checklist`).toBe("checklist");
    }
  });

  it("ranks an unknown source below everything that claims a provenance", () => {
    expect(authorityRank(null)).toBeLessThan(authorityRank("ingest-auto-seed"));
    expect(authorityRank("something-nobody-declared")).toBeLessThan(authorityRank("ingest-auto-seed"));
  });
});

describe("the merge rule the write path implements", () => {
  // Mirrors upsertCatalogEntry's decision so the ordering is asserted directly
  // rather than only through a live Cosmos call.
  const winnerIsIncoming = (incoming: { source: string; confidence: number },
                            existing: { source: string; confidence: number } | null) => {
    const a = authorityRank(incoming.source);
    const b = existing ? authorityRank(existing.source) : -1;
    return !existing || a > b || (a === b && incoming.confidence > existing.confidence);
  };

  it("a checklist beats a higher-confidence derived row", () => {
    // The exact case that motivated this: 0.85 auto-seed vs a 0.6 checklist.
    expect(winnerIsIncoming(
      { source: "beckett-scraped-2026-08-26", confidence: 0.6 },
      { source: "ingest-auto-seed", confidence: 0.85 },
    )).toBe(true);
  });

  it("a derived row never displaces a checklist, however confident", () => {
    expect(winnerIsIncoming(
      { source: "ingest-auto-seed", confidence: 0.99 },
      { source: "beckett-checklist", confidence: 0.5 },
    )).toBe(false);
  });

  it("within one class, confidence still decides", () => {
    expect(winnerIsIncoming(
      { source: "beckett-checklist", confidence: 0.9 },
      { source: "checklistcenter", confidence: 0.7 },
    )).toBe(true);
    expect(winnerIsIncoming(
      { source: "beckett-checklist", confidence: 0.5 },
      { source: "checklistcenter", confidence: 0.7 },
    )).toBe(false);
  });

  it("anything wins against no existing row", () => {
    expect(winnerIsIncoming({ source: "ingest-auto-seed", confidence: 0.1 }, null)).toBe(true);
  });
});
