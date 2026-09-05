// CF-ONE-VALUATION-PATH (D16, 2026-08-30) — the entry's rules.
//
// One identity (a catalog slug; a vendor id maps to one, nothing is minted),
// one engine call (the unified exact pool, hobbyiqCardId alone first, its
// twin second, >= 1 sale, every tier at its own window), one curve; the
// headline for the requested tier IS its curve entry. When the tier has no
// pool: this identity's other tiers anchor an empirical fill; with no sale
// at any grade the GATED ladder may answer under its own name; otherwise null
// with a reason. The Cosmos read is mocked at the engine's own seam
// (exactPoolReader), so the real engine prices the fixture.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
  vendorMap: new Map<string, string>(),
  ladder: null as null | ((input: Record<string, unknown>) => unknown),
  ladderCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; hobbyiqCardIds?: readonly string[] | null; windowDays: number; nowMs?: number }) => {
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    const keys = new Set([input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])].filter(Boolean));
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || keys.has(r.hobbyiqCardId as string))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the entry asks the resolver
// directly; the fixture catalog answers through the real pure rule.
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/catalog/catalogIdentityResolver.js")>();
  return { ...actual, resolveIdentityToCatalogRow: vi.fn(async (slug: string) => actual.pickCatalogRow(slug, [...h.catalog.keys()])) };
});
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    catalogSlugIfExists: vi.fn(async (slug: string) => {
      if (h.catalog.has(slug)) return slug;
      const twin = slug.replace(/:num-\d+$/, "");
      return twin !== slug && h.catalog.has(twin) ? twin : null;
    }),
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => h.catalog.get(slug) ?? null),
    lookupCatalogPlayerName: vi.fn(async () => null),
  };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    lookupHobbyIqCardIdForVendorCardId: vi.fn(async (id: string) => (id.startsWith("hiq:") ? id : h.vendorMap.get(id) ?? null)),
  };
});
vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/portfolioiq/hobbyIqFmv.service.js")>();
  return {
    ...actual,
    computeHobbyIqFmv: vi.fn(async (input: Record<string, unknown>) => {
      h.ladderCalls.push(input);
      return h.ladder ? h.ladder(input) : actual.computeHobbyIqFmv(input as never);
    }),
  };
});
delete process.env.COSMOS_CONNECTION_STRING;

import { valueIdentity, tierLabelFor, normalizeGrade } from "../src/services/compiq/oneValuationPath.service.js";
import { isExactPoolRung } from "../src/services/compiq/fmvRung.js";
import { gradeCurveEntryLabel } from "../src/services/compiq/gradeCurveEntry.js";
import { shouldGateRung, POOL_MIGRATING_LABEL_CODE } from "../src/services/compiq/poolMigrationGate.js";
import { persistedLabelsForValuation } from "../src/services/compiq/valuationLabels.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const GOLD = "hiq:baseball:2018:bowman-chrome:49:gold-refractor:no-auto:num-50";
const GOLD_UNNUMBERED = "hiq:baseball:2018:bowman-chrome:49:gold-refractor:no-auto";
const EMPTY = "hiq:baseball:2020:topps-chrome:1:base:no-auto";
const VENDOR = "1778477531904x850967262057528600";
const identityRow = (over: Record<string, unknown> = {}) => ({
  playerName: "Test Player", year: 2018, setKey: "bowman-chrome", setName: "2018 Bowman Chrome",
  cardNumber: "49", parallel: "Gold Refractor", isAuto: false, sport: "baseball", printRun: 50, imageUrl: "https://img/x.jpg",
  ...over,
});
const sale = (slug: string, price: number, d: number, grade: { c: string; v: number } | null = null) => ({
  cardId: "ch-vendor-row", hobbyiqCardId: slug, price, soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null, gradeValue: grade?.v ?? null, source: "tca-ebay",
});
const RAW_10 = (slug: string) => Array.from({ length: 10 }, (_, i) => sale(slug, 100 + i * 4, 45 - i * 5));
const PSA10_6 = (slug: string) => Array.from({ length: 6 }, (_, i) => sale(slug, 900 + i * 10, 20 - i * 3, { c: "PSA", v: 10 }));

