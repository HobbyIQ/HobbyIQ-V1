// CF-AS-OF-IS-AN-UPPER-BOUND (#1651, the engine backtest, 2026-09-02).
//
// THE ONE THING THIS FILE EXISTS TO PROVE: when the engine is asked to price
// a card AS OF a past instant, a sale that happened AFTER that instant cannot
// change the answer.
//
// Why this is the whole game. A backtest's published number — "HobbyIQ landed
// within X% of the actual next sale on N held-out sales" — is worth exactly
// as much as its no-lookahead guarantee and not one point more. A lookahead
// leak does not produce an obviously wrong number that someone would catch in
// review. It produces a BETTER-LOOKING one: the engine "predicts" a sale it
// can already see, the error collapses toward zero, and the accuracy figure
// becomes a self-validating lie. The more thoroughly the leak works, the more
// impressive the report, and the less anyone is inclined to question it. So
// the guarantee cannot rest on the evaluator remembering to filter its inputs
// — it has to be structural, and it has to be pinned by a test that would go
// red if the structure were removed.
//
// THE METHOD: differential. Every case prices an identity twice against the
// SAME fixture pool — once as it stands, once with future-dated rows spliced
// in — and requires the two answers to be byte-identical. The future rows are
// deliberately obnoxious: 10x the price, dense enough to change the window
// cascade, recent enough to reset staleness. If ANY of them reached ANY rung,
// the numbers would move and the case would go red.
//
// The fixture readers below enforce the ceiling the REAL Cosmos queries
// enforce (`c.soldAt < @asOf`), so what is pinned is the contract those
// queries implement — and the mocks assert they were actually HANDED the
// cutoff, which is what catches a caller that quietly stopped passing it.
//
// WHAT IS PINNED
//   1. the exact-pool rung ignores future sales of the card itself;
//   2. the player-index rung ignores future sales of the PLAYER'S BASKET —
//      the rung whose whole claim is "the player's market moved R% since",
//      and therefore the one a leak would flatter most;
//   3. the fallback ladder ignores future sales of OTHER identities;
//   4. the cutoff actually REACHES all three reads [MUTATION: drop asOfMs at
//      any call site in oneValuationPath -> red];
//   5. the player-index memo does not serve one evaluation point's basket to
//      another at a different as-of [MUTATION: drop asOfMs from the memo key
//      -> red]. This is the leak that would otherwise depend on the order the
//      sample happened to be walked in;
//   6. production is unchanged: with no asOfMs, no ceiling is sent at all.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  playerRows: [] as Array<Record<string, unknown>>,
  ladderRows: [] as Array<Record<string, unknown>>,
  catalog: new Map<string, Record<string, unknown>>(),
  /** Every asOf the exact-pool read was handed (null = no ceiling sent). */
  exactAsOf: [] as Array<number | null>,
  /** Every asOf the player-basket read was handed. */
  playerAsOf: [] as Array<string | null>,
  /** Every asOf the fallback ladder's pool read was handed. */
  ladderAsOf: [] as Array<string | null>,
  /** Distinct player-basket reads actually performed (memo misses). */
  playerReadCalls: 0,
}));

// The exact-pool read seam (D16). The fixture honors BOTH bounds the real
// query carries: the window's lower bound, and the as-of ceiling.
vi.mock("../src/services/compiq/exactPoolReader.js", () => ({
  readExactPoolRows: vi.fn(async (input: {
    cardId: string; hobbyiqCardId: string | null;
    hobbyiqCardIds?: readonly string[] | null;
    windowDays: number; nowMs?: number; asOfMs?: number | null;
  }) => {
    const asOf = typeof input.asOfMs === "number" ? input.asOfMs : null;
    h.exactAsOf.push(asOf);
    const now = input.nowMs ?? Date.now();
    const cutoff = now - input.windowDays * 86_400_000;
    const keys = new Set([input.hobbyiqCardId, ...(input.hobbyiqCardIds ?? [])].filter(Boolean));
    return h.rows.filter((r) => {
      const t = Date.parse(String(r.soldAt));
      if (!((r.cardId === input.cardId || keys.has(r.hobbyiqCardId as string)) && t >= cutoff)) return false;
      if (asOf === null) return true;
      // Faithful to the REAL query: an ORDINAL STRING comparison against the
      // cutoff, exactly as Cosmos performs it on `c.soldAt`. Comparing parsed
      // times here instead would make the mock kinder than production and the
      // serialization bug invisible — which is how it shipped the first time.
      // The reader's parsed guard is applied after, as it is in the source.
      return String(r.soldAt) < asOfCutoffString(asOf) && isBeforeAsOf(r.soldAt, asOf);
    });
  }),
}));

