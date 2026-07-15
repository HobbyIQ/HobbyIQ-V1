// CF-HISTORICAL-BACKFILL (Drew, 2026-07-15) — pins the dual-vendor
// (CH + CS) full-history sweep that accumulates seasonality data
// in sold_comps.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import type { CardHedgeSale } from "../src/services/compiq/cardhedge.client.js";
import type { CardsightPricingResponse } from "../src/services/compiq/cardsightSlim.client.js";

vi.mock("../src/services/compiq/cardhedge.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardhedge.client.js")>(
    "../src/services/compiq/cardhedge.client.js",
  );
  return { ...actual, getCardSales: vi.fn() };
});
vi.mock("../src/services/compiq/cardsightSlim.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardsightSlim.client.js")>(
    "../src/services/compiq/cardsightSlim.client.js",
  );
  return { ...actual, getPricing: vi.fn() };
});

import { getCardSales } from "../src/services/compiq/cardhedge.client.js";
import { getPricing } from "../src/services/compiq/cardsightSlim.client.js";
import {
  runHistoricalBackfill,
  buildTargetsFromHoldings,
} from "../src/services/portfolioiq/historicalBackfill.service.js";
import {
  _setContainerForTests as setSoldCompsContainer,
  readCompsByCardId,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

const mockedCH = vi.mocked(getCardSales);
const mockedCS = vi.mocked(getPricing);

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.cardId}::${doc.id}`, doc);
        return { resource: doc };
      },
      query(spec: { query: string; parameters?: Array<{ name: string; value: any }> }) {
        const params = new Map<string, any>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const cid = params.get("@cid");
            let rows = Array.from(store.values());
            if (cid) rows = rows.filter((d) => d.cardId === cid);
            rows.sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1));
            return { resources: rows };
          },
        };
      },
    },
  } as unknown as Container;
  return { container, store };
}

let store: Map<string, any>;
beforeEach(() => {
  vi.resetAllMocks();
  const f = fakeContainer();
  store = f.store;
  setSoldCompsContainer(f.container);
});
afterEach(() => setSoldCompsContainer(null));

function chSale(o: Partial<CardHedgeSale> = {}): CardHedgeSale {
  return {
    price: 100,
    date: "2024-07-15T00:00:00Z",
    grade: "Raw",
    source: "ebay",
    sale_type: "auction",
    title: "Sale",
    url: null,
    ...o,
  };
}

function csPricing(o: Partial<CardsightPricingResponse> = {}): CardsightPricingResponse {
  return {
    raw: { count: 0, records: [], ...(o.raw ?? {}) },
    graded: o.graded ?? [],
    meta: { total_records: 0, last_sale_date: null, ...(o.meta ?? {}) },
  } as CardsightPricingResponse;
}

const identity = {
  playerName: "Bobby Witt Jr",
  cardYear: 2020,
  setName: "Bowman Chrome",
  parallel: null,
  cardNumber: "BCP-42",
  isAuto: false,
};

describe("runHistoricalBackfill — dual-vendor accumulation", () => {
  it("writes CH sales to sold_comps at confidence 0.8", async () => {
    mockedCH.mockResolvedValue([
      chSale({ price: 500, date: "2022-08-01T00:00:00Z" }),
      chSale({ price: 480, date: "2023-08-01T00:00:00Z" }),
      chSale({ price: 460, date: "2024-08-01T00:00:00Z" }),
    ]);
    mockedCS.mockResolvedValue(csPricing());
    const result = await runHistoricalBackfill([
      { chCardId: "ch-witt-base", csCardId: null, identity },
    ]);
    expect(result.totalCHSalesWritten).toBe(3);
    expect(result.totalCSSalesWritten).toBe(0);
    const rows = await readCompsByCardId({
      cardId: "ch-witt-base",
      fromDate: "2000-01-01T00:00:00Z",
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "cardhedge" && r.confidence === 0.8)).toBe(true);
  });

  it("writes CS raw + graded records at confidence 0.6", async () => {
    mockedCH.mockResolvedValue([]);
    mockedCS.mockResolvedValue(csPricing({
      raw: { count: 2, records: [
        { price: 100, date: "2023-01-01T00:00:00Z" },
        { price: 110, date: "2024-01-01T00:00:00Z" },
      ] as any },
      graded: [{
        company_name: "PSA",
        grades: [{
          grade_value: "10",
          count: 1,
          records: [{ price: 800, date: "2023-06-01T00:00:00Z" }] as any,
        }],
      }],
    }));
    const result = await runHistoricalBackfill([
      { chCardId: null, csCardId: "cs-uuid-1", identity },
    ]);
    expect(result.totalCSSalesWritten).toBe(3);
    const rows = await readCompsByCardId({
      cardId: "cs-uuid-1", fromDate: "2000-01-01T00:00:00Z",
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "cardsight" && r.confidence === 0.6)).toBe(true);
  });

  it("both vendors together for a single target", async () => {
    mockedCH.mockResolvedValue([chSale({ price: 200 })]);
    mockedCS.mockResolvedValue(csPricing({
      raw: { count: 1, records: [{ price: 190, date: "2024-06-01T00:00:00Z" }] as any },
    }));
    const result = await runHistoricalBackfill([
      { chCardId: "ch-1", csCardId: "cs-1", identity },
    ]);
    expect(result.totalCHSalesWritten).toBe(1);
    expect(result.totalCSSalesWritten).toBe(1);
    expect(mockedCH).toHaveBeenCalledWith("ch-1", "Raw", 500);
    expect(mockedCS).toHaveBeenCalledWith("cs-1");
  });

  it("is IDEMPOTENT — running twice doesn't duplicate", async () => {
    mockedCH.mockResolvedValue([
      chSale({ price: 500, date: "2022-08-01T00:00:00Z" }),
      chSale({ price: 480, date: "2023-08-01T00:00:00Z" }),
    ]);
    mockedCS.mockResolvedValue(csPricing());
    await runHistoricalBackfill([{ chCardId: "ch-x", csCardId: null, identity }]);
    await runHistoricalBackfill([{ chCardId: "ch-x", csCardId: null, identity }]);
    // Same composite ids → upsert dedups → still 2 rows, not 4
    expect(store.size).toBe(2);
  });

  it("skips targets with no chCardId AND no csCardId", async () => {
    const result = await runHistoricalBackfill([
      { chCardId: null, csCardId: null, identity },
    ]);
    expect(result.totalCHSalesWritten).toBe(0);
    expect(result.totalCSSalesWritten).toBe(0);
    expect(mockedCH).not.toHaveBeenCalled();
    expect(mockedCS).not.toHaveBeenCalled();
  });

  it("captures errors per-target without killing the batch", async () => {
    mockedCH.mockRejectedValueOnce(new Error("boom-1")).mockResolvedValueOnce([chSale()]);
    mockedCS.mockResolvedValue(csPricing());
    const result = await runHistoricalBackfill([
      { chCardId: "ch-fail", csCardId: null, identity },
      { chCardId: "ch-ok", csCardId: null, identity },
    ]);
    expect(result.perTarget[0].errors[0]).toContain("ch:boom-1");
    expect(result.perTarget[0].chSalesWritten).toBe(0);
    expect(result.perTarget[1].chSalesWritten).toBe(1);
  });
});

describe("buildTargetsFromHoldings — holding → target mapping", () => {
  it("emits target with both cardIds when present", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "cs-uuid",
      chCardId: "ch-bubble",
      playerName: "Bobby Witt Jr",
      cardYear: 2020,
      setName: "Bowman Chrome",
    }]);
    expect(targets).toHaveLength(1);
    expect(targets[0].csCardId).toBe("cs-uuid");
    expect(targets[0].chCardId).toBe("ch-bubble");
  });

  it("skips holdings with no cardId anywhere", () => {
    const targets = buildTargetsFromHoldings([{ playerName: "Bobby Witt Jr" }]);
    expect(targets).toHaveLength(0);
  });

  it("skips backstop-synthetic 'cardsight:x::y' compound cardIds (not queryable via CS getPricing)", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "cardsight:parent-uuid::par-uuid",
      chCardId: null,
      playerName: "Bobby Witt Jr",
    }]);
    // No ch, no valid cs → skipped
    expect(targets).toHaveLength(0);
  });

  it("uses holding's grade for CH sales grade filter when present", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "cs-1", chCardId: "ch-1",
      playerName: "P", gradeCompany: "PSA", gradeValue: 10,
    }]);
    expect(targets[0].grade).toBe("PSA 10");
  });

  it("defaults grade to 'Raw' when ungraded", () => {
    const targets = buildTargetsFromHoldings([{
      cardId: "cs-1", chCardId: "ch-1",
      playerName: "P",
    }]);
    expect(targets[0].grade).toBe("Raw");
  });
});
