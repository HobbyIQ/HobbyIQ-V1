/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3): the sold_comps
 * read behind recent-sales / price-history / canonical-fmv / listing-range matched
 * `c.hobbyiqCardId = @cid` exactly, so the 35 rows keyed …:refractor:auto:num-499
 * were invisible to a request for …:refractor:auto. The read now asks the resolver
 * ONCE and queries the row the identity IS — still one equality, never a STARTSWITH
 * union (two numbered twins must not merge).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import type { CatalogRowResolution } from "../src/services/catalog/catalogIdentityResolver.js";

const resolver = vi.hoisted(() => ({ resolveIdentityToCatalogRow: vi.fn() }));
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, resolveIdentityToCatalogRow: resolver.resolveIdentityToCatalogRow };
});

import {
  _setContainerForTests,
  poolReadIdFor,
  readCompsByCardId,
  readCompsByHobbyIqCardId,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const VENDOR = "1778814561816x835862652021336800";
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

/** 35 raw sales keyed under the numbered twin — the prod pool shape. */
const POOL = Array.from({ length: 35 }, (_, i) => ({
  id: `tca-ebay::${i}`, cardId: "ch-vendor-row", hobbyiqCardId: MWI_499, source: "tca-ebay",
  price: 100 + i, soldAt: daysAgo(i + 1), isAuto: true, printRun: 499, parallel: "Refractor",
  gradeCompany: null, gradeValue: null,
}));

type Spec = { query: string; parameters: Array<{ name: string; value: unknown }> };
const calls: Array<{ spec: Spec; opts: Record<string, unknown> | undefined }> = [];
function stubContainer(): Container {
  return {
    items: {
      query(spec: Spec, opts?: Record<string, unknown>) {
        calls.push({ spec, opts });
        const key = spec.parameters.find((p) => p.name === "@cid" || p.name === "@hiq")?.value;
        return { async fetchAll() { return { resources: POOL.filter((r) => r.hobbyiqCardId === key) }; } };
      },
    },
  } as unknown as Container;
}
const resolution = (requested: string, kind: CatalogRowResolution["kind"], id: string | null, twins: string[] = []): CatalogRowResolution =>
  ({ requested, id, kind, twins });

beforeEach(() => {
  calls.length = 0;
  _setContainerForTests(stubContainer());
  resolver.resolveIdentityToCatalogRow.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("readCompsByCardId -- an un-numbered hiq id", () => {
  it("queries `c.hobbyiqCardId = @cid` with @cid = the single numbered twin, and returns its 35 rows", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    const rows = await readCompsByCardId({ cardId: MWI, fromDate: daysAgo(365) });
    // Mutation check: with @cid = the id as given this is 0.
    expect(rows).toHaveLength(35);
    expect(resolver.resolveIdentityToCatalogRow).toHaveBeenCalledTimes(1);
    expect(resolver.resolveIdentityToCatalogRow).toHaveBeenCalledWith(MWI);
    expect(calls).toHaveLength(1);
    expect(calls[0].spec.query).toMatch(/c\.hobbyiqCardId = @cid/);
    expect(calls[0].spec.parameters.find((p) => p.name === "@cid")?.value).toBe(MWI_499);
    expect(calls[0].opts).toEqual({});                 // cross-partition, as before
    expect(calls[0].spec.query).not.toMatch(/ORDER BY/); // sorted in memory, as before
    expect(rows[0].soldAt > rows[34].soldAt).toBe(true);
  });
  it("never unions twins: no STARTSWITH in the query, one @cid", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    await readCompsByCardId({ cardId: MWI });
    expect(calls[0].spec.query).not.toMatch(/STARTSWITH/);
    expect(calls[0].spec.parameters.filter((p) => p.name === "@cid")).toHaveLength(1);
  });
  it("ambiguous (two twins): queries the id AS GIVEN and returns what sits under it — nothing here", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "ambiguous", null, [MWI_250, MWI_499]));
    const rows = await readCompsByCardId({ cardId: MWI });
    expect(rows).toEqual([]);
    expect(calls[0].spec.parameters.find((p) => p.name === "@cid")?.value).toBe(MWI);
  });
  it("none / unnumbered-twin: the id as given (today's behaviour)", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "none", null));
    await readCompsByCardId({ cardId: MWI });
    expect(calls[0].spec.parameters.find((p) => p.name === "@cid")?.value).toBe(MWI);
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI_250, "unnumbered-twin", MWI));
    await readCompsByCardId({ cardId: MWI_250 });
    expect(calls[1].spec.parameters.find((p) => p.name === "@cid")?.value).toBe(MWI_250);
  });
  it("a pre-resolved identity (recent-sales passes its own) is used without a second resolve", async () => {
    const rows = await readCompsByCardId({ cardId: MWI, resolvedIdentity: resolution(MWI, "numbered-twin", MWI_499, [MWI_499]) });
    expect(rows).toHaveLength(35);
    expect(resolver.resolveIdentityToCatalogRow).not.toHaveBeenCalled();
  });
});