// The player-basket read seam. Same discipline; the real index math then runs
// over whatever this returns.
vi.mock("../src/services/compiq/playerIndexRead.js", () => ({
  readPlayerPoolRows: vi.fn(async (input: {
    playerName: string; sport?: string | null; fromIso: string;
    limit?: number; asOfIso?: string | null;
  }) => {
    h.playerReadCalls++;
    const asOf = input.asOfIso ?? null;
    h.playerAsOf.push(asOf);
    const from = Date.parse(input.fromIso);
    return h.playerRows.filter((r) => {
      const t = Date.parse(String(r.soldAt));
      if (t < from) return false;
      if (asOf === null) return true;
      // Ordinal string comparison, as Cosmos does it — see the exact-pool mock.
      return String(r.soldAt) < asOf;
    });
  }),
}));

vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/catalog/catalogIdentityResolver.js")>();
  return { ...actual, resolveIdentityToCatalogRow: vi.fn(async (slug: string) => actual.pickCatalogRow(slug, [...h.catalog.keys()])) };
});
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    catalogSlugIfExists: vi.fn(async (slug: string) => (h.catalog.has(slug) ? slug : null)),
    readCatalogIdentityBySlug: vi.fn(async (slug: string) => h.catalog.get(slug) ?? null),
    lookupCatalogPlayerName: vi.fn(async () => "Greg Maddux"),
  };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    lookupHobbyIqCardIdForVendorCardId: vi.fn(async (id: string) => (id.startsWith("hiq:") ? id : null)),
  };
});

// The fallback ladder. NOT stubbed out to a constant here (the speculation
// suite does that, because there it only needs to know the rung was reached):
// this file has to prove the LADDER's own reads honor the cutoff too, so the
// mock is a miniature of the real thing — it filters the fixture by the same
// two bounds and prices off what survives. A ladder that could see the future
// would be the baseline the improvement claim is measured against, which is
// the one place a leak would silently flatter the new rung.
vi.mock("../src/services/portfolioiq/hobbyIqFmv.service.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/portfolioiq/hobbyIqFmv.service.js")>();
  return {
    ...actual,
    computeHobbyIqFmv: vi.fn(async (input: Record<string, unknown>) => {
      const asOfMs = typeof input.asOfMs === "number" ? (input.asOfMs as number) : null;
      h.ladderAsOf.push(asOfMs === null ? null : asOfCutoffString(asOfMs));
      const visible = h.ladderRows.filter((r) =>
        asOfMs === null || String(r.soldAt) < asOfCutoffString(asOfMs));
      if (visible.length === 0) {
        return {
          fmv: null, method: "no-basis", rungLabel: "no-basis", confidence: 0,
          compCount: 0, basisNote: "no rows", recentComps: [],
          trend: { direction: "flat", slopePerMonthPct: 0 },
        };
      }
      const mean = visible.reduce((s, r) => s + Number(r.price), 0) / visible.length;
      return {
        fmv: Math.round(mean * 100) / 100,
        method: "family-baseline", rungLabel: "family-baseline",
        confidence: 0.3, compCount: visible.length,
        basisNote: `family rung over ${visible.length} sales`,
        recentComps: [], trend: { direction: "flat", slopePerMonthPct: 0 },
      };
    }),
  };
});

delete process.env.COSMOS_CONNECTION_STRING;

