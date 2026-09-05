/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3 — Max Williams
 * 2025 Bowman Draft CPA-MWI Refractor auto). The pure core: which catalog row an id
 * resolves to, given the ids the catalog holds under its stem. The real ids from the
 * prod repro (read-only, 2026-08-30): the un-numbered id had NO row, exactly one twin
 * …:num-499 (checklistcenter, /499) — and 35 sales the card page could not see.
 */
import { describe, expect, it } from "vitest";
import { numberedTwinsOf, pickCatalogRow, poolReadIdsFor } from "../src/services/catalog/catalogIdentityResolver.js";

const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const GOLD_50 = "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50";
const TG = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto";
const VENDOR = "1778814561816x835862652021336800";

describe("pickCatalogRow -- an un-numbered id", () => {
  it("resolves to its ONE numbered twin when it has no row of its own (the Max Williams case)", () => {
    const r = pickCatalogRow(MWI, [MWI_499, GOLD_50]);
    // Mutation check: the pre-fix catalogSlugIfExists answered null here.
    expect(r).toEqual({ requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499], poolTwin: MWI_499, sourceOfRow: null });
  });
  it("keeps its OWN row when it has one, even when a numbered twin also exists (conform's rowFor agrees)", () => {
    expect(pickCatalogRow(MWI, [MWI, MWI_499])).toEqual({ requested: MWI, id: MWI, kind: "exact", twins: [], poolTwin: null, sourceOfRow: null });
  });
  it("two numbered twins are two cards: ambiguous, id null, both listed — a ruling, never a guess", () => {
    const r = pickCatalogRow(MWI, [MWI_499, MWI_250, GOLD_50]);
    expect(r.kind).toBe("ambiguous");
    expect(r.id).toBeNull();
    expect(r.twins).toEqual([MWI_250, MWI_499]);
  });
  it("no row and no twin is nothing", () => {
    expect(pickCatalogRow(MWI, [GOLD_50]).kind).toBe("none");
    expect(pickCatalogRow(MWI, []).id).toBeNull();
  });
  it("a graded child and a different parallel under the same card are NOT twins (Gillen)", () => {
    const ids = [`${TG}:num-150`, `${TG}:num-150:psa-9`, `${TG}:num-150:psa-10`, "hiq:baseball:2024:bowman-draft:cpa-tg:blue-wave-refractor:auto:num-150"];
    expect(numberedTwinsOf(TG, ids)).toEqual([`${TG}:num-150`]);
    expect(pickCatalogRow(TG, ids)).toMatchObject({ id: `${TG}:num-150`, kind: "numbered-twin" });
    // Only graded children, no twin: nothing — a child is derived from a row that is not there.
    expect(pickCatalogRow(TG, [`${TG}:num-150:psa-9`, `${TG}:num-150:psa-10`]).kind).toBe("none");
  });
});

describe("pickCatalogRow -- a numbered id (the #1509 direction, preserved)", () => {
  it("with its own row is exact, even when the un-numbered row also exists", () => {
    expect(pickCatalogRow(MWI_499, [MWI_499, MWI])).toMatchObject({ id: MWI_499, kind: "exact" });
  });
  it("with no row but an un-numbered row resolves to the un-numbered twin", () => {
    expect(pickCatalogRow(MWI_499, [MWI])).toEqual({ requested: MWI_499, id: MWI, kind: "unnumbered-twin", twins: [], poolTwin: null, sourceOfRow: null });
  });
  it("with neither is nothing; another print run is not its twin", () => {
    expect(pickCatalogRow(MWI_499, []).kind).toBe("none");
    expect(pickCatalogRow(MWI_499, [MWI_250]).kind).toBe("none");
  });
});

describe("pickCatalogRow -- several twins: the checklist authority names the card (the secondary refutation)", () => {
  const CHECKLIST = { id: MWI_499, source: "checklistcenter-2026-08-29" };
  const VENDOR_500 = { id: `${MWI}:num-500`, source: "cardhedge" };
  const DERIVED_250 = { id: MWI_250, source: "sold-comps-stub" };
  it("one checklist twin beside a vendor twin: the checklist row, chosenBy authority, both twins listed", () => {
    expect(pickCatalogRow(MWI, [CHECKLIST, VENDOR_500])).toEqual({
      requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499, `${MWI}:num-500`], chosenBy: "authority", poolTwin: MWI_499,
      // CF-WE-DONT-WANT-SELF-DERIVED (2026-09-04): the provenance of the row
      // ADOPTED, carried out of the stem query the resolution already ran, so
      // the pricing gate needs no second catalog read.
      sourceOfRow: "checklistcenter-2026-08-29",
    });
    expect(pickCatalogRow(MWI, [VENDOR_500, DERIVED_250, CHECKLIST]).id).toBe(MWI_499);
  });
  it("two checklist authorities that disagree on the print run: ambiguous (a ruling, not a guess)", () => {
    expect(pickCatalogRow(MWI, [CHECKLIST, { id: MWI_250, source: "beckett-checklist" }])).toMatchObject({ id: null, kind: "ambiguous", twins: [MWI_250, MWI_499] });
  });
  it("no authority among several twins: ambiguous", () => {
    expect(pickCatalogRow(MWI, [VENDOR_500, DERIVED_250])).toMatchObject({ id: null, kind: "ambiguous" });
  });
  it("a single twin is the card whatever its source (unchanged); bare ids are read as source-less", () => {
    // A single twin is still the card -- and its source is reported as what it
    // IS, so the gate can decline to price a vendor identity downstream.
    expect(pickCatalogRow(MWI, [VENDOR_500])).toEqual({ requested: MWI, id: `${MWI}:num-500`, kind: "numbered-twin", twins: [`${MWI}:num-500`], poolTwin: `${MWI}:num-500`, sourceOfRow: "cardhedge" });
    expect(pickCatalogRow(MWI, [MWI_499, MWI_250])).toMatchObject({ kind: "ambiguous" });
  });
});

