/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3): valueIdentity —
 * the ONE entry behind price-by-id, hobbyiq-fmv, card-detail, observed-grade-curve,
 * card-panel and canonical-fmv — gates every route on the catalog. For an un-numbered
 * id whose only catalog row is …:num-499 that answered identity-not-in-catalog /
 * no-basis before any pool was read. And the pool is keyed BOTH ways until the D29
 * fleet re-keys it (the fold re-keyed catalog rows only): the exact-pool read must
 * union the id and its one twin — the same union recent-sales lists — so an FMV never
 * cites compsUsed N with 0 comps listed. The catalog answer is the REAL pickCatalogRow
 * over the fixture catalog's ids; the pool is fed at the engine's own read seam, so
 * the real engine prices it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogRowResolution } from "../src/services/catalog/catalogIdentityResolver.js";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
  reads: [] as Array<{ cardId: string; hobbyiqCardId: string | null; hobbyiqCardIds: readonly string[] | null }>,
  ladderCalls: [] as Array<Record<string, unknown>>,
  unresolved: null as null | string,   // when set, the catalog "cannot be asked" (fail-open path)
}));

vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; hobbyiqCardIds?: readonly string[] | null; windowDays: number; nowMs?: number }) => {
    h.reads.push({ cardId: input.cardId, hobbyiqCardId: input.hobbyiqCardId, hobbyiqCardIds: input.hobbyiqCardIds ?? null });
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    const keys = new Set([input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])].filter(Boolean));
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || keys.has(r.hobbyiqCardId as string))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/catalog/catalogIdentityResolver.js")>();
  return {
    ...actual,
    // The real rule over the fixture catalog: exact, else the one numbered twin, else nothing.
    resolveIdentityToCatalogRow: vi.fn(async (slug: string): Promise<CatalogRowResolution> =>
      h.unresolved
        ? { requested: slug, id: null, kind: "unresolved", twins: [], error: h.unresolved }
        : actual.pickCatalogRow(slug, [...h.catalog.keys()])),
  };
});
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => h.catalog.get(slug) ?? null),
    lookupCatalogPlayerName: vi.fn(async () => null),
  };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, lookupHobbyIqCardIdForVendorCardId: vi.fn(async (id: string) => (id.startsWith("hiq:") ? id : null)) };
});
vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/portfolioiq/hobbyIqFmv.service.js")>();
  return {
    ...actual,
    computeHobbyIqFmv: vi.fn(async (input: Record<string, unknown>) => { h.ladderCalls.push(input); return actual.computeHobbyIqFmv(input as never); }),
  };
});
delete process.env.COSMOS_CONNECTION_STRING;

import { valueIdentity } from "../src/services/compiq/oneValuationPath.service.js";
import { isExactPoolRung } from "../src/services/compiq/fmvRung.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const row = (printRun: number | null) => ({
  playerName: "Max Williams", year: 2025, setKey: "bowman-draft", setName: "2025 Bowman Draft",
  cardNumber: "CPA-MWI", parallel: "Refractor", isAuto: true, sport: "baseball", printRun, imageUrl: null,
});
const sale = (slug: string, price: number, d: number) => ({
  cardId: "ch-vendor-row", hobbyiqCardId: slug, price, soldAt: daysAgo(d), gradeCompany: null, gradeValue: null, source: "tca-ebay",
});
const RAW_10 = (slug: string) => Array.from({ length: 10 }, (_, i) => sale(slug, 100 + i * 4, 45 - i * 5));
const RAW_5 = (slug: string, offset: number) => Array.from({ length: 5 }, (_, i) => sale(slug, 100 + (i + offset) * 4, 45 - (i + offset) * 5));

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.rows = [];
  h.catalog = new Map();
  h.reads = [];
  h.ladderCalls = [];
  h.unresolved = null;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
const events = (spy: ReturnType<typeof vi.spyOn>, name: string) => spy.mock.calls
  .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
  .filter((e): e is Record<string, unknown> => !!e && e.event === name);

