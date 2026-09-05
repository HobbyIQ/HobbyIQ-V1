/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the Cosmos wrapper. The point read
 * first (the hit path, 1 RU — what catalogSlugIfExists always did); on a 404 the twin
 * lookup in whichever direction the id allows: a numbered id point-reads its
 * un-numbered form; an un-numbered id runs ONE stem query — DISTINCT (the SDK's
 * parallel pipeline: 150–340 ms instead of 1.7–2.4 s at the same 112 RU fan-out
 * floor), twins only, memoized per stem (10 min, bounded) and shared by concurrent
 * callers — unless the caller's print run names the twin, which a 1-RU point read
 * settles. Fails OPEN on anything that is not a 404 (kind "unresolved"), never "none".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  _clearIdentityMemoForTests,
  _identityMemoSizeForTests,
  _setContainerForTests,
  IDENTITY_MEMO_MAX_ENTRIES,
  IDENTITY_MEMO_TTL_MS,
  poolReadIdsFor,
  resolveIdentityToCatalogRow,
  STEM_QUERY,
} from "../src/services/catalog/catalogIdentityResolver.js";

const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const VENDOR = "1778814561816x835862652021336800";

type Spec = { query: string; parameters: Array<{ name: string; value: unknown }> };
type Row = { id: string; source?: string | null };

/** A card_catalog stub: point reads by id; the stem query answers the way the
 *  server does — DISTINCT { id, source } rows under the stem with nothing after
 *  the print run (graded children filtered server-side). */
function stub(rows: Array<string | Row>, opts: { readError?: Error; queryError?: Error; queryDelayMs?: number } = {}) {
  const table: Row[] = rows.map((r) => (typeof r === "string" ? { id: r, source: "checklistcenter" } : r));
  const calls = { reads: [] as string[], queries: [] as Spec[] };
  const container = {
    item(id: string, pk: string) {
      return {
        async read() {
          calls.reads.push(`${id}|${pk}`);
          if (opts.readError) throw opts.readError;
          if (table.some((r) => r.id === id)) return { resource: { id } };
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
            if (opts.queryDelayMs) await new Promise((r) => setTimeout(r, opts.queryDelayMs));
            if (opts.queryError) throw opts.queryError;
            const stem = String(spec.parameters.find((p) => p.name === "@stem")?.value ?? "");
            const resources = table
              .filter((r) => r.id.startsWith(stem) && !r.id.slice(stem.length).includes(":"))
              .map((r) => ({ id: r.id, source: r.source ?? null }));
            return { resources, requestCharge: 112 };
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
  _clearIdentityMemoForTests();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  _setContainerForTests(null);
  _clearIdentityMemoForTests();
  vi.useRealTimers();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});
const events = (spy: ReturnType<typeof vi.spyOn>, name: string) => spy.mock.calls
  .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
  .filter((e): e is Record<string, unknown> => !!e && e.event === name);

describe("resolveIdentityToCatalogRow -- an un-numbered id", () => {
  it("point-reads the id, then runs ONE DISTINCT twins-only stem query and resolves to the single twin", async () => {
    const { container, calls } = stub([MWI_499, `${MWI_499}:psa-9`, "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50"]);
    const r = await resolveIdentityToCatalogRow(MWI, { container });
    // sourceOfRow rides out of the stem query this test already counts
    // (CF-WE-DONT-WANT-SELF-DERIVED, 2026-09-04) — the pricing gate reads the
    // adopted row's provenance without a second catalog read.
    expect(r).toEqual({ requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499], poolTwin: MWI_499, sourceOfRow: "checklistcenter" });
    expect(calls.reads).toEqual([`${MWI}|${MWI}`]);
    expect(calls.queries).toHaveLength(1);
    expect(calls.queries[0].query).toBe(STEM_QUERY);
    // The shape that cuts the latency and the rows: DISTINCT (the SDK's parallel
    // pipeline), the id-prefix (the only predicate that is correct — rows disagree
    // with their own fields), no graded children (nothing after the print run).
    expect(calls.queries[0].query).toMatch(/^SELECT DISTINCT c\.id, c\.source FROM c WHERE STARTSWITH\(c\.id, @stem\)/);
    expect(calls.queries[0].query).toMatch(/NOT CONTAINS\(SUBSTRING\(c\.id, LENGTH\(@stem\), 64\), ':'\)/);
    expect(calls.queries[0].parameters).toEqual([{ name: "@stem", value: `${MWI}:num-` }]);
    expect(events(logSpy, "catalog_identity_resolved_to_twin")).toMatchObject([{ slug: MWI, resolvedTo: MWI_499, chosenBy: "only" }]);
    expect(events(logSpy, "catalog_identity_stem_lookup")).toMatchObject([{ slug: MWI, kind: "numbered-twin", ru: 112 }]);
  });
  it("its own row is the hit path: one point read, no query, nothing memoized", async () => {
    const { container, calls } = stub([MWI, MWI_499]);
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: MWI, kind: "exact" });
    expect(calls.reads).toHaveLength(1);
    expect(calls.queries).toHaveLength(0);
    expect(_identityMemoSizeForTests()).toBe(0);
  });
  it("two checklist twins is ambiguous — the authorities disagree — logged with the twin list", async () => {
    const { container } = stub([MWI_499, MWI_250, `${MWI_499}:psa-9`]);
    const r = await resolveIdentityToCatalogRow(MWI, { container });
    expect(r).toEqual({ requested: MWI, id: null, kind: "ambiguous", twins: [MWI_250, MWI_499], poolTwin: null });
    expect(events(warnSpy, "catalog_identity_ambiguous_twins")).toMatchObject([{ slug: MWI, twins: [MWI_250, MWI_499] }]);
  });
  it("prefers the checklist-authority twin when a vendor row spells another print run", async () => {
    const { container } = stub([{ id: MWI_499, source: "checklistcenter-2026-08-29" }, { id: `${MWI}:num-500`, source: "cardhedge" }]);
    const r = await resolveIdentityToCatalogRow(MWI, { container });
    // Mutation check: without the authority rule this is "ambiguous", id null.
    expect(r).toEqual({ requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499, `${MWI}:num-500`], chosenBy: "authority", poolTwin: MWI_499, sourceOfRow: "checklistcenter-2026-08-29" });
    expect(events(logSpy, "catalog_identity_resolved_to_twin")).toMatchObject([{ slug: MWI, resolvedTo: MWI_499, chosenBy: "authority" }]);
  });
  it("two vendor twins and no authority is still a refusal", async () => {
    const { container } = stub([{ id: MWI_499, source: "cardhedge" }, { id: MWI_250, source: "sold-comps-stub" }]);
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: null, kind: "ambiguous" });
  });
  it("no row under the stem is none — and that answer is memoized too (the 20% no-row ids pay once)", async () => {
    const { container, calls } = stub([]);
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: null, kind: "none" });
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: null, kind: "none" });
    expect(calls.queries).toHaveLength(1);
  });
});

