/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the Cosmos wrapper. The point read
 * first (the hit path, 1 RU — what catalogSlugIfExists always did); on a 404 the twin
 * lookup in whichever direction the id allows: a numbered id point-reads its
 * un-numbered form, an un-numbered id runs ONE stem query. Fails closed on anything
 * that is not a 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import { _setContainerForTests, resolveIdentityToCatalogRow, STEM_QUERY } from "../src/services/catalog/catalogIdentityResolver.js";

const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const VENDOR = "1778814561816x835862652021336800";

type Spec = { query: string; parameters: Array<{ name: string; value: unknown }> };

function stub(rows: string[], opts: { readError?: Error; queryError?: Error } = {}) {
  const calls = { reads: [] as string[], queries: [] as Spec[] };
  const container = {
    item(id: string, pk: string) {
      return {
        async read() {
          calls.reads.push(`${id}|${pk}`);
          if (opts.readError) throw opts.readError;
          if (rows.includes(id)) return { resource: { id } };
          const e = new Error("NotFound") as Error & { code: number };
          e.code = 404;
          throw e;
        },
      };
    },
    items: {
      query(spec: Spec) {
        calls.queries.push(spec);
        return {
          async fetchAll() {
            if (opts.queryError) throw opts.queryError;
            const stem = String(spec.parameters.find((p) => p.name === "@stem")?.value ?? "");
            return { resources: rows.filter((id) => id.startsWith(stem)) };
          },
        };
      },
    },
  } as unknown as Container;
  return { container, calls };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  delete process.env.COSMOS_CONNECTION_STRING;
  _setContainerForTests(null);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  _setContainerForTests(null);
  warnSpy.mockRestore();
  logSpy.mockRestore();
});
const events = (spy: ReturnType<typeof vi.spyOn>, name: string) => spy.mock.calls
  .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
  .filter((e): e is Record<string, unknown> => !!e && e.event === name);

describe("resolveIdentityToCatalogRow -- an un-numbered id", () => {
  it("point-reads the id, then runs ONE stem query with STARTSWITH(c.id, @stem) and resolves to the single twin", async () => {
    const { container, calls } = stub([MWI_499, "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50"]);
    const r = await resolveIdentityToCatalogRow(MWI, { container });
    expect(r).toEqual({ requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499] });
    expect(calls.reads).toEqual([`${MWI}|${MWI}`]);
    expect(calls.queries).toHaveLength(1);
    expect(calls.queries[0].query).toBe(STEM_QUERY);
    expect(calls.queries[0].query).toMatch(/STARTSWITH\(c\.id, @stem\)/);
    expect(calls.queries[0].parameters).toEqual([{ name: "@stem", value: `${MWI}:num-` }]);
    expect(events(logSpy, "catalog_identity_resolved_to_twin")).toMatchObject([{ slug: MWI, resolvedTo: MWI_499 }]);
  });
  it("its own row is the hit path: one point read, no query", async () => {
    const { container, calls } = stub([MWI, MWI_499]);
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: MWI, kind: "exact" });
    expect(calls.reads).toHaveLength(1);
    expect(calls.queries).toHaveLength(0);
  });
  it("two twins (graded children ignored) is ambiguous, logged with the twin list", async () => {
    const { container } = stub([MWI_499, MWI_250, `${MWI_499}:psa-9`]);
    const r = await resolveIdentityToCatalogRow(MWI, { container });
    expect(r).toEqual({ requested: MWI, id: null, kind: "ambiguous", twins: [MWI_250, MWI_499] });
    expect(events(warnSpy, "catalog_identity_ambiguous_twins")).toMatchObject([{ slug: MWI, twins: [MWI_250, MWI_499] }]);
  });
  it("no row under the stem is none", async () => {
    const { container } = stub([]);
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: null, kind: "none" });
  });
});

describe("resolveIdentityToCatalogRow -- a numbered id", () => {
  it("does not run the stem query: it point-reads itself, then its un-numbered form", async () => {
    const { container, calls } = stub([MWI]);
    expect(await resolveIdentityToCatalogRow(MWI_499, { container })).toMatchObject({ id: MWI, kind: "unnumbered-twin" });
    expect(calls.reads).toEqual([`${MWI_499}|${MWI_499}`, `${MWI}|${MWI}`]);
    expect(calls.queries).toHaveLength(0);
  });
  it("with its own row: one read, exact", async () => {
    const { container, calls } = stub([MWI_499]);
    expect(await resolveIdentityToCatalogRow(MWI_499, { container })).toMatchObject({ id: MWI_499, kind: "exact" });
    expect(calls.reads).toHaveLength(1);
  });
});

describe("resolveIdentityToCatalogRow -- fails closed", () => {
  it("a non-404 read error is none, logged", async () => {
    const { container, calls } = stub([MWI_499], { readError: Object.assign(new Error("429 throttled"), { code: 429 }) });
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toEqual({ requested: MWI, id: null, kind: "none", twins: [] });
    expect(calls.queries).toHaveLength(0);
    expect(events(warnSpy, "catalog_identity_resolve_error")).toMatchObject([{ step: "point-read", slug: MWI }]);
  });
  it("a stem-query error is none, logged", async () => {
    const { container } = stub([MWI_499], { queryError: new Error("query failed") });
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: null, kind: "none" });
    expect(events(warnSpy, "catalog_identity_resolve_error")).toMatchObject([{ step: "stem-query", slug: MWI }]);
  });
  it("no container (no connection string) is none, without throwing", async () => {
    expect(await resolveIdentityToCatalogRow(MWI)).toEqual({ requested: MWI, id: null, kind: "none", twins: [] });
  });
  it("a vendor id is none with ZERO reads", async () => {
    const { container, calls } = stub([VENDOR]);
    _setContainerForTests(container);
    expect(await resolveIdentityToCatalogRow(VENDOR)).toMatchObject({ id: null, kind: "none" });
    expect(calls.reads).toHaveLength(0);
    expect(calls.queries).toHaveLength(0);
  });
  it("_setContainerForTests seam: the module container is used when no override is passed", async () => {
    const { container, calls } = stub([MWI_499]);
    _setContainerForTests(container);
    expect(await resolveIdentityToCatalogRow(MWI)).toMatchObject({ id: MWI_499, kind: "numbered-twin" });
    expect(calls.reads).toHaveLength(1);
  });
});
