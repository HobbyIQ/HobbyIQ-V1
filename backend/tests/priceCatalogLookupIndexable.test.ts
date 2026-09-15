/**
 * CF-AN-EQUALITY-THE-INDEX-CAN-SEEK / CF-TWO-PASSES-IN-THE-TIME-OF-ONE
 * (Fable, 2026-09-15).
 *
 * THE MEASUREMENT. After the hang was fixed, the star query
 * "2024 Bowman Chrome Ohtani Base" still took 9,194 ms while every other smoke
 * case answered in 150 ms-1.9 s. App Insights for that request
 * (operation_Id 8934a4f603e74d67b1b222014170160f, 2026-09-15T08:22:18.550Z)
 * shows 2,821 Cosmos round trips in one request, none of them slow — sold_comps
 * averaged 6.4 ms, worst 95 ms. A call-count problem, not a latency one.
 *
 * This file pins the route's share of that: the catalog identity lookup.
 * Every predicate in it was wrapped in LOWER() or CONTAINS(), neither of which
 * a Cosmos range index can seek, so the "lookup" scanned every row of the year
 * — once per pass, and the two passes ran in series.
 *
 * Three changes, and the tests below are mostly about what did NOT change:
 *   - `c.setKey = @sk` without LOWER() (both sides are normalised slugs)
 *   - `c.playerSlug = @pslug` promoted to the leading disjunct, CONTAINS forms
 *     KEPT as fallbacks so no row stops matching
 *   - P1/P2 concurrent with a split budget, P1's rows still preferred
 *
 * `LOWER(c.parallel)` deliberately STAYS — see the test that pins it.
 */
import request from "supertest";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING
  ?? "AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdC1rZXktbm90LWEtc2VjcmV0;";

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

/** Every catalog query the route issues, captured as its spec. */
const catalogQuery = vi.fn();
vi.mock("../src/services/portfolioiq/cardCatalog.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCardCatalogContainer: vi.fn(async () => ({ items: { query: catalogQuery } })),
  };
});

/** The one valuation path. It must PRICE the winner, because the route only
 *  emits cardIdentity on a priced return — so this is what makes "which row
 *  won the ranking" observable from the wire at all. It records the slug it
 *  was asked about, which IS the ranking's verdict. */
const valueIdentity = vi.fn();
vi.mock("../src/services/compiq/oneValuationPath.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, valueIdentity };
});

const computeEstimate = vi.fn(async () => ({
  fairMarketValue: 0, source: "no-recent-comps", compsUsed: 0, compsAvailable: 0,
  recentComps: [], cardIdentity: { card_id: "x" }, confidence: { pricingConfidence: 0 },
}));
vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, computeEstimate };
});

let app: any;
beforeAll(async () => { app = (await import("../src/app")).default; });

/** A base-set row (P1 would return this) and an insert row (only P2 would). */
const BASE_ROW = {
  id: "hiq:baseball:2024:bowman-chrome:85:base:no-auto",
  playerName: "Shohei Ohtani", playerSlug: "shohei-ohtani",
  setName: "Bowman Chrome", setKey: "bowman-chrome", cardNumber: "85",
  parallel: "Base", sport: "baseball", recentSaleCount: 40, year: 2024,
};
const INSERT_ROW = {
  ...BASE_ROW,
  id: "hiq:baseball:2024:bowman-chrome:ii-1:base:no-auto",
  cardNumber: "II-1", recentSaleCount: 999,
};

/** The SQL each catalog call carried. The base-set pass is the one whose
 *  text contains IS_NUMBER, so the flag is readable straight off the query. */
const specs = () => catalogQuery.mock.calls.map((c) => String(c[0].query));