describe("resolveIdentityToCatalogRow -- the caller's print run settles the twin with a point read", () => {
  it("printRun 499: reads the id (404) then …:num-499 (hit) — no stem query at all", async () => {
    const { container, calls } = stub([MWI_499]);
    const r = await resolveIdentityToCatalogRow(MWI, { container, printRun: 499 });
    expect(r).toEqual({ requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499], chosenBy: "print-run", poolTwin: MWI_499 });
    expect(calls.reads).toEqual([`${MWI}|${MWI}`, `${MWI_499}|${MWI_499}`]);
    expect(calls.queries).toHaveLength(0);
    expect(events(logSpy, "catalog_identity_resolved_to_twin")).toMatchObject([{ slug: MWI, resolvedTo: MWI_499, chosenBy: "print-run" }]);
  });
  it("a print run the catalog does not carry falls through to the stem query (the catalog's /499 wins over the holding's /250)", async () => {
    const { container, calls } = stub([MWI_499]);
    const r = await resolveIdentityToCatalogRow(MWI, { container, printRun: 250 });
    expect(r).toMatchObject({ id: MWI_499, kind: "numbered-twin" });
    expect(calls.reads).toEqual([`${MWI}|${MWI}`, `${MWI_250}|${MWI_250}`]);
    expect(calls.queries).toHaveLength(1);
  });
  it("a print run disambiguates a memoized refusal without a second query", async () => {
    const { container, calls } = stub([MWI_499, MWI_250]);
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ kind: "ambiguous" });
    const r = await resolveIdentityToCatalogRow(MWI, { container, printRun: 250 });
    expect(r).toMatchObject({ id: MWI_250, kind: "numbered-twin", chosenBy: "print-run" });
    expect(calls.queries).toHaveLength(1);
    // Without a print run the refusal stands, from the memo.
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ kind: "ambiguous" });
    expect(calls.queries).toHaveLength(1);
  });
  it("a string print run is accepted; a non-positive one is ignored", async () => {
    const { container, calls } = stub([MWI_499]);
    expect(await resolveIdentityToCatalogRow(MWI, { container, printRun: "499" })).toMatchObject({ id: MWI_499, chosenBy: "print-run" });
    expect(calls.queries).toHaveLength(0);
    _clearIdentityMemoForTests();
    await resolveIdentityToCatalogRow(MWI, { container, printRun: 0 });
    expect(calls.queries).toHaveLength(1);
  });
});