describe("valueIdentity -- an un-numbered id whose only catalog row is its numbered twin", () => {
  it("prices the twin's pool: identity.slug and pooledAs = …:num-499, ONE read under both keys, an exact-pool rung, reason null", async () => {
    h.catalog.set(MWI_499, row(499));
    h.rows = RAW_10(MWI_499);
    const v = await valueIdentity({ id: MWI });
    // Mutation check: before, reason identity-not-in-catalog and rungLabel no-basis.
    expect(v.reason).toBeNull();
    expect(v.identity.requestedId).toBe(MWI);
    expect(v.identity.slug).toBe(MWI_499);
    expect(v.identity.pooledAs).toBe(MWI_499);
    expect(v.identity.pooledVia).toBe("hobbyiqCardId+numbered-twin");
    expect(v.identity.printRun).toBe(499);
    expect(v.identity.playerName).toBe("Max Williams");
    expect(v.fairMarketValue).toBeGreaterThan(0);
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    expect(v.rungLabel).toBe("exact-pool-projection");
    expect(v.valueSource).toBe("observed");
    expect(v.compsUsed).toBe(10);
    expect(v.sales).toHaveLength(10);
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toEqual({ cardId: MWI_499, hobbyiqCardId: MWI_499, hobbyiqCardIds: [MWI_499, MWI] });
    expect(h.ladderCalls).toEqual([]);
  });
  it("the un-numbered id's OWN rows (the common state: 14 vs 0 on …:cpa-sha:green:auto) price it — a swap read 0", async () => {
    h.catalog.set(MWI_499, row(499));
    h.rows = RAW_10(MWI);                      // 10 under the un-numbered key, 0 under the twin
    const v = await valueIdentity({ id: MWI });
    // Mutation check: reading the twin alone gives no-exact-pool here.
    expect(v.reason).toBeNull();
    expect(v.identity.slug).toBe(MWI_499);
    expect(v.compsUsed).toBe(10);
    expect(v.sales).toHaveLength(10);
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    expect(h.reads).toHaveLength(1);
    expect(h.ladderCalls).toEqual([]);
  });
  it("both halves: compsUsed 10 and 10 comps listed — never compsUsed N with 0 comps", async () => {
    h.catalog.set(MWI_499, row(499));
    h.rows = [...RAW_5(MWI, 0), ...RAW_5(MWI_499, 5)];
    const v = await valueIdentity({ id: MWI });
    expect(v.compsUsed).toBe(10);
    expect(v.sales).toHaveLength(10);
    expect(v.totalSampleCount).toBe(10);
    expect(h.reads).toHaveLength(1);
    // The two halves are never re-tried alone: one attempt priced it.
    const tier = v.gradeCurve.find((e) => e.grade === "Raw");
    expect(tier?.sampleCount).toBe(10);
  });
  it("answers the same number as the numbered id asked directly (rows under the twin)", async () => {
    h.catalog.set(MWI_499, row(499));
    h.rows = RAW_10(MWI_499);
    const viaUnnumbered = await valueIdentity({ id: MWI });
    const viaNumbered = await valueIdentity({ id: MWI_499 });
    expect(viaUnnumbered.fairMarketValue).toBe(viaNumbered.fairMarketValue);
    expect(viaUnnumbered.rungLabel).toBe(viaNumbered.rungLabel);
    expect(viaUnnumbered.identity.slug).toBe(viaNumbered.identity.slug);
  });
  it("two numbered twins: null, identity-not-in-catalog, no-basis — and NO engine read, no ladder", async () => {
    h.catalog.set(MWI_499, row(499));
    h.catalog.set(MWI_250, row(250));
    h.rows = [...RAW_10(MWI_499), ...RAW_10(MWI_250)];
    const v = await valueIdentity({ id: MWI });
    expect(v.fairMarketValue).toBeNull();
    expect(v.reason).toBe("identity-not-in-catalog");
    expect(v.rungLabel).toBe("no-basis");
    expect(v.identity.slug).toBeNull();
    expect(h.reads).toEqual([]);
    expect(h.ladderCalls).toEqual([]);
  });
  it("the id's own row still wins over a twin, and reads itself alone", async () => {
    h.catalog.set(MWI, row(null));
    h.catalog.set(MWI_499, row(499));
    h.rows = RAW_10(MWI);
    const v = await valueIdentity({ id: MWI });
    expect(v.identity.slug).toBe(MWI);
    expect(v.identity.pooledVia).toBe("hobbyiqCardId");
    expect(v.compsUsed).toBe(10);
    expect(h.reads[0]).toEqual({ cardId: MWI, hobbyiqCardId: MWI, hobbyiqCardIds: null });
  });
});

describe("valueIdentity -- the catalog could not be asked: fail OPEN, read as given", () => {
  it("a throttled resolver prices the id as given (its pool), logged — never identity-not-in-catalog", async () => {
    h.unresolved = "429 throttled";
    h.rows = RAW_10(MWI);
    const v = await valueIdentity({ id: MWI });
    // Mutation check: fail-closed answered identity-not-in-catalog / no-basis here.
    expect(v.reason).toBeNull();
    expect(v.identity.slug).toBe(MWI);
    expect(v.compsUsed).toBe(10);
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    expect(h.reads[0]).toEqual({ cardId: MWI, hobbyiqCardId: MWI, hobbyiqCardIds: null });
    expect(events(warnSpy, "valuation_identity_unresolved_read_as_given")).toMatchObject([{ requestedId: MWI, slug: MWI, error: "429 throttled" }]);
  });
  it("with no pool either, the reason is no-exact-pool, not identity-not-in-catalog", async () => {
    h.unresolved = "503";
    const v = await valueIdentity({ id: MWI });
    expect(v.reason).toBe("no-exact-pool");
    expect(v.identity.slug).toBe(MWI);
  });
});