import { valueIdentity } from "../src/services/compiq/oneValuationPath.service.js";
import { _clearPlayerIndexMemo } from "../src/services/compiq/playerIndex.service.js";
import { asOfCutoffString, isBeforeAsOf } from "../src/services/compiq/asOfCutoff.js";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const DAY = 86_400_000;

/** The evaluation point: we price the card as it stood 60 days ago. */
const AS_OF = NOW - 60 * DAY;

const daysBeforeAsOf = (d: number) => new Date(AS_OF - d * DAY).toISOString();
const daysAfterAsOf = (d: number) => new Date(AS_OF + d * DAY).toISOString();

const MADDUX = "hiq:baseball:1987:donruss:36:base:no-auto";

const identityRow = (over: Record<string, unknown> = {}) => ({
  playerName: "Greg Maddux", year: 1987, setKey: "donruss", setName: "1987 Donruss",
  cardNumber: "36", parallel: "Base", isAuto: false, sport: "baseball",
  printRun: null, imageUrl: null, ...over,
});

const targetSale = (price: number, soldAt: string) => ({
  cardId: "vendor-row", hobbyiqCardId: MADDUX, price, soldAt,
  gradeCompany: null, gradeValue: null, source: "tca-ebay",
});

const memberSale = (cardId: string, price: number, soldAt: string) => ({
  hobbyiqCardId: cardId, cardId, price, soldAt,
  gradeCompany: null, gradeValue: null,
});

beforeEach(() => {
  h.rows = [];
  h.playerRows = [];
  h.ladderRows = [];
  h.catalog = new Map([[MADDUX, identityRow()]]);
  h.exactAsOf = [];
  h.playerAsOf = [];
  h.ladderAsOf = [];
  h.playerReadCalls = 0;
  _clearPlayerIndexMemo();
  vi.setSystemTime(NOW);
});

/** Price the identity as of AS_OF. */
const priceAsOf = () => valueIdentity({ id: MADDUX, asOfMs: AS_OF });

/** The fields a lookahead leak would move. Compared whole so a leak that
 *  moved the RUNG rather than the price is caught too. */
const shape = (v: Awaited<ReturnType<typeof valueIdentity>>) => ({
  fairMarketValue: v.fairMarketValue,
  rungLabel: v.rungLabel,
  compsUsed: v.compsUsed,
  valueSource: v.valueSource,
  windowDays: v.windowDays,
  trendPctPerWeek: v.trend.pctPerWeek,
});

