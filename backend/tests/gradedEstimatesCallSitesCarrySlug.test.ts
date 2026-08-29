// CF-ROUTE-SLUGS (D4 "one valuation path", PR 3 — 2026-08-29).
//
// Three route call sites handed compileGradedEstimatesForCard a vendor cardId
// and no hiq slug, so the compiler's exact-pool supremacy (and the unified
// adapter that will replace the compiler) had no canonical identity to price
// by. The routes now resolve the slug BEFORE pricing: the free-text routes
// derive it from the parsed query, /price-by-id passes the slug it was given
// or maps a vendor id through sold_comps.
//
// The mocks mirror compiqRouteGradedEstimatesSurface.test.ts, which pins the
// wire SHAPE. This file pins the INPUT the compiler receives.
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

const VENDOR_ID = "fixture-card-id-2017-judge";
const SLUG_FOR_VENDOR = "hiq:baseball:2017:topps-chrome:169:base:no-auto";
const HIQ_REQUEST = "hiq:baseball:2018:topps-chrome:150:refractor:no-auto";

const h = vi.hoisted(() => ({
  compile: vi.fn(async () => ({ estimates: [], mutationDetected: false })),
  lookup: vi.fn(async (_id: string): Promise<string | null> => null),
}));

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user",
      email: "t@t",
      username: null,
      fullName: null,
      plan: "pro_seller",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

vi.mock("../src/services/compiq/compileGradedEstimatesForCard.js", () => ({
  compileGradedEstimatesForCard: h.compile,
}));

// The vendor-id -> slug mapping is a Cosmos point read; stub the seam.
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, lookupHobbyIqCardIdForVendorCardId: h.lookup };
});

vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>("../src/services/compiq/compiqEstimate.service.js");
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 152,
      premiumValue: 175,
      quickSaleValue: 134,
      marketDNA: { trend: "up", speed: "Normal" },
      confidence: { pricingConfidence: 75 },
      source: "live",
      verdict: "Hold",
      compsUsed: 35,
      compsAvailable: 35,
      recentComps: [],
      cardIdentity: { card_id: VENDOR_ID },
      gradeUsed: "Raw",
      daysSinceNewestComp: 0,
      variantWarning: [],
      neighborSynthesis: null,
      crossParallelAnchor: null,
      effectiveFmv: 152,
      lastSale: { price: 152, soldDate: "2026-06-26T00:00:00.000Z" },
      estimateSource: "observed",
      estimatedValue: 152,
      estimateRange: [140, 165],
      estimateBasis: "comps-direct",
    })),
  };
});

// "not notFound" so every route reaches its compile call.
vi.mock("../src/services/compiq/catalogSource.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getPricing: vi.fn(async () => ({ notFound: false, card: { id: VENDOR_ID }, sales: [] })),
  };
});

vi.mock("../src/services/compiq/marketRead.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    buildGradeBreakdown: vi.fn(() => []),
    generateMarketRead: vi.fn(async () => null),
    pickCardImageUrl: vi.fn(() => null),
  };
});

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  h.compile.mockClear();
  h.lookup.mockClear();
  h.lookup.mockResolvedValue(null);
});

type CompileInput = { source: string; cardId: string; hobbyiqCardId?: string | null };
function lastCompileInput(): CompileInput | undefined {
  const calls = h.compile.mock.calls as unknown as CompileInput[][];
  return calls[calls.length - 1]?.[0];
}

const post = (path: string, body: Record<string, unknown>) =>
  request(app).post(path).set("x-session-id", "test-sess").send(body);

// Queries carry a unique tail: /search and /price are cacheWrap-ed on the
// query text, so a repeat would answer from cache without calling the
// compiler at all.
describe("CF-ROUTE-SLUGS: the free-text routes derive the hiq slug from the parsed query", () => {
  it("/search: the compiler receives the canonical slug, not just the vendor id", async () => {
    const res = await post("/api/compiq/search", { query: "2017 Topps Chrome Aaron Judge #169 Refractor ROUTESLUG001" });
    expect(res.status).toBe(200);
    const input = lastCompileInput();
    expect(input?.source).toBe("compiq.search");
    expect(input?.cardId).toBe(VENDOR_ID);
    expect(input?.hobbyiqCardId).toBe("hiq:baseball:2017:topps-chrome:169:refractor:no-auto");
  });

  it("/price: same derivation", async () => {
    const res = await post("/api/compiq/price", { query: "2017 Topps Chrome Aaron Judge #169 Refractor ROUTESLUG002" });
    expect(res.status).toBe(200);
    const input = lastCompileInput();
    expect(input?.source).toBe("compiq.price");
    expect(input?.hobbyiqCardId).toBe("hiq:baseball:2017:topps-chrome:169:refractor:no-auto");
  });

  it("the product is the SET, not the brand: Topps #169 is not Topps Chrome #169", async () => {
    const res = await post("/api/compiq/search", { query: "2017 Topps Aaron Judge #169 ROUTESLUG003" });
    expect(res.status).toBe(200);
    expect(lastCompileInput()?.hobbyiqCardId).toBe("hiq:baseball:2017:topps:169:base:no-auto");
  });

  it("no card number means no slug: the route passes null rather than guessing", async () => {
    const res = await post("/api/compiq/price", { query: "2017 Topps Chrome Aaron Judge ROUTESLUG004" });
    expect(res.status).toBe(200);
    const input = lastCompileInput();
    expect(input).toBeDefined();
    expect(input?.hobbyiqCardId).toBeNull();
  });
});

describe("CF-ROUTE-SLUGS: /price-by-id resolves the identity before pricing", () => {
  it("a vendor id is mapped to its slug through sold_comps", async () => {
    h.lookup.mockResolvedValue(SLUG_FOR_VENDOR);
    const res = await post("/api/compiq/price-by-id", { cardId: VENDOR_ID });
    expect(res.status).toBe(200);
    expect(h.lookup).toHaveBeenCalledWith(VENDOR_ID);
    const input = lastCompileInput();
    expect(input?.source).toBe("compiq.price-by-id");
    expect(input?.hobbyiqCardId).toBe(SLUG_FOR_VENDOR);
  });

  it("a vendor id nothing maps stays unlabelled: null, never a guess", async () => {
    // Its own id: /price-by-id is cache-wrapped on cardId, and a repeat of the
    // id above would answer from cache without reaching the compiler.
    const unmapped = `${VENDOR_ID}-unmapped`;
    const res = await post("/api/compiq/price-by-id", { cardId: unmapped });
    expect(res.status).toBe(200);
    expect(h.lookup).toHaveBeenCalledWith(unmapped);
    const input = lastCompileInput();
    expect(input?.cardId).toBe(unmapped);
    expect(input?.hobbyiqCardId).toBeNull();
  });

  it("a request that arrived with an hiq: slug passes that slug through, with no lookup", async () => {
    const res = await post("/api/compiq/price-by-id", { cardId: HIQ_REQUEST });
    expect(res.status).toBe(200);
    expect(lastCompileInput()?.hobbyiqCardId).toBe(HIQ_REQUEST);
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
