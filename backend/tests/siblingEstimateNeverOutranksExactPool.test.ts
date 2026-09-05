// D4 PR 5 (2026-08-29) — the sibling estimate seam obeys the doctrine.
//
// The fixture is real: holding ca7a150b, 2026 Bowman Chrome CPA-MG Marconi
// German Gold Refractor /50 auto, raw, purchase $187.49. Exact pool under
// its slug: $182.50 (08-18), $187.49 (08-18), $102.50 (06-17). Persisted:
// fairMarketValue 1109.44, isEstimate true, estimateBasis "sibling: … ×
// 8.00× parallel (floor lifted from 1.00×)", pricingSource "unified-
// pricing", pricingSourceMeta { method: "cross-setkey", compsUsed: 3 }.
// The holding's cardId was the WRONG identity (…:cpa-mg:refractor:auto)
// while hobbyiqCardId was the right one (…:cpa-mg:gold-refractor:auto).
// The same reprice run's log then showed the exact pool computed —
// our_pool_fallback_wired_from_reprice_hit, method "unified-market-value",
// compsUsed 3, fmv 182.5 — and labelled "estimated".
//
// Doctrine pinned here: exact-pool supremacy (a fallback rung never
// outranks an exact pool with >= 1 sale), empirical-only multipliers (no
// measurement, no price), cross-setkey stays inside the product family
// and the player, and labels tell the truth.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import * as repriceJobs from "../src/services/portfolioiq/repriceJobTracker.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.PORTFOLIO_REPRICE_HTTP_MIN_AGE_MS = "1";
process.env.PORTFOLIO_REPRICE_HTTP_THROTTLE_MS = "1";
// The runner's shape: no unified early exit, so the reprice walks the
// legacy chain to the sibling rung — where the fixture was written.
delete process.env.PORTFOLIO_OBSERVED_GRADE_OVERRIDE_ENABLED;
delete process.env.COSMOS_CONNECTION_STRING;

const h = vi.hoisted(() => {
  const empty = (cardId: string) => ({
    cardId, fmv: null, marketValue: null, predictedPrice: null, trendPctPerWeek: null,
    trendDirection: "flat", gradeCurve: [], windowDays: 180, totalSampleCount: 0,
    method: "no-basis", confidence: 0, computedAt: new Date().toISOString(), rungLabel: "no-basis",
  });
  return {
    empty,
    unified: null as null | ((cardId: string, opts: any) => any),
    ourPool: null as null | ((holding: any) => any),
    sibling: null as null | ((input: any) => any),
    judge: null as null | ((holding: any) => any),
    unifiedCalls: [] as Array<{ cardId: string; hobbyiqCardId: string | null }>,
  };
});

vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    // CH has nothing for the wrong identity: the confidence gate fails and
    // the reprice walks ladder -> resolver -> our-pool -> sibling.
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 0,
      confidence: { pricingConfidence: 0 },
      source: "no-recent-comps",
      compsUsed: 0,
      compsAvailable: 0,
      recentComps: [],
      cardIdentity: null,
      gradeUsed: "Raw",
      daysSinceNewestComp: null,
      variantWarning: [],
    })),
  };
});
vi.mock("../src/services/compiq/unifiedPricing.service.js", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    computeUnifiedPrice: vi.fn(async (cardId: string, opts: any) => {
      h.unifiedCalls.push({ cardId, hobbyiqCardId: opts?.hobbyiqCardId ?? null });
      return h.unified ? h.unified(cardId, opts) : h.empty(cardId);
    }),
  };
});
vi.mock("../src/services/portfolioiq/priceFromOurPool.service.js", async (importActual) => {
  const actual = await importActual<any>();
  return { ...actual, priceHoldingFromOurPool: vi.fn(async (holding: any) => (h.ourPool ? h.ourPool(holding) : null)) };
});
vi.mock("../src/services/compiq/siblingCardPriceFallback.service.js", async (importActual) => {
  const actual = await importActual<any>();
  return { ...actual, attemptSiblingPriceFallback: vi.fn(async (input: any) => (h.sibling ? h.sibling(input) : null)) };
});
vi.mock("../src/services/portfolioiq/exactPoolSupremacy.js", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    judgeExactPoolSupremacyForHolding: vi.fn(async (holding: any) =>
      h.judge ? h.judge(holding) : actual.judgeExactPoolSupremacy(actual.exactIdentityCandidates(holding), {})),
  };
});
vi.mock("../src/services/compiq/observedGradeCurve.service.js", async (importActual) => {
  const actual = await importActual<any>();
  return { ...actual, deriveWeeklyRate: vi.fn(async () => null) };
});
vi.mock("../src/services/compiq/releaseDecayPrior.service.js", () => ({
  getReleaseDecayForCardAsync: vi.fn(async () => null),
}));

import {
  filterCrossSetKeyComps,
  foldPlayerName,
  majorityPlayerFold,
  describeCrossSetKeyPool,
} from "../src/services/portfolioiq/crossSetKeyRule.js";
import { productFamilyKey, sameProductFamily } from "../src/services/portfolioiq/productFamily.service.js";
import {
  exactIdentityCandidates,
  judgeExactPoolSupremacy,
  isCrossIdentityRung,
  unifiedIdentityAttempts,
  countExactSalesInWindow,
} from "../src/services/portfolioiq/exactPoolSupremacy.js";
import { readUserDoc, writeUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, rel), "utf8");