beforeEach(() => {
  vi.clearAllMocks();
  valueIdentity.mockImplementation(async (req: { id: string }) => ({
    fairMarketValue: 500, compsUsed: 9, reason: null, rungLabel: "direct-slug",
    basis: "Priced from the exact-identity pool.", confidence: 0.9, sales: [],
    identity: { sport: "baseball", slug: req.id, cardNumber: null, isAuto: false, setKey: "bowman-chrome" },
  }));
  catalogQuery.mockImplementation((spec: any) => ({
    fetchAll: async () => ({
      resources: String(spec.query).includes("IS_NUMBER") ? [BASE_ROW] : [INSERT_ROW],
    }),
  }));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => { vi.unstubAllGlobals(); });

const post = (year: number) =>
  request(app).post("/api/compiq/price")
    .set("x-session-id", "test-session")
    .send({ query: `${year} Bowman Chrome Ohtani Base` });

describe("the catalog lookup is a seek, not a scan", () => {
  it("seeks setKey by EQUALITY, without LOWER()", async () => {
    await post(2024);

    const sql = specs()[0];
    expect(sql).toMatch(/c\.setKey\s*=\s*@sk/);
    // MUTATION CHECK: pre-fix this read `LOWER(c.setKey) = @sk`, which no
    // range index can seek — so a lookup for one product scanned the year.
    expect(sql).not.toMatch(/LOWER\(c\.setKey\)\s*=/);
  });

  it("leads the player predicate with a playerSlug EQUALITY", async () => {
    await post(2025);

    const sql = specs()[0];
    const player = sql.slice(sql.indexOf("c.playerSlug"));
    expect(sql).toMatch(/IS_DEFINED\(c\.playerSlug\)\s*AND\s*c\.playerSlug\s*=\s*@pslug/);
    // The seekable branch must come FIRST — it is the one the planner should
    // try before falling back to a scan.
    expect(sql.indexOf("c.playerSlug = @pslug")).toBeLessThan(sql.indexOf("CONTAINS(LOWER(c.playerName)"));
    expect(player.length).toBeGreaterThan(0);
  });

  it("KEEPS the CONTAINS fallbacks, so no row stops matching", async () => {
    await post(2026);

    const sql = specs()[0];
    // Measured on prod: 393 of 400 sampled rows carry a playerSlug. The ~2%
    // that do not — and genuine substring matches where the slug differs —
    // must still resolve, so this change may only ADD a branch, never replace
    // one. Dropping these would make the query faster and wrong.
    expect(sql).toMatch(/CONTAINS\(LOWER\(c\.playerName\), @p, true\)/);
    expect(sql).toMatch(/CONTAINS\(c\.playerSlug, @pslug\)/);
  });

  it("KEEPS LOWER() on parallel, which is NOT a slug", async () => {
    await post(2022);

    const sql = specs()[0];
    // cardCatalog.CardCatalogEntry documents `parallel` as the canonical HUMAN
    // form ("Blue Refractor"), and prod agrees: of 400 sampled 2024 rows, 71
    // parallels contain a space, ZERO contain a hyphen, and the casing is
    // mixed — "Pearl Refractor" alongside "blue refractor". Dropping LOWER()
    // here would silently stop matching every non-lowercase row: a WRONG
    // answer, not a slow one. This pin is the reason it survived the sweep.
    expect(sql).toMatch(/LOWER\(c\.parallel\)\s*=\s*@par/);
  });
});

describe("the two passes cost what one used to", () => {
  it("issues at most 2 catalog queries for the Ohtani plan", async () => {
    await post(2021);

    expect(catalogQuery.mock.calls.length).toBeLessThanOrEqual(2);
    // Both are equality-anchored on the year and the player slug — the two
    // fields that make this a seek.
    for (const sql of specs()) {
      expect(sql).toMatch(/c\.year\s*=\s*@y/);
      expect(sql).toMatch(/c\.playerSlug\s*=\s*@pslug/);
    }
  });

  it("runs the base-set and full passes CONCURRENTLY", async () => {
    let live = 0;
    let maxLive = 0;
    catalogQuery.mockImplementation((spec: any) => ({
      fetchAll: async () => {
        live++; maxLive = Math.max(maxLive, live);
        await new Promise((r) => setTimeout(r, 20));
        live--;
        return { resources: String(spec.query).includes("IS_NUMBER") ? [] : [INSERT_ROW] };
      },
    }));

    await post(2020);

    // MUTATION CHECK: serially this is 1 — P2 was only issued after P1 had
    // returned and been found empty, so the common miss cost P1 + P2 in series.
    expect(maxLive).toBe(2);
  });

  it("still PREFERS the base-set pass when it returns rows", async () => {
    // P1 returns the base card, P2 the higher-recentSaleCount insert. If the
    // preference were lost, ranking would pick the insert — which is exactly
    // how "2023 Topps Chrome Acuna Base" once resolved to insert C-13.
    await post(2019);

    expect(valueIdentity).toHaveBeenCalledTimes(1);
    expect(valueIdentity.mock.calls[0][0].id).toBe(BASE_ROW.id);
  });

  it("falls back to the full pass when the base-set pass is empty", async () => {
    catalogQuery.mockImplementation((spec: any) => ({
      fetchAll: async () => ({
        resources: String(spec.query).includes("IS_NUMBER") ? [] : [INSERT_ROW],
      }),
    }));

    await post(2018);

    // A prospect product is entirely alpha-numbered, so an empty P1 is normal
    // and must not lose the card.
    expect(valueIdentity.mock.calls[0][0].id).toBe(INSERT_ROW.id);
  });

  it("a base-set pass that times out degrades to 'no base-set rows', not a failure", async () => {
    catalogQuery.mockImplementation((spec: any) => ({
      fetchAll: async () => {
        if (String(spec.query).includes("IS_NUMBER")) {
          const err = new Error("The operation was aborted.");
          err.name = "TimeoutError";
          throw err;
        }
        return { resources: [INSERT_ROW] };
      },
    }));

    await post(2017);

    // P1 is an optimisation, not a requirement: when it runs out of its half
    // of the budget the full pass can still answer, and the caller gets a card
    // rather than a refusal.
    expect(valueIdentity.mock.calls[0][0].id).toBe(INSERT_ROW.id);
  });
});