describe("the cutoff survives the pool's three timestamp serializations", () => {
  // THE REGRESSION. Found by running the backtest against the live pool, not
  // by reading the query. `c.soldAt` is compared as a STRING, and sold_comps
  // holds one instant written three ways (measured over 4,000 rows since
  // 2026-06-01: 3,062 as "+00:00", 878 as ".000Z", 60 as "Z"). Those sort by
  // ordinal, not by time:
  //
  //     "+" (0x2B) < "." (0x2E) < "Z" (0x5A)
  //
  // so a ceiling of `…T23:09:00.000Z` ADMITTED the "+00:00" spelling of its own
  // instant. In the live smoke run that meant the engine priced a card off a
  // pool of one comp — the sale being predicted — and "predicted" $29.99 to the
  // cent. Green fixtures had missed it because fixtures used one format.
  it("a .000Z ceiling would sort ABOVE the +00:00 spelling of the same instant", () => {
    // The bug, stated as the fact that caused it. If this ever becomes false,
    // the rest of this block is testing nothing.
    expect("2026-06-04T23:09:00+00:00" < "2026-06-04T23:09:00.000Z").toBe(true);
  });

  it("the cutoff sorts at or below every serialization of its own second", () => {
    const ms = Date.parse("2026-06-04T23:09:00.000Z");
    const cutoff = asOfCutoffString(ms);
    expect(cutoff).toBe("2026-06-04T23:09:00");
    for (const spelling of [
      "2026-06-04T23:09:00+00:00",
      "2026-06-04T23:09:00.000Z",
      "2026-06-04T23:09:00Z",
      "2026-06-04T23:09:00.123456+00:00",
    ]) {
      // `c.soldAt < @asOf` must be FALSE for all of them — the held-out sale's
      // own second is excluded whatever spelling it was stored in.
      expect(spelling < cutoff).toBe(false);
    }
  });

  it("the cutoff still admits everything strictly earlier, in every spelling", () => {
    const cutoff = asOfCutoffString(Date.parse("2026-06-04T23:09:00.000Z"));
    for (const spelling of [
      "2026-06-04T23:08:59+00:00",
      "2026-06-04T23:08:59.999Z",
      "2026-06-04T00:00:00Z",
      "2026-06-03T23:09:00+00:00",
    ]) {
      expect(spelling < cutoff).toBe(true);
    }
  });

  it("the parsed guard agrees with the string bound on every spelling", () => {
    const ms = Date.parse("2026-06-04T23:09:00.000Z");
    for (const same of ["2026-06-04T23:09:00+00:00", "2026-06-04T23:09:00.000Z", "2026-06-04T23:09:00Z"]) {
      expect(isBeforeAsOf(same, ms)).toBe(false);
    }
    for (const before of ["2026-06-04T23:08:59+00:00", "2026-06-01T10:00:00.000Z"]) {
      expect(isBeforeAsOf(before, ms)).toBe(true);
    }
    // An unparseable date is EXCLUDED: it is not evidence, and admitting it
    // inflates the accuracy number.
    expect(isBeforeAsOf("not a date", ms)).toBe(false);
    expect(isBeforeAsOf(null, ms)).toBe(false);
    // No cutoff (production) admits everything.
    expect(isBeforeAsOf("2099-01-01T00:00:00Z", null)).toBe(true);
  });


  it("the PARSED guard alone excludes the sale — a negative-offset spelling walks straight through the string bound", () => {
    // The mirror of the case below, and the reason the parsed guard is not
    // decoration. The block above measured the pool's three spellings, all of
    // which are UTC and all of which begin with the same 19 characters as the
    // cutoff — which is exactly why a 19-char prefix bound works on them.
    //
    // It works on them BECAUSE they are UTC. A zoned serialization of the same
    // instant is not merely a fourth spelling; its first 19 characters are a
    // DIFFERENT, EARLIER wall-clock reading:
    //
    //     "2026-06-04T19:09:00-04:00"  ===  "2026-06-04T23:09:00.000Z"
    //      ^^^^^^^^^^^^^^^^^^^ sorts four hours below the cutoff
    //
    // So the string bound does not merely fail to sort it correctly — it admits
    // it enthusiastically, as though it were a sale from earlier that evening.
    // Nothing about the 19-char prefix argument covers this case, and no amount
    // of care in choosing the cutoff's spelling would fix it: the row's own
    // spelling is what carries the offset.
    //
    // `isBeforeAsOf` is the ONLY thing standing between that row and the pool,
    // which is why it is asserted here on its own rather than only alongside
    // the query bound. (Mutation-checked: weakening the guard's comparison
    // leaves every UTC-spelled case in this file green, and reds only here and
    // in the boundary case below.)
    const asOf = Date.parse("2026-06-04T23:09:00.000Z");
    const heldOutZoned = "2026-06-04T19:09:00-04:00";   // the SAME instant, -04:00

    // Same instant, and the string bound is defeated by it.
    expect(Date.parse(heldOutZoned)).toBe(asOf);
    expect(heldOutZoned < asOfCutoffString(asOf)).toBe(true);   // query says ADMIT

    // The parsed guard is what rejects it.
    expect(isBeforeAsOf(heldOutZoned, asOf)).toBe(false);

    // And a genuinely earlier sale in the same zoned spelling still gets in —
    // the guard rejects the instant, not the offset notation.
    expect(isBeforeAsOf("2026-06-04T19:08:59-04:00", asOf)).toBe(true);
    // A zoned spelling of an instant AFTER the as-of is rejected too, even
    // though its first 19 characters sort below the cutoff.
    expect(isBeforeAsOf("2026-06-04T20:09:00-04:00", asOf)).toBe(false);
  });

  it("strict vs inclusive: at a mid-second as-of the guard admits exactly what the query admits", () => {
    // The header's invariant, in the one place it can be violated: "Same second
    // as the held-out sale is excluded, matching the string bound so the two
    // filters can never disagree about a row."
    //
    // The query bound is second-granular — the cutoff is truncated to the
    // second — so when the as-of instant falls MID-second, the query excludes
    // the whole of that second, including the milliseconds before the as-of.
    // The guard must floor to the same second to agree. Comparing against the
    // raw `asOfMs` instead (`t < asOfMs`) is inclusive of those milliseconds,
    // and the two filters then disagree about a real row: Cosmos never returns
    // it, but the in-process guard would have let it through — so the guard
    // stops being a re-check of the same rule and becomes a second, weaker one.
    //
    // That divergence is invisible when the as-of lands exactly on a second
    // boundary, which is what every other case in this file uses. This case
    // exists to make the mutation red.
    const asOf = Date.parse("2026-06-04T23:09:00.500Z");   // MID-second
    const cutoff = asOfCutoffString(asOf);
    expect(cutoff).toBe("2026-06-04T23:09:00");

    // Rows spanning the boundary, including the two that straddle the as-of
    // WITHIN its own second.
    for (const soldAt of [
      "2026-06-04T23:09:00.200Z",     // before asOfMs, but inside the cut second
      "2026-06-04T23:09:00.000Z",     // start of the cut second
      "2026-06-04T23:09:00+00:00",    // same, other spelling
      "2026-06-04T23:09:00.800Z",     // after asOfMs
      "2026-06-04T23:08:59.999Z",     // strictly earlier second
      "2026-05-30T10:00:00Z",         // long before
    ]) {
      // The invariant: whatever the query decides, the guard decides the same.
      expect(isBeforeAsOf(soldAt, asOf)).toBe(soldAt < cutoff);
    }

    // Stated directly, because it is the mutation's exact escape: a row 300ms
    // BEFORE the as-of instant but inside the cut second is excluded by both.
    // `t < asOfMs` would admit it and disagree with the query.
    expect("2026-06-04T23:09:00.200Z" < cutoff).toBe(false);
    expect(isBeforeAsOf("2026-06-04T23:09:00.200Z", asOf)).toBe(false);
  });
  it("the STRING bound alone excludes the sale — the parsed guard is a second layer, not the only one", () => {
    // Why this case is separate from the end-to-end one below. The two defenses
    // are independent by design, and a test that only ever exercises them
    // TOGETHER cannot tell you which one is working: with the sale's timestamp
    // exactly equal to the cutoff instant, the parsed guard rejects it either
    // way, and a broken string bound stays invisible. (Observed: mutating
    // asOfCutoffString back to toISOString left the end-to-end case green.)
    //
    // So this asserts the query-level bound on its own — the layer that decides
    // what Cosmos actually returns, and therefore the only one that bounds RU
    // cost and the TOP-N basket read.
    const asOf = Date.parse("2026-06-04T23:09:00.000Z");
    const cutoff = asOfCutoffString(asOf);
    const heldOut = "2026-06-04T23:09:00+00:00";
    // The query predicate, exactly as Cosmos evaluates it.
    const admittedByQuery = heldOut < cutoff;
    expect(admittedByQuery).toBe(false);
  });

  it("end to end: a +00:00 held-out sale cannot price itself", async () => {
    // The live failure, reproduced through the real engine. The pool holds the
    // held-out sale in "+00:00" form and nothing else recent; if the ceiling
    // admits it, the engine prices the card at exactly that sale.
    const asOf = Date.parse("2026-06-04T23:09:00.000Z");
    h.rows = [
      {
        cardId: "vendor-row", hobbyiqCardId: MADDUX, price: 29.99,
        soldAt: "2026-06-04T23:09:00+00:00",          // THE SALE BEING PREDICTED
        gradeCompany: null, gradeValue: null, source: "cardhedge",
      },
      // Genuine prior evidence, also in the pool's mixed spellings.
      { cardId: "vendor-row", hobbyiqCardId: MADDUX, price: 10, soldAt: "2026-05-20T10:00:00+00:00", gradeCompany: null, gradeValue: null, source: "cardhedge" },
      { cardId: "vendor-row", hobbyiqCardId: MADDUX, price: 11, soldAt: "2026-05-25T10:00:00.000Z", gradeCompany: null, gradeValue: null, source: "tca-ebay" },
      { cardId: "vendor-row", hobbyiqCardId: MADDUX, price: 10.5, soldAt: "2026-05-30T10:00:00Z", gradeCompany: null, gradeValue: null, source: "cardhedge" },
    ];
    const v = await valueIdentity({ id: MADDUX, asOfMs: asOf });

    // Priced off the ~$10 prior sales, NOT off the $29.99 it was asked to
    // predict. Before the fix this returned exactly 29.99.
    expect(v.fairMarketValue).not.toBeCloseTo(29.99, 2);
    expect(v.fairMarketValue as number).toBeLessThan(20);
    // And the sale itself never reached the engine's comp list.
    expect(v.sales.some((s) => Math.abs(s.price - 29.99) < 0.005)).toBe(false);
  });
});

