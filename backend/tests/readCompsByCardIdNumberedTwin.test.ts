/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3): the sold_comps
 * read behind recent-sales / price-history / canonical-fmv / listing-range matched
 * `c.hobbyiqCardId = @cid` exactly, so the 35 rows keyed …:refractor:auto:num-499
 * were invisible to a request for …:refractor:auto. A first fix SWAPPED the id for
 * its twin — and read 0 for every card whose pool still sits under the un-numbered
 * key (the fold re-keyed catalog rows, not sold_comps: …:cpa-sha:green:auto 14 vs
 * 0, …:bdc-145:chrome-black-refractor 4 vs 0, …:cpa-bm:red-refractor:auto 8 vs 0).
 * The read now asks the resolver ONCE and queries the id AND its one twin — two
 * equalities in one query, never a STARTSWITH union (two numbered twins must not
 * merge). The permanent fix is the D29 fleet re-keying the pool.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import { poolReadIdsFor, type CatalogRowResolution } from "../src/services/catalog/catalogIdentityResolver.js";

const resolver = vi.hoisted(() => ({ resolveIdentityToCatalogRow: vi.fn() }));
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, resolveIdentityToCatalogRow: resolver.resolveIdentityToCatalogRow };
});

import {
  _setContainerForTests,
  readCompsByCardId,
  readCompsByHobbyIqCardId,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const VENDOR = "1778814561816x835862652021336800";
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const sale = (slug: string, i: number, printRun: number | null) => ({
  id: `tca-ebay::${slug}::${i}`, cardId: "ch-vendor-row", hobbyiqCardId: slug, source: "tca-ebay",
  price: 100 + i, soldAt: daysAgo(i + 1), isAuto: true, printRun, parallel: "Refractor",
  gradeCompany: null, gradeValue: null,
});
/** 35 raw sales keyed under the numbered twin — the Max Williams shape. */
const TWIN_ROWS = Array.from({ length: 35 }, (_, i) => sale(MWI_499, i, 499));
/** 14 raw sales keyed under the UN-numbered id — the cpa-sha shape (the common state). */
const UN_ROWS = Array.from({ length: 14 }, (_, i) => sale(MWI, i, null));

type Spec = { query: string; parameters: Array<{ name: string; value: unknown }> };
const calls: Array<{ spec: Spec; opts: Record<string, unknown> | undefined }> = [];
let pool: Array<Record<string, unknown>> = [];
function stubContainer(): Container {
  return {
    items: {
      query(spec: Spec, opts?: Record<string, unknown>) {
        calls.push({ spec, opts });
        const keys = spec.parameters
          .filter((p) => ["@cid", "@cid1", "@hiq", "@hiq1"].includes(p.name))
          .map((p) => p.value);
        return { async fetchAll() { return { resources: pool.filter((r) => keys.includes(r.hobbyiqCardId) || keys.includes(r.cardId)) }; } };
      },
    },
  } as unknown as Container;
}
// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: poolTwin is what poolReadIdsFor reads,
// and it is SYMMETRIC (round-2 refutation) — an un-numbered id's one numbered
// row, or a numbered id's stem when the stem has no row of its own.
const resolution = (requested: string, kind: CatalogRowResolution["kind"], id: string | null, twins: string[] = [], poolTwin: string | null = kind === "numbered-twin" ? id : null): CatalogRowResolution =>
  ({ requested, id, kind, twins, poolTwin });
const param = (i: number, name: string) => calls[i].spec.parameters.find((p) => p.name === name)?.value;

beforeEach(() => {
  calls.length = 0;
  pool = [];
  _setContainerForTests(stubContainer());
  resolver.resolveIdentityToCatalogRow.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("readCompsByCardId -- an un-numbered hiq id whose one catalog row is its numbered twin", () => {
  it("reads the id AND the twin in one query: the twin's 35 rows (Max Williams)", async () => {
    pool = TWIN_ROWS;
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    const rows = await readCompsByCardId({ cardId: MWI, fromDate: daysAgo(365) });
    // Mutation check: with @cid = the id as given (main) this is 0.
    expect(rows).toHaveLength(35);
    expect(resolver.resolveIdentityToCatalogRow).toHaveBeenCalledTimes(1);
    expect(resolver.resolveIdentityToCatalogRow).toHaveBeenCalledWith(MWI, { printRun: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].spec.query).toMatch(/\(c\.hobbyiqCardId = @cid OR c\.hobbyiqCardId = @cid1\)/);
    expect(param(0, "@cid")).toBe(MWI);
    expect(param(0, "@cid1")).toBe(MWI_499);
    expect(calls[0].opts).toEqual({});                 // cross-partition, as before
    expect(calls[0].spec.query).not.toMatch(/ORDER BY/); // sorted in memory, as before
    expect(rows[0].soldAt > rows[34].soldAt).toBe(true);
  });
  it("the un-numbered id's OWN rows (14 under the id, 0 under the twin — the cpa-sha shape) are read, not dropped", async () => {
    pool = UN_ROWS;
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    const rows = await readCompsByCardId({ cardId: MWI });
    // Mutation check: the swap (@cid = the twin only) read 0 here — the refuted branch.
    expect(rows).toHaveLength(14);
    expect(param(0, "@cid")).toBe(MWI);
    expect(param(0, "@cid1")).toBe(MWI_499);
  });
  it("both halves: 14 + 35 = 49, newest first, still ONE query", async () => {
    pool = [...UN_ROWS, ...TWIN_ROWS];
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    const rows = await readCompsByCardId({ cardId: MWI });
    expect(rows).toHaveLength(49);
    expect(calls).toHaveLength(1);
    for (let i = 1; i < rows.length; i++) expect(Date.parse(rows[i - 1].soldAt) >= Date.parse(rows[i].soldAt)).toBe(true);
  });
  it("never a STARTSWITH union: exactly two equalities, never a third id", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    await readCompsByCardId({ cardId: MWI });
    expect(calls[0].spec.query).not.toMatch(/STARTSWITH/);
    expect(calls[0].spec.parameters.filter((p) => p.name.startsWith("@cid"))).toHaveLength(2);
  });
  it("ambiguous (two twins): queries the id AS GIVEN only — two cards are never merged", async () => {
    pool = [...UN_ROWS, ...TWIN_ROWS];
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "ambiguous", null, [MWI_250, MWI_499]));
    const rows = await readCompsByCardId({ cardId: MWI });
    expect(rows).toHaveLength(14);
    expect(calls[0].spec.query).toMatch(/c\.hobbyiqCardId = @cid AND/);
    expect(param(0, "@cid")).toBe(MWI);
    expect(param(0, "@cid1")).toBeUndefined();
  });
  it("none / unnumbered-twin / unresolved: the id as given (fail open on unresolved)", async () => {
    pool = [...UN_ROWS, ...TWIN_ROWS];
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "none", null));
    expect(await readCompsByCardId({ cardId: MWI })).toHaveLength(14);
    expect(param(0, "@cid")).toBe(MWI);
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI_250, "unnumbered-twin", MWI));
    await readCompsByCardId({ cardId: MWI_250 });
    expect(param(1, "@cid")).toBe(MWI_250);
    resolver.resolveIdentityToCatalogRow.mockResolvedValue({ ...resolution(MWI, "unresolved", null), error: "429" });
    expect(await readCompsByCardId({ cardId: MWI })).toHaveLength(14);
    expect(param(2, "@cid")).toBe(MWI);
    expect(param(2, "@cid1")).toBeUndefined();
  });
  it("a pre-resolved identity (recent-sales passes its own) is used without a second resolve", async () => {
    pool = TWIN_ROWS;
    const rows = await readCompsByCardId({ cardId: MWI, resolvedIdentity: resolution(MWI, "numbered-twin", MWI_499, [MWI_499]) });
    expect(rows).toHaveLength(35);
    expect(resolver.resolveIdentityToCatalogRow).not.toHaveBeenCalled();
  });
  it("a caller's printRun is handed to the resolver as the twin hint (a 1-RU point read, not the stem query)", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    await readCompsByCardId({ cardId: MWI, printRun: 499 });
    expect(resolver.resolveIdentityToCatalogRow).toHaveBeenCalledWith(MWI, { printRun: 499 });
  });
});

