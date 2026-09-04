// CF-ONE-VALUATION-PATH (D16, 2026-08-30) — the four pricing routes are ONE
// computation.
//
// The D14 probe (probe-price-routes) replayed 200 checklist-backed slugs
// through /price-by-id, /canonical-fmv, /hobbyiq-fmv and
// /observed-grade-curve and found them disagreeing by more than 25% on 44.2%
// of (slug, Raw); price-by-id labelled its number `direct-comp` (not a rung),
// hobbyiq-fmv's method was `unified-market-value` (outside its union) 80% of
// the time, the curve was served under a vendor id 89% of the time.
//
// This file feeds ONE fixture pool — mocked at the unified engine's own read
// seam (exactPoolReader), so the real engine prices it — through all four
// HANDLERS via supertest and asserts identical numbers, identical rung labels
// in the closed vocabulary (read from the TS unions, as the probe does), an
// in-union `method` on the two wires that have one, the curve served under
// the slug, and the same null-with-a-reason when there is nothing. Spies pin
// that no second engine is consulted for the headline.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.CANONICAL_FMV_ENABLED = "true";
delete process.env.COSMOS_CONNECTION_STRING;
delete process.env.HOBBYIQFMV_COMPOSITE_ENABLED;

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
  vendorMap: new Map<string, string>(),
  calls: { canonical: 0, estimate: 0, curve: 0, ladder: [] as Array<Record<string, unknown>>, unified: 0, reads: [] as string[] },
}));

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user", email: "t@t", username: null, fullName: null,
      plan: "pro_seller", createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});
vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; hobbyiqCardIds?: readonly string[] | null; windowDays: number; nowMs?: number }) => {
    h.calls.reads.push(input.cardId);
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    const keys = new Set([input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])].filter(Boolean));
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || keys.has(r.hobbyiqCardId as string))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the catalog answer is the
// REAL resolver rule over the fixture catalog's ids — the row itself, else
// its one numbered twin, else nothing — not a bare `has`. The entry asks the
// resolver directly; the matcher's wrapper answers the same for the writers.
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/catalog/catalogIdentityResolver.js")>();
  return { ...actual, resolveIdentityToCatalogRow: vi.fn(async (slug: string) => actual.pickCatalogRow(slug, [...h.catalog.keys()])) };
});
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const { pickCatalogRow } = await import("../src/services/catalog/catalogIdentityResolver.js");
  return {
    ...actual,
    catalogSlugIfExists: vi.fn(async (slug: string) => pickCatalogRow(slug, [...h.catalog.keys()]).id),
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => h.catalog.get(slug) ?? null),
    lookupCatalogPlayerName: vi.fn(async () => "Test Player"),
  };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    lookupHobbyIqCardIdForVendorCardId: vi.fn(async (id: string) => (id.startsWith("hiq:") ? id : h.vendorMap.get(id) ?? null)),
  };
});
// Spies on every other engine: wrapped, counted, still real.
vi.mock("../src/services/compiq/canonicalFmv.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/compiq/canonicalFmv.service.js")>();
  return { ...actual, computeCanonicalFmv: vi.fn(async (input: never) => { h.calls.canonical++; return actual.computeCanonicalFmv(input); }) };
});
// The CH estimate engine: counted, and answered with nothing — no route may
// reach it (pinned at 0 on every route case), and the persist site's legacy
// chain must find nothing in it so what it persists can only be the entry's.
vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/compiq/compiqEstimate.service.js")>();
  return {
    ...actual,
    computeEstimate: vi.fn(async () => {
      h.calls.estimate++;
      return {
        fairMarketValue: 0, confidence: { pricingConfidence: 0 }, source: "no-recent-comps",
        compsUsed: 0, compsAvailable: 0, recentComps: [], cardIdentity: null, gradeUsed: "Raw",
        daysSinceNewestComp: null, variantWarning: [],
      };
    }),
  };
});
// The persist site's other estimate rungs (D4 PR 5's fixture stubs them the
// same way): nothing measured, nothing to persist.
vi.mock("../src/services/portfolioiq/priceFromOurPool.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, priceHoldingFromOurPool: vi.fn(async () => null) };
});
vi.mock("../src/services/compiq/siblingCardPriceFallback.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, attemptSiblingPriceFallback: vi.fn(async () => null) };
});
vi.mock("../src/services/compiq/observedGradeCurve.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/compiq/observedGradeCurve.service.js")>();
  return { ...actual, buildObservedGradeCurve: vi.fn(async (...args: never[]) => { h.calls.curve++; return (actual.buildObservedGradeCurve as (...a: never[]) => unknown)(...args); }) };
});
vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/portfolioiq/hobbyIqFmv.service.js")>();
  return { ...actual, computeHobbyIqFmv: vi.fn(async (input: Record<string, unknown>) => { h.calls.ladder.push(input); return actual.computeHobbyIqFmv(input as never); }) };
});
vi.mock("../src/services/compiq/unifiedPricing.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/compiq/unifiedPricing.service.js")>();
  return { ...actual, computeUnifiedPrice: vi.fn(async (...args: never[]) => { h.calls.unified++; return (actual.computeUnifiedPrice as (...a: never[]) => unknown)(...args); }) };
});