// ─── The fixture's identities ────────────────────────────────────────────────
const GOLD = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto";
const GOLD_50 = `${GOLD}:num-50`;
const REFRACTOR = "hiq:baseball:2026:bowman-chrome:cpa-mg:refractor:auto";
const SIBLING_CH_ID = "1778814561816x835862652021336800";
const FLOOR_BASIS = `sibling: ${SIBLING_CH_ID} × 8.00× parallel (floor lifted from 1.00×)`;

const MARCONI_TARGET = {
  sport: "baseball",
  year: 2026,
  setKey: "bowman-chrome",
  cardNumber: "cpa-mg",
  isAuto: true,
  parallel: "gold-refractor",
  printRun: 50,
  playerFold: foldPlayerName("Marconi German,"),
};

const sale = (over: Record<string, unknown>) => ({
  price: 150,
  soldAt: "2026-08-18T00:00:00.000Z",
  source: "tca-ebay",
  parallel: "Gold Refractor",
  playerName: "Marconi German",
  ...over,
});

/** The unified engine's answer for the exact gold pool: n=3, $182.50. */
const EXACT_GOLD = (cardId: string) => ({
  cardId,
  fmv: 182.5,
  marketValue: 182.5,
  predictedPrice: 180,
  trendPctPerWeek: 0,
  trendDirection: "flat",
  gradeCurve: [],
  windowDays: 90,
  totalSampleCount: 3,
  method: "weighted-median",
  confidence: 0.37,
  computedAt: new Date().toISOString(),
  rungLabel: "exact-pool-leading-edge",
});

/** What the sibling seam says for this card today: a measured 2.5× on the
 *  player's Base Auto ($175 median, n=4) — never a floor. */
const SIBLING_RESULT = {
  estimatedRawPrice: 437.5,
  estimatedPSA10Price: 1200,
  estimatedRawPredicted7d: null,
  siblingCardId: SIBLING_CH_ID,
  siblingParallel: "Base",
  siblingBaseMedianRaw: 175,
  siblingBaseProjectedToday: 175,
  siblingWeeksSinceNewestSale: 1,
  siblingCompCount: 4,
  parallelPremium: 2.5,
  empiricalPremium: 2.5,
  premiumSampleSize: 12,
  inferredPrintRun: 50,
  premiumMatchedSet: "Bowman Chrome",
  premiumUsedProxy: false,
  siblingIsCrossClass: false,
  crossClassAutoPremium: null,
};

// ─── Cross-setkey stays inside the family and the player ────────────────────
describe("productFamilyKey / sameProductFamily — the ladder the matcher honours", () => {
  it.each([
    ["bowman-chrome-prospects", "bowman-chrome", true],
    ["bowman-chrome-updates", "bowman-chrome", true],
    ["bowman-chrome-mega-box", "bowman-chrome-prospects", true],
    ["topps-chrome-update", "topps-chrome", true],
    ["bowman-draft-chrome", "bowman-draft", true],
    // Drew's rulings: paper is not Chrome, flagship is not Chrome.
    ["bowman", "bowman-chrome", false],
    ["topps", "topps-chrome", false],
    ["bowman", "bowman-draft", false],
    // Sapphire is its own checklist and never crosses.
    ["bowman-chrome-sapphire", "bowman-chrome", false],
    ["bowman-draft-sapphire", "bowman-draft", false],
    ["topps-chrome-sapphire", "topps-chrome", false],
    ["bowman-sterling", "bowman-chrome", false],
    ["panini-prizm", "panini-select", false],
  ])("%s ↔ %s → %s", (a, b, expected) => {
    expect(sameProductFamily(a, b)).toBe(expected);
    expect(sameProductFamily(b, a)).toBe(expected);
  });

  it("an empty key is in no family", () => {
    expect(productFamilyKey("")).toBe("");
    expect(sameProductFamily("", "")).toBe(false);
  });
});

describe("foldPlayerName — the player equality the rung uses", () => {
  it("drops the eBay import's trailing comma, case, diacritics and a generational suffix", () => {
    expect(foldPlayerName("Marconi German,")).toBe("marconi german");
    expect(foldPlayerName("MARCONI GERMAN")).toBe("marconi german");
    expect(foldPlayerName("José Ramírez Jr.")).toBe("jose ramirez");
    expect(foldPlayerName("Ken Griffey Jr")).toBe("ken griffey");
  });
  it("is empty for nothing", () => {
    expect(foldPlayerName(null)).toBe("");
    expect(foldPlayerName("   ")).toBe("");
  });
  it("majorityPlayerFold learns the player from the exact slug's own pool", () => {
    expect(majorityPlayerFold([
      sale({ playerName: "Marconi German" }),
      sale({ playerName: "Marconi German," }),
      sale({ playerName: "Some Other Guy" }),
      sale({ playerName: null }),
    ])).toBe("marconi german");
    expect(majorityPlayerFold([sale({ playerName: null })])).toBeNull();
  });
});

