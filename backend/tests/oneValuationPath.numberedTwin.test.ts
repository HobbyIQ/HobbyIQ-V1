/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3): valueIdentity —
 * the ONE entry behind price-by-id, hobbyiq-fmv, card-detail, observed-grade-curve,
 * card-panel and canonical-fmv — gates every route on catalogSlugIfExists. For an
 * un-numbered id whose only catalog row is …:num-499 that answered
 * identity-not-in-catalog / no-basis before any pool was read. The catalog answer is
 * the REAL pickCatalogRow over the fixture catalog's ids; the pool is fed at the
 * engine's own read seam, so the real engine prices it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
  reads: [] as string[],
  ladderCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; windowDays: number; nowMs?: number }) => {
    h.reads.push(input.cardId);
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || (input.hobbyiqCardId && r.hobbyiqCardId === input.hobbyiqCardId))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const { pickCatalogRow } = await import("../src/services/catalog/catalogIdentityResolver.js");
  return {
    ...actual,
    // The real rule over the fixture catalog: exact, else the one numbered twin, else nothing.
    catalogSlugIfExists: vi.fn(async (slug: string) => pickCatalogRow(slug, [...h.catalog.keys()]).id),
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

beforeEach(() => {
  h.rows = [];
  h.catalog = new Map();
  h.reads = [];
  h.ladderCalls = [];
});

describe("valueIdentity -- an un-numbered id whose only catalog row is its numbered twin", () => {
  it("prices the twin's pool: identity.slug and pooledAs = …:num-499, an exact-pool rung, reason null", async () => {
    h.catalog.set(MWI_499, row(499));
    h.rows = RAW_10(MWI_499);
    const v = await valueIdentity({ id: MWI });
    // Mutation check: before, reason identity-not-in-catalog and rungLabel no-basis.
    expect(v.reason).toBeNull();
    expect(v.identity.requestedId).toBe(MWI);
    expect(v.identity.slug).toBe(MWI_499);
    expect(v.identity.pooledAs).toBe(MWI_499);
    expect(v.identity.printRun).toBe(499);
    expect(v.identity.playerName).toBe("Max Williams");
    expect(v.fairMarketValue).toBeGreaterThan(0);
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    expect(v.rungLabel).toBe("exact-pool-projection");
    expect(v.valueSource).toBe("observed");
    expect(v.compsUsed).toBe(10);
    expect(v.sales).toHaveLength(10);
    expect(h.reads[0]).toBe(MWI_499);
    expect(h.ladderCalls).toEqual([]);
  });
  it("answers the same number as the numbered id asked directly", async () => {
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
  it("the id's own row still wins over a twin", async () => {
    h.catalog.set(MWI, row(null));
    h.catalog.set(MWI_499, row(499));
    h.rows = RAW_10(MWI);
    const v = await valueIdentity({ id: MWI });
    expect(v.identity.slug).toBe(MWI);
    expect(v.compsUsed).toBe(10);
  });
});