describe("resolveIdentityToCatalogRow -- the memo: one stem query per stem per TTL", () => {
  it("a card page's 4-5 reads of one stem pay the query once", async () => {
    const { container, calls } = stub([MWI_499]);
    for (let i = 0; i < 5; i++) expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: MWI_499 });
    // Mutation check: without the memo this is 5.
    expect(calls.queries).toHaveLength(1);
    expect(calls.reads).toHaveLength(5);            // the 1-RU point read still runs (a row could appear)
    expect(_identityMemoSizeForTests()).toBe(1);
  });
  it("concurrent callers share ONE in-flight query", async () => {
    const { container, calls } = stub([MWI_499], { queryDelayMs: 20 });
    const [a, b, c] = await Promise.all([
      resolveIdentityToCatalogRow(MWI, { container }),
      resolveIdentityToCatalogRow(MWI, { container }),
      resolveIdentityToCatalogRow(MWI, { container }),
    ]);
    expect([a.id, b.id, c.id]).toEqual([MWI_499, MWI_499, MWI_499]);
    expect(calls.queries).toHaveLength(1);
  });
  it("a memoized answer is a copy: mutating it does not poison the next caller", async () => {
    const { container } = stub([MWI_499]);
    const first = await resolveIdentityToCatalogRow(MWI, { container });
    first.twins.push("junk");
    (first as { id: string | null }).id = null;
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toEqual({ requested: MWI, id: MWI_499, kind: "numbered-twin", twins: [MWI_499], poolTwin: MWI_499, sourceOfRow: "checklistcenter" });
  });
  it("expires after the TTL (~10 min) and is bounded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
    const { container, calls } = stub([MWI_499]);
    await resolveIdentityToCatalogRow(MWI, { container });
    vi.setSystemTime(new Date(Date.now() + IDENTITY_MEMO_TTL_MS - 1));
    await resolveIdentityToCatalogRow(MWI, { container });
    expect(calls.queries).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 2));
    await resolveIdentityToCatalogRow(MWI, { container });
    expect(calls.queries).toHaveLength(2);
    expect(IDENTITY_MEMO_TTL_MS).toBe(10 * 60_000);
    expect(IDENTITY_MEMO_MAX_ENTRIES).toBe(5000);
  });
  it("evicts the oldest stem past the bound", async () => {
    const { container, calls } = stub([]);
    const stem = (i: number) => `hiq:baseball:2025:bowman-draft:cpa-x${i}:refractor:auto`;
    for (let i = 0; i < IDENTITY_MEMO_MAX_ENTRIES + 1; i++) await resolveIdentityToCatalogRow(stem(i), { container });
    expect(_identityMemoSizeForTests()).toBe(IDENTITY_MEMO_MAX_ENTRIES);
    const before = calls.queries.length;
    await resolveIdentityToCatalogRow(stem(0), { container });             // evicted: queried again
    await resolveIdentityToCatalogRow(stem(IDENTITY_MEMO_MAX_ENTRIES), { container }); // newest: from the memo
    expect(calls.queries.length).toBe(before + 1);
  });
});