describe("filterCrossSetKeyComps — a comp crosses a setKey only inside the family, for the same player, at a print run that does not contradict", () => {
  it("keeps the same card under a sibling spelling of the product; refuses another player's CPA-MG and a bowman paper /75", () => {
    const rows = [
      // The rescue this rung exists for: one physical card, two spellings.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50", playerName: "Marconi German," }),
      // Same family, un-numbered twin — unknown print run does not contradict /50.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto", printRun: null }),
      // Another player's CPA-MG in the same family: the initials collide.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50", playerName: "Mateo Gil" }),
      // Bowman paper /75: a different card at a different price.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-75", printRun: 75 }),
      // Sapphire: its own checklist.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-sapphire:cpa-mg:gold-refractor:auto:num-50" }),
      // Same family, same player, but /25 contradicts /50.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-25", printRun: 25 }),
      // Same family, same player, the slug says a different parallel.
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:refractor:auto" }),
      // No slug at all: cannot be judged.
      sale({ hobbyiqCardId: undefined }),
      // Same family, same player, different year in the slug.
      sale({ hobbyiqCardId: "hiq:baseball:2025:bowman-chrome:cpa-mg:gold-refractor:auto:num-50" }),
    ];
    const v = filterCrossSetKeyComps(MARCONI_TARGET, rows);
    expect(v.refused).toBeNull();
    expect(v.kept.map((r) => r.hobbyiqCardId)).toEqual([
      "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50",
      "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto",
    ]);
    expect(v.excluded).toEqual({
      noSlug: 1,
      otherIdentity: 1,
      otherFamily: 2,
      otherParallel: 1,
      otherPrintRun: 1,
      otherPlayer: 1,
    });
  });

  it("refuses the whole rung when the target's player is unknown — a cross-product comp cannot be verified", () => {
    const v = filterCrossSetKeyComps({ ...MARCONI_TARGET, playerFold: null }, [
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50" }),
    ]);
    expect(v.refused).toBe("no-player");
    expect(v.kept).toEqual([]);
  });

  it("the basis note names the comps, the family, the player and what was turned away", () => {
    const rows = [
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50" }),
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50" }),
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-updates:cpa-mg:gold-refractor:auto:num-50" }),
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-75", printRun: 75 }),
    ];
    const v = filterCrossSetKeyComps(MARCONI_TARGET, rows);
    const note = describeCrossSetKeyPool(MARCONI_TARGET, v.kept, v.excluded);
    expect(note).toBe(
      "Estimated from 3 sales of this exact card within the bowman-chrome family (bowman-chrome-prospects ×2, bowman-chrome-updates ×1; player marconi german); excluded 1 other-family",
    );
  });

  it("a target with no print run accepts comps at any print run (the un-numbered slug is the fixture's own shape)", () => {
    const v = filterCrossSetKeyComps({ ...MARCONI_TARGET, printRun: null }, [
      sale({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-prospects:cpa-mg:gold-refractor:auto:num-50", printRun: 50 }),
    ]);
    expect(v.kept).toHaveLength(1);
  });
});

describe("hobbyIqFmv — the rung reads the rule (source pin)", () => {
  const src = read("../src/services/portfolioiq/hobbyIqFmv.service.ts");
  it("the cross-setkey rung filters through filterCrossSetKeyComps and describes its pool", () => {
    expect(src).toMatch(/const verdict = filterCrossSetKeyComps\(crossTarget, parallelMatched\);/);
    expect(src).toMatch(/buildResult\(slug, graded, "cross-setkey",\s*describeCrossSetKeyPool\(/);
    expect(src).toMatch(/const targetPlayerFold = foldPlayerName\(input\.playerName\) \|\| majorityPlayerFold\(exactSlugRowsAnyGrade\);/);
  });
  it("the input carries the caller's player and priceFromOurPool passes the holding's", () => {
    expect(src).toMatch(/playerName\?: string \| null;/);
    const ourPool = read("../src/services/portfolioiq/priceFromOurPool.service.ts");
    expect(ourPool).toMatch(/playerName: typeof holding\.playerName === "string" \? holding\.playerName : null,/);
  });
});

// ─── Exact-pool supremacy: the pure gate ────────────────────────────────────
describe("exactPoolSupremacy — candidates, judgement, attempts (pure)", () => {
  const fixture = { hobbyiqCardId: GOLD, cardId: REFRACTOR, printRun: 50 };

  it("the fixture's candidates: hobbyiqCardId first, then its numbered twin, then the (wrong) cardId and its twin", () => {
    expect(exactIdentityCandidates(fixture)).toEqual([GOLD, GOLD_50, REFRACTOR, `${REFRACTOR}:num-50`]);
  });

  it("a numbered slug yields its un-numbered twin; a vendor cardId is itself; nothing yields nothing", () => {
    expect(exactIdentityCandidates({ hobbyiqCardId: GOLD_50, cardId: SIBLING_CH_ID })).toEqual([GOLD_50, GOLD, SIBLING_CH_ID]);
    expect(exactIdentityCandidates({ hobbyiqCardId: null, cardId: null })).toEqual([]);
    expect(exactIdentityCandidates({ hobbyiqCardId: "not-a-slug", cardId: "  " })).toEqual([]);
  });

  it("MARCONI GERMAN: three exact sales under hobbyiqCardId block the estimate even though cardId's pool is empty", () => {
    const v = judgeExactPoolSupremacy(exactIdentityCandidates(fixture), { [GOLD]: 3, [REFRACTOR]: 0 });
    expect(v.allowed).toBe(false);
    expect(v.blockingId).toBe(GOLD);
    expect(v.blockingCount).toBe(3);
  });

  it("ONE exact sale is enough — a fallback rung never outranks an exact pool with >= 1 sale", () => {
    const v = judgeExactPoolSupremacy([GOLD, REFRACTOR], { [REFRACTOR]: 1 });
    expect(v.allowed).toBe(false);
    expect(v.blockingId).toBe(REFRACTOR);
  });

  it("no sale under any identity → the estimate may be persisted", () => {
    expect(judgeExactPoolSupremacy(exactIdentityCandidates(fixture), {}).allowed).toBe(true);
    expect(judgeExactPoolSupremacy(exactIdentityCandidates(fixture), { [GOLD]: 0 }).allowed).toBe(true);
    expect(judgeExactPoolSupremacy([], {}).allowed).toBe(true);
  });

  it("the guard applies to cross-identity rungs and to unnamed ones, never to rungs that read this identity's pool", () => {
    for (const r of ["sibling-estimate", "sibling-parallel", "family-baseline", "cross-setkey", "cross-printrun",
      "same-printrun-cross-parallel", "printrun-discovery", "composite-neighbor", "cross-parallel", "neighbor-parallel",
      "product-tier", "tiered-momentum-player", "no-basis", null, undefined, ""]) {
      expect(isCrossIdentityRung(r), String(r)).toBe(true);
    }
    for (const r of ["exact-pool-projection", "exact-pool-last-sale", "exact-pool-leading-edge", "exact-pool-weighted-median",
      "exact-pool-median", "exact-pool-trajectory", "cross-grade-fallback", "grade-cross-raw", "rare-card-anchor", "grade-curve-estimate"]) {
      expect(isCrossIdentityRung(r), r).toBe(false);
    }
  });

  it("the unified engine is asked for hobbyiqCardId ALONE before any union with cardId", () => {
    expect(unifiedIdentityAttempts(fixture)).toEqual([
      { cardId: GOLD, hobbyiqCardId: GOLD, label: "hobbyiqCardId" },
      { cardId: GOLD_50, hobbyiqCardId: GOLD_50, label: "hobbyiqCardId-twin" },
      { cardId: REFRACTOR, hobbyiqCardId: GOLD, label: "cardId+hobbyiqCardId" },
      { cardId: `${REFRACTOR}:num-50`, hobbyiqCardId: `${REFRACTOR}:num-50`, label: "cardId-twin" },
    ]);
    // A vendor cardId with a slug beside it: the slug alone, then the union.
    expect(unifiedIdentityAttempts({ hobbyiqCardId: GOLD_50, cardId: SIBLING_CH_ID })).toEqual([
      { cardId: GOLD_50, hobbyiqCardId: GOLD_50, label: "hobbyiqCardId" },
      { cardId: GOLD, hobbyiqCardId: GOLD, label: "hobbyiqCardId-twin" },
      { cardId: SIBLING_CH_ID, hobbyiqCardId: GOLD_50, label: "cardId+hobbyiqCardId" },
    ]);
    // Only a vendor id: today's shape.
    expect(unifiedIdentityAttempts({ cardId: SIBLING_CH_ID })).toEqual([
      { cardId: SIBLING_CH_ID, hobbyiqCardId: null, label: "cardId" },
    ]);
  });

  it("countExactSalesInWindow matches a slug on hobbyiqCardId and a vendor id on cardId, in the window", async () => {
    const seen: Array<{ query: string; id: unknown }> = [];
    const container = {
      items: {
        query: (spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) => ({
          fetchAll: async () => {
            const id = spec.parameters.find((p) => p.name === "@id")?.value;
            seen.push({ query: spec.query, id });
            return { resources: [id === GOLD ? 3 : 0] };
          },
        }),
      },
    } as any;
    const counts = await countExactSalesInWindow([GOLD, SIBLING_CH_ID], { container });
    expect(counts).toEqual({ [GOLD]: 3, [SIBLING_CH_ID]: 0 });
    expect(seen[0].query).toMatch(/c\.hobbyiqCardId = @id/);
    expect(seen[0].query).toMatch(/c\.soldAt >= @cutoff/);
    expect(seen[0].query).toMatch(/flaggedWrong/);
    expect(seen[1].query).toMatch(/c\.cardId = @id/);
  });
});

// ─── Exact-pool supremacy at the persist site (reprice, through the route) ──
describe("repriceHoldingsForUser — the fixture, end to end", () => {
  let app: any;
  let session: { sessionId: string; userId: string };

  beforeAll(async () => {
    app = (await import("../src/app")).default;
    const res = await request(app).post("/api/auth/signin").send({ username: "HobbyIQ", password: "Baseball25" });
    expect(res.status).toBe(200);
    session = { sessionId: res.body.sessionId, userId: res.body.user?.userId };
  });

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
    h.unified = null; h.ourPool = null; h.sibling = null; h.judge = null; h.unifiedCalls = [];
    const doc = await readUserDoc(session.userId);
    doc.holdings = {};
    await writeUserDoc(session.userId, doc);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const MARCONI = (over: Record<string, unknown> = {}) => ({
    id: `ca7a150b-${Math.random().toString(36).slice(2, 8)}`,
    quantity: 1,
    purchasePrice: 187.49,
    totalCostBasis: 187.49,
    cardStatus: "active",
    playerName: "Marconi German,",
    cardYear: 2026,
    setName: "Bowman Chrome",
    product: "Bowman Chrome",
    cardNumber: "CPA-MG",
    parallel: "Gold Refractor",
    isAuto: true,
    printRun: 50,
    cardId: REFRACTOR,
    hobbyiqCardId: GOLD,
    lastUpdated: "2026-08-01T00:00:00.000Z",
    ...over,
  });

  /** The holding as persisted tonight: the floor estimate, the stale labels. */
  const STALE = {
    fairMarketValue: 1109.44,
    isEstimate: true,
    valuationStatus: "estimated",
    estimateBasis: FLOOR_BASIS,
    pricingSource: "unified-pricing",
    pricingSourceMeta: { slug: GOLD, method: "cross-setkey", compsUsed: 3 },
    fmvRung: null,
  };

  async function seed(fields: Record<string, unknown>): Promise<string> {
    const holding = MARCONI(fields);
    const doc = await readUserDoc(session.userId);
    doc.holdings[holding.id] = holding as any;
    await writeUserDoc(session.userId, doc);
    return holding.id;
  }

  // CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): /reprice/batch dispatches and
  // answers 202; the run's result lands on the job record afterwards.
  async function reprice(): Promise<any> {
    const r = await request(app).post("/api/portfolio/reprice/batch").set("x-session-id", session.sessionId).send({});
    expect(r.status).toBe(202);
    await repriceJobs.__awaitSettledForTests(session.userId, 20_000);
    const job = repriceJobs.getJob(session.userId);
    expect(job?.status, `reprice run errored: ${job?.error}`).toBe("done");
    return job!.result!;
  }

  async function stored(id: string): Promise<any> {
    return (await readUserDoc(session.userId)).holdings[id];
  }

  it("FIXTURE: three exact sales under hobbyiqCardId, a sibling that says $437 — the exact pool prices it, observed, labelled; the estimate is telemetry", async () => {
    h.judge = () => ({ allowed: false, blockingId: GOLD, blockingCount: 3, candidates: [GOLD, GOLD_50, REFRACTOR], counts: { [GOLD]: 3 } });
    h.unified = (cardId) => (cardId === GOLD ? EXACT_GOLD(cardId) : h.empty(cardId));
    h.sibling = () => SIBLING_RESULT;
    const id = await seed(STALE);

    const body = await reprice();
    const hld = await stored(id);

    expect(hld.fairMarketValue).toBe(182.5);
    expect(hld.isEstimate).toBe(false);
    expect(hld.valuationStatus).toBe("observed");
    expect(hld.pricingSource).toBe("unified-pricing");
    expect(hld.fmvRung).toBe("exact-pool-leading-edge");
    // CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04). `labels` was `[]`.
    // The three exact sales carry no seller (as no real sold_comps row
    // does), so the persisted price now states that seller independence
    // could not be verified. The claim this test makes — the exact pool
    // outranks the sibling estimate, observed and labelled — is unchanged.
    expect(hld.pricingSourceMeta).toEqual({ slug: GOLD, method: "exact-pool-leading-edge", compsUsed: 3, confidence: expect.any(Number), labels: [{ code: "independence-unverified", text: expect.stringContaining("do not tell us who sold them") }], selfAnchored: null });
    expect(hld.estimateBasis).toMatch(/^unified: /);
    expect(hld.estimateBasis).toContain("id=hobbyiqCardId");
    expect(hld.estimateBasis).not.toMatch(/floor/i);
    expect(hld.estimatedValue).toBeNull();
    // The sibling estimate WAS computed — and never written.
    const { attemptSiblingPriceFallback } = await import("../src/services/compiq/siblingCardPriceFallback.service.js");
    expect(attemptSiblingPriceFallback).toHaveBeenCalled();
    // The exact pool was asked for hobbyiqCardId ALONE first — not the wrong cardId, not a union.
    expect(h.unifiedCalls[0]).toEqual({ cardId: GOLD, hobbyiqCardId: GOLD });
    expect(h.unifiedCalls.some((c) => c.cardId === REFRACTOR)).toBe(false);
    const update = body.updates.find((u: any) => u.id === id);
    expect(update.status).toBe("repriced");
    expect(update.reason).toMatch(/^exact-pool-supremacy:reprice\.sibling-estimate/);
  });

  it("NO exact sales anywhere, a measured premium: the sibling estimate is persisted with honest labels", async () => {
    h.judge = (holding) => ({ allowed: true, blockingId: null, blockingCount: 0, candidates: exactIdentityCandidates(holding), counts: {} });
    h.sibling = () => SIBLING_RESULT;
    const id = await seed({});

    const body = await reprice();
    const hld = await stored(id);

    expect(hld.fairMarketValue).toBe(437.5);
    expect(hld.isEstimate).toBe(true);
    expect(hld.valuationStatus).toBe("estimated");
    expect(hld.pricingSource).toBe("sibling-estimate");
    expect(hld.fmvRung).toBe("sibling-estimate");
    // confidence: null — the sibling lane measures none and now says so
    // explicitly (CF-CONFIDENCE-IS-NOT-OPTIONAL, persisted half, 2026-09-04).
    expect(hld.pricingSourceMeta).toEqual({ slug: GOLD, method: "sibling-estimate", compsUsed: 4, confidence: null });
    expect(hld.estimateBasis).toBe(`sibling: ${SIBLING_CH_ID} × 2.50× parallel (empirical n=12, Bowman Chrome)`);
    expect(hld.estimateBasis).not.toMatch(/floor/i);
    expect(body.updates.find((u: any) => u.id === id)).toMatchObject({ status: "repriced", reason: "sibling-fallback" });
  });

  it("NO exact sales, NO measured premium: nothing is persisted — no floor stands in", async () => {
    h.judge = (holding) => ({ allowed: true, blockingId: null, blockingCount: 0, candidates: exactIdentityCandidates(holding), counts: {} });
    h.sibling = () => null;   // the seam's answer when nothing was measured
    const id = await seed({});

    const body = await reprice();
    const hld = await stored(id);

    // CF-A-RETENTION-IS-STATED-ON-THE-ROW (#1685): the confidence gate no
    // longer leaves the row silent. It routes through writeHoldingValuation,
    // which states the outcome explicitly — so a holding this pass could not
    // price carries `fairMarketValue: null` and an `fmvRungAbsentReason`
    // naming the gate, rather than an absent field a reader has to interpret.
    // Null IS the "no price" statement; the defect this case guards is a
    // NUMBER appearing where nothing was measured, and that is what is
    // asserted. `isEstimate` and `estimateBasis` stay absent: no estimate was
    // made, and no floor stood in for one.
    expect(hld.fairMarketValue == null).toBe(true);
    expect(hld.isEstimate).not.toBe(true);
    expect(hld.estimateBasis).toBeUndefined();
    expect(hld.fmvRungAbsentReason).toMatch(/confidence-gated reprice/);
    expect(body.updates.find((u: any) => u.id === id).status).toBe("skipped");
  });

  it("exact sales the engine cannot price: the estimate is withheld and the stale floor estimate is cleared", async () => {
    h.judge = () => ({ allowed: false, blockingId: GOLD, blockingCount: 3, candidates: [GOLD], counts: { [GOLD]: 3 } });
    h.unified = null;   // every identity: no-basis
    h.sibling = () => SIBLING_RESULT;
    const id = await seed(STALE);

    const body = await reprice();
    const hld = await stored(id);

    expect(hld.fairMarketValue).toBeNull();
    expect(hld.isEstimate).toBe(false);
    expect(hld.valuationStatus).toBe("pending");
    expect(hld.estimateBasis).toMatch(/^estimate withheld: 3 exact sales under hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto/);
    expect(hld.fmvRung).toBeNull();

    // CF-A-REFUSAL-STATES-WHAT-ACTUALLY-HAPPENED (Drew, 2026-09-04). The
    // prose used to end "...that the engine could not price" on EVERY
    // withhold, including the ones where the engine had priced the card
    // moments earlier and a whitelist upstream threw the answer away. It may
    // never make that claim again.
    expect(hld.estimateBasis).not.toMatch(/engine could not price/);
    // In THIS fixture the engine genuinely was asked and found nothing
    // (h.unified = null on every identity), so the reason names the legacy
    // read — the specific thing that happened, not a blanket accusation.
    expect(hld.estimateBasis).toMatch(/neither the valuation path nor the legacy exact-pool read produced a number/);

    // CF-A-WITHHOLD-IS-VISIBLE-TO-THE-AUDITOR: the meta used to be ABSENT
    // here (writeMeta:true with no meta), which is precisely the shape #1674
    // found invisible to the invariant auditor. A refusal is the event an
    // auditor most needs to see, so it is written.
    const meta = hld.pricingSourceMeta as unknown as {
      method?: string;
      withheld?: { reason?: string; blockingId?: string; blockingCount?: number; proposed?: number | null };
    };
    expect(meta).toBeDefined();
    expect(meta.method).toBe("withheld");
    expect(meta.withheld?.reason).toBe("legacy-unpriced");
    expect(meta.withheld?.blockingId).toBe(GOLD);
    expect(meta.withheld?.blockingCount).toBe(3);

    // CF-A-WITHHOLD-DOES-NOT-DESTROY-EVIDENCE: the number the ladder produced
    // is RETAINED, not erased. It is not published (isEstimate false,
    // valuationStatus pending, fairMarketValue null) — but a reader can see
    // what was withheld, which is what makes the refusal auditable at all.
    expect(hld.estimatedValue).toBe(437.5);
    expect(meta.withheld?.proposed).toBe(437.5);
    const update = body.updates.find((u: any) => u.id === id);
    expect(update.status).toBe("skipped");
    expect(update.reason).toMatch(/^estimate-withheld:reprice\.sibling-estimate \(hiq:.*stale estimate cleared\)$/);
  });

  it("TONIGHT'S LOG: our-pool computed the exact pool (unified-market-value, n=3, $182.50) — it replaces the persisted floor estimate as OBSERVED", async () => {
    // priceFromOurPool now classifies an exact-pool rung as observed
    // (pinned in priceFromOurPool.test.ts); this is what the reprice site
    // does with that answer.
    h.ourPool = () => ({
      fairMarketValue: 182.5,
      valuationStatus: "observed",
      estimatedValue: null,
      estimateLow: null,
      estimateHigh: null,
      estimateConfidence: "ballpark",
      estimateBasis: "unified: window=90d median=$182 marketValue=$182 predicted=$180 trend=flat 0.0%/wk conf=0.37",
      method: "unified-market-value",
      rungLabel: "exact-pool-leading-edge",
      compsUsed: 3,
      slug: GOLD,
      source: "our-pool",
    });
    h.sibling = () => { throw new Error("the sibling rung must not run once the exact pool answered"); };
    const id = await seed(STALE);

    const body = await reprice();
    const hld = await stored(id);

    expect(hld.fairMarketValue).toBe(182.5);
    expect(hld.isEstimate).toBe(false);
    expect(hld.valuationStatus).toBe("observed");
    expect(hld.pricingSource).toBe("our-pool");
    expect(hld.fmvRung).toBe("exact-pool-leading-edge");
    // CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03): the our-pool writer does
    // NOT stamp a pricing confidence — priceFromOurPool collapses the
    // engine's numeric confidence to a tier string and never returns the
    // number, so there is nothing truthful to stamp here yet. These rows
    // render "—" in the report's confidence column, which is the honest
    // answer; carrying the numeric through this path is its own change.
    //
    // CF-CONFIDENCE-IS-NOT-OPTIONAL, persisted half (2026-09-04): that "no
    // confidence to give" is now STATED as an explicit null rather than left
    // absent. writeHoldingValuation used to drop a null on the floor, so a
    // lane that says "I measured nothing" persisted identically to one that
    // forgot — the exact distinction the required-nullable type exists to
    // preserve. The rendered answer is unchanged ("—"); it is now recorded.
    expect(hld.pricingSourceMeta).toEqual({ slug: GOLD, method: "exact-pool-leading-edge", compsUsed: 3, confidence: null });
    expect(hld.estimateBasis).not.toMatch(/floor/i);
    expect(hld.lastUpdated).not.toBe("2026-08-01T00:00:00.000Z");
    expect(body.updates.find((u: any) => u.id === id)).toMatchObject({ status: "repriced", reason: "our-pool:unified-market-value" });
  });
});

// ─── Source pins: every estimate site asks the gate; labels are literal ─────
describe("portfolioStore — every estimate site asks the gate (source pin)", () => {
  const src = read("../src/services/portfolioiq/portfolioStore.service.ts");
  it("six reprice sites and the autoPriceHolding price surface", () => {
    const sites = [...src.matchAll(/site: "([^"]+)"/g)].map((m) => m[1]);
    expect(sites).toEqual([
      "autoPriceHolding.priceSurface",
      "reprice.t3-base-auto-floor",
      "reprice.last-sale-ladder",
      "reprice.grade-ladder",
      "reprice.resolver-fallback",
      "reprice.our-pool",
      "reprice.sibling-estimate",
    ]);
    expect((src.match(/applyGate\(await gateEstimateAgainstExactPool\(/g) ?? []).length).toBe(6);
  });
  it("the sibling write names itself and the unified writes name their rung", () => {
    // CF-ONE-PERSIST-HELPER (C-7, 2026-09-03): every one of these writes now
    // goes through writeHoldingValuation, which REQUIRES a rung declaration
    // and a valueSource. The subject of this pin is unchanged — the sibling
    // write still names itself, the four unified writes still name their rung,
    // sample count, confidence and labels — but the rung now arrives as the
    // helper's `rung:` argument rather than a hand-written `fmvRung:` literal,
    // and `method` is derived FROM that same argument (so the two can no
    // longer carry different vocabularies at all, which is the defect the old
    // separate-literals shape allowed).
    expect(src).toMatch(/rung: \{ rung: "sibling-estimate" \},/);
    expect(src).toMatch(/pricingSource: "sibling-estimate",/);
    // A sibling × premium is another card's evidence: never "observed".
    expect(src).toMatch(/rung: \{ rung: "sibling-estimate" \},[\s\S]{0,200}?valueSource: "estimated",/);
    // CF-A-UNION-IS-ONE-CARD (2026-09-01): the unified write in
    // unifiedHoldingWrite now wraps its meta in withUnionRefused(...) so a
    // refused pool-twin union is auditable on the holding. The pin's subject
    // is unchanged — FOUR unified writes still name their rung and sample
    // count — so it accepts the wrapped form too.
    // CF-REPORT-CONFIDENCE-IS-PRICING (2026-09-03): the meta now also
    // carries the engine's PRICING confidence, so the report can render the
    // figure the basis prose already quoted as conf=. The pin's subject is
    // unchanged — FOUR unified writes still name their rung and sample count
    // — and it now also requires the confidence to travel with them.
    // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (2026-09-03): and the LABELS,
    // derived per-tier through the one derivation. The metas are multi-line
    // now, so the pin matches across newlines; its subject is still FOUR.
    // CF-ONE-PERSIST-HELPER: the meta is now the helper's `meta:` argument.
    // `method` is no longer written here at all — the helper derives it from
    // the required rung declaration — so the pin's subject is the rung + the
    // sample count + the confidence + the labels travelling together, which
    // is what it always actually protected.
    const unifiedMetas = src.match(
      /rung: \{ rung: (?:u|bU|unified)\.rungLabel \},[\s\S]*?valueSource: "observed",[\s\S]*?meta: (?:withUnionRefused\()?\{[\s\S]*?compsUsed: (?:u|bU|unified)\.totalSampleCount,[\s\S]*?confidence: (?:u|bU|unified)\.confidence,[\s\S]*?persistedLabelsForUnifiedResult\(/g,
    ) ?? [];
    expect(unifiedMetas.length).toBe(4);
    // The wrap adds the breadcrumb and nothing else: the same keys when no
    // union was refused. Multi-line since the labels joined the meta.
    expect(src).toMatch(/meta: withUnionRefused\(\{\s+slug: exact\.attempt\.cardId,/);
  });
  it("every unified write prices a thin exact pool (>= 1 sample); no site demands confidence >= 0.3 any more", () => {
    expect(src).not.toMatch(/(unified|unifiedResult|bU|u)\.confidence >= 0\.3/);
    expect(src).toMatch(/unified !== null && bChosen !== null && bChosen > 0 && unified\.totalSampleCount >= 1/);
    expect(src).toMatch(/finalChosen > 0 && unifiedResult\.totalSampleCount >= 1/);
    // And every unified call goes through the identity attempts (hobbyiqCardId first).
    expect(src).not.toMatch(/await computeUnifiedPrice\(/);
    expect((src.match(/await priceHoldingFromExactPool\(/g) ?? []).length).toBe(5);
  });
});

// CF-CONFIDENCE-IS-NOT-OPTIONAL (2026-09-03) — the source pin, extended.
//
// The #1658 pin above requires rung + compsUsed + confidence + labels to
// travel together on the FOUR unified writes in portfolioStore. That file was
// its entire scope, and that is precisely how the defect shipped: the reprice
// wave ran through holdingValuation.ts, a DIFFERENT module the pin never read,
// whose two lanes built a meta with slug, compsUsed and labels and no
// confidence at all. Measured after run 33801195439: absent on 43 of 43.
//
// Extending the pin to those lanes is the point. A source pin that covers one
// of two sibling write paths cannot see the path that disagrees with it.
describe("holdingValuation — the unified lanes carry the engine's confidence", () => {
  const src = read("../src/services/portfolioiq/holdingValuation.ts");

  it("BOTH lanes stamp confidence: v.confidence in their meta", () => {
    // observed + grade-curve-estimate. Not `>= 1`: exactly the two lanes this
    // module has, so a third added without a confidence fails here.
    const metas = src.match(
      /meta: \{[\s\S]*?compsUsed: v\.compsUsed,[\s\S]*?confidence: v\.confidence,/g,
    ) ?? [];
    expect(metas.length, "a holdingValuation lane built a meta without the engine's confidence").toBe(2);
  });

  it("every writeHoldingValuation meta in the module names a confidence", () => {
    // One `confidence:` for each `meta: {` the module opens — no meta may be
    // built here without naming one.
    const metaOpens = (src.match(/meta: \{/g) ?? []).length;
    const confidences = (src.match(/^\s*confidence: /gm) ?? []).length;
    expect(metaOpens).toBeGreaterThanOrEqual(2);
    expect(confidences, "a meta in holdingValuation.ts names no confidence").toBe(metaOpens);
  });

  it("the engine's 0..1 confidence is passed through UNSCALED", () => {
    // scalePricingConfidence converts the legacy 0..100 pricingConfidence.
    // computeConfidence already emits 0..1, so scaling here would turn 0.23
    // into 0.0023 and fail unitOrNull -> "unknown-confidence" all over again.
    // Matched as a CALL, so the comment naming the trap does not trip the pin.
    expect(src).not.toMatch(/scalePricingConfidence\(/);
  });
});

// The helper's contract: confidence is REQUIRED on a written meta, so a lane
// cannot omit it and still compile. This pin guards the TYPE, because the type
// is the enforcement — if `confidence?:` comes back, every lane may silently
// drop it again and only prod would say so.
describe("writeHoldingValuation — confidence is a required meta field", () => {
  const src = read("../src/services/portfolioiq/writeHoldingValuation.ts");

  it("declares `confidence: number | null`, never optional", () => {
    expect(src).toMatch(/^\s*confidence: number \| null;/m);
    // The DECLARATION, not the docblock that quotes the old optional shape as
    // the defect it describes: a leading-whitespace, line-start match.
    expect(src, "confidence went back to optional — a lane can drop it again")
      .not.toMatch(/^\s*confidence\?:/m);
  });
});

export { GOLD, GOLD_50 };