// ── the closed vocabulary, read from the unions (as the probe reads it) ──
const here = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => fs.readFileSync(path.join(here, "../src/services", rel), "utf8");
function unionLiterals(src: string, typeName: string): string[] {
  const at = src.indexOf(`export type ${typeName} =`);
  if (at < 0) throw new Error(`union ${typeName} not found`);
  const body = src.slice(at, at + 6000).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const end = body.indexOf(";");
  const union = body.slice(body.indexOf("=") + 1, end > 0 ? end : undefined).replace(/Exclude<[^>]*>/g, "");
  return [...union.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}
const rungSrc = readSrc("compiq/fmvRung.ts");
const EXACT = new Set(unionLiterals(rungSrc, "ExactPoolRungLabel"));
const CANON = new Set(unionLiterals(readSrc("compiq/canonicalFmv.service.ts"), "CanonicalFmvMethod"));
const HIQ = new Set(unionLiterals(readSrc("portfolioiq/hobbyIqFmv.service.ts"), "HobbyIqFmvMethod"));
const VOCAB = new Set([
  ...EXACT, ...unionLiterals(rungSrc, "FmvRungLabel"),
  ...[...CANON].filter((x) => x !== "direct-comp"), ...[...HIQ].filter((x) => x !== "direct-slug"),
]);

// ── the fixture pool ──
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const GOLD = "hiq:baseball:2018:bowman-chrome:49:gold-refractor:no-auto:num-50";
const THIN = "hiq:baseball:2019:topps-stadium-club:100:base:auto";
const EMPTY = "hiq:baseball:2020:topps-chrome:1:base:no-auto";
const NOT_IN_CATALOG = "hiq:baseball:2021:bowman:7:base:no-auto";
const VENDOR = "1778477531904x850967262057528600";
const identityRow = (over: Record<string, unknown>) => ({
  playerName: "Test Player", year: 2018, setKey: "bowman-chrome", setName: "2018 Bowman Chrome",
  cardNumber: "49", parallel: "Gold Refractor", isAuto: false, sport: "baseball", printRun: 50, imageUrl: null,
  ...over,
});
const sale = (slug: string, price: number, d: number, grade: { c: string; v: number } | null = null) => ({
  cardId: "ch-vendor-row", hobbyiqCardId: slug, price, soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null, gradeValue: grade?.v ?? null, source: "tca-ebay",
});

let app: import("express").Express;
// CF-CHRONIC-REDS-SLOW (2026-09-03). This is the exact case the hookTimeout
// note in vitest.config.ts describes -- `await import("../src/app")` triggers a
// cold SWC transform of the whole compiq route graph. Measured at 122s in a
// full-suite run, i.e. past even the raised 120s file-level ceiling, at which
// point vitest SKIPS the suite: this file reported "24 tests | 24 skipped",
// which is a silent gap, not a visible red. All 24 pass in isolation. Give the
// hook its own headroom so the assertions actually run.
beforeAll(async () => {
  app = (await import("../src/app")).default;
}, 300_000);
beforeEach(() => {
  h.rows = [
    ...Array.from({ length: 10 }, (_, i) => sale(GOLD, 100 + i * 4, 45 - i * 5)),
    ...Array.from({ length: 6 }, (_, i) => sale(GOLD, 900 + i * 10, 20 - i * 3, { c: "PSA", v: 10 })),
    sale(GOLD, 300, 8, { c: "PSA", v: 9 }), sale(GOLD, 310, 40, { c: "PSA", v: 9 }),
    sale(THIN, 0.88, 12), sale(THIN, 0.15, 60),
  ];
  h.catalog = new Map([
    [GOLD, identityRow({})],
    [THIN, identityRow({ year: 2019, setKey: "topps-stadium-club", setName: "2019 Topps Stadium Club", cardNumber: "100", parallel: "Base", isAuto: true, printRun: null })],
    [EMPTY, identityRow({ year: 2020, setKey: "topps-chrome", setName: "2020 Topps Chrome", cardNumber: "1", parallel: "Base", printRun: null })],
  ]);
  h.vendorMap = new Map([[VENDOR, GOLD]]);
  h.calls = { canonical: 0, estimate: 0, curve: 0, ladder: [], unified: 0, reads: [] };
});

const H = { "x-session-id": "test-sess" };
const grade = (g: { company: string; value: number } | null) => (g ? { gradeCompany: g.company, gradeValue: g.value } : {});
async function four(id: string, g: { company: string; value: number } | null = null) {
  const [pb, cf, hf, gc] = await Promise.all([
    request(app).post("/api/compiq/price-by-id").set(H).send({ cardId: id, ...grade(g) }),
    request(app).post("/api/compiq/canonical-fmv").set(H).send({ cardId: id, ...grade(g) }),
    request(app).post("/api/compiq/hobbyiq-fmv").set(H).send({ hobbyiqCardId: id, ...grade(g) }),
    request(app).get(`/api/compiq/observed-grade-curve/${encodeURIComponent(id)}`).set(H),
  ]);
  for (const r of [pb, cf, hf, gc]) expect(r.status).toBe(200);
  const label = g ? `${g.company.toUpperCase()} ${g.value}` : "Raw";
  const tile = (gc.body.entries as Array<Record<string, unknown>>).find((e) => (g ? e.grade === label : e.grader === "Raw"));
  return { pb: pb.body, cf: cf.body, hf: hf.body, gc: gc.body, tile };
}

describe("D16 — one fixture pool, four handlers, one number", () => {
  it("(slug, Raw): identical FMV, identical exact-pool rung, every label in the vocabulary, identity on every wire", async () => {
    const { pb, cf, hf, gc, tile } = await four(GOLD);
    const fmvs = [pb.marketValue, cf.fmv, hf.fmv, tile?.trendAdjustedValue];
    expect(fmvs.every((x) => typeof x === "number" && x > 0)).toBe(true);
    expect(new Set(fmvs).size).toBe(1);
    expect(pb.fairMarketValueLive).toBe(pb.marketValue);
    expect(tile?.value).toBe(tile?.trendAdjustedValue);
    const labels = [pb.rungLabel, cf.rungLabel, hf.rungLabel, tile?.rungLabel];
    expect(new Set(labels).size).toBe(1);
    expect(EXACT.has(labels[0])).toBe(true);
    for (const l of [...labels, pb.source]) expect(VOCAB.has(l), String(l)).toBe(true);
    // price-by-id's `source` is the rung now, not canonical-fmv's method.
    expect(pb.source).toBe(pb.rungLabel);
    expect(pb.source).not.toBe("direct-comp");
    // hobbyiq-fmv's method is inside its own union; canonical-fmv's inside its own.
    expect(HIQ.has(hf.method)).toBe(true);
    expect(hf.method).toBe("direct-slug");
    expect(CANON.has(cf.method)).toBe(true);
    expect(cf.method).toBe("direct-comp");
    // The curve is served under the slug, and every wire carries the identity.
    expect(gc.cardId).toBe(GOLD);
    for (const b of [pb.cardIdentity, cf.identity, hf.identity, gc.identity]) {
      expect(b.setKey).toBe("bowman-chrome");
      expect(b.slug).toBe(GOLD);
      expect(b.player).toBe("Test Player");
    }
    // Comps used: the tier's pool, the same on every wire.
    expect(pb.compsUsed).toBe(10);
    expect(hf.compCount).toBe(10);
    expect(cf.recentRange.n).toBe(10);
    expect(tile?.sampleCount).toBe(10);
    expect(pb.recentComps.length).toBe(10);
    expect(pb.lastSale.price).toBe(136);
    // No second engine touched the headline.
    expect(h.calls.canonical).toBe(0);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
    expect(h.calls.ladder).toEqual([]);
  });

  it("(slug, PSA 10): the graded headline on three wires equals the curve's PSA 10 tile, and differs from Raw", async () => {
    const raw = await four(GOLD);
    const g = await four(GOLD, { company: "PSA", value: 10 });
    const fmvs = [g.pb.marketValue, g.cf.fmv, g.hf.fmv, g.tile?.trendAdjustedValue];
    expect(fmvs.every((x) => typeof x === "number" && x > 0)).toBe(true);
    expect(new Set(fmvs).size).toBe(1);
    expect(new Set([g.pb.rungLabel, g.cf.rungLabel, g.hf.rungLabel, g.tile?.rungLabel]).size).toBe(1);
    expect(EXACT.has(g.pb.rungLabel)).toBe(true);
    expect(g.pb.marketValue).not.toBe(raw.pb.marketValue);
    // The curve does not change with the requested grade: one result.
    expect(g.gc.entries).toEqual(raw.gc.entries);
  });

  it("(slug, PSA 9 — a thin graded tier) and a thin Raw pool: still one number, an honest thin-pool rung", async () => {
    const psa9 = await four(GOLD, { company: "PSA", value: 9 });
    expect(new Set([psa9.pb.marketValue, psa9.cf.fmv, psa9.hf.fmv, psa9.tile?.trendAdjustedValue]).size).toBe(1);
    expect(psa9.pb.rungLabel).toBe("exact-pool-weighted-median");
    const thin = await four(THIN);
    expect(new Set([thin.pb.marketValue, thin.cf.fmv, thin.hf.fmv, thin.tile?.trendAdjustedValue]).size).toBe(1);
    // D22 (CF-ONE-SALE-WINDOW-POLICY): this fixture — $0.88 at 12d, $0.15 at
    // 60d — is the one-sale shape: the newest sale carries ~97% of the window's
    // recency weight and disagrees with the 180d leading edge ($0.515) by 71%.
    // Drew's ruling (the default): the latest sale is the market — the same
    // $0.88 as before, under the label that says one sale carried it. Still
    // an exact-pool thin rung, still one number on every route.
    expect(thin.pb.rungLabel).toBe("exact-pool-last-sale");
    expect(thin.pb.marketValue).toBe(0.88);
    expect(thin.hf.compCount).toBe(2);
    expect(h.calls.ladder).toEqual([]);
  });

  it("(slug, PSA 8 — no pool at that tier): the identity's own Raw × empirical ratio, labelled grade-curve-estimate, on every wire", async () => {
    const g = await four(GOLD, { company: "PSA", value: 8 });
    const fmvs = [g.pb.marketValue, g.cf.fmv, g.hf.fmv, g.tile?.value];
    expect(fmvs.every((x) => typeof x === "number" && x > 0)).toBe(true);
    expect(new Set(fmvs).size).toBe(1);
    for (const l of [g.pb.rungLabel, g.cf.rungLabel, g.hf.rungLabel, g.tile?.rungLabel]) expect(l).toBe("grade-curve-estimate");
    expect(g.pb.approximate).toBe(true);
    expect(g.pb.valueSource).toBe("estimated");
    expect(g.tile?.valueSource).toBe("estimated");
    expect(HIQ.has(g.hf.method)).toBe(true);
    expect(CANON.has(g.cf.method)).toBe(true);
    // The observed tiers were not rewritten to make room for it.
    const raw = (g.gc.entries as Array<Record<string, unknown>>).find((e) => e.grader === "Raw")!;
    expect(raw.valueSource).toBe("observed");
    expect(h.calls.ladder).toEqual([]);
  });

  it("no exact pool at any grade: every route says null, no-basis, the same reason — and the ladder was consulted once per route, gated", async () => {
    const e = await four(EMPTY);
    for (const b of [e.pb.marketValue, e.cf.fmv, e.hf.fmv, e.tile?.value, e.tile?.trendAdjustedValue]) expect(b ?? null).toBeNull();
    for (const l of [e.pb.rungLabel, e.cf.rungLabel, e.hf.rungLabel]) expect(l).toBe("no-basis");
    for (const r of [e.pb.fmvReason, e.cf.fmvReason, e.hf.fmvReason, e.gc.fmvReason]) expect(r).toBe("no-exact-pool");
    expect(e.pb.source).toBe("no-recent-comps");   // iOS's no-data check
    expect(e.pb.marketTier).toBeNull();
    expect(e.hf.method).toBe("no-basis");
    expect(e.cf.method).toBe("no-basis");
    expect(e.gc.cardId).toBe(EMPTY);
    expect(h.calls.ladder.length).toBe(4);
    expect(h.calls.ladder.every((c) => c.skipExactPool === true && c.hobbyiqCardId === EMPTY)).toBe(true);
    expect(h.calls.canonical).toBe(0);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
  });

  it("an hiq slug the catalog does not hold: null on every route, identity-not-in-catalog, and NO engine is asked", async () => {
    h.rows.push(...Array.from({ length: 5 }, (_, i) => sale(NOT_IN_CATALOG, 20 + i, 10 + i)));
    const e = await four(NOT_IN_CATALOG);
    for (const b of [e.pb.marketValue, e.cf.fmv, e.hf.fmv, e.tile?.value]) expect(b ?? null).toBeNull();
    for (const r of [e.pb.fmvReason, e.cf.fmvReason, e.hf.fmvReason, e.gc.fmvReason]) expect(r).toBe("identity-not-in-catalog");
    expect(h.calls.unified).toBe(0);
    expect(h.calls.ladder).toEqual([]);
    expect(h.calls.canonical).toBe(0);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
  });

  it("an un-numbered id whose ONLY catalog row is its numbered twin (Max Williams CPA-MWI): every route prices the twin's pool under the twin's slug", async () => {
    const UN = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
    const TWIN = `${UN}:num-499`;
    h.catalog.set(TWIN, identityRow({ year: 2025, setKey: "bowman-draft", setName: "2025 Bowman Draft", cardNumber: "CPA-MWI", parallel: "Refractor", isAuto: true, printRun: 499 }));
    h.rows.push(...Array.from({ length: 10 }, (_, i) => sale(TWIN, 200 + i * 4, 45 - i * 5)));
    const direct = await four(TWIN);
    const via = await four(UN);
    // Mutation check: before, the un-numbered id was identity-not-in-catalog on every route.
    expect(typeof via.pb.marketValue === "number" && via.pb.marketValue > 0).toBe(true);
    expect(via.pb.marketValue).toBe(direct.pb.marketValue);
    expect(new Set([via.pb.marketValue, via.cf.fmv, via.hf.fmv, via.tile?.trendAdjustedValue]).size).toBe(1);
    expect(new Set([via.pb.rungLabel, via.cf.rungLabel, via.hf.rungLabel, via.tile?.rungLabel]).size).toBe(1);
    expect(EXACT.has(via.pb.rungLabel)).toBe(true);
    expect(via.pb.compsUsed).toBe(10);
    for (const r of [via.pb.fmvReason, via.cf.fmvReason, via.hf.fmvReason, via.gc.fmvReason]) expect(r ?? null).toBeNull();
    // Served under the twin — the row the identity IS.
    expect(via.gc.cardId).toBe(TWIN);
    for (const b of [via.pb.cardIdentity, via.cf.identity, via.hf.identity, via.gc.identity]) {
      expect(b.slug).toBe(TWIN);
      expect(b.setKey).toBe("bowman-draft");
    }
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
  });

  it("a vendor id resolves to its catalog slug first: priced as the slug, the curve served under the slug", async () => {
    const asSlug = await four(GOLD);
    const [pb, cf, gc] = await Promise.all([
      request(app).post("/api/compiq/price-by-id").set(H).send({ cardId: VENDOR }),
      request(app).post("/api/compiq/canonical-fmv").set(H).send({ cardId: VENDOR }),
      request(app).get(`/api/compiq/observed-grade-curve/${VENDOR}`).set(H),
    ]);
    expect(pb.status).toBe(200);
    expect(pb.body.marketValue).toBe(asSlug.pb.marketValue);
    expect(pb.body.rungLabel).toBe(asSlug.pb.rungLabel);
    expect(pb.body.cardIdentity.slug).toBe(GOLD);
    expect(cf.body.fmv).toBe(asSlug.cf.fmv);
    expect(gc.body.cardId).toBe(GOLD);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
  });

  it("the grade curve: every priced tier names a rung in the vocabulary; observed tiers are exact-pool rungs; graded estimates on price-by-id come from the same curve", async () => {
    const { pb, gc } = await four(GOLD);
    const entries = gc.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const e of entries) {
      if (e.valueSource === "unavailable") { expect(e.rungLabel ?? null).toBeNull(); continue; }
      expect(VOCAB.has(String(e.rungLabel)), `${e.grade} ${e.rungLabel}`).toBe(true);
      if (e.valueSource === "observed") expect(EXACT.has(String(e.rungLabel))).toBe(true);
    }
    const psa10 = entries.find((e) => e.grade === "PSA 10")!;
    const est = (pb.gradedEstimates as Array<Record<string, unknown>>).find((x) => x.gradeCompany === "PSA" && x.gradeValue === 10)!;
    expect(est.estimatedValue).toBe(psa10.trendAdjustedValue);
    expect(est.rungLabel).toBe(psa10.rungLabel);
  });
});