describe("poolReadIdsFor -- which pool keys a reader unions", () => {
  it("numbered-twin: the id and its ONE twin; every other kind the id alone", () => {
    expect(poolReadIdsFor(MWI, pickCatalogRow(MWI, [MWI_499, GOLD_50]))).toEqual([MWI, MWI_499]);
    expect(poolReadIdsFor(MWI, pickCatalogRow(MWI, [MWI, MWI_499]))).toEqual([MWI]);
    expect(poolReadIdsFor(MWI, pickCatalogRow(MWI, [MWI_499, MWI_250]))).toEqual([MWI]);
    expect(poolReadIdsFor(MWI, pickCatalogRow(MWI, []))).toEqual([MWI]);
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI]))).toEqual([MWI_499]);
    expect(poolReadIdsFor(VENDOR, null)).toEqual([VENDOR]);
  });

  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW, the SYMMETRIC half (round-2
  // refutation, 2026-08-30). The branch's own writers rewrite holdings to the
  // NUMBERED form, and for THAT form the pool rows may still sit under the
  // stem — measured read-only, 2025 bowman-draft: 8 of 200 numbered ids whose
  // stem has no catalog row carry rows under the stem, three of them with
  // ZERO under the numbered id (…:bd-20:green-refractor:no-auto twin=0
  // stem=2). Reading the numbered id alone lists no comps for a card that has
  // sales — the mirror of the bug this branch fixes.
  it("REVERSE: a numbered id whose stem has NO catalog row reads [id, stem]", () => {
    // The catalog holds the numbered row only (the fold moved it here).
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI_499]))).toEqual([MWI_499, MWI]);
    // …and when the catalog holds neither: still the same card's two keys.
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, []))).toEqual([MWI_499, MWI]);
    // A sibling parallel under the same card changes nothing.
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI_499, GOLD_50]))).toEqual([MWI_499, MWI]);
  });

  it("REVERSE stops where the stem is a row of its OWN — a different identity, never unioned", () => {
    // #1509: the stem IS a catalog row, so the numbered id is the seller's
    // spelling of a DIFFERENT row; exactPoolSupremacy reaches it as a twin
    // attempt, the reader never merges the two pools.
    expect(pickCatalogRow(MWI_499, [MWI])).toMatchObject({ kind: "unnumbered-twin", poolTwin: null });
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI]))).toEqual([MWI_499]);
    // Both rows exist: the numbered id is its own row and the stem is another.
    expect(pickCatalogRow(MWI_499, [MWI_499, MWI])).toMatchObject({ kind: "exact", poolTwin: null });
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI_499, MWI]))).toEqual([MWI_499]);
  });

  it("the union is SYMMETRIC: the same two keys whichever form the reader arrives with", () => {
    // The stem has no row; the numbered row is the card. One list, two ways in.
    const fromStem = poolReadIdsFor(MWI, pickCatalogRow(MWI, [MWI_499]));
    const fromNumbered = poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI_499]));
    expect(fromStem).toEqual([MWI, MWI_499]);
    expect(fromNumbered).toEqual([MWI_499, MWI]);
    expect([...fromStem].sort()).toEqual([...fromNumbered].sort());
  });

  it("two numbered twins of one stem stay a refusal in BOTH directions", () => {
    expect(poolReadIdsFor(MWI, pickCatalogRow(MWI, [MWI_499, MWI_250]))).toEqual([MWI]);
    // From the numbered side the sibling twin is simply not this card's key:
    // the stem is the only other key, and it is unioned only because it has
    // no row of its own. :num-250's pool is never pulled into :num-499's.
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI_499, MWI_250]))).toEqual([MWI_499, MWI]);
    expect(poolReadIdsFor(MWI_499, pickCatalogRow(MWI_499, [MWI_499, MWI_250]))).not.toContain(MWI_250);
  });

  it("never unions two ids that are not the two halves of ONE stem", () => {
    const OTHER = "hiq:baseball:2025:bowman-draft:cpa-xyz:refractor:auto";
    // A hand-made resolution naming an unrelated slug is refused by the guard.
    expect(poolReadIdsFor(MWI, { requested: MWI, id: OTHER, kind: "numbered-twin", twins: [OTHER], poolTwin: OTHER })).toEqual([MWI]);
    expect(poolReadIdsFor(MWI, { requested: MWI, id: GOLD_50, kind: "numbered-twin", twins: [GOLD_50], poolTwin: GOLD_50 })).toEqual([MWI]);
  });
});

describe("pickCatalogRow -- not an hiq id", () => {
  it("a vendor id, blank, or garbage is none", () => {
    expect(pickCatalogRow(VENDOR, [VENDOR])).toEqual({ requested: VENDOR, id: null, kind: "none", twins: [], poolTwin: null });
    expect(pickCatalogRow("", []).kind).toBe("none");
    expect(pickCatalogRow("hiq:", []).kind).toBe("none");
  });
  it("trims the requested id", () => {
    expect(pickCatalogRow(`  ${MWI_499} `, [MWI_499])).toMatchObject({ requested: MWI_499, kind: "exact" });
  });
});