beforeEach(() => {
  h.rows = [];
  h.catalog = new Map();
  h.vendorMap = new Map();
  h.ladder = null;
  h.ladderCalls = [];
});

describe("valueIdentity — the exact pool prices the requested tier", () => {
  it("Raw: the engine's number, the engine's rung, the tier's sales; headline == curve[Raw]", async () => {
    h.catalog.set(GOLD, identityRow());
    h.rows = [...RAW_10(GOLD), ...PSA10_6(GOLD)];
    const v = await valueIdentity({ id: GOLD });
    expect(v.identity.slug).toBe(GOLD);
    expect(v.identity.setKey).toBe("bowman-chrome");
    expect(v.identity.playerName).toBe("Test Player");
    expect(v.identity.printRun).toBe(50);
    expect(v.fairMarketValue).toBeGreaterThan(0);
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    expect(v.rungLabel).toBe("exact-pool-projection");
    expect(v.valueSource).toBe("observed");
    expect(v.compsUsed).toBe(10);
    expect(v.reason).toBeNull();
    const raw = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "Raw")!;
    expect(raw.trendAdjustedValue).toBe(v.fairMarketValue);
    expect(raw.value).toBe(v.fairMarketValue);
    expect(raw.rungLabel).toBe(v.rungLabel);
    expect(raw.salesHistory.length).toBe(10);
    expect(v.sales.length).toBe(10);
    expect(v.sales[0].price).toBe(136);   // newest first
    // No ladder was consulted: the pool priced it.
    expect(h.ladderCalls).toEqual([]);
  });

  it("PSA 10: the graded tier's own pool; the Raw headline is not the PSA 10 headline", async () => {
    h.catalog.set(GOLD, identityRow());
    h.rows = [...RAW_10(GOLD), ...PSA10_6(GOLD)];
    const raw = await valueIdentity({ id: GOLD });
    const psa10 = await valueIdentity({ id: GOLD, grade: { company: "psa", value: 10 } });
    expect(psa10.requestedTier).toBe("PSA 10");
    expect(psa10.rungLabel).toBe("exact-pool-leading-edge");
    expect(psa10.compsUsed).toBe(6);
    expect(psa10.fairMarketValue).toBeGreaterThan(raw.fairMarketValue as number);
    // The curve is the same on both calls (one engine result, every tier).
    const rawTierOnPsaCall = psa10.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "Raw")!;
    expect(rawTierOnPsaCall.trendAdjustedValue).toBe(raw.fairMarketValue);
    const psaTierOnRawCall = raw.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 10")!;
    expect(psaTierOnRawCall.trendAdjustedValue).toBe(psa10.fairMarketValue);
  });

  it("a thin pool (n=2) is still the exact pool: weighted-median rung, no ladder", async () => {
    h.catalog.set(GOLD, identityRow());
    h.rows = [sale(GOLD, 50, 3), sale(GOLD, 60, 30)];
    const v = await valueIdentity({ id: GOLD });
    expect(v.rungLabel).toBe("exact-pool-weighted-median");
    expect(v.valueSource).toBe("observed");
    expect(v.compsUsed).toBe(2);
    expect(h.ladderCalls).toEqual([]);
  });

  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW, SYMMETRIC (round-2 refutation). This
  // used to reach the un-numbered pool through the SECOND attempt and report
  // pooledAs = the un-numbered id. It is now the FIRST attempt, reading both
  // keys in one query and reporting the catalog row — the same union
  // recent-sales lists, so the FMV's compsUsed and the listed sales agree.
  it("a numbered slug whose sales sit under its un-numbered twin is priced from the union, reported as the catalog row", async () => {
    h.catalog.set(GOLD, identityRow());
    h.rows = [...RAW_10(GOLD_UNNUMBERED)];
    const v = await valueIdentity({ id: GOLD });
    expect(v.identity.slug).toBe(GOLD);
    expect(v.identity.pooledAs).toBe(GOLD);
    expect(v.identity.pooledVia).toBe("hobbyiqCardId+pool-twin");
    expect(v.fairMarketValue).toBeGreaterThan(0);
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    // Mutation check: round 2 skipped the resolve for a numbered slug, so the
    // first attempt read GOLD alone (0 rows) and only the fallback twin
    // attempt found these — a second query, and a pooledAs the card page
    // could not reproduce.
    expect(v.compsUsed).toBe(RAW_10(GOLD_UNNUMBERED).length);
  });

  it("...and the same card entered from its un-numbered half prices identically", async () => {
    h.catalog.set(GOLD, identityRow());
    h.rows = [...RAW_10(GOLD_UNNUMBERED)];
    const fromNumbered = await valueIdentity({ id: GOLD });
    const fromStem = await valueIdentity({ id: GOLD_UNNUMBERED });
    expect(fromStem.identity.slug).toBe(GOLD);
    expect(fromStem.fairMarketValue).toBe(fromNumbered.fairMarketValue);
    expect(fromStem.compsUsed).toBe(fromNumbered.compsUsed);
  });

  it("a vendor id resolves to its catalog slug first and is priced as that slug", async () => {
    h.catalog.set(GOLD, identityRow());
    h.vendorMap.set(VENDOR, GOLD);
    h.rows = [...RAW_10(GOLD)];
    const v = await valueIdentity({ id: VENDOR });
    expect(v.identity.slug).toBe(GOLD);
    expect(v.identity.requestedId).toBe(VENDOR);
    expect(v.fairMarketValue).toBeGreaterThan(0);
    const asSlug = await valueIdentity({ id: GOLD });
    expect(v.fairMarketValue).toBe(asSlug.fairMarketValue);
  });
});