describe("readCompsByCardId -- unchanged for the other inputs", () => {
  it("a numbered hiq id with its own row queries itself", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI_499, "exact", MWI_499));
    expect(await readCompsByCardId({ cardId: MWI_499 })).toHaveLength(35);
    expect(calls[0].spec.parameters.find((p) => p.name === "@cid")?.value).toBe(MWI_499);
  });
  it("a vendor cardId is not resolved: partition-scoped on c.cardId, ORDER BY kept", async () => {
    await readCompsByCardId({ cardId: VENDOR });
    expect(resolver.resolveIdentityToCatalogRow).not.toHaveBeenCalled();
    expect(calls[0].spec.query).toMatch(/c\.cardId = @cid/);
    expect(calls[0].spec.query).toMatch(/ORDER BY c\.soldAt DESC/);
    expect(calls[0].opts).toEqual({ partitionKey: VENDOR });
  });
});

describe("readCompsByHobbyIqCardId -- the same rule", () => {
  it("reads the numbered twin's rows for an un-numbered id", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "numbered-twin", MWI_499, [MWI_499]));
    const rows = await readCompsByHobbyIqCardId({ hobbyiqCardId: MWI, limit: 500 });
    expect(rows).toHaveLength(35);
    expect(calls[0].spec.query).toMatch(/c\.hobbyiqCardId = @hiq/);
    expect(calls[0].spec.parameters.find((p) => p.name === "@hiq")?.value).toBe(MWI_499);
    expect(calls[0].spec.query).not.toMatch(/STARTSWITH/);
  });
  it("ambiguous stays as given", async () => {
    resolver.resolveIdentityToCatalogRow.mockResolvedValue(resolution(MWI, "ambiguous", null, [MWI_250, MWI_499]));
    expect(await readCompsByHobbyIqCardId({ hobbyiqCardId: MWI })).toEqual([]);
    expect(calls[0].spec.parameters.find((p) => p.name === "@hiq")?.value).toBe(MWI);
  });
});

describe("poolReadIdFor -- pure", () => {
  it("only numbered-twin redirects; every other kind reads the id as given", () => {
    expect(poolReadIdFor(MWI, resolution(MWI, "numbered-twin", MWI_499, [MWI_499]))).toBe(MWI_499);
    expect(poolReadIdFor(MWI, resolution(MWI, "exact", MWI))).toBe(MWI);
    expect(poolReadIdFor(MWI, resolution(MWI, "ambiguous", null, [MWI_250, MWI_499]))).toBe(MWI);
    expect(poolReadIdFor(MWI, resolution(MWI, "none", null))).toBe(MWI);
    expect(poolReadIdFor(MWI_250, resolution(MWI_250, "unnumbered-twin", MWI))).toBe(MWI_250);
    expect(poolReadIdFor(VENDOR, null)).toBe(VENDOR);
  });
});