// ─── D17: every price surface through the one entry ─────────────────────────
//
// D16 left /card-detail, /card-panel, /observed-grade-curves-bulk and the
// portfolio persist site on their own calls (same window policy, separate
// computation). The same fixture pool goes through each of them here and
// must come back as the SAME number and the SAME rung the four routes
// serve — and the same null + reason when there is nothing.

async function detail(id: string, g: { company: string; value: number } | null = null, extra: Record<string, unknown> = {}) {
  const r = await request(app).post("/api/compiq/card-detail").set(H).send({
    hobbyiqCardId: id, ...grade(g), includeGradeLadder: true, ...extra,
  });
  expect(r.status).toBe(200);
  const label = g ? `${g.company.toUpperCase()} ${g.value}` : "Raw";
  const tier = (r.body.gradeLadder as Array<Record<string, unknown>> | null)?.find((t) => t.gradeLabel === label) ?? null;
  return { body: r.body, tier };
}

describe("D17 — /card-detail: the header is /hobbyiq-fmv's number, the ladder is the curve", () => {
  it("(slug, Raw): fmv.fmv, fmv.rungLabel and the Raw ladder tier equal the four routes; identity on the wire", async () => {
    const { pb, hf, gc } = await four(GOLD);
    const { body, tier } = await detail(GOLD);
    expect(body.fmv.fmv).toBe(pb.marketValue);
    expect(body.fmv.fmv).toBe(hf.fmv);
    expect(body.fmv.rungLabel).toBe(hf.rungLabel);
    expect(body.fmv.method).toBe("direct-slug");
    expect(body.rungLabel).toBe(pb.rungLabel);
    expect(body.valueSource).toBe("observed");
    expect(body.fmvReason).toBeNull();
    expect(tier?.fmv).toBe(pb.marketValue);
    expect(tier?.rungLabel).toBe(pb.rungLabel);
    expect(tier?.method).toBe(pb.rungLabel);
    expect(tier?.compCount).toBe(10);
    expect(body.fmv.compCount).toBe(10);
    // Every ladder tier is a curve entry: same value, same rung, per grade.
    const entries = gc.entries as Array<Record<string, unknown>>;
    for (const t of body.gradeLadder as Array<Record<string, unknown>>) {
      const e = entries.find((x) => (t.gradeLabel === "Raw" ? x.grader === "Raw" : x.grade === t.gradeLabel))!;
      expect(t.fmv, String(t.gradeLabel)).toBe(e.trendAdjustedValue ?? e.value);
      expect(t.rungLabel, String(t.gradeLabel)).toBe(e.rungLabel);
      expect(VOCAB.has(String(t.method)), String(t.method)).toBe(true);
    }
    expect(body.catalogIdentity.slug).toBe(GOLD);
    expect(body.identity.setKey).toBe("bowman-chrome");
    expect(body.identity.printRun).toBe(50);
    expect(h.calls.canonical).toBe(0);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
    expect(h.calls.ladder).toEqual([]);
  });

  it("(slug, PSA 10) and (slug, PSA 8): the graded header equals the graded wire — exact pool, then the empirical fill", async () => {
    const psa10 = await four(GOLD, { company: "PSA", value: 10 });
    const d10 = await detail(GOLD, { company: "PSA", value: 10 });
    expect(d10.body.fmv.fmv).toBe(psa10.pb.marketValue);
    expect(d10.body.fmv.rungLabel).toBe(psa10.pb.rungLabel);
    expect(d10.tier?.fmv).toBe(psa10.pb.marketValue);
    const psa8 = await four(GOLD, { company: "PSA", value: 8 });
    const d8 = await detail(GOLD, { company: "PSA", value: 8 });
    expect(d8.body.fmv.fmv).toBe(psa8.pb.marketValue);
    expect(d8.body.rungLabel).toBe("grade-curve-estimate");
    expect(d8.body.fmv.rungLabel).toBe("grade-curve-estimate");
    expect(d8.body.valueSource).toBe("estimated");
    expect(d8.tier?.fmv).toBe(psa8.pb.marketValue);
    expect(d8.tier?.valueSource).toBe("estimated");
    expect(d8.tier?.compCount).toBe(0);
    expect(h.calls.ladder).toEqual([]);
  });

  it("no exact pool: fmv null, no-basis, the same reason as the four routes; the ladder stays empty (no second engine fills it)", async () => {
    const e = await four(EMPTY);
    const { body } = await detail(EMPTY);
    expect(body.fmv.fmv).toBeNull();
    expect(body.fmv.method).toBe("no-basis");
    expect(body.rungLabel).toBe("no-basis");
    expect(body.fmvReason).toBe(e.pb.fmvReason);
    expect(body.fmvReason).toBe("no-exact-pool");
    expect(body.gradeLadder).toEqual([]);
    expect(body.fmvError).toBeNull();
    expect(h.calls.canonical).toBe(0);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
  });

  it("a slug the catalog does not hold: identity-not-in-catalog, nothing priced, no engine asked", async () => {
    const { body } = await detail(NOT_IN_CATALOG);
    expect(body.fmv.fmv).toBeNull();
    expect(body.fmvReason).toBe("identity-not-in-catalog");
    expect(body.catalogIdentity.slug).toBeNull();
    expect(h.calls.unified).toBe(0);
    expect(h.calls.ladder).toEqual([]);
  });
});