describe("valueIdentity — no pool at the requested tier", () => {
  it("this identity's other tiers anchor an empirical fill: grade-curve-estimate, never a clamp on an observed tier", async () => {
    h.catalog.set(GOLD, identityRow());
    h.rows = [...RAW_10(GOLD)];
    const v = await valueIdentity({ id: GOLD, grade: { company: "PSA", value: 10 } });
    expect(v.rungLabel).toBe("grade-curve-estimate");
    expect(v.valueSource).toBe("estimated");
    expect(v.fairMarketValue).toBeGreaterThan(0);
    expect(v.compsUsed).toBe(0);
    expect(v.reason).toBeNull();
    expect(v.basis).toMatch(/own Raw sales × the empirical PSA 10 ratio/);
    const psa10 = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 10")!;
    expect(psa10.value).toBe(v.fairMarketValue);
    expect(psa10.valueSource).toBe("estimated");
    expect(psa10.rungLabel).toBe("grade-curve-estimate");
    expect(psa10.estimatedMultiplier).toBeGreaterThan(1);
    const raw = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "Raw")!;
    expect(raw.valueSource).toBe("observed");
    expect(raw.rungLabel).toBe("exact-pool-projection");
    expect(h.ladderCalls).toEqual([]);
  });

  it("with no sale at any grade the GATED ladder may answer, under its own rung name, and its Raw anchors the graded tiers", async () => {
    h.catalog.set(EMPTY, identityRow({ setKey: "topps-chrome", setName: "2020 Topps Chrome", cardNumber: "1", parallel: "Base", printRun: null }));
    h.rows = [];
    h.ladder = () => ({
      slug: EMPTY, fmv: 12.5, compCount: 4, min: 10, max: 15,
      breakdown: { bySource: { "tca-ebay": 4 }, byAutoStyle: { onCard: 0, sticker: 0, unknown: 4 }, byGradeQualifier: {} },
      trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
      recentComps: [{ price: 12, soldAt: daysAgo(3), source: "tca-ebay" }],
      method: "sibling-parallel", rungLabel: "sibling-parallel",
      basisNote: "Estimated from 4 sales of sibling parallels", confidence: 0.4,
      population: null, quality: { score: 0.4, flaggedCompCount: 0, sources: ["tca-ebay"] },
      computedAt: new Date().toISOString(), cachedFrom: "sold_comps",
    });
    const v = await valueIdentity({ id: EMPTY });
    expect(h.ladderCalls.length).toBe(1);
    expect(h.ladderCalls[0].skipExactPool).toBe(true);
    expect(h.ladderCalls[0].hobbyiqCardId).toBe(EMPTY);
    expect(v.fairMarketValue).toBe(12.5);
    expect(v.rungLabel).toBe("sibling-parallel");
    expect(v.valueSource).toBe("estimated");
    expect(v.compsUsed).toBe(4);
    expect(v.unified).toBeNull();
    const raw = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "Raw")!;
    expect(raw.value).toBe(12.5);
    expect(raw.valueSource).toBe("estimated");
    expect(raw.rungLabel).toBe("sibling-parallel");
    const psa10 = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === "PSA 10")!;
    expect(psa10.valueSource).toBe("estimated");
    expect(psa10.rungLabel).toBe("grade-curve-estimate");
    expect(psa10.value).toBeGreaterThan(12.5);
  });

  it("nothing anywhere: null, rung no-basis, reason no-exact-pool", async () => {
    h.catalog.set(EMPTY, identityRow({ setKey: "topps-chrome", setName: "2020 Topps Chrome", printRun: null }));
    h.rows = [];
    const v = await valueIdentity({ id: EMPTY });
    expect(v.fairMarketValue).toBeNull();
    expect(v.rungLabel).toBe("no-basis");
    expect(v.valueSource).toBe("unavailable");
    expect(v.reason).toBe("no-exact-pool");
    expect(v.gradeCurve.every((e) => e.valueSource === "unavailable")).toBe(true);
  });
});