describe("readCompsByCardId -- unchanged for the other inputs", () => {
  it("a numbered hiq id with its own row queries itself only", async () => {
    pool = [...UN_ROWS, ...TWIN_ROWS];
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI_499, "exact", MWI_499));
    expect(await readCompsByCardId({ cardId: MWI_499 })).toHaveLength(35);
    expect(param(0, "@cid")).toBe(MWI_499);
    expect(param(0, "@cid1")).toBeUndefined();
  });
  it("a vendor cardId is not resolved: partition-scoped on c.cardId, ORDER BY kept", async () => {
    await readCompsByCardId({ cardId: VENDOR });
    expect(resolver.resolveIdentityToCatalogRow).not.toHaveBeenCalled();
    expect(calls[0].spec.query).toMatch(/c\.cardId = @cid AND/);
    expect(calls[0].spec.query).toMatch(/ORDER BY c\.soldAt DESC/);
    expect(calls[0].opts).toEqual({ partitionKey: VENDOR });
  });
});

describe("readCompsByHobbyIqCardId -- the same rule", () => {
  it("reads both halves for an un-numbered id: 14 + 35", async () => {
    pool = [...UN_ROWS, ...TWIN_ROWS];
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    const rows = await readCompsByHobbyIqCardId({ hobbyiqCardId: MWI, limit: 500 });
    expect(rows).toHaveLength(49);
    expect(calls[0].spec.query).toMatch(/\(c\.hobbyiqCardId = @hiq OR c\.hobbyiqCardId = @hiq1\)/);
    expect(param(0, "@hiq")).toBe(MWI);
    expect(param(0, "@hiq1")).toBe(MWI_499);
    expect(calls[0].spec.query).not.toMatch(/STARTSWITH/);
    expect(resolver.resolveIdentityToCatalogRow).toHaveBeenCalledWith(MWI, { printRun: null });
  });
  it("ambiguous stays as given", async () => {
    pool = TWIN_ROWS;
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "ambiguous", null, [MWI_250, MWI_499]));
    expect(await readCompsByHobbyIqCardId({ hobbyiqCardId: MWI })).toEqual([]);
    expect(param(0, "@hiq")).toBe(MWI);
    expect(param(0, "@hiq1")).toBeUndefined();
  });
});

// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW, SYMMETRIC (round-2 refutation): the
// same union from the numbered side. Measured read-only 2026-08-30, 2025
// bowman-draft: 8 of 200 numbered ids whose stem has no catalog row carry
// pool rows under the stem, three with ZERO under the numbered id.
describe("readCompsByCardId -- REVERSE: a numbered id whose sales sit under its stem", () => {
  it("reads the id AND the stem in one query: the stem's rows are not dropped", async () => {
    pool = UN_ROWS;
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI_499, "exact", MWI_499, [], MWI));
    const rows = await readCompsByCardId({ cardId: MWI_499, fromDate: daysAgo(365) });
    // Mutation check: round 2 read …:num-499 alone here and returned 0 — the
    // …:bd-20:green-refractor:no-auto shape (twin=0, stem=2).
    expect(rows).toHaveLength(14);
    expect(calls).toHaveLength(1);
    expect([param(0, "@cid"), param(0, "@cid1")]).toEqual([MWI_499, MWI]);
  });
  it("both halves in one query, exactly two equalities, never a third id", async () => {
    pool = [...TWIN_ROWS, ...UN_ROWS];
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI_499, "exact", MWI_499, [], MWI));
    expect(await readCompsByCardId({ cardId: MWI_499, fromDate: daysAgo(365) })).toHaveLength(49);
    expect(calls[0].spec.query).not.toMatch(/STARTSWITH/);
    expect(calls[0].spec.parameters.filter((p) => p.name.startsWith("@cid"))).toHaveLength(2);
  });
  it("a stem that IS a catalog row of its own is never unioned in (#1509 stays)", async () => {
    pool = [...TWIN_ROWS, ...UN_ROWS];
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI_499, "exact", MWI_499, [], null));
    expect(await readCompsByCardId({ cardId: MWI_499, fromDate: daysAgo(365) })).toHaveLength(35);
    expect(param(0, "@cid1")).toBeUndefined();
  });
});

describe("poolReadIdsFor -- pure", () => {
  it("unions the id with its ONE pool twin; every other kind reads the id as given", () => {
    expect(poolReadIdsFor(MWI, resolution(MWI, "numbered-twin", MWI_499, [MWI_499]))).toEqual([MWI, MWI_499]);
    expect(poolReadIdsFor(MWI, resolution(MWI, "exact", MWI))).toEqual([MWI]);
    expect(poolReadIdsFor(MWI, resolution(MWI, "ambiguous", null, [MWI_250, MWI_499]))).toEqual([MWI]);
    expect(poolReadIdsFor(MWI, resolution(MWI, "none", null))).toEqual([MWI]);
    expect(poolReadIdsFor(MWI, { ...resolution(MWI, "unresolved", null), error: "429" })).toEqual([MWI]);
    expect(poolReadIdsFor(MWI_250, resolution(MWI_250, "unnumbered-twin", MWI))).toEqual([MWI_250]);
    expect(poolReadIdsFor(VENDOR, null)).toEqual([VENDOR]);
    expect(poolReadIdsFor(`  ${MWI} `, undefined)).toEqual([MWI]);
  });
  // The round-2 refutation, at the reader: the writers leave the NUMBERED
  // form on a holding while the sales stay under the stem.
  it("REVERSE: a numbered id whose stem has no catalog row reads [id, stem]", () => {
    expect(poolReadIdsFor(MWI_499, resolution(MWI_499, "exact", MWI_499, [], MWI))).toEqual([MWI_499, MWI]);
    expect(poolReadIdsFor(MWI_499, resolution(MWI_499, "none", null, [], MWI))).toEqual([MWI_499, MWI]);
  });
});
