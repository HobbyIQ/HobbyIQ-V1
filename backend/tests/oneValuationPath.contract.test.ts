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
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
  calls: { canonical: 0, estimate: 0, curve: 0, ladder: [] as Array<Record<string, unknown>>, unified: 0 },
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
  readExactPoolRows: vi.fn(async (input: { cardId: string; hobbyiqCardId: string | null; windowDays: number; nowMs?: number }) => {
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    return h.rows.filter((r) =>
      (r.cardId === input.cardId || (input.hobbyiqCardId && r.hobbyiqCardId === input.hobbyiqCardId))
      && Date.parse(String(r.soldAt)) >= cutoff);
  }),
}));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    catalogSlugIfExists: vi.fn(async (slug: string) => (h.catalog.has(slug) ? slug : null)),
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
vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/compiq/compiqEstimate.service.js")>();
  return { ...actual, computeEstimate: vi.fn(async (...args: never[]) => { h.calls.estimate++; return (actual.computeEstimate as (...a: never[]) => unknown)(...args); }) };
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
beforeAll(async () => {
  app = (await import("../src/app")).default;
});
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
  h.calls = { canonical: 0, estimate: 0, curve: 0, ladder: [], unified: 0 };
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
    expect(thin.pb.rungLabel).toBe("exact-pool-weighted-median");
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