describe("valueIdentity — identity", () => {
  it("an hiq slug the catalog does not hold is not priced: identity-not-in-catalog", async () => {
    h.rows = [...RAW_10(GOLD)];   // sales exist, but the catalog does not hold the slug
    const v = await valueIdentity({ id: GOLD });
    expect(v.identity.slug).toBeNull();
    expect(v.fairMarketValue).toBeNull();
    expect(v.rungLabel).toBe("no-basis");
    expect(v.reason).toBe("identity-not-in-catalog");
    expect(h.ladderCalls).toEqual([]);
  });

  it("a vendor id no catalog slug maps to: no-catalog-identity", async () => {
    const v = await valueIdentity({ id: VENDOR });
    expect(v.identity.slug).toBeNull();
    expect(v.reason).toBe("no-catalog-identity");
  });

  it("tier labels follow the engine: no company is Raw; the company is upper-cased", () => {
    expect(tierLabelFor(null)).toBe("Raw");
    expect(tierLabelFor({ company: "", value: 10 })).toBe("Raw");
    expect(tierLabelFor({ company: "psa", value: 10 })).toBe("PSA 10");
    expect(normalizeGrade({ company: " bgs ", value: 9.5 })).toEqual({ company: "BGS", value: 9.5 });
    expect(normalizeGrade({ company: null, value: 10 })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CF-A-GATE-THAT-FIRES-ABOVE-EVERY-RUNG-IS-NOT-A-RUNG-GATE (#1811).
//
// #1776 shipped `shouldGateRung`, documented it as naming the rungs the gate
// applies to, TESTED it — and never called it. The withhold fired
// unconditionally above the whole ladder, so a freshly minted identity blanked
// even when the only rung that could answer was one that reads OTHER cards
// entirely: a family baseline, a cross-setkey read, a sibling pool. A rematch
// on THIS identity's pool cannot disturb those, so blanking them is not
// caution — it is a second defect on top of the one #1776 fixed.
//
// These pins drive the REAL entry (`valueIdentity`) with a catalog row minted
// inside the settle window, which is the only way to prove which behaviour the
// choke point actually has. The pure-function classification lives in
// pricingRefusalGates.test.ts; this file proves it is WIRED.
describe("a migrating pool withholds only the rungs that read it (#1811)", () => {
  // Inside POOL_SETTLE_HOURS=6, with no settle marker: MIGRATING. (No Cosmos
  // is configured in this suite, so `readSettleMarker` returns null — the
  // fail-closed path, which is exactly the production state today.)
  const migratingRow = (over: Record<string, unknown> = {}) =>
    identityRow({ observedAt: new Date(NOW - 2 * 3_600_000).toISOString(), ...over });
  // Outside the window: settled by default, whatever the marker says.
  const settledRow = (over: Record<string, unknown> = {}) =>
    identityRow({ observedAt: new Date(NOW - 48 * 3_600_000).toISOString(), ...over });

  it("the exact rung on a migrating identity is WITHHELD — the Maddux rule stands", async () => {
    h.catalog.set(GOLD, migratingRow());
    h.rows = [...RAW_10(GOLD)];
    const v = await valueIdentity({ id: GOLD });
    expect(v.fairMarketValue).toBeNull();
    expect(v.reason).toBe("pool-migrating");
    expect(v.rungLabel).toBe("no-basis");
    expect(v.valueSource).toBe("unavailable");
    expect(v.confidence).toBe(0);
    // The state rides along in BOTH outcomes, so a reader never has to parse
    // the basis prose to learn the pool was mid-migration.
    expect(v.poolMigrating).not.toBeNull();
    expect(v.poolMigrating?.because).toBe("within-settle-window");
    // It REFUSES rather than substituting: no fallback number is fetched for a
    // gated own-pool rung. A substitute is precisely what produced the $240.
    expect(h.ladderCalls).toEqual([]);
    // ...and the CURVE goes with the headline. #1776 returned before the
    // ladder ran, so a blank curve came for free; this gate returns AFTER
    // every tier is priced off the same half-arrived pool, and leaving those
    // in would withhold the headline while publishing the identical number one
    // field over — the card page and the accuracy panel both read the curve.
    expect(v.gradeCurve.every((e) => (e.value ?? null) === null)).toBe(true);
    expect(v.sales).toEqual([]);
  });

  it("...and the SAME pool prices normally once the row is outside the window", async () => {
    h.catalog.set(GOLD, settledRow());
    h.rows = [...RAW_10(GOLD)];
    const v = await valueIdentity({ id: GOLD });
    expect(v.reason).toBeNull();
    expect(v.fairMarketValue).toBeGreaterThan(0);
    expect(isExactPoolRung(v.rungLabel)).toBe(true);
    expect(v.poolMigrating).toBeNull();
  });

  // THE FIX. The identity's own pool is empty at every grade, so section 3's
  // gated ladder answers off OTHER identities. Nothing it read can have been
  // moved by this identity's migration — and #1776 blanked it anyway.
  it("an OTHER-IDENTITY rung on a migrating identity PRICES, carrying the label", async () => {
    h.catalog.set(EMPTY, migratingRow({ setKey: "topps-chrome", printRun: null }));
    h.rows = [];   // this identity has no sales of its own at any grade
    h.ladder = () => ({
      fmv: 42, method: "family-baseline", rungLabel: "family-baseline",
      compCount: 31, confidence: 0.5, basisNote: "family baseline over 31 sibling sales",
      trend: { direction: "flat", slopePerMonthPct: 0 }, recentComps: [],
    });
    const v = await valueIdentity({ id: EMPTY });
    // The number STANDS.
    expect(v.fairMarketValue).toBe(42);
    expect(v.rungLabel).toBe("family-baseline");
    expect(v.valueSource).toBe("estimated");
    // ...and it is not a refusal: a caller that retains priors on
    // `pool-migrating` must NOT treat this as one, or the fix blanks the
    // holding it was meant to price.
    expect(v.reason).toBeNull();
    // But the reader is told, because a price from this card's OWN sales may
    // replace it within hours.
    expect(v.poolMigrating).not.toBeNull();
    expect(v.poolMigrating?.because).toBe("within-settle-window");

    // MUTATION CHECK. Removing the `shouldGateRung` call at the choke point
    // restores #1776's unconditional withhold, which is this assertion's
    // exact negation: fairMarketValue null, reason "pool-migrating".
  });

  it("the label reaches the persisted holding — a published caveat, not a withheld one", async () => {
    h.catalog.set(EMPTY, migratingRow({ setKey: "topps-chrome", printRun: null }));
    h.rows = [];
    h.ladder = () => ({
      fmv: 42, method: "family-baseline", rungLabel: "family-baseline",
      compCount: 31, confidence: 0.5, basisNote: "family baseline",
      trend: { direction: "flat", slopePerMonthPct: 0 }, recentComps: [],
    });
    const v = await valueIdentity({ id: EMPTY });
    const { labels } = persistedLabelsForValuation(v);
    const migrating = labels.find((l) => l.code === POOL_MIGRATING_LABEL_CODE);
    expect(migrating, "a published migrating price must carry its caveat").toBeDefined();
    expect(migrating!.text).toMatch(/still being matched onto it/i);

    // The label is for PUBLISHED prices only. A withheld one says so through
    // `reason`; stacking a caveat on a number that does not exist would be a
    // caveat about nothing.
    h.catalog.set(GOLD, migratingRow());
    h.rows = [...RAW_10(GOLD)];
    const withheld = await valueIdentity({ id: GOLD });
    expect(withheld.fairMarketValue).toBeNull();
    expect(persistedLabelsForValuation(withheld).labels.some((l) => l.code === POOL_MIGRATING_LABEL_CODE)).toBe(false);
  });

  // MUTATION CHECK, the other direction. If `player-index-projection` were
  // classified as an other-identity rung, a migrating identity would publish a
  // number anchored on `lastRealComp` — this pool's newest sale — while the
  // pool was still deciding which sale that is. It is OWN-POOL, and the
  // section-1 branch it lives in withholds with everything else there.
  it("the graded-to-raw curve — the $240 rung itself — is withheld on a migrating identity", async () => {
    // Raw tier empty, PSA 10 tier populated: exactly the Maddux shape, where
    // the curve read an absent tier as evidence of absence.
    h.catalog.set(GOLD, migratingRow());
    h.rows = [...PSA10_6(GOLD)];
    const v = await valueIdentity({ id: GOLD });
    expect(v.requestedTier).toBe("Raw");
    expect(v.fairMarketValue).toBeNull();
    expect(v.reason).toBe("pool-migrating");
    // Settled, the very same fixture DOES price through that rung — so the
    // withhold above is the gate's doing, not an empty-pool coincidence.
    h.catalog.set(GOLD, settledRow());
    const settled = await valueIdentity({ id: GOLD });
    expect(settled.fairMarketValue).toBeGreaterThan(0);
    expect(shouldGateRung(settled.rungLabel), "the settled rung must be one the gate WOULD have withheld").toBe(true);
  });

  it("a migrating identity with nothing anywhere reports the pool state, not a false absence", async () => {
    h.catalog.set(EMPTY, migratingRow({ setKey: "topps-chrome", printRun: null }));
    h.rows = [];
    h.ladder = () => ({
      fmv: null, method: "no-basis", rungLabel: "no-basis", compCount: 0, confidence: 0,
      basisNote: "", trend: { direction: "flat", slopePerMonthPct: 0 }, recentComps: [],
    });
    const v = await valueIdentity({ id: EMPTY });
    // NOT "no-exact-pool": the pool is not empty, it is INCOMPLETE — and the
    // two reasons are handled differently downstream (pool-migrating retains
    // the prior value; no-exact-pool does not).
    expect(v.reason).toBe("pool-migrating");
    expect(v.basis).toMatch(/still in flight|still being re-keyed/i);
  });
});