describe("resolveIdentityToCatalogRow -- a numbered id", () => {
  it("does not run the stem query: it point-reads itself, then its un-numbered form", async () => {
    const { container, calls } = stub([MWI]);
    expect(await resolveIdentityToCatalogRow(MWI_499, { container })).toMatchObject({ id: MWI, kind: "unnumbered-twin", poolTwin: null });
    expect(calls.reads).toEqual([`${MWI_499}|${MWI_499}`, `${MWI}|${MWI}`]);
    expect(calls.queries).toHaveLength(0);
  });

  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW, the SYMMETRIC half (round-2
  // refutation, 2026-08-30). The branch's own writers leave the NUMBERED form
  // on a holding, and the fold moved the catalog row without moving the sales
  // — so the numbered id's other pool key is its stem. Measured read-only,
  // 2025 bowman-draft: 8 of 200 such ids carry rows under the stem, three
  // with ZERO under the numbered id.
  it("REVERSE: its own row and NO row for its stem — kind exact, poolTwin the stem, TWO reads", async () => {
    const { container, calls } = stub([MWI_499]);
    const r = await resolveIdentityToCatalogRow(MWI_499, { container });
    // Mutation check: round 2 returned after the first read and never set
    // poolTwin, so the reader read …:num-499 alone while the sales sat under
    // the stem — the mirror of the bug this branch fixes.
    // sourceOfRow is NULL on this path and that is correct: the row was
    // settled by two POINT READS, which return the id alone — no stem query
    // ran, so no source was fetched. Absence is unknown provenance, and the
    // pricing gate treats unknown as unbacked rather than as permission.
    expect(r).toEqual({ requested: MWI_499, id: MWI_499, kind: "exact", twins: [], poolTwin: MWI, sourceOfRow: null });
    expect(poolReadIdsFor(MWI_499, r)).toEqual([MWI_499, MWI]);
    // The stem read is what settles poolTwin: two point reads (2 RU), no query.
    expect(calls.reads).toEqual([`${MWI_499}|${MWI_499}`, `${MWI}|${MWI}`]);
    expect(calls.queries).toHaveLength(0);
    expect(events(logSpy, "catalog_identity_pool_twin_is_the_stem")).toMatchObject([{ slug: MWI_499, poolTwin: MWI }]);
  });

  it("REVERSE: BOTH rows exist — the stem is its own identity, poolTwin null, no union", async () => {
    const { container } = stub([MWI_499, MWI]);
    const r = await resolveIdentityToCatalogRow(MWI_499, { container });
    expect(r).toMatchObject({ id: MWI_499, kind: "exact", poolTwin: null });
    expect(poolReadIdsFor(MWI_499, r)).toEqual([MWI_499]);
  });

  it("REVERSE: neither row exists — kind none, but the stem is still the other pool key", async () => {
    const { container } = stub([]);
    const r = await resolveIdentityToCatalogRow(MWI_499, { container });
    expect(r).toMatchObject({ id: null, kind: "none", poolTwin: MWI });
    expect(poolReadIdsFor(MWI_499, r)).toEqual([MWI_499, MWI]);
  });

  it("REVERSE: a sibling print run is never pulled in", async () => {
    const { container } = stub([MWI_499, MWI_250]);
    expect(poolReadIdsFor(MWI_499, await resolveIdentityToCatalogRow(MWI_499, { container }))).toEqual([MWI_499, MWI]);
  });

  it("REVERSE: a stem read that is not a 404 fails OPEN — unresolved, the id read as given", async () => {
    let n = 0;
    const container = {
      item(id: string, pk: string) {
        return {
          async read() {
            n++;
            if (id === MWI_499) return { resource: { id } };
            throw Object.assign(new Error("429 throttled"), { code: 429 });
          },
        };
      },
      items: { query() { throw new Error("no query expected"); } },
    } as unknown as Container;
    const r = await resolveIdentityToCatalogRow(MWI_499, { container });
    expect(r).toMatchObject({ id: null, kind: "unresolved", error: "429 throttled", poolTwin: null });
    expect(poolReadIdsFor(MWI_499, r)).toEqual([MWI_499]);
    expect(n).toBe(2);
  });
});

describe("resolveIdentityToCatalogRow -- fails OPEN on anything that is not a 404", () => {
  it("a 429 on the point read is unresolved (id null, the error carried), logged, not memoized — never none", async () => {
    const { container, calls } = stub([MWI_499], { readError: Object.assign(new Error("429 throttled"), { code: 429 }) });
    const r = await resolveIdentityToCatalogRow(MWI, { container });
    // Mutation check: the fail-closed resolver answered kind "none" here — identity-not-in-catalog for a card with a row.
    expect(r).toEqual({ requested: MWI, id: null, kind: "unresolved", twins: [], error: "429 throttled", poolTwin: null });
    expect(calls.queries).toHaveLength(0);
    expect(events(warnSpy, "catalog_identity_resolve_error")).toMatchObject([{ step: "point-read", slug: MWI, failOpen: true }]);
    expect(_identityMemoSizeForTests()).toBe(0);
    // The next call, catalog healthy, resolves.
    const healthy = stub([MWI_499]);
    expect(await resolveIdentityToCatalogRow(MWI, { container: healthy.container })).toMatchObject({ id: MWI_499, kind: "numbered-twin" });
  });
  it("a stem-query error is unresolved, logged, not memoized", async () => {
    const { container } = stub([MWI_499], { queryError: new Error("query failed") });
    expect(await resolveIdentityToCatalogRow(MWI, { container })).toMatchObject({ id: null, kind: "unresolved", error: "query failed" });
    expect(events(warnSpy, "catalog_identity_resolve_error")).toMatchObject([{ step: "stem-query", slug: MWI, failOpen: true }]);
    expect(_identityMemoSizeForTests()).toBe(0);
  });
  it("a numbered id's twin read failing is unresolved too", async () => {
    let n = 0;
    const base = stub([]);
    const container = {
      ...base.container,
      item(id: string) {
        return { async read() { n++; if (n === 2) throw Object.assign(new Error("503"), { code: 503 }); throw Object.assign(new Error("NotFound"), { code: 404 }); } };
      },
    } as unknown as Container;
    expect(await resolveIdentityToCatalogRow(MWI_499, { container })).toMatchObject({ kind: "unresolved", error: "503" });
  });
  it("no container (no connection string) is none, without throwing — nothing was asked", async () => {
    expect(await resolveIdentityToCatalogRow(MWI)).toEqual({ requested: MWI, id: null, kind: "none", twins: [], poolTwin: null });
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
