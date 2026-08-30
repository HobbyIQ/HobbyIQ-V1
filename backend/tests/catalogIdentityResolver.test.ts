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
    expect(r).toEqual({ requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499] });
  });
  it("keeps its OWN row when it has one, even when a numbered twin also exists (conform's rowFor agrees)", () => {
    expect(pickCatalogRow(MWI, [MWI, MWI_499])).toEqual({ requested: MWI, id: MWI, kind: "exact", twins: [] });
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
    expect(pickCatalogRow(MWI_499, [MWI])).toEqual({ requested: MWI_499, id: MWI, kind: "unnumbered-twin", twins: [] });
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
      requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499, `${MWI}:num-500`], chosenBy: "authority",
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
    expect(pickCatalogRow(MWI, [VENDOR_500])).toEqual({ requested: MWI, id: `${MWI}:num-500`, kind: "numbered-twin", twins: [`${MWI}:num-500`] });
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
});

describe("pickCatalogRow -- not an hiq id", () => {
  it("a vendor id, blank, or garbage is none", () => {
    expect(pickCatalogRow(VENDOR, [VENDOR])).toEqual({ requested: VENDOR, id: null, kind: "none", twins: [] });
    expect(pickCatalogRow("", []).kind).toBe("none");
    expect(pickCatalogRow("hiq:", []).kind).toBe("none");
  });
  it("trims the requested id", () => {
    expect(pickCatalogRow(`  ${MWI_499} `, [MWI_499])).toMatchObject({ requested: MWI_499, kind: "exact" });
  });
});