async function panel(id: string) {
  const r = await request(app).get(`/api/compiq/card-panel/${encodeURIComponent(id)}`).set(H);
  expect(r.status).toBe(200);
  return r.body;
}

describe("D17 — /card-panel: the tiers are the one entry's curve, served under the slug", () => {
  it("(slug): every entry equals /observed-grade-curve's; the Raw tile equals the four routes' headline; identity from the catalog", async () => {
    const { pb, gc } = await four(GOLD);
    const p = await panel(GOLD);
    expect(p.cardId).toBe(GOLD);
    expect(p.gradeCurve.entries).toEqual(gc.entries);
    expect(p.gradeCurve.totalSampleCount).toBe(gc.totalSampleCount);
    const raw = (p.gradeCurve.entries as Array<Record<string, unknown>>).find((e) => e.grader === "Raw")!;
    expect(raw.trendAdjustedValue).toBe(pb.marketValue);
    expect(raw.rungLabel).toBe(pb.rungLabel);
    expect(p.identity.cardId).toBe(GOLD);
    expect(p.identity.player).toBe("Test Player");
    expect(p.identity.set).toBe("2018 Bowman Chrome");
    expect(p.identity.number).toBe("49");
    expect(p.identity.variant).toBe("Gold Refractor");
    expect(p.identity.year).toBe(2018);
    expect(p.identity.slug).toBe(GOLD);
    expect(p.referencePrices).toEqual([]);
    expect(Array.isArray(p.samePlayerSiblings)).toBe(true);
    expect(p.rungLabel).toBe(pb.rungLabel);
    expect(p.gradeCurve.siblingFallback).toBeNull();
    expect(h.calls.canonical).toBe(0);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
    expect(h.calls.ladder).toEqual([]);
  });

  it("a vendor id resolves to its catalog slug first: the panel is served under the slug, entries identical", async () => {
    const asSlug = await panel(GOLD);
    const p = await panel(VENDOR);
    expect(p.cardId).toBe(GOLD);
    expect(p.gradeCurve.entries).toEqual(asSlug.gradeCurve.entries);
    expect(h.calls.curve).toBe(0);
  });

  it("no exact pool: every tier unavailable, the same reason as the four routes, no second engine fills a tier", async () => {
    const e = await four(EMPTY);
    const p = await panel(EMPTY);
    expect(p.cardId).toBe(EMPTY);
    expect(p.fmvReason).toBe(e.pb.fmvReason);
    expect(p.gradeCurve.fmvReason).toBe("no-exact-pool");
    for (const t of p.gradeCurve.entries as Array<Record<string, unknown>>) {
      expect(t.valueSource).toBe("unavailable");
      expect(t.value ?? null).toBeNull();
    }
    expect(h.calls.curve).toBe(0);
    expect(h.calls.estimate).toBe(0);
  });
});