describe("CF-AS-OF-IS-AN-UPPER-BOUND: a future sale changes nothing", () => {
  it("the exact-pool rung is blind to sales after the cutoff", async () => {
    // A healthy, fresh-as-of-the-cutoff pool: eight sales in the 30 days
    // before the evaluation point, all near $100.
    const base = [
      targetSale(100, daysBeforeAsOf(2)),
      targetSale(102, daysBeforeAsOf(5)),
      targetSale(98, daysBeforeAsOf(9)),
      targetSale(101, daysBeforeAsOf(13)),
      targetSale(99, daysBeforeAsOf(17)),
      targetSale(103, daysBeforeAsOf(21)),
      targetSale(97, daysBeforeAsOf(25)),
      targetSale(100, daysBeforeAsOf(29)),
    ];

    h.rows = [...base];
    const before = await priceAsOf();

    // Now splice in the future: a dozen sales at TEN TIMES the price, in the
    // days AFTER the evaluation point. In a leaking engine these dominate the
    // recency-weighted level completely.
    h.rows = [
      ...base,
      ...Array.from({ length: 12 }, (_, i) => targetSale(1000, daysAfterAsOf(i * 2 + 1))),
      // ...including one at the exact evaluation instant. `soldAt < @asOf` is
      // strict, so the sale being predicted is future data like any other.
      targetSale(5000, new Date(AS_OF).toISOString()),
    ];
    _clearPlayerIndexMemo();
    const after = await priceAsOf();

    expect(shape(after)).toEqual(shape(before));
    // And the price is the pool's own level, not a number pulled up by $1,000
    // sales — a positive check, so a bug that returned null for both would not
    // pass this case by making the two sides trivially equal.
    expect(before.fairMarketValue).toBeGreaterThan(80);
    expect(before.fairMarketValue).toBeLessThan(130);
    expect(before.rungLabel.startsWith("exact-pool-")).toBe(true);

    // The cutoff genuinely reached the read.
    expect(h.exactAsOf.length).toBeGreaterThan(0);
    expect(h.exactAsOf.every((v) => v === AS_OF)).toBe(true);
  });

  it("the player-index rung is blind to future sales in the player's basket", async () => {
    // The stale-card shape the speculation rung exists for: two sales, ~90
    // days before the cutoff, so as of the cutoff the pool is cold (> 45d)
    // and two sales is below every trend branch's floor — the card's own
    // trend is unmeasurable. Rungs 1 and 2 both decline; rung 3 is reached.
    const base = [
      targetSale(1000, daysBeforeAsOf(90)),
      targetSale(1000, daysBeforeAsOf(93)),
    ];
    // A five-card basket, liquid as of the cutoff, up 30% since the anchor.
    const basket: Array<Record<string, unknown>> = [];
    const members: Array<[string, number, number]> = [
      ["hiq:baseball:1987:donruss:37:base:no-auto", 1000, 1300],
      ["hiq:baseball:1987:donruss:38:base:no-auto", 800, 1040],
      ["hiq:baseball:1987:donruss:39:base:no-auto", 1200, 1560],
      ["hiq:baseball:1987:donruss:40:base:no-auto", 900, 1170],
      ["hiq:baseball:1987:donruss:41:base:no-auto", 1100, 1430],
    ];
    for (const [id, atAnchor, atCutoff] of members) {
      basket.push(memberSale(id, atAnchor, daysBeforeAsOf(96)));
      basket.push(memberSale(id, atAnchor, daysBeforeAsOf(93)));
      basket.push(memberSale(id, atAnchor, daysBeforeAsOf(90)));
      basket.push(memberSale(id, atCutoff, daysBeforeAsOf(12)));
      basket.push(memberSale(id, atCutoff, daysBeforeAsOf(8)));
      basket.push(memberSale(id, atCutoff, daysBeforeAsOf(4)));
    }

    h.rows = [...base];
    h.playerRows = [...basket];
    const before = await priceAsOf();

    // The player's market then EXPLODES after the cutoff — every basket member
    // quadruples. A leaking basket would read that as the ratio and the card
    // would be priced off a rally it could not have known about.
    h.rows = [...base];
    h.playerRows = [
      ...basket,
      ...members.flatMap(([id, , atCutoff]) => [
        memberSale(id, atCutoff * 4, daysAfterAsOf(2)),
        memberSale(id, atCutoff * 4, daysAfterAsOf(6)),
        memberSale(id, atCutoff * 4, daysAfterAsOf(10)),
      ]),
    ];
    _clearPlayerIndexMemo();
    const after = await priceAsOf();

    expect(shape(after)).toEqual(shape(before));
    // The rung really did fire — otherwise this case proves nothing about it.
    expect(before.rungLabel).toBe("player-index-projection");
    // ~30% carry on a $1,000 anchor: the basket's move BEFORE the cutoff, not
    // the 4x after it.
    expect(before.fairMarketValue).toBeGreaterThan(1_150);
    expect(before.fairMarketValue).toBeLessThan(1_450);

    expect(h.playerAsOf.length).toBeGreaterThan(0);
    expect(h.playerAsOf.every((v) => v === asOfCutoffString(AS_OF))).toBe(true);
  });

  it("the fallback ladder is blind to future sales of other identities", async () => {
    // No pool at all for this identity, so the gated ladder answers.
    h.rows = [];
    h.ladderRows = [
      { price: 200, soldAt: daysBeforeAsOf(20) },
      { price: 220, soldAt: daysBeforeAsOf(40) },
      { price: 180, soldAt: daysBeforeAsOf(60) },
    ];
    const before = await priceAsOf();

    h.ladderRows = [
      ...h.ladderRows,
      { price: 9000, soldAt: daysAfterAsOf(3) },
      { price: 9500, soldAt: daysAfterAsOf(9) },
    ];
    _clearPlayerIndexMemo();
    const after = await priceAsOf();

    expect(shape(after)).toEqual(shape(before));
    expect(before.rungLabel).toBe("family-baseline");
    expect(before.fairMarketValue).toBeCloseTo(200, 0);

    expect(h.ladderAsOf.length).toBeGreaterThan(0);
    expect(h.ladderAsOf.every((v) => v === asOfCutoffString(AS_OF))).toBe(true);
  });

  it("the player-index memo does not leak one evaluation point's basket into another", async () => {
    // THE ORDER-DEPENDENT LEAK. Two evaluation points for the SAME player at
    // different as-of instants, priced back to back — which is exactly what a
    // backtest does, thousands of times, milliseconds apart. With a memo keyed
    // on (player, sport) alone, the second point is served the FIRST point's
    // basket, and whether that basket contains the second point's future
    // depends only on which order the sample happened to be walked in.
    const stale = (asOf: number) => [
      targetSale(1000, new Date(asOf - 90 * DAY).toISOString()),
      targetSale(1000, new Date(asOf - 93 * DAY).toISOString()),
    ];
    const basketFor = (asOf: number, level: number) => {
      const rows: Array<Record<string, unknown>> = [];
      for (const n of [37, 38, 39, 40, 41]) {
        const id = `hiq:baseball:1987:donruss:${n}:base:no-auto`;
        rows.push(memberSale(id, 1000, new Date(asOf - 96 * DAY).toISOString()));
        rows.push(memberSale(id, 1000, new Date(asOf - 90 * DAY).toISOString()));
        rows.push(memberSale(id, level, new Date(asOf - 10 * DAY).toISOString()));
        rows.push(memberSale(id, level, new Date(asOf - 5 * DAY).toISOString()));
        rows.push(memberSale(id, level, new Date(asOf - 3 * DAY).toISOString()));
      }
      return rows;
    };

    const EARLY = NOW - 120 * DAY;
    const LATE = NOW - 30 * DAY;

    // The player's market is FLAT as of the early point and DOUBLED as of the
    // late one. The two must therefore produce different ratios; if the memo
    // leaks, the second call reuses the first basket and they come out equal.
    const early = basketFor(EARLY, 1000);
    const late = [...early, ...basketFor(LATE, 2000)];

    h.rows = stale(EARLY);
    h.playerRows = early;
    const earlyResult = await valueIdentity({ id: MADDUX, asOfMs: EARLY });
    const readsAfterFirst = h.playerReadCalls;

    h.rows = stale(LATE);
    h.playerRows = late;
    const lateResult = await valueIdentity({ id: MADDUX, asOfMs: LATE });

    // A second distinct read happened — the memo did not serve the first
    // point's basket to the second.
    expect(h.playerReadCalls).toBeGreaterThan(readsAfterFirst);
    // Both as-of values were actually sent, and they differ.
    expect(new Set(h.playerAsOf)).toEqual(new Set([
      asOfCutoffString(EARLY),
      asOfCutoffString(LATE),
    ]));
    // Flat market vs doubled market: the two evaluation points disagree, which
    // they cannot do if one was answered from the other's cache.
    expect(earlyResult.fairMarketValue).not.toBeCloseTo(lateResult.fairMarketValue as number, 0);
    expect(lateResult.fairMarketValue as number).toBeGreaterThan(earlyResult.fairMarketValue as number);
  });

  it("production is unchanged: no asOfMs means no ceiling is sent", async () => {
    // The other half of the contract. Everything above would also be true of
    // an engine that had quietly acquired a permanent ceiling, which would
    // break every live price. With no asOfMs the reads must be handed null and
    // the future-dated rows must be VISIBLE (they are simply "recent sales").
    const base = [
      targetSale(100, new Date(NOW - 3 * DAY).toISOString()),
      targetSale(100, new Date(NOW - 6 * DAY).toISOString()),
      targetSale(100, new Date(NOW - 9 * DAY).toISOString()),
      targetSale(100, new Date(NOW - 12 * DAY).toISOString()),
      targetSale(100, new Date(NOW - 15 * DAY).toISOString()),
    ];
    h.rows = base;
    const live = await valueIdentity({ id: MADDUX });
    expect(h.exactAsOf.every((v) => v === null)).toBe(true);
    expect(live.fairMarketValue).toBeGreaterThan(0);

    // Adding sales the live engine SHOULD see does move the number — proof the
    // ceiling is genuinely absent rather than merely defaulting to "now".
    h.exactAsOf = [];
    h.rows = [...base, ...Array.from({ length: 6 }, (_, i) =>
      targetSale(400, new Date(NOW - (i + 1) * DAY).toISOString()))];
    _clearPlayerIndexMemo();
    const liveAfter = await valueIdentity({ id: MADDUX });
    expect(liveAfter.fairMarketValue).not.toBeCloseTo(live.fairMarketValue as number, 0);
  });
});