describe("D17 — /observed-grade-curves-bulk: every slug through the entry, once, keyed by the requested id", () => {
  it("the batch's curves equal the single route's, per slug; a repeated id is valued once; the empty pool carries the shared reason", async () => {
    const gold = await four(GOLD);
    const thin = await four(THIN);
    const empty = await four(EMPTY);
    // The single route's pool reads for the same four identities, measured
    // at the engine's read seam (the one mock that cannot race an import).
    const singleBefore = h.calls.reads.length;
    for (const id of [GOLD, THIN, EMPTY, VENDOR]) {
      await request(app).get(`/api/compiq/observed-grade-curve/${encodeURIComponent(id)}`).set(H);
    }
    const singleReads = h.calls.reads.slice(singleBefore).sort();
    expect(singleReads).toEqual([GOLD, GOLD, THIN, EMPTY].sort());
    const bulkBefore = h.calls.reads.length;
    const r = await request(app).post("/api/compiq/observed-grade-curves-bulk").set(H)
      .send({ cardIds: [GOLD, THIN, GOLD, EMPTY, VENDOR] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(4);
    const byId = new Map<string, Record<string, unknown>>((r.body.curves as Array<Record<string, unknown>>).map((c) => [String(c.cardId), c]));
    expect([...byId.keys()].sort()).toEqual([GOLD, THIN, EMPTY, VENDOR].sort());
    expect(byId.get(GOLD)!.entries).toEqual(gold.gc.entries);
    expect(byId.get(THIN)!.entries).toEqual(thin.gc.entries);
    expect(byId.get(EMPTY)!.entries).toEqual(empty.gc.entries);
    expect(byId.get(EMPTY)!.fmvReason).toBe("no-exact-pool");
    // A vendor id is answered under the requested id, from its catalog slug.
    const vendor = byId.get(VENDOR)!;
    expect(vendor.slug).toBe(GOLD);
    expect(vendor.entries).toEqual(gold.gc.entries);
    expect((vendor.identity as Record<string, unknown>).slug).toBe(GOLD);
    // The batch reads exactly what the single route reads for the same four
    // identities — one pool read per identity; GOLD sent twice is read once
    // for itself (the vendor id is its own identity read, as on the single route).
    expect(h.calls.reads.slice(bulkBefore).sort()).toEqual(singleReads);
    expect(h.calls.curve).toBe(0);
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.canonical).toBe(0);
  });

  it("a slug the catalog does not hold is null with identity-not-in-catalog — not sent to the legacy build", async () => {
    const r = await request(app).post("/api/compiq/observed-grade-curves-bulk").set(H).send({ cardIds: [NOT_IN_CATALOG] });
    expect(r.status).toBe(200);
    const c = (r.body.curves as Array<Record<string, unknown>>)[0];
    expect(c.cardId).toBe(NOT_IN_CATALOG);
    expect(c.fmvReason).toBe("identity-not-in-catalog");
    expect(h.calls.unified).toBe(0);
    expect(h.calls.curve).toBe(0);
  });
});

// ─── D17: the portfolio persist site ────────────────────────────────────────
//
// repriceHoldingsForUser (the batch / scheduled site) and autoPriceHolding
// (add / update / refresh — reached through POST /holdings/:id/refresh) with
// a fixture holding against the same mocked reader: the number persisted on
// the holding must be the number the four routes serve for its slug + grade,
// under the same rung. The unified early-exit flag is ON here so the
// boundary is observable: for an identity the catalog names, the entry
// decides and the flagged legacy reads never run; for an identity it cannot
// name, the legacy reads still price it (unchanged since #1462).
describe("D17 — the portfolio persist site: what is written is what the routes serve", () => {
  const USER = "test-user";
  let store: typeof import("../src/services/portfolioiq/portfolioStore.service.js");
  beforeAll(async () => {
    store = await import("../src/services/portfolioiq/portfolioStore.service.js");
    process.env.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED = "true";
  });
  afterAll(() => { delete process.env.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED; });
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
    const doc = await store.readUserDoc(USER);
    doc.holdings = {};
    await store.writeUserDoc(USER, doc);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function seed(fields: Record<string, unknown>): Promise<string> {
    const id = `h-${Math.random().toString(36).slice(2, 8)}`;
    const doc = await store.readUserDoc(USER);
    doc.holdings[id] = {
      id, quantity: 1, purchasePrice: 100, totalCostBasis: 100, cardStatus: "active",
      playerName: "Test Player", cardYear: 2018, setName: "Bowman Chrome", cardNumber: "49",
      parallel: "Gold Refractor", isAuto: false, lastUpdated: "2026-08-01T00:00:00.000Z",
      ...fields,
    } as never;
    await store.writeUserDoc(USER, doc);
    return id;
  }
  const stored = async (id: string): Promise<Record<string, unknown>> => (await store.readUserDoc(USER)).holdings[id] as unknown as Record<string, unknown>;
  async function refresh(id: string): Promise<void> {
    const r = await request(app).post(`/api/portfolio/holdings/${id}/refresh`).set(H);
    expect(r.status).toBe(200);
  }

  it("(slug, Raw): the batch reprice AND the refresh persist the four routes' number and rung, labelled observed, with the routes' comp count", async () => {
    const { pb, cf } = await four(GOLD);
    const id = await seed({ hobbyiqCardId: GOLD });
    const res = await store.repriceHoldingsForUser(USER);
    expect(res.updates.find((u) => u.id === id)).toMatchObject({ status: "repriced", reason: `one-valuation-path:${pb.rungLabel}` });
    const hld = await stored(id);
    expect(hld.fairMarketValue).toBe(pb.marketValue);
    expect(hld.fmvRung).toBe(pb.rungLabel);
    expect(EXACT.has(String(hld.fmvRung))).toBe(true);
    expect(hld.isEstimate).toBe(false);
    expect(hld.valuationStatus).toBe("observed");
    expect(hld.pricingSource).toBe("unified-pricing");
    // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the meta now
    // also carries the price's LABELS and, when one applies, the self-anchored
    // ratio. Still asserted exactly — this pin's job is that a previous pass's
    // rung and pool cannot survive, so the shape stays closed rather than
    // becoming a toMatchObject that would let a stale key ride along. These
    // fixtures have no owner-contributed sale, so the self label never fires.
    // CF-CONFIDENCE-IS-NOT-OPTIONAL (#1683, 2026-09-03): the meta also carries
    // the engine's own 0..1 confidence. It is asserted from the WIRE the routes
    // serve, not as a literal — that keeps this a persist-equals-serve pin
    // (which is this suite's whole thesis) instead of a float that any future
    // calibration rebase would have to hand-edit.
    // CF-A-CAVEAT-THAT-FIRES-EVERYWHERE-SAYS-NOTHING (Drew, 2026-09-04).
    // `labels` was `[]`, then briefly carried `independence-unverified`
    // under #1775, and is `[]` again — for a DIFFERENT reason than the
    // first time. These fixture comps carry no seller (like every real
    // sold_comps row), so independence is genuinely unverifiable here; what
    // changed is that Drew ruled the caveat belongs only on THIN pools,
    // where one seller could plausibly be behind every sale. This pool
    // clears the measured floor of 5, so the reader is not told something
    // that would be true of every card they own. The basis itself is still
    // on the API for any caller that asks. The contract this suite exists
    // to hold is untouched: what is PERSISTED is exactly what the routes
    // SERVE, labels included — here, both empty.
    expect(hld.pricingSourceMeta).toEqual({ slug: GOLD, method: pb.rungLabel, compsUsed: pb.compsUsed, labels: [], selfAnchored: null, confidence: cf.confidence });
    expect(hld.predictedPrice).toBe(pb.predictedPrice);
    expect(hld.estimateBasis).toMatch(/^unified: Raw window=/);
    expect(hld.estimateBasis).toContain("id=hobbyiqCardId");
    expect(hld.lastUpdated).not.toBe("2026-08-01T00:00:00.000Z");
    // The on-demand site, from a stale number: the same answer.
    const doc = await store.readUserDoc(USER);
    (doc.holdings[id] as unknown as Record<string, unknown>).fairMarketValue = 1;
    (doc.holdings[id] as unknown as Record<string, unknown>).fmvRung = null;
    await store.writeUserDoc(USER, doc);
    await refresh(id);
    const again = await stored(id);
    expect(again.fairMarketValue).toBe(pb.marketValue);
    expect(again.fmvRung).toBe(pb.rungLabel);
    // CF-A-CAVEAT-THAT-FIRES-EVERYWHERE-SAYS-NOTHING (Drew, 2026-09-04).
    // `labels` was `[]`, then briefly carried `independence-unverified`
    // under #1775, and is `[]` again — for a DIFFERENT reason than the
    // first time. These fixture comps carry no seller (like every real
    // sold_comps row), so independence is genuinely unverifiable here; what
    // changed is that Drew ruled the caveat belongs only on THIN pools,
    // where one seller could plausibly be behind every sale. This pool
    // clears the measured floor of 5, so the reader is not told something
    // that would be true of every card they own. The basis itself is still
    // on the API for any caller that asks. The contract this suite exists
    // to hold is untouched: what is PERSISTED is exactly what the routes
    // SERVE, labels included — here, both empty.
    expect(again.pricingSourceMeta).toEqual({ slug: GOLD, method: pb.rungLabel, compsUsed: pb.compsUsed, labels: [], selfAnchored: null, confidence: cf.confidence });
    // No second engine, no legacy chain, on either site.
    expect(h.calls.estimate).toBe(0);
    expect(h.calls.curve).toBe(0);
    expect(h.calls.canonical).toBe(0);
    expect(h.calls.ladder).toEqual([]);
  });

  it("(slug, PSA 10): the graded holding persists the graded wire's number — not Raw's", async () => {
    const raw = await four(GOLD);
    const psa10 = await four(GOLD, { company: "PSA", value: 10 });
    const id = await seed({ hobbyiqCardId: GOLD, gradeCompany: "PSA", gradeValue: 10 });
    await store.repriceHoldingsForUser(USER);
    const hld = await stored(id);
    expect(hld.fairMarketValue).toBe(psa10.pb.marketValue);
    expect(hld.fairMarketValue).not.toBe(raw.pb.marketValue);
    expect(hld.fmvRung).toBe(psa10.pb.rungLabel);
    // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the meta now
    // also carries the price's LABELS and, when one applies, the self-anchored
    // ratio. Still asserted exactly — this pin's job is that a previous pass's
    // rung and pool cannot survive, so the shape stays closed rather than
    // becoming a toMatchObject that would let a stale key ride along. These
    // fixtures have no owner-contributed sale, so the self label never fires.
    // CF-CONFIDENCE-IS-NOT-OPTIONAL (#1683, 2026-09-03): the meta also carries
    // the engine's own 0..1 confidence. It is asserted from the WIRE the routes
    // serve, not as a literal — that keeps this a persist-equals-serve pin
    // (which is this suite's whole thesis) instead of a float that any future
    // calibration rebase would have to hand-edit.
    // CF-A-CAVEAT-THAT-FIRES-EVERYWHERE-SAYS-NOTHING (Drew, 2026-09-04).
    // `labels` was `[]`, then briefly carried `independence-unverified`
    // under #1775, and is `[]` again — for a DIFFERENT reason than the
    // first time. These fixture comps carry no seller (like every real
    // sold_comps row), so independence is genuinely unverifiable here; what
    // changed is that Drew ruled the caveat belongs only on THIN pools,
    // where one seller could plausibly be behind every sale. This pool
    // clears the measured floor of 5, so the reader is not told something
    // that would be true of every card they own. The basis itself is still
    // on the API for any caller that asks. The contract this suite exists
    // to hold is untouched: what is PERSISTED is exactly what the routes
    // SERVE, labels included — here, both empty.
    expect(hld.pricingSourceMeta).toEqual({ slug: GOLD, method: psa10.pb.rungLabel, compsUsed: psa10.pb.compsUsed, labels: [], selfAnchored: null, confidence: psa10.cf.confidence });
  });

  it("(slug, PSA 8 — no pool at the tier): the same entry's grade-curve-estimate is persisted as an ESTIMATE under its rung — never the engine's cross-grade rescale as observed", async () => {
    const psa8 = await four(GOLD, { company: "PSA", value: 8 });
    expect(psa8.pb.rungLabel).toBe("grade-curve-estimate");
    const id = await seed({ hobbyiqCardId: GOLD, gradeCompany: "PSA", gradeValue: 8 });
    const res = await store.repriceHoldingsForUser(USER);
    expect(res.updates.find((u) => u.id === id)).toMatchObject({ status: "repriced", reason: "one-valuation-path:grade-curve-estimate" });
    const hld = await stored(id);
    expect(hld.fairMarketValue).toBe(psa8.pb.marketValue);
    expect(hld.fmvRung).toBe("grade-curve-estimate");
    expect(hld.fmvRung).not.toBe("cross-grade-fallback");
    expect(hld.isEstimate).toBe(true);
    expect(hld.valuationStatus).toBe("estimated");
    expect(hld.pricingSource).toBe("unified-pricing");
    // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the meta now
    // also carries the price's LABELS and, when one applies, the self-anchored
    // ratio. Still asserted exactly — this pin's job is that a previous pass's
    // rung and pool cannot survive, so the shape stays closed rather than
    // becoming a toMatchObject that would let a stale key ride along. These
    // fixtures have no owner-contributed sale, so the self label never fires.
    // CF-CONFIDENCE-IS-NOT-OPTIONAL (#1683, 2026-09-03): the meta also carries
    // the engine's own 0..1 confidence. It is asserted from the WIRE the routes
    // serve, not as a literal — that keeps this a persist-equals-serve pin
    // (which is this suite's whole thesis) instead of a float that any future
    // calibration rebase would have to hand-edit.
    expect(hld.pricingSourceMeta).toEqual({ slug: GOLD, method: "grade-curve-estimate", compsUsed: 0, labels: [{ code: "fallback-rung", text: expect.stringContaining("no sales of this exact card at this grade") }], selfAnchored: null, confidence: psa8.cf.confidence });
    expect(hld.estimateBasis).toMatch(/^Estimated from this card's own Raw sales/);
    await refresh(id);
    const again = await stored(id);
    expect(again.fairMarketValue).toBe(psa8.pb.marketValue);
    expect(again.fmvRung).toBe("grade-curve-estimate");
    expect(h.calls.estimate).toBe(0);
  });

  it("no exact pool: the entry declines, the flagged legacy exact-pool reads do NOT run, the gated estimate chain finds nothing — no exact-pool rung, no unified-pricing label, skipped", async () => {
    const e = await four(EMPTY);
    expect(e.pb.fmvReason).toBe("no-exact-pool");
    const id = await seed({ hobbyiqCardId: EMPTY, cardYear: 2020, setName: "Topps Chrome", cardNumber: "1", parallel: "Base" });
    const res = await store.repriceHoldingsForUser(USER);
    expect(res.updates.find((u) => u.id === id)?.status).toBe("skipped");
    const hld = await stored(id);
    expect(hld.fairMarketValue ?? null).toBeNull();
    expect(EXACT.has(String(hld.fmvRung))).toBe(false);
    expect(hld.pricingSource).not.toBe("unified-pricing");
    // The legacy estimate chain ran (once), found nothing, and persisted nothing.
    expect(h.calls.estimate).toBe(1);
  });

  it("a slug the catalog does not hold, with sales under it: the entry declines and the LEGACY exact-pool read still prices it — legacy survives only for identities the catalog cannot name", async () => {
    h.rows.push(...Array.from({ length: 5 }, (_, i) => sale(NOT_IN_CATALOG, 20 + i, 10 + i)));
    const id = await seed({ hobbyiqCardId: NOT_IN_CATALOG, cardYear: 2021, setName: "Bowman", cardNumber: "7", parallel: "Base" });
    const res = await store.repriceHoldingsForUser(USER);
    expect(res.updates.find((u) => u.id === id)).toMatchObject({ status: "repriced", reason: "unified-pricing-early-exit" });
    const hld = await stored(id);
    expect(EXACT.has(String(hld.fmvRung))).toBe(true);
    expect(hld.pricingSource).toBe("unified-pricing");
    // And the routes say null for it: the same identity rule, both sides.
    const { pb } = await four(NOT_IN_CATALOG);
    expect(pb.fmvReason).toBe("identity-not-in-catalog");
  });

  it("the cost-basis floor still stands: an exact-pool number under 15% of a > $50 cost basis is not written", async () => {
    const id = await seed({ hobbyiqCardId: THIN, cardYear: 2019, setName: "Topps Stadium Club", cardNumber: "100", parallel: "Base", isAuto: true, purchasePrice: 400, totalCostBasis: 400 });
    const res = await store.repriceHoldingsForUser(USER);
    expect(res.updates.find((u) => u.id === id)?.status).toBe("skipped");
    const hld = await stored(id);
    expect(hld.fairMarketValue ?? null).toBeNull();
    expect(EXACT.has(String(hld.fmvRung))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The moved sites (audit follow-up to #1679) — each returns the SAME NUMBER
// valueIdentity returns, over this same fixture pool.
//
// These are the six sites the verifier found still on computeCanonicalFmv.
// Each now goes through computeCanonicalValuation, which calls the one entry
// and renders its answer in the canonical wire shape — so "same number" here
// is byte-identical, not approximately equal.
// ────────────────────────────────────────────────────────────────────────────
describe("the moved sites return what the one entry returns", () => {
  it("computeCanonicalValuation === valueIdentity, in the canonical wire shape", async () => {
    const { valueIdentity } = await import("../src/services/compiq/oneValuationPath.service.js");
    const { toCanonicalFmvResponse } = await import("../src/services/compiq/oneValuationPathAdapters.js");
    const { computeCanonicalValuation } = await import("../src/services/compiq/canonicalValuation.js");

    const v = await valueIdentity({ id: GOLD, grade: null, printRun: null, playerName: null });
    const expected = toCanonicalFmvResponse(v);
    const actual = await computeCanonicalValuation({ cardId: GOLD });

    // computedAt is a wall-clock stamp taken per call; everything that carries
    // a VALUE is compared byte-for-byte.
    expect({ ...actual, computedAt: null }).toEqual({ ...expected, computedAt: null });
    expect(actual.fmv).toBe(v.fairMarketValue);
    expect(actual.rungLabel).toBe(v.rungLabel);
    expect(actual.confidence).toBe(v.confidence);
    expect(EXACT.has(String(actual.rungLabel))).toBe(true);
    // MUTATION: pointing the door back at computeCanonicalFmv makes this red —
    // the second engine reads a different pool and answers a different number.
    expect(h.calls.canonical).toBe(0);
  });

  it("POST /canonical-fmv agrees with the one entry for a VENDOR id too — the tail that used to be the second engine", async () => {
    const { valueIdentity } = await import("../src/services/compiq/oneValuationPath.service.js");
    // VENDOR maps to GOLD through lookupHobbyIqCardIdForVendorCardId, which is
    // resolveValuationIdentity's own mapping — so the one path can answer it,
    // and the computeCanonicalFmv fallthrough was never needed.
    const res = await request(app).post("/api/compiq/canonical-fmv").set(H).send({ cardId: VENDOR });
    expect(res.status).toBe(200);
    const v = await valueIdentity({ id: VENDOR, grade: null, printRun: null, playerName: null });
    expect(res.body.fmv).toBe(v.fairMarketValue);
    expect(res.body.rungLabel).toBe(v.rungLabel);
    expect(res.body.identity.slug).toBe(GOLD);
    expect(h.calls.canonical).toBe(0);
  });

  it("the sell draft prices a holding at exactly the one entry's number", async () => {
    const { valueIdentity } = await import("../src/services/compiq/oneValuationPath.service.js");
    const { composeSellDraftPricing } = await import("../src/services/ebay/ebaySellDraft.service.js");

    const v = await valueIdentity({ id: GOLD, grade: null, printRun: null, playerName: null });
    const ctx = await composeSellDraftPricing({
      hobbyiqCardId: GOLD,
      playerName: "Test Player",
      cardYear: 2018,
      setName: "2018 Bowman Chrome",
      cardNumber: "49",
      parallel: "Gold Refractor",
    } as never);

    expect(ctx.pricing.status).toBe("engine");
    // Cents, from the entry's dollars — a representation change, not a
    // valuation one. MUTATION: restoring computeCanonicalFmv here makes the
    // draft quote a different pool's number and turns this red.
    expect(ctx.pricing.priceCents).toBe(Math.round((v.fairMarketValue as number) * 100));
    expect(ctx.pricing.rungLabel).toBe(v.rungLabel);
    expect(ctx.pricing.confidence).toBe(v.confidence);
    expect(h.calls.canonical).toBe(0);
  });

  it("the sell draft declines — rather than guessing — when the entry has no number", async () => {
    const { composeSellDraftPricing } = await import("../src/services/ebay/ebaySellDraft.service.js");
    const ctx = await composeSellDraftPricing({
      hobbyiqCardId: EMPTY,
      playerName: "Test Player",
      cardYear: 2020,
      setName: "2020 Topps Chrome",
      cardNumber: "1",
      parallel: "Base",
    } as never);
    expect(ctx.pricing.status).not.toBe("engine");
    expect(ctx.pricing.priceCents).toBeNull();
    expect(h.calls.canonical).toBe(0);
  });
});
